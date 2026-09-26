// Link previews (PROTOCOL.md §4 Embed), laid out like Discord's. Everything
// here is server-supplied text and server-hosted media: an embed's images and
// videos always point back at the Nightcord server's /proxy route, never at
// the site being previewed, so opening a channel never tells that site who is
// reading. The one exception is a YouTube video, whose player is only loaded
// from YouTube when the viewer presses play.

import { mediaLoaded } from "./chat.js";
import { h, serverUrl } from "./dom.js";
import { icon } from "./icons.js";
import { openLightbox } from "./attachments.js";
import { leavingDialog } from "./links.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/embeds");

const MAX_W = 400;
const MAX_H = 300;
const THUMB = 80;

// A server path (/proxy/…) made absolute; anything else is ignored.
const proxied = (path) => (typeof path === "string" && path.startsWith("/proxy/") ? serverUrl(path) : null);
const isWeb = (url) => typeof url === "string" && /^https?:\/\//i.test(url);

// Keep a box's size before its media loads, so the chat doesn't jump.
function fitted(w, h2, maxW = MAX_W, maxH = MAX_H) {
  if (!w || !h2) return null;
  const scale = Math.min(1, maxW / w, maxH / h2);
  return { width: `${Math.round(w * scale)}px`, aspectRatio: `${w} / ${h2}` };
}

// A link that goes through the "leaving Nightcord" guard (ui/links.js), like
// links in messages: trusted domains skip the dialog.
function link(url, cls, ...children) {
  return isWeb(url)
    ? h("a", { class: `md-link ${cls}`, href: url, target: "_blank", rel: "noopener noreferrer" }, ...children)
    : h("span", { class: cls }, ...children);
}

function suppressButton(message, actions) {
  return actions?.canSuppressEmbeds?.(message)
    ? h("button", {
      class: "embed-x", type: "button", title: t("hide_previews"), "aria-label": t("hide_previews"),
      on: { click: () => actions.suppressEmbeds(message) },
    }, icon("x"))
    : null;
}

// --- bare media (image links, GIF sites) -------------------------------------------

function bareImage(embed, message, actions) {
  const src = proxied(embed.image);
  if (!src) return null;
  const name = embed.site_name || t("image");
  return h("div", { class: "embed-bare" },
    h("button", {
      class: "att-image", type: "button", title: embed.url, style: fitted(embed.image_width, embed.image_height),
      "aria-label": t("open_image"),
      on: { click: () => openLightbox([{ url: embed.image, filename: name }]) },
    }, h("img", { src, alt: "", loading: "lazy", decoding: "async", draggable: "false", on: { load: mediaLoaded } })),
    suppressButton(message, actions));
}

function bareGifv(embed, message, actions) {
  const src = proxied(embed.video);
  if (!src) return bareImage(embed, message, actions);
  const w = embed.video_width || embed.image_width;
  const hgt = embed.video_height || embed.image_height;
  const video = h("video", {
    // No poster: GIF sites' posters are the full GIF, often megabytes.
    src, autoplay: true, loop: true, muted: true, playsinline: true,
    preload: "auto", "aria-label": t("gif"), disablepictureinpicture: true,
    on: { loadedmetadata: mediaLoaded },
  });
  // Autoplay needs muted set as a property too, not just the attribute.
  video.muted = true;
  video.addEventListener("error", () => video.replaceWith(h("img", { src: proxied(embed.image) || "", alt: "" })), { once: true });
  return h("div", { class: "embed-bare" },
    h("div", { class: "embed-gifv", style: fitted(w, hgt), title: embed.url }, video,
      h("span", { class: "gif-tag", "aria-hidden": "true" }, "GIF")),
    suppressButton(message, actions));
}

// --- cards -----------------------------------------------------------------------------

function youtubePlayer(embed) {
  const poster = proxied(embed.image);
  const box = h("div", { class: "embed-video yt", style: { aspectRatio: "16 / 9" } });
  const play = () => {
    box.replaceChildren(h("iframe", {
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(embed.youtube_id)}?autoplay=1`,
      title: embed.title || "YouTube",
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
      allowfullscreen: true,
      referrerpolicy: "strict-origin-when-cross-origin",
    }));
  };
  box.append(h("button", {
    class: "embed-play-btn", type: "button", title: t("play_here"), "aria-label": t("play_here"), on: { click: play },
  },
  poster ? h("img", { src: poster, alt: "", loading: "lazy", decoding: "async", on: { load: mediaLoaded } }) : null,
  h("span", { class: "embed-play", "aria-hidden": "true" }, icon("play"))));
  return box;
}

function inlineVideo(embed) {
  const src = proxied(embed.video);
  const poster = proxied(embed.image);
  const w = embed.video_width || embed.image_width;
  const hgt = embed.video_height || embed.image_height;
  const video = h("video", {
    src, poster, controls: true, preload: "metadata", playsinline: true, "aria-label": embed.title || t("video"),
    on: { loadedmetadata: mediaLoaded },
  });
  // Too big for the proxy (or gone): fall back to the poster and a link out.
  video.addEventListener("error", () => video.replaceWith(poster
    ? h("button", { class: "embed-image video", type: "button", title: t("play_on_site", { site: embed.site_name || t("the_site") }), on: { click: () => leavingDialog(embed.url, embed.url) } },
      h("img", { src: poster, alt: "" }), h("span", { class: "embed-play", "aria-hidden": "true" }, icon("play")))
    : h("p", { class: "muted small" }, t("video_unavailable"))), { once: true });
  return h("div", { class: "embed-video", style: fitted(w, hgt) || { width: `${MAX_W}px`, aspectRatio: "16 / 9" } }, video);
}

function card(embed, actions, message) {
  const image = proxied(embed.image);
  const thumb = proxied(embed.thumbnail);
  let media = null;
  if (embed.youtube_id) media = youtubePlayer(embed);
  else if (embed.kind === "video" && proxied(embed.video)) media = inlineVideo(embed);
  else if (image) {
    const video = embed.kind === "video"; // an older server's YouTube card: the thumbnail links out
    media = h("button", {
      class: `embed-image ${video ? "video" : ""}`, type: "button", style: fitted(embed.image_width, embed.image_height),
      title: video ? t("play_on_site", { site: embed.site_name || t("the_site") }) : t("open_image"),
      on: { click: () => (video ? leavingDialog(embed.url, embed.url) : openLightbox([{ url: embed.image, filename: embed.title || embed.site_name || "" }])) },
    }, h("img", { src: image, alt: "", loading: "lazy", decoding: "async", on: { load: mediaLoaded } }),
    video ? h("span", { class: "embed-play", "aria-hidden": "true" }, icon("play")) : null);
  }
  return h("div", {
    class: `embed ${embed.kind} ${thumb ? "has-thumb" : ""}`,
    style: embed.color ? `--embed-color:${embed.color}` : null,
  },
  h("div", { class: "embed-main" },
    embed.site_name ? link(embed.provider_url, "embed-provider", embed.site_name) : null,
    embed.author ? link(embed.author_url, "embed-author", embed.author) : null,
    embed.title ? link(embed.url, "embed-title", embed.title) : null,
    embed.description ? h("div", { class: "embed-desc" }, embed.description) : null,
    media),
  thumb ? h("button", {
    class: "embed-thumb", type: "button", "aria-label": t("open_image"),
    on: { click: () => openLightbox([{ url: embed.thumbnail, filename: embed.title || embed.site_name || "" }]) },
  }, h("img", { src: thumb, alt: "", loading: "lazy", width: THUMB, height: THUMB, on: { load: mediaLoaded } })) : null,
  suppressButton(message, actions));
}

// "Just media": the message is nothing but links that became bare images or
// GIFs, so (like Discord) the link text itself isn't shown.
export function isMediaOnly(message) {
  const embeds = message.embeds || [];
  const words = (message.content || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length || !embeds.length) return false;
  return words.every((w) => embeds.some((e) => (e.kind === "image" || e.kind === "gifv") && e.url === w));
}

export function renderEmbeds(message, actions) {
  const list = message.embeds;
  if (!list?.length) return null;
  return h("div", { class: "embeds" }, list.map((e) => {
    if (e.kind === "image") return bareImage(e, message, actions) || card(e, actions, message);
    if (e.kind === "gifv") return bareGifv(e, message, actions);
    return card(e, actions, message);
  }));
}
