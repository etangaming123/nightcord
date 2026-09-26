// The preview: the whole client, talking to a pretend server that lives in
// this tab (./server.js). Loaded only when someone picks "Try a preview", and
// left out of the standalone build.
//
// PreviewConnection has the same shape as connection.js's Connection (open,
// request, on, close, isOpen, plus its events), so main.js, actions.js and
// events.js run unchanged. Uploads and image URLs, which normally go over
// HTTP, are answered here too: uploads become blob: URLs and images are
// data: URLs (resolveUrl).

import { NightcordError } from "../connection.js";
import { ERR, LIMITS, PERMS } from "../protocol.js";
import { Activity } from "./activity.js";
import registerAccount from "./handlers/account.js";
import registerAdmin from "./handlers/admin.js";
import registerChat from "./handlers/chat.js";
import registerGuilds from "./handlers/guilds.js";
import { MEMBER, OWNER, buildServer } from "./seed.js";
import { PreviewError, newId } from "./server.js";

export const ACCOUNTS = { owner: OWNER, member: MEMBER };

// A believable round trip, so loading states and spinners still show.
const latency = () => 40 + Math.random() * 80;

const toError = (e) => (e instanceof PreviewError
  ? new NightcordError(e.code, e.message, { code: e.code, message: e.message, ...e.data })
  : new NightcordError(ERR.INTERNAL_ERROR, e?.message || "Something went wrong in the preview."));

class PreviewConnection extends EventTarget {
  constructor(server) {
    super();
    this.server = server;
    this.preview = true;
    this.open_ = false;
  }

  open() {
    this.open_ = true;
    this.server.sink = (type, payload) => this.#emit(type, payload);
    return Promise.resolve();
  }

  close() {
    this.open_ = false;
    if (this.server.sink && this.server.connection === this) this.server.sink = null;
  }

  get isOpen() { return this.open_; }

  on(type, fn) {
    const handler = (e) => fn(e.detail);
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  #emit(type, detail) {
    if (!this.open_) return;
    // Copies, like a real network would make: the client mutates what it gets.
    this.dispatchEvent(new CustomEvent(type, { detail: structuredClone(detail) }));
  }

  // Events a request causes arrive before its result, as they do from the
  // real server (it fans out, then answers).
  request(type, payload = {}) {
    if (!this.open_) return Promise.reject(new NightcordError(ERR.DISCONNECTED, "Not connected."));
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const events = [];
        const sink = this.server.sink;
        this.server.sink = (t, p) => events.push([t, structuredClone(p)]);
        let result;
        let error;
        try {
          result = structuredClone(this.server.handle(type, structuredClone(payload)));
        } catch (e) {
          error = e;
          if (!(e instanceof PreviewError)) console.error("[preview]", type, e);
        } finally {
          this.server.sink = sink;
        }
        for (const [t, p] of events) this.#emit(t, p);
        if (error) reject(toError(error));
        else resolve(result);
      }, latency());
    });
  }

  // POST /upload, in memory. onProgress(0..1) fakes a short upload.
  async upload(file, { channelId, filename, width, height }, onProgress) {
    const s = this.server;
    const ch = s.channels.get(channelId);
    const need = PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES | PERMS.ATTACH_FILES;
    if (!ch || (s.channelPerms(s.me, ch) & need) !== need) throw new Error("You can't upload files here.");
    if (s.isMuted(s.me)) throw new Error("You're muted on this server.");
    if (file.size > s.config.max_upload_bytes) throw new Error("That file is too big.");
    for (let p = 0.2; p < 1; p += 0.2) {
      await new Promise((r) => setTimeout(r, 60 + Math.random() * 60));
      onProgress?.(p);
    }
    const id = newId();
    const name = String(filename || file.name || "file").slice(0, 128);
    const attachment = {
      attachment_id: id, filename: name, content_type: file.type || "application/octet-stream", size: file.size,
      width: width ? Number(width) : null, height: height ? Number(height) : null,
      url: `/files/${id}/${encodeURIComponent(name)}`, user_id: s.me, channel_id: channelId, claimed: false,
      blobUrl: URL.createObjectURL(file),
    };
    s.attachments.set(id, attachment);
    return s.serializeAttachment(attachment);
  }

  // POST /media, in memory.
  async uploadMedia(kind, blob) {
    const cap = LIMITS.MEDIA_KINDS[kind];
    if (!cap) throw new Error("Unknown image kind.");
    if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) throw new Error("PNG, JPEG, GIF or WebP only.");
    let width = 128;
    let height = 128;
    try {
      const bmp = await createImageBitmap(blob);
      width = bmp.width;
      height = bmp.height;
      bmp.close?.();
    } catch { /* keep the guess */ }
    await new Promise((r) => setTimeout(r, latency()));
    const media = this.server.addMedia(kind, {
      url: URL.createObjectURL(blob), content_type: blob.type, size: blob.size, width, height, animated: blob.type === "image/gif",
    });
    const { url: _u, claimed: _c, created_at: _t, ...out } = media;
    return out;
  }
}

// One preview per page. `connect()` gives a fresh connection to the same
// pretend server (switching accounts reconnects, like the real client does).
export function createPreview() {
  const server = buildServer();
  registerAccount(server);
  registerGuilds(server);
  registerChat(server);
  registerAdmin(server);
  const activity = new Activity(server);

  // Paths the client would fetch from the server's https origin.
  const resolveUrl = (path) => {
    const [, kind, id] = /^\/(media|files|proxy\/preview|avatars)\/([^/?]+)/.exec(path) || [];
    if (kind === "media" || kind === "avatars") return server.media.get(id)?.url || null;
    if (kind === "files") return server.attachments.get(id)?.blobUrl || null;
    if (kind === "proxy/preview") return server.proxyImage(id);
    return null;
  };

  // A logged-in session per sample account, so the account switcher can hop
  // between owner and member without a password.
  const sessionFor = (role) => {
    const user = server.userByName(ACCOUNTS[role].username);
    const token = `preview-${newId()}`;
    const id = newId();
    server.sessions.set(id, {
      session_id: id, user_id: user.user_id, token, created_at: Date.now(), last_seen: Date.now(),
      user_agent: globalThis.navigator?.userAgent || "Nightcord preview", device_id: "preview-device", ip: "127.0.0.1",
    });
    return { token, user: server.selfUser(user.user_id) };
  };

  return {
    server,
    activity,
    resolveUrl,
    sessionFor,
    connect() {
      const conn = new PreviewConnection(server);
      server.connection = conn;
      return conn;
    },
  };
}
