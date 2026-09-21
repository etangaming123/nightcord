// Crop-before-upload for avatars, banners and guild images. Drag to pan,
// slider to zoom; the canvas viewport *is* the crop, so what you see is what
// gets uploaded (PROTOCOL.md §2 HTTP, §4 Limits).
//
// Cropping re-encodes on a canvas, which keeps only the first frame, so
// animated files get a "Keep animation" button that uploads them untouched.

import { LIMITS } from "../protocol.js";
import { h } from "./dom.js";
import { SHAPES, encode } from "./images.js";
import { closeModal, openModal } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/cropper");
const tc = scopedT("common");

const VIEW_W = 380; // the crop box on screen; the output is `kind`'s own size
const MAX_ZOOM = 4;
const MAYBE_ANIMATED = new Set(["image/gif", "image/webp", "image/apng", "image/png"]);

// Opens the cropper for `file`. Resolves to a Blob to upload, or null if the
// person backed out. Kinds that aren't cropped to a fixed box resolve at once.
export function cropImage(file, kind, { allowAnimated = false } = {}) {
  const shape = SHAPES[kind];
  if (!shape || shape.fit !== "cover") return Promise.resolve(file);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    createImageBitmap(file).then((bitmap) => {
      openCropper(bitmap, file, kind, shape, allowAnimated, finish);
    }).catch(() => finish(file)); // unreadable here: let the upload path report it
  });
}

function openCropper(bitmap, file, kind, shape, allowAnimated, finish) {
  const viewW = Math.min(VIEW_W, shape.w);
  const viewH = Math.round(viewW * shape.h / shape.w);
  const canvas = h("canvas", { width: viewW, height: viewH, class: "cropper-canvas", title: t("drag_to_move") });
  const ctx = canvas.getContext("2d");
  const zoom = h("input", { type: "range", min: "1", max: String(MAX_ZOOM), step: "0.01", value: "1", class: "cropper-zoom", "aria-label": t("zoom_aria") });

  const min = Math.max(viewW / bitmap.width, viewH / bitmap.height);
  let scale = min;
  let x = (viewW - bitmap.width * scale) / 2;
  let y = (viewH - bitmap.height * scale) / 2;

  const clamp = () => {
    x = Math.min(0, Math.max(viewW - bitmap.width * scale, x));
    y = Math.min(0, Math.max(viewH - bitmap.height * scale, y));
  };
  const draw = () => {
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.drawImage(bitmap, x, y, bitmap.width * scale, bitmap.height * scale);
  };

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    x += e.clientX - lastX;
    y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    clamp();
    draw();
  });
  for (const ev of ["pointerup", "pointercancel"]) canvas.addEventListener(ev, () => { dragging = false; });
  // Zooming keeps whatever sits in the middle of the box in the middle.
  const zoomTo = (factor) => {
    const next = min * Math.min(MAX_ZOOM, Math.max(1, factor));
    const cx = viewW / 2;
    const cy = viewH / 2;
    x = cx - ((cx - x) / scale) * next;
    y = cy - ((cy - y) / scale) * next;
    scale = next;
    clamp();
    draw();
  };
  zoom.addEventListener("input", () => zoomTo(Number(zoom.value)));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const next = Math.min(MAX_ZOOM, Math.max(1, scale / min * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    zoom.value = String(next);
    zoomTo(next);
  }, { passive: false });

  const apply = h("button", { class: "btn primary", type: "button" }, t("apply"));
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    const out = h("canvas", { width: shape.w, height: shape.h });
    const r = shape.w / viewW;
    out.getContext("2d").drawImage(bitmap, x * r, y * r, bitmap.width * scale * r, bitmap.height * scale * r);
    try {
      const blob = await encode(out, LIMITS.MEDIA_KINDS[kind].maxBytes);
      bitmap.close?.();
      closeModal();
      finish(blob);
    } catch (e) {
      apply.disabled = false;
      finish(null);
      closeModal();
      throw e;
    }
  });
  const keep = allowAnimated && MAYBE_ANIMATED.has(file.type)
    ? h("button", { class: "btn", type: "button", title: t("keep_animation_title") }, t("keep_animation"))
    : null;
  keep?.addEventListener("click", () => { bitmap.close?.(); closeModal(); finish(file); });

  openModal({
    title: t("crop_image_title"),
    subtitle: keep ? t("crop_subtitle_with_keep") : t("crop_subtitle"),
    content: h("div", { class: "cropper" }, h("div", { class: "cropper-stage" }, canvas), zoom),
    actions: [
      h("button", { class: "btn", type: "button", on: { click: () => { bitmap.close?.(); closeModal(); finish(null); } } }, tc("cancel")),
      keep,
      apply,
    ].filter(Boolean),
    onClose: () => { bitmap.close?.(); finish(null); },
  });
  draw();
}
