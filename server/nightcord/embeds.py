"""Link previews (PROTOCOL.md §4 Embed).

The server fetches pages people post and keeps the bits worth showing, laid
out the way Discord does: provider, author, title, description, theme colour
and an image (big, or a thumbnail for "summary" cards), plus a video when the
page has one. GIF sites (Tenor, Giphy) and direct image/video links become
bare media. oEmbed fills in author and provider lines (that's how fixupx
shows a tweet's stats), YouTube's oEmbed gives video titles, and X/Twitter
links are read through fixupx when the `fx_links` setting is on.

Viewers never talk to the third-party site themselves — images and videos
are rewritten to this server's /proxy route — so a link in a message can't
be used to collect everyone's IP address. The server's own address is
exposed instead, which the README says. (The one exception is a YouTube
video, which the client only loads from YouTube when you press play.)

Results are cached in memory and in the database (`embed_cache`): a day for
a preview, ten minutes for a page that had nothing to show.

Everything here is hostile-input handling:

* only http and https, and only ports the URL itself names;
* every address the hostname resolves to must be globally routable, checked
  on the socket that is actually connected (not just up front), and again on
  each of at most 3 redirects;
* a 5 s timeout for a whole fetch (redirects included), a 1 MB read cap and
  text/html only for pages;
* an 8 MB cap and image/* for proxied images, 25 MB and mp4/webm for videos;
* stdlib html.parser, no HTML is ever executed or re-rendered.
"""

from __future__ import annotations

import asyncio
import html
import html.parser
import ipaddress
import json
import logging
import os
import re
import socket
import time
import urllib.parse

import aiohttp

from . import protocol as P
from .files import image_info

log = logging.getLogger("nightcord.embeds")

MAX_EMBEDS = P.MAX_EMBEDS_PER_MESSAGE
MAX_REDIRECTS = 3
FETCH_TIMEOUT = P.EMBED_FETCH_TIMEOUT
PAGE_MAX_BYTES = P.EMBED_PAGE_MAX_BYTES
IMAGE_MAX_BYTES = P.EMBED_IMAGE_MAX_BYTES
VIDEO_MAX_BYTES = P.EMBED_VIDEO_MAX_BYTES
OEMBED_MAX_BYTES = 64 * 1024
CACHE_TTL = P.EMBED_CACHE_SECONDS
FAIL_TTL = P.EMBED_FAIL_CACHE_SECONDS
CACHE_MAX = 2000
# "bot" in the name is what fixupx and friends look for before serving a
# preview page instead of redirecting to the real site.
USER_AGENT = "Mozilla/5.0 (compatible; NightcordBot/1.0; +https://github.com/etangaming123/nightcord)"

TITLE_MAX = 256
DESCRIPTION_MAX = 1000
SITE_MAX = 64
AUTHOR_MAX = 256
DIM_MAX = 10000

IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")
VIDEO_TYPES = ("video/mp4", "video/webm")
IMAGE_PATH_RE = re.compile(r"\.(png|jpe?g|gif|webp|avif)(?:$|\?)", re.I)
VIDEO_PATH_RE = re.compile(r"\.(mp4|webm)(?:$|\?)", re.I)
# Sites whose "videos" are really GIFs: shown as bare looping media.
GIFV_HOSTS = ("tenor.com", "giphy.com")

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


def content_type_of(resp) -> str:
    return (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()


async def fetch_guarded(
    session: aiohttp.ClientSession, url: str, *, accept: str, max_bytes: int,
    total: float = FETCH_TIMEOUT, peek: tuple[str, ...] = (), peek_bytes: int = 64 * 1024,
    sizes: dict[str, int] | None = None,
):
    """GET url following redirects by hand, re-checking each hop, all within
    `total` seconds. Returns (final_url, response, body) or raises UnsafeUrl /
    ClientError / TimeoutError.

    peek: content types for which only the first peek_bytes are read (enough
    for an image's size) — the rest is left for the proxy to fetch later.
    sizes: per top-level type ("image", "video") read caps instead of max_bytes."""
    async with asyncio.timeout(total):
        seen = 0
        while True:
            check_url(url)
            resp = await session.get(
                url, allow_redirects=False, headers={"Accept": accept},
                timeout=aiohttp.ClientTimeout(total=total),
            )
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
            ctype = content_type_of(resp)
            limit = (sizes or {}).get(ctype.split("/")[0], max_bytes)
            if ctype in peek:
                limit = peek_bytes
            elif resp.content_length is not None and resp.content_length > limit:
                resp.close()
                raise UnsafeUrl("too large")
            body = b""
            async for chunk in resp.content.iter_chunked(64 * 1024):
                body += chunk
                if len(body) > limit:
                    if ctype in peek:
                        body = body[:limit]
                        break
                    resp.close()
                    raise UnsafeUrl("too large")
            resp.close()
            return url, resp, body


# --- HTML meta parsing -------------------------------------------------------


class MetaParser(html.parser.HTMLParser):
    """Pulls <title>, <meta> and <link> out of a page's head, nothing else."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.links: list[dict[str, str]] = []
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
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "link":
            if len(self.links) < 50:
                self.links.append(a)
            return
        if tag != "meta":
            return
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


def _clean_multiline(text: str | None, limit: int) -> str | None:
    """Like _clean, but keeps line breaks (tweets and descriptions use them)."""
    if not text:
        return None
    lines = [" ".join(line.split()) for line in html.unescape(text).replace("\r", "").split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return text[:limit] or None


COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _color(value: str | None) -> str | None:
    if not value or not COLOR_RE.match(value.strip()):
        return None
    c = value.strip().lower()
    return "#" + "".join(ch * 2 for ch in c[1:]) if len(c) == 4 else c


def _dim(value) -> int | None:
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if 0 < n <= DIM_MAX else None


def _abs_url(base: str, value: str | None) -> str | None:
    """value made absolute against base, if it's an http(s) URL at all."""
    if not value:
        return None
    try:
        out = urllib.parse.urljoin(base, value.strip())
    except ValueError:
        return None
    return out if urllib.parse.urlsplit(out).scheme in ("http", "https") and len(out) <= 2000 else None


_CHARSET_RE = re.compile(rb"""<meta[^>]+charset=["']?([A-Za-z0-9_.:-]+)""", re.I)


def decode_page(body: bytes, header_charset: str | None = None) -> str:
    """Page text in the charset the server or the page itself declares."""
    for charset in (header_charset, (_CHARSET_RE.search(body[:4096]) or [None, b""])[1].decode("ascii", "ignore")):
        if charset:
            try:
                return body.decode(charset, "replace")
            except LookupError:
                pass
    return body.decode("utf-8", "replace")


def _host_is(host: str, domains) -> bool:
    host = host.lower()
    return any(host == d or host.endswith("." + d) for d in domains)


def empty_embed(kind: str, url: str) -> dict:
    """Every field an embed has (PROTOCOL.md §4 Embed), blank."""
    return {
        "kind": kind, "url": url,
        "title": None, "description": None,
        "site_name": None, "provider_url": None,
        "author": None, "author_url": None,
        "color": None,
        "image": None, "image_width": None, "image_height": None,
        "thumbnail": None,
        "video": None, "video_width": None, "video_height": None,
        "youtube_id": None,
    }


def parse_meta(body: bytes | str, url: str, *, charset: str | None = None) -> dict:
    """An embed dict (without proxied URLs) from a page's bytes. The page's
    oEmbed link, if any, rides along as "_oembed" for the caller to fetch."""
    parser = MetaParser()
    try:
        parser.feed(body if isinstance(body, str) else decode_page(body, charset))
    except Exception:  # a malformed page shouldn't take a message down
        log.debug("meta parse failed for %s", url, exc_info=True)
    m = parser.meta
    pick = lambda *keys: next((m[k] for k in keys if m.get(k)), None)  # noqa: E731
    host = urllib.parse.urlsplit(url).hostname or ""
    image = _abs_url(url, pick("og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"))
    card = (pick("twitter:card") or "").lower()

    video = None
    for key, type_key in (("og:video:secure_url", "og:video:type"), ("og:video:url", "og:video:type"),
                          ("og:video", "og:video:type"), ("twitter:player:stream", "twitter:player:stream:content_type")):
        candidate = _abs_url(url, m.get(key))
        vtype = (m.get(type_key) or "").lower()
        if candidate and (vtype in VIDEO_TYPES or (not vtype and VIDEO_PATH_RE.search(candidate))):
            video = candidate
            break

    kind = "link"
    if video:
        kind = "gifv" if _host_is(host, GIFV_HOSTS) else "video"
    embed = empty_embed(kind, url)
    embed.update({
        "title": _clean(pick("og:title", "twitter:title") or parser.title, TITLE_MAX),
        "description": _clean_multiline(pick("og:description", "twitter:description", "description"), DESCRIPTION_MAX),
        "site_name": _clean(pick("og:site_name") or host.removeprefix("www."), SITE_MAX),
        "author": _clean(pick("article:author", "twitter:creator"), AUTHOR_MAX),
        "color": _color(pick("theme-color", "msapplication-TileColor")),
    })
    if video:
        embed["video"] = video
        embed["video_width"] = _dim(pick("og:video:width", "twitter:player:width"))
        embed["video_height"] = _dim(pick("og:video:height", "twitter:player:height"))
    if image:
        # Discord's rule: a big image only for large-image cards (and videos'
        # posters); any other page image is a small thumbnail on the right.
        if video or card in ("summary_large_image", "player"):
            embed["image"] = image
            embed["image_width"] = _dim(pick("og:image:width"))
            embed["image_height"] = _dim(pick("og:image:height"))
        else:
            embed["thumbnail"] = image
    if not embed["title"] and not embed["description"] and not image and not video:
        return {}
    for link in parser.links:
        if "alternate" in link.get("rel", "").lower().split() and link.get("type", "").lower() == "application/json+oembed":
            embed["_oembed"] = _abs_url(url, link.get("href"))
            break
    return embed


def apply_oembed(embed: dict, data: dict) -> None:
    """Author and provider lines from an oEmbed response (Discord uses these
    over the page's own tags)."""
    if not isinstance(data, dict):
        return
    author = _clean(data.get("author_name") if isinstance(data.get("author_name"), str) else None, AUTHOR_MAX)
    if author:
        embed["author"] = author
        embed["author_url"] = _abs_url(embed["url"], data.get("author_url") if isinstance(data.get("author_url"), str) else None)
    provider = _clean(data.get("provider_name") if isinstance(data.get("provider_name"), str) else None, SITE_MAX)
    if provider:
        embed["site_name"] = provider
        embed["provider_url"] = _abs_url(embed["url"], data.get("provider_url") if isinstance(data.get("provider_url"), str) else None)
    title = data.get("title")
    if not embed.get("title") and isinstance(title, str):
        embed["title"] = _clean(title, TITLE_MAX)


async def fetch_oembed(session: aiohttp.ClientSession, url: str) -> dict | None:
    try:
        _final, _resp, body = await fetch_guarded(session, url, accept="application/json", max_bytes=OEMBED_MAX_BYTES)
        data = json.loads(body.decode("utf-8", "replace"))
    except (UnsafeUrl, aiohttp.ClientError, asyncio.TimeoutError, UnicodeError, OSError, ValueError) as e:
        log.debug("oembed fetch failed for %s: %s", url, e)
        return None
    return data if isinstance(data, dict) else None


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


# YouTube's own oEmbed endpoint: the video's title and channel. Overridable so
# tests can point it at a local site.
YOUTUBE_OEMBED = "https://www.youtube.com/oembed?format=json&url="


# --- X / Twitter via fixupx --------------------------------------------------

TWITTER_HOSTS = {"x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"}
TWITTER_STATUS_RE = re.compile(r"^/[A-Za-z0-9_]{1,15}/status(?:es)?/\d+")
# Where status pages are read from when fx_links is on (overridable for tests).
FX_BASE = "https://fixupx.com"


def fx_url(url: str) -> str | None:
    """The fixupx page for an X/Twitter status URL, or None."""
    parts = urllib.parse.urlsplit(url)
    if (parts.hostname or "").lower() not in TWITTER_HOSTS or not TWITTER_STATUS_RE.match(parts.path):
        return None
    return FX_BASE + parts.path + (f"?{parts.query}" if parts.query else "")


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

# Front cache in memory (url -> (expires, embed)); the database behind it
# survives restarts. {} means "looked, nothing to show".
_cache: dict[str, tuple[float, dict]] = {}


def cache_clear() -> None:
    _cache.clear()


def _cached(key: str, db) -> dict | None:
    hit = _cache.get(key)
    if hit is not None:
        if hit[0] >= time.time():
            return hit[1]
        _cache.pop(key, None)
    if db is not None:
        found = db.embed_cache_get(key)
        if found is not None:
            data, expires = found
            _remember(key, data, expires)
            return data
    return None


def _remember(key: str, embed: dict, expires: float) -> None:
    while len(_cache) >= CACHE_MAX:
        _cache.pop(next(iter(_cache)))  # oldest first (dicts keep insertion order)
    _cache[key] = (expires, embed)


def _store(key: str, embed: dict, db) -> None:
    ttl = CACHE_TTL if embed else FAIL_TTL
    expires = time.time() + ttl
    _remember(key, embed, expires)
    if db is not None:
        try:
            db.embed_cache_put(key, embed, int(expires))
        except Exception:
            log.warning("couldn't save a link preview to the cache", exc_info=True)


async def build_embed(session: aiohttp.ClientSession, url: str, *, db=None, fx: bool = True) -> dict:
    """One embed for one URL. Returns {} when there's nothing worth showing."""
    via = fx_url(url) if fx else None
    key = f"{url}#fx" if via else url
    cached = _cached(key, db)
    if cached is not None:
        return dict(cached) if cached else {}
    embed = await _build(session, url, via)
    _store(key, embed, db)
    return dict(embed) if embed else {}


async def _youtube(session: aiohttp.ClientSession, url: str, video: str) -> dict:
    embed = empty_embed("video", url)
    embed.update({
        "site_name": "YouTube", "provider_url": "https://www.youtube.com", "color": "#ff0000",
        "image": f"https://i.ytimg.com/vi/{video}/hqdefault.jpg", "image_width": 480, "image_height": 360,
        "youtube_id": video,
    })
    data = await fetch_oembed(session, YOUTUBE_OEMBED + urllib.parse.quote(url, safe=""))
    if data:
        embed["title"] = _clean(data.get("title") if isinstance(data.get("title"), str) else None, TITLE_MAX)
        apply_oembed(embed, {k: data.get(k) for k in ("author_name", "author_url")})
    return embed


async def _build(session: aiohttp.ClientSession, url: str, via: str | None = None) -> dict:
    video = youtube_id(url)
    if video:
        return await _youtube(session, url, video)
    try:
        final, resp, body = await fetch_guarded(
            session, via or url, accept="text/html,*/*;q=0.5", max_bytes=PAGE_MAX_BYTES,
            peek=IMAGE_TYPES + VIDEO_TYPES,
        )
    except (UnsafeUrl, aiohttp.ClientError, asyncio.TimeoutError, UnicodeError, OSError) as e:
        log.debug("embed fetch failed for %s: %s", url, e)
        return {}
    content_type = content_type_of(resp)
    host = urllib.parse.urlsplit(final).hostname or None
    if content_type in IMAGE_TYPES or (not content_type and IMAGE_PATH_RE.search(url)):
        embed = empty_embed("image", url)
        info = image_info(body)
        embed.update({"site_name": host, "image": final,
                      "image_width": _dim(info[0]) if info else None, "image_height": _dim(info[1]) if info else None})
        return embed
    if content_type in VIDEO_TYPES or (not content_type and VIDEO_PATH_RE.search(url)):
        embed = empty_embed("video", url)
        embed.update({"site_name": host, "video": final})
        return embed
    if content_type not in ("text/html", "application/xhtml+xml"):
        return {}
    charset = None
    match = re.search(r"charset=([A-Za-z0-9_.:-]+)", resp.headers.get("Content-Type") or "", re.I)
    if match:
        charset = match.group(1)
    embed = parse_meta(body, final, charset=charset)
    if not embed:
        return {}
    embed["url"] = url  # the link as posted, not where fixupx or a redirect led
    oembed = embed.pop("_oembed", None)
    if oembed:
        data = await fetch_oembed(session, oembed)
        if data:
            apply_oembed(embed, data)
    return embed


async def build_embeds(session: aiohttp.ClientSession, content: str, *, db=None, fx: bool = True) -> list[dict]:
    urls = extract_urls(content)
    if not urls:
        return []
    results = await asyncio.gather(*(build_embed(session, u, db=db, fx=fx) for u in urls), return_exceptions=True)
    out = []
    for r in results:
        if isinstance(r, BaseException):
            log.debug("embed task failed", exc_info=r)
            continue
        if r:
            out.append(r)
    return out
