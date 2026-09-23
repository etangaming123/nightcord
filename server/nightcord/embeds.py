"""Link previews (PROTOCOL.md §4 Embed).

The server fetches pages people post and keeps the bits worth showing: site
name, title, description, theme colour and one image. Viewers never talk to
the third-party site themselves — images are rewritten to this server's
/proxy route — so a link in a message can't be used to collect everyone's IP
address. The server's own address is exposed instead, which the README says.

Everything here is hostile-input handling:

* only http and https, and only ports the URL itself names;
* every address the hostname resolves to must be globally routable, checked
  on the socket that is actually connected (not just up front), and again on
  each of at most 3 redirects;
* a 5 s timeout, a 1 MB read cap and text/html only for pages;
* an 8 MB cap and image/* only for the proxy;
* stdlib html.parser, no HTML is ever executed or re-rendered.
"""

from __future__ import annotations

import asyncio
import html
import html.parser
import ipaddress
import logging
import os
import re
import socket
import time
import urllib.parse

import aiohttp

log = logging.getLogger("nightcord.embeds")

MAX_EMBEDS = 5
MAX_REDIRECTS = 3
FETCH_TIMEOUT = 5
PAGE_MAX_BYTES = 1024 * 1024
IMAGE_MAX_BYTES = 8 * 1024 * 1024
CACHE_TTL = 3600
CACHE_MAX = 2000
USER_AGENT = "NightcordBot"

TITLE_MAX = 256
DESCRIPTION_MAX = 400
SITE_MAX = 64
AUTHOR_MAX = 128

IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")
IMAGE_PATH_RE = re.compile(r"\.(png|jpe?g|gif|webp|avif)(?:$|\?)", re.I)

# Hosts allowed to resolve to a private address. Empty unless something asks:
# the tests point it at their own loopback site, and
# NIGHTCORD_EMBED_ALLOW_HOSTS=a,b does the same for local development. Never
# set that on a server anyone else can post to — it's exactly the hole the
# rest of this module exists to close.
_ALLOW_PRIVATE: set[str] = {
    h.strip().lower() for h in os.environ.get("NIGHTCORD_EMBED_ALLOW_HOSTS", "").split(",") if h.strip()
}


def allow_private_host(host: str | None) -> None:
    """Let one host resolve to a loopback/private address; None clears the list."""
    if host is None:
        _ALLOW_PRIVATE.clear()
    else:
        _ALLOW_PRIVATE.add(host.lower())


def _ip_allowed(ip: str, host: str) -> bool:
    if host.lower() in _ALLOW_PRIVATE:
        return True
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


class UnsafeUrl(Exception):
    """The URL points somewhere the server must not fetch."""


def check_url(url: str) -> tuple[str, str, int]:
    """(scheme, host, port) for a URL that's safe to *try*. Raises UnsafeUrl."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as e:
        raise UnsafeUrl(str(e)) from e
    if parsed.scheme not in ("http", "https"):
        raise UnsafeUrl("only http and https")
    host = parsed.hostname
    if not host:
        raise UnsafeUrl("no host")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as e:
        raise UnsafeUrl("bad port") from e
    # A literal IP is checked here; a name is checked again once it resolves.
    try:
        if not ipaddress.ip_address(host).is_global and host.lower() not in _ALLOW_PRIVATE:
            raise UnsafeUrl("not a public address")
    except ValueError:
        pass
    return parsed.scheme, host, port


class GuardedResolver(aiohttp.abc.AbstractResolver):
    """Drops every resolved address that isn't globally routable, so a name
    that points at 127.0.0.1 or 169.254.169.254 never reaches connect()."""

    def __init__(self):
        self._inner = aiohttp.ThreadedResolver()

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET):
        hosts = await self._inner.resolve(host, port, family)
        allowed = [h for h in hosts if _ip_allowed(h["host"], host)]
        if not allowed:
            raise UnsafeUrl(f"{host} resolves to a private address")
        return allowed

    async def close(self) -> None:
        await self._inner.close()


def make_session() -> aiohttp.ClientSession:
    """The shared outbound session; created in app.py on_startup."""
    connector = aiohttp.TCPConnector(resolver=GuardedResolver(), limit=8, ttl_dns_cache=60, force_close=True)
    return aiohttp.ClientSession(
        connector=connector,
        timeout=aiohttp.ClientTimeout(total=FETCH_TIMEOUT),
        headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
        auto_decompress=True,
    )


async def fetch_guarded(session: aiohttp.ClientSession, url: str, *, accept: str, max_bytes: int):
    """GET url following redirects by hand, re-checking each hop.
    Returns (final_url, response, body) or raises UnsafeUrl / ClientError."""
    seen = 0
    while True:
        check_url(url)
        resp = await session.get(url, allow_redirects=False, headers={"Accept": accept})
        location = resp.headers.get("Location")
        if resp.status in (301, 302, 303, 307, 308) and location:
            resp.release()
            seen += 1
            if seen > MAX_REDIRECTS:
                raise UnsafeUrl("too many redirects")
            url = urllib.parse.urljoin(url, location)
            continue
        if resp.status != 200:
            resp.release()
            raise UnsafeUrl(f"HTTP {resp.status}")
        body = b""
        async for chunk in resp.content.iter_chunked(64 * 1024):
            body += chunk
            if len(body) > max_bytes:
                resp.close()
                raise UnsafeUrl("too large")
        return url, resp, body


# --- HTML meta parsing -------------------------------------------------------


class MetaParser(html.parser.HTMLParser):
    """Pulls <title>, <meta> and nothing else out of a page's head."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False
        self._done = False

    def handle_starttag(self, tag, attrs):
        if self._done:
            return
        if tag == "title" and not self.title:
            self._in_title = True
            return
        if tag == "body":
            self._done = True
            return
        if tag != "meta":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        key = a.get("property") or a.get("name")
        value = a.get("content")
        if key and value:
            self.meta.setdefault(key.lower().strip(), value.strip())

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and len(self.title) < 1000:
            self.title += data


def _clean(text: str | None, limit: int) -> str | None:
    if not text:
        return None
    text = html.unescape(" ".join(text.split()))
    if not text:
        return None
    return text[:limit]


COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _color(value: str | None) -> str | None:
    if not value or not COLOR_RE.match(value.strip()):
        return None
    c = value.strip().lower()
    return "#" + "".join(ch * 2 for ch in c[1:]) if len(c) == 4 else c


def parse_meta(body: bytes, url: str) -> dict:
    """An embed dict (without proxied image URLs) from a page's bytes."""
    parser = MetaParser()
    try:
        parser.feed(body.decode("utf-8", "replace"))
    except Exception:  # a malformed page shouldn't take a message down
        log.debug("meta parse failed for %s", url, exc_info=True)
    m = parser.meta
    pick = lambda *keys: next((m[k] for k in keys if m.get(k)), None)  # noqa: E731
    host = urllib.parse.urlsplit(url).hostname or ""
    image = pick("og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src")
    embed = {
        "kind": "link",
        "url": url,
        "title": _clean(pick("og:title", "twitter:title") or parser.title, TITLE_MAX),
        "description": _clean(pick("og:description", "twitter:description", "description"), DESCRIPTION_MAX),
        "site_name": _clean(pick("og:site_name", "twitter:site") or host.removeprefix("www."), SITE_MAX),
        "author": _clean(pick("article:author", "twitter:creator"), AUTHOR_MAX),
        "color": _color(pick("theme-color", "msapplication-TileColor")),
        "image": urllib.parse.urljoin(url, image) if image else None,
        "thumbnail": None,
    }
    if not embed["title"] and not embed["description"] and not embed["image"]:
        return {}
    return embed


# --- YouTube -----------------------------------------------------------------

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def youtube_id(url: str) -> str | None:
    """The video id in a watch, youtu.be or shorts URL, or None."""
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    if host not in YOUTUBE_HOSTS:
        return None
    if host.endswith("youtu.be"):
        candidate = parts.path.lstrip("/").split("/")[0]
    elif parts.path == "/watch":
        candidate = urllib.parse.parse_qs(parts.query).get("v", [""])[0]
    elif parts.path.startswith("/shorts/") or parts.path.startswith("/live/"):
        candidate = parts.path.split("/")[2] if len(parts.path.split("/")) > 2 else ""
    else:
        return None
    return candidate if YOUTUBE_ID_RE.match(candidate) else None


# --- URL extraction ----------------------------------------------------------

# Spans that never contribute a link: code blocks, inline code, spoilers, and
# anything wrapped in <> (the "don't preview this" form, PROTOCOL.md §4).
_SKIP = re.compile(
    r"```[\s\S]*?```|`[^`\n]*`|\|\|[\s\S]*?\|\||<https?://[^\s<>]+>|\[[^\]\n]{1,200}\]\(<https?://[^\s<>]+>\)",
)
_MASKED = re.compile(r"\[[^\]\n]{1,200}\]\((https?://[^\s)<>\"']+)\)")
_BARE = re.compile(r"https?://[^\s<>\"']+")
_TRIM = re.compile(r"[.,;:!?'\"]+$")


def _trim_url(url: str) -> str:
    """Same rule as the client (client/js/ui/markdown.js trimUrl)."""
    while True:
        before = url
        url = _TRIM.sub("", url)
        if url[-1:] in (")", "]"):
            close = url[-1]
            open_ = "(" if close == ")" else "["
            if url.count(close) > url.count(open_):
                url = url[:-1]
        if url == before:
            return url


def extract_urls(content: str, limit: int = MAX_EMBEDS) -> list[str]:
    """URLs in a message that should get a preview, in order, de-duplicated."""
    # Blank out the spans that opt out, keeping offsets so the rest still lines up.
    masked = _SKIP.sub(lambda m: " " * len(m.group(0)), content or "")
    found: list[tuple[int, str]] = []
    for m in _MASKED.finditer(masked):
        found.append((m.start(1), _trim_url(m.group(1))))
    # A masked link's URL is inside the text, so don't also match it bare.
    covered = [(m.start(), m.end()) for m in _MASKED.finditer(masked)]
    for m in _BARE.finditer(masked):
        if any(a <= m.start() < b for a, b in covered):
            continue
        found.append((m.start(), _trim_url(m.group(0))))
    out: list[str] = []
    for _, url in sorted(found):
        if len(url) > 2000 or url in out:
            continue
        try:
            check_url(url)
        except UnsafeUrl:
            continue
        out.append(url)
        if len(out) >= limit:
            break
    return out


# --- building embeds ---------------------------------------------------------

_cache: dict[str, tuple[float, dict]] = {}


def cache_clear() -> None:
    _cache.clear()


def _cached(url: str) -> dict | None:
    hit = _cache.get(url)
    if hit is None:
        return None
    if hit[0] < time.time():
        _cache.pop(url, None)
        return None
    return hit[1]


def _store(url: str, embed: dict) -> None:
    if len(_cache) > CACHE_MAX:
        _cache.clear()
    _cache[url] = (time.time() + CACHE_TTL, embed)


async def build_embed(session: aiohttp.ClientSession, url: str) -> dict:
    """One embed for one URL. Returns {} when there's nothing worth showing."""
    cached = _cached(url)
    if cached is not None:
        return dict(cached) if cached else {}
    embed = await _build(session, url)
    _store(url, embed)
    return dict(embed) if embed else {}


async def _build(session: aiohttp.ClientSession, url: str) -> dict:
    video = youtube_id(url)
    if video:
        return {
            "kind": "video",
            "url": url,
            "title": None,
            "description": None,
            "site_name": "YouTube",
            "author": None,
            "color": "#ff0000",
            "image": f"https://i.ytimg.com/vi/{video}/hqdefault.jpg",
            "thumbnail": None,
        }
    try:
        final, resp, body = await fetch_guarded(session, url, accept="text/html,*/*;q=0.5", max_bytes=PAGE_MAX_BYTES)
    except (UnsafeUrl, aiohttp.ClientError, asyncio.TimeoutError, UnicodeError, OSError) as e:
        log.debug("embed fetch failed for %s: %s", url, e)
        return {}
    content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if content_type in IMAGE_TYPES or (not content_type and IMAGE_PATH_RE.search(url)):
        return {
            "kind": "image", "url": url, "title": None, "description": None,
            "site_name": urllib.parse.urlsplit(final).hostname or None,
            "author": None, "color": None, "image": final, "thumbnail": None,
        }
    if content_type not in ("text/html", "application/xhtml+xml"):
        return {}
    return parse_meta(body, final)


async def build_embeds(session: aiohttp.ClientSession, content: str) -> list[dict]:
    urls = extract_urls(content)
    if not urls:
        return []
    results = await asyncio.gather(*(build_embed(session, u) for u in urls), return_exceptions=True)
    out = []
    for r in results:
        if isinstance(r, BaseException):
            log.debug("embed task failed", exc_info=r)
            continue
        if r:
            out.append(r)
    return out
