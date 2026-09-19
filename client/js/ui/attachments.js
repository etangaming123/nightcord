// Message attachments (PROTOCOL.md §4 Attachment): inline images with a
// lightbox, playable video and audio, a viewer for text files, and a
// download card for everything else.

import { mediaLoaded } from "./chat.js";
import { add, clear, fmtBytes, h, serverUrl } from "./dom.js";
import { openModal, toast } from "./modals.js";

const TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_INLINE_W = 400;
const MAX_INLINE_H = 300;

const kind = (a) => {
  const t = a.content_type || "";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "text/plain") return "text";
  return "file";
};

function fileIcon(a) {
  const ext = (a.filename.split(".").pop() || "").toLowerCase();
  if (["zip", "rar", "7z", "tar", "gz", "xz"].includes(ext)) return "🗜️";
  if (["pdf"].includes(ext)) return "📕";
  if (kind(a) === "audio") return "🎵";
  if (kind(a) === "text") return "📄";
  return "📦";
}

// Keep the box's size before the media loads, so the chat doesn't jump.
function fitted(a) {
  if (!a.width || !a.height) return null;
  const scale = Math.min(1, MAX_INLINE_W / a.width, MAX_INLINE_H / a.height);
  return { width: `${Math.round(a.width * scale)}px`, height: `${Math.round(a.height * scale)}px` };
}

function card(a, url, { onOpen } = {}) {
  return h("div", { class: "file-card" },
    h("span", { class: "file-icon", "aria-hidden": "true" }, fileIcon(a)),
    h("span", { class: "file-meta" },
      onOpen
        ? h("button", { class: "file-name btn link", type: "button", on: { click: onOpen } }, a.filename)
        : h("a", { class: "file-name", href: url, download: a.filename, target: "_blank", rel: "noopener" }, a.filename),
      h("span", { class: "file-size" }, fmtBytes(a.size))),
    h("a", { class: "icon-btn", href: url, download: a.filename, target: "_blank", rel: "noopener", title: "Download", "aria-label": `Download ${a.filename}` }, "⤓"));
}

export function renderAttachments(message) {
  const media = (message.attachments || []).filter((a) => ["image", "video"].includes(kind(a)));
  // Pictures and videos first, then everything else, like Discord.
  const list = [...media, ...(message.attachments || []).filter((a) => !media.includes(a))];
  if (!list.length) return null;
  const images = list.filter((a) => kind(a) === "image");
  return h("div", { class: `attachments ${images.length > 1 ? "gallery" : ""}` }, list.map((a) => {
    const url = serverUrl(a.url);
    switch (kind(a)) {
      case "image":
        return h("button", {
          class: "att-image", type: "button", title: a.filename, style: images.length > 1 ? null : fitted(a),
          "aria-label": `Open image ${a.filename}`,
          on: { click: () => openLightbox(images, images.indexOf(a)) },
        }, h("img", { src: url, alt: a.filename, loading: "lazy", decoding: "async", draggable: "false", on: { load: mediaLoaded } }));
      case "video":
        return h("div", { class: "att-video", style: fitted(a) },
          h("video", { src: url, controls: true, preload: "metadata", playsinline: true, "aria-label": a.filename, on: { loadedmetadata: mediaLoaded } }));
      case "audio":
        return h("div", { class: "att-audio" }, card(a, url), h("audio", { src: url, controls: true, preload: "none" }));
      case "text":
        return card(a, url, { onOpen: () => openTextViewer(a, url) });
      default:
        return card(a, url);
    }
  }));
}

// Full-size image viewer with ← / → between a message's images.
export function openLightbox(images, index = 0) {
  let i = index;
  const img = h("img", { class: "lightbox-img", alt: "" });
  const caption = h("div", { class: "lightbox-caption" });
  const draw = () => {
    const a = images[i];
    img.src = serverUrl(a.url);
    img.alt = a.filename;
    clear(caption,
      h("span", {}, a.filename, images.length > 1 ? ` (${i + 1}/${images.length})` : ""),
      h("a", { href: serverUrl(a.url), target: "_blank", rel: "noopener", class: "btn link" }, "Open original"));
  };
  const step = (d) => { i = (i + d + images.length) % images.length; draw(); };
  const modal = openModal({
    title: "Image",
    content: h("div", { class: "lightbox" },
      images.length > 1 ? h("button", { class: "icon-btn lb-prev", type: "button", "aria-label": "Previous image", on: { click: () => step(-1) } }, "‹") : null,
      img,
      images.length > 1 ? h("button", { class: "icon-btn lb-next", type: "button", "aria-label": "Next image", on: { click: () => step(1) } }, "›") : null,
      caption),
    cls: "lightbox-modal",
  });
  modal.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  modal.tabIndex = -1;
  modal.focus();
  draw();
}

async function openTextViewer(a, url) {
  const pre = h("pre", { class: "text-viewer" }, "Loading…");
  openModal({
    title: a.filename,
    subtitle: fmtBytes(a.size),
    wide: true,
    content: pre,
    actions: [h("a", { class: "btn", href: url, download: a.filename, target: "_blank", rel: "noopener" }, "Download")],
    cls: "text-modal",
  });
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
    if (!res.ok) throw new Error(res.status === 403 ? "This link has expired; reload the channel." : `HTTP ${res.status}`);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(await res.arrayBuffer());
    const lines = text.split("\n");
    const truncated = a.size > TEXT_PREVIEW_BYTES;
    clear(pre, lines.map((line, n) => h("span", { class: "tv-line" }, h("span", { class: "tv-no", "aria-hidden": "true" }, String(n + 1)), line, "\n")));
    if (truncated) add(pre, h("span", { class: "muted" }, "\n… (download to see the rest)"));
  } catch (e) {
    clear(pre, e.message);
    toast(e.message, { error: true });
  }
}
