// Link previews (PROTOCOL.md §4 Embed). Everything here is server-supplied
// text and server-hosted images: an embed's image URLs always point back at
// the Nightcord server's /proxy route, never at the site being previewed, so
// opening a channel never tells that site who is reading.

import { $, h, serverUrl } from "./dom.js";
import { leavingDialog } from "./links.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/embeds");

// An embed image is a server path (/proxy/…); anything else is ignored.
const proxied = (path) => (typeof path === "string" && path.startsWith("/proxy/") ? serverUrl(path) : null);

function openLink(url) {
  leavingDialog(url, url);
}

function card(embed, actions, message) {
  const site = embed.site_name || null;
  const image = proxied(embed.image);
  const thumb = proxied(embed.thumbnail);
  const canSuppress = actions?.canSuppressEmbeds?.(message);
  const title = embed.title
    ? h("button", {
      class: "embed-title", type: "button",
      on: { click: () => openLink(embed.url) },
    }, embed.title)
    : null;
  const media = image
    ? h("button", {
      class: `embed-image ${embed.kind === "video" ? "video" : ""}`, type: "button",
      title: embed.kind === "video" ? t("play_on_site", { site: site || t("the_site") }) : t("open_image"),
      on: { click: () => openLink(embed.url) },
    }, h("img", { src: image, alt: "", loading: "lazy", decoding: "async" }),
    embed.kind === "video" ? h("span", { class: "embed-play", "aria-hidden": "true" }, "▶") : null)
    : null;
  return h("div", {
    class: `embed ${embed.kind}`,
    style: embed.color ? `--embed-color:${embed.color}` : null,
  },
  h("div", { class: "embed-main" },
    site ? h("div", { class: "embed-site" }, site) : null,
    title,
    embed.description ? h("div", { class: "embed-desc" }, embed.description) : null,
    embed.author ? h("div", { class: "embed-author muted small" }, embed.author) : null),
  thumb ? h("img", { class: "embed-thumb", src: thumb, alt: "", loading: "lazy" }) : null,
  media,
  canSuppress
    ? h("button", {
      class: "embed-x", type: "button", title: t("hide_previews"), "aria-label": t("hide_previews"),
      on: { click: () => actions.suppressEmbeds(message) },
    }, "✕")
    : null);
}

export function renderEmbeds(message, actions) {
  const list = message.embeds;
  if (!list?.length) return null;
  return h("div", { class: "embeds" }, list.map((e) => card(e, actions, message)));
}

// Images inside embeds load late; keep a bottom-pinned chat pinned.
export function watchEmbedImages(onLoad) {
  $("#messages")?.addEventListener("load", (e) => {
    if (e.target?.tagName === "IMG" && e.target.closest(".embed")) onLoad();
  }, true);
}
