// Attachment uploads for the composer (PROTOCOL.md §2 HTTP: POST /upload).
// Files upload as soon as they're added; the message sends their ids.

import { LIMITS } from "./protocol.js";
import { invalidate } from "./render.js";
import { state } from "./state.js";
import * as store from "./storage.js";
import { fmtBytes, serverUrl } from "./ui/dom.js";
import { toast } from "./ui/modals.js";

let seq = 0;

async function measure(file) {
  try {
    if (file.type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      const out = { width: bmp.width, height: bmp.height };
      bmp.close?.();
      return out;
    }
    if (file.type.startsWith("video/")) {
      // Some files never report metadata; don't hold the upload up for them.
      return await new Promise((resolve) => {
        setTimeout(() => resolve({}), 2000);
        const v = document.createElement("video");
        const url = URL.createObjectURL(file);
        v.preload = "metadata";
        v.onloadedmetadata = () => { resolve({ width: v.videoWidth, height: v.videoHeight }); URL.revokeObjectURL(url); };
        v.onerror = () => { resolve({}); URL.revokeObjectURL(url); };
        v.src = url;
      });
    }
  } catch { /* unknown format: no size hint */ }
  return {};
}

function setProgress(item) {
  const el = document.querySelector(`[data-upload="${item.id}"] .up-bar > i`);
  if (el) el.style.width = `${Math.round(item.progress * 100)}%`;
}

function upload(item, channelId) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ channel_id: channelId, filename: item.name });
    if (item.width) params.set("width", item.width);
    if (item.height) params.set("height", item.height);
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("POST", serverUrl(`/upload?${params}`));
    xhr.setRequestHeader("Authorization", `Bearer ${store.getToken(state.url)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) { item.progress = e.loaded / e.total; setProgress(item); }
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 200 && body.attachment) resolve(body.attachment);
      else reject(new Error(body.error?.message || `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check your connection"));
    xhr.onabort = () => reject(new Error("Cancelled"));
    xhr.send(item.file);
  });
}

export function addFiles(files) {
  const channelId = state.channelId;
  if (!channelId) return;
  const limit = state.info?.max_upload_bytes || Infinity;
  for (const file of files) {
    if (state.pending.length >= LIMITS.MAX_ATTACHMENTS) {
      toast(`You can attach at most ${LIMITS.MAX_ATTACHMENTS} files to a message.`, { error: true });
      break;
    }
    if (file.size > limit) {
      toast(`${file.name} is too large — this server allows files up to ${fmtBytes(limit)}.`, { error: true, ms: 6000 });
      continue;
    }
    if (!file.size) { toast(`${file.name} is empty.`, { error: true }); continue; }
    const item = {
      id: ++seq, file, channelId, name: file.name || "pasted-image.png", size: file.size, type: file.type,
      progress: 0, attachment: null, error: null,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    };
    state.pending.push(item);
    item.done = measure(file).then((dims) => {
      Object.assign(item, dims);
      return upload(item, channelId);
    }).then((attachment) => {
      item.attachment = attachment;
      item.progress = 1;
    }, (e) => {
      item.error = e.message;
      if (e.message !== "Cancelled") toast(`${item.name}: ${e.message}`, { error: true, ms: 6000 });
    }).finally(() => invalidate("composer"));
  }
  invalidate("composer");
}

export function removePending(id) {
  const item = state.pending.find((p) => p.id === id);
  if (!item) return;
  item.xhr?.abort();
  if (item.preview) URL.revokeObjectURL(item.preview);
  state.pending = state.pending.filter((p) => p !== item);
  invalidate("composer");
}

export function clearPending() {
  for (const item of state.pending) {
    item.xhr?.abort();
    if (item.preview) URL.revokeObjectURL(item.preview);
  }
  state.pending = [];
}

// Waits for in-flight uploads; returns the attachment ids ready to send.
export async function readyAttachments() {
  await Promise.all(state.pending.map((p) => p.done));
  const failed = state.pending.filter((p) => p.error);
  if (failed.length) throw new Error(`Remove the failed upload${failed.length > 1 ? "s" : ""} first.`);
  return state.pending.map((p) => p.attachment.attachment_id);
}

export const uploading = () => state.pending.some((p) => !p.attachment && !p.error);

// Uploads an image for an emoji, sticker, avatar, banner or icon
// (PROTOCOL.md §2 HTTP: POST /media); resolves to the Media object whose
// media_id is then passed to the WebSocket request that uses it.
export async function uploadMedia(kind, blob) {
  const cap = LIMITS.MEDIA_KINDS[kind];
  if (cap && blob.size > cap.maxBytes) {
    throw new Error(`That image is too large — at most ${fmtBytes(cap.maxBytes)} here.`);
  }
  let res;
  try {
    res = await fetch(serverUrl(`/media?kind=${encodeURIComponent(kind)}`), {
      method: "POST", body: blob, headers: { Authorization: `Bearer ${store.getToken(state.url)}` },
    });
  } catch {
    throw new Error("Upload failed — check your connection");
  }
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body.media) throw new Error(body.error?.message || `Upload failed (HTTP ${res.status})`);
  return body.media;
}
