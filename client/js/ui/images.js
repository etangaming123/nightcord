// Preparing images for POST /media (PROTOCOL.md §2 HTTP, §4 Limits).
//
// Still images are resized and re-encoded on a canvas. GIFs, WebPs and PNGs
// that already fit are uploaded untouched so animation survives (a canvas
// only keeps the first frame).

import { LIMITS } from "../protocol.js";
import { uploadMedia } from "../uploads.js";

// kind -> how to fit: "cover" crops to the box's aspect ratio, "contain" fits inside it.
const SHAPES = {
  avatar: { w: 256, h: 256, fit: "cover" },
  guild_icon: { w: 256, h: 256, fit: "cover" },
  banner: { w: 960, h: 384, fit: "cover" },
  guild_banner: { w: 960, h: 540, fit: "cover" },
  emoji: { w: 128, h: 128, fit: "contain" },
  sticker: { w: 320, h: 320, fit: "contain" },
  role_icon: { w: 64, h: 64, fit: "contain" },
};

const KEEPS_ANIMATION = new Set(["image/gif", "image/webp", "image/png"]);

async function encode(canvas, maxBytes) {
  const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
  for (const type of ["image/webp", "image/png", "image/jpeg"]) {
    for (const q of [0.92, 0.8, 0.65, 0.5]) {
      const blob = await toBlob(type, q);
      if (!blob || blob.type !== type) break; // this browser can't encode it
      if (blob.size <= maxBytes) return blob;
      if (type === "image/png") break; // quality doesn't apply
    }
  }
  throw new Error("Couldn't shrink that image enough; try a smaller one.");
}

// Returns a Blob ready to upload for `kind`.
// still: always re-encode on a canvas (drops animation).
export async function prepareImage(file, kind, { still = false } = {}) {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error("Pick a PNG, JPEG, GIF or WebP image.");
  }
  const shape = SHAPES[kind];
  const cap = LIMITS.MEDIA_KINDS[kind];
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be read.");
  }
  const { width, height } = bitmap;
  const maxDim = cap.maxDim || Infinity;
  if (!still && KEEPS_ANIMATION.has(file.type) && file.size <= cap.maxBytes && width <= maxDim && height <= maxDim) {
    // Already small enough: keep the original bytes (and any animation).
    // Still images bigger than the box are resized anyway, to save space.
    if (file.type === "image/gif" || (width <= shape.w * 2 && height <= shape.h * 2)) {
      bitmap.close?.();
      return file;
    }
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (shape.fit === "cover") {
    canvas.width = shape.w;
    canvas.height = shape.h;
    const scale = Math.max(shape.w / width, shape.h / height);
    const sw = shape.w / scale;
    const sh = shape.h / scale;
    ctx.drawImage(bitmap, (width - sw) / 2, (height - sh) / 2, sw, sh, 0, 0, shape.w, shape.h);
  } else {
    const scale = Math.min(1, shape.w / width, shape.h / height);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  bitmap.close?.();
  return encode(canvas, cap.maxBytes);
}

// Prepares and uploads; resolves to the Media object.
export async function uploadImage(file, kind, opts = {}) {
  return uploadMedia(kind, await prepareImage(file, kind, opts));
}

// Opens a file picker for one image.
export function pickImage(onFile) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp";
  input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); });
  input.click();
}
