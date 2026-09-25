// The Home page: what you see on Home with no conversation open (Friends
// and the other tabs have their own links in the sidebar).

import { getPrefs, setPrefs } from "../prefs.js";
import { invalidate } from "../render.js";
import {
  APP_OPENED, isIncomingRequest, isUnread, relationsOf, state, statusOf,
} from "../state.js";
import { mdContext } from "./chat.js";
import { add, h } from "./dom.js";
import { icon } from "./icons.js";
import { render as renderMarkdown } from "./markdown.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/home");

// hidden -> server name -> server address -> hidden (prefs.homeServerReveal)
const REVEAL = ["hidden", "name", "address"];

export const serverHost = () => {
  try {
    return new URL(state.url.replace(/^ws/, "http")).host;
  } catch {
    return state.url || "";
  }
};

// "5m", "2h 14m", "1d 3h" since the page was opened.
function uptime() {
  const mins = Math.floor((Date.now() - APP_OPENED) / 60000);
  if (mins < 1) return t("uptime_under_minute");
  const d = Math.floor(mins / 1440);
  const hr = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return t("uptime_days", { d, h: hr });
  if (hr) return t("uptime_hours", { h: hr, m: String(m).padStart(2, "0") });
  return t("uptime_minutes", { m });
}

// The uptime line updates on its own while the page is open.
let uptimeTimer = null;
function tickUptime(el) {
  clearInterval(uptimeTimer);
  uptimeTimer = setInterval(() => {
    if (!el.isConnected) { clearInterval(uptimeTimer); uptimeTimer = null; return; }
    el.textContent = uptime();
  }, 15000);
}

export function renderHomeHeader(header, state) {
  const about = state.homeTab === "about";
  add(header,
    h("span", { class: "hash", "aria-hidden": "true" }, icon(about ? "info" : "house")),
    h("span", { class: "title" }, about ? t("about_title") : t("title")));
}

// About this server: its name, address and the owner's description.
export function renderAboutPage(state, actions) {
  const desc = state.info?.server_description || "";
  return h("div", { class: "home-page about-page" },
    h("h1", { class: "about-name" }, state.info?.server_name || serverHost()),
    h("p", { class: "muted mono small" }, serverHost()),
    desc
      ? h("div", { class: "about-desc" }, renderMarkdown(desc, mdContext(state, actions)))
      : h("p", { class: "muted" }, t("about_empty")));
}

// The description's first paragraph, with a way to the full About page.
function aboutTeaser(state, actions) {
  const desc = (state.info?.server_description || "").trim();
  if (!desc) return null;
  const first = desc.split(/\n\s*\n/)[0];
  return h("div", { class: "home-about" },
    h("div", { class: "home-about-text" }, renderMarkdown(first, mdContext(state, actions))),
    h("button", { class: "btn link", type: "button", on: { click: () => actions.openFriends("about") } },
      first.length < desc.length ? t("read_more") : t("about_link")));
}

export function renderHomePage(state, actions) {
  const mode = REVEAL.includes(getPrefs().homeServerReveal) ? getPrefs().homeServerReveal : "hidden";
  const shown = mode === "name" ? state.info?.server_name || serverHost() : mode === "address" ? serverHost() : t("server_hidden");
  const reveal = h("button", {
    class: `server-reveal ${mode}`, type: "button",
    title: t(`reveal_${mode}_title`), "aria-label": t(`reveal_${mode}_title`),
    on: { click: () => { setPrefs({ homeServerReveal: REVEAL[(REVEAL.indexOf(mode) + 1) % REVEAL.length] }); invalidate("chat"); } },
  }, icon(mode === "hidden" ? "eye-off" : mode === "name" ? "server" : "globe"), h("span", {}, shown));

  const online = relationsOf("friend").filter((r) => statusOf(r.user.user_id) !== "offline").length;
  const guilds = [...state.guilds.values()].filter((g) => !g.ghost).length;
  const pending = relationsOf("incoming").length;
  const unreadDms = [...state.dms.values()].filter((ch) => !isIncomingRequest(ch) && isUnread(ch.channel_id)).length;
  const up = h("strong", {}, uptime());
  tickUptime(up);

  const stat = (glyph, strong, label, onClick = null) => h("li", {},
    h("span", { class: "home-stat-icon", "aria-hidden": "true" }, icon(glyph)),
    onClick
      ? h("button", { class: "btn link home-stat-link", type: "button", on: { click: onClick } }, strong, " ", label)
      : h("span", {}, strong, " ", label));

  return h("div", { class: "home-page" },
    h("h1", { class: "home-title" }, t("title_big")),
    h("p", { class: "home-welcome" }, t("welcome"), " ", reveal),
    aboutTeaser(state, actions),
    h("ul", { class: "home-stats" },
      stat("users", h("strong", {}, String(online)), t("friends_online", { count: online }), () => actions.openFriends("online")),
      stat("server", h("strong", {}, String(guilds)), t("servers_joined", { count: guilds })),
      stat("clock", up, t("uptime_label")),
      pending ? stat("user-plus", h("strong", {}, String(pending)), t("pending_requests", { count: pending }), () => actions.openFriends("pending")) : null,
      unreadDms ? stat("message-circle", h("strong", {}, String(unreadDms)), t("unread_dms", { count: unreadDms })) : null));
}
