// Touch gestures for phones, Discord-mobile style:
//  - long-press a message: its action sheet (with a little buzz)
//  - swipe a message left: reply to it
//  - swipe right: the channel list; swipe in from the right edge: members
//  - swipe an open drawer back the way it came to close it
// Only touch events are handled, so mice and trackpads never see any of this.

import { state } from "../state.js";
import { $, h } from "./dom.js";
import { icon } from "./icons.js";
import { fullscreenOpen, modalOpen, popoverOpen, sheetOpen } from "./modals.js";
import { messageAbilities, messageSheet } from "./messageMenu.js";

const LONG_PRESS_MS = 450;
const SLOP_PX = 10; // finger wobble that still counts as holding still
const REPLY_PX = 60; // how far a message slides before letting go replies
const REPLY_MAX_PX = 90;
const DRAWER_PX = 60; // how far a swipe travels to open or close a drawer
const EDGE_PX = 32; // the right-edge strip that pulls the member list in

const navIsDrawer = () => matchMedia("(max-width: 720px)").matches;
const membersIsDrawer = () => matchMedia("(max-width: 1100px)").matches;

// Something scrollable sideways (a code block, a wide table) keeps its swipes.
function scrollsSideways(el, stop) {
  for (; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

export function setupGestures(actions) {
  const app = $("#app");
  let g = null;

  const reset = () => {
    if (!g) return;
    clearTimeout(g.timer);
    if (g.mode === "reply" && g.msgEl) {
      g.msgEl.classList.remove("swiping", "swipe-ready");
      g.msgEl.style.transform = "";
      g.icon?.remove();
    }
    g = null;
  };

  app.addEventListener("touchstart", (e) => {
    reset();
    if (e.touches.length !== 1 || modalOpen() || popoverOpen() || fullscreenOpen() || sheetOpen()) return;
    const { clientX: x, clientY: y } = e.touches[0];
    const msgEl = e.target.closest("#messages .msg[data-id]:not(.msg-blocked):not(.editing)");
    const msg = msgEl && !e.target.closest("input, textarea, video, audio")
      ? state.messages.find((m) => m.message_id === msgEl.dataset.id) : null;
    g = { x, y, dx: 0, msgEl: msg ? msgEl : null, msg, mode: null, fired: false, target: e.target };
    if (msg) {
      g.timer = setTimeout(() => {
        if (!g || g.mode) return;
        g.fired = true;
        navigator.vibrate?.(10);
        window.getSelection()?.removeAllRanges();
        messageSheet(msg, actions);
      }, LONG_PRESS_MS);
    }
  }, { passive: true });

  app.addEventListener("touchmove", (e) => {
    if (!g || g.fired) return;
    const dx = e.touches[0].clientX - g.x;
    const dy = e.touches[0].clientY - g.y;
    g.dx = dx;
    if (!g.mode) {
      if (Math.hypot(dx, dy) < SLOP_PX) return;
      clearTimeout(g.timer);
      g.mode = "none";
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || scrollsSideways(g.target, app)) return;
      const navOpen = app.classList.contains("nav-open");
      const membersOpen = app.classList.contains("members-open");
      if (navOpen) g.mode = dx < 0 ? "close-nav" : "none";
      else if (membersOpen) g.mode = dx > 0 ? "close-members" : "none";
      else if (dx > 0 && navIsDrawer()) g.mode = "nav";
      else if (dx < 0 && g.x > window.innerWidth - EDGE_PX && membersIsDrawer() && $("#chat-header .members-btn")) g.mode = "members";
      else if (dx < 0 && g.msg && messageAbilities(g.msg, actions).reply) {
        g.mode = "reply";
        g.icon = h("span", { class: "swipe-reply-icon", "aria-hidden": "true" }, icon("reply"));
        g.msgEl.append(g.icon);
        g.msgEl.classList.add("swiping");
      }
    }
    if (g.mode === "none") return;
    e.preventDefault(); // a sideways gesture, not a scroll
    if (g.mode === "reply") {
      const off = Math.max(-REPLY_MAX_PX, Math.min(0, dx));
      g.msgEl.style.transform = `translateX(${off}px)`;
      g.msgEl.classList.toggle("swipe-ready", off <= -REPLY_PX);
    }
  }, { passive: false });

  const end = (e) => {
    if (!g) return;
    const { mode, dx, msg, fired } = g;
    // The long-press already did its thing; don't let the lift click too.
    if (fired && e.cancelable) e.preventDefault();
    reset();
    if (mode === "reply" && dx <= -REPLY_PX) {
      navigator.vibrate?.(5);
      actions.reply(msg);
    } else if (mode === "nav" && dx > DRAWER_PX) actions.toggleNav(true);
    else if (mode === "close-nav" && dx < -DRAWER_PX) actions.toggleNav(false);
    else if (mode === "members" && dx < -DRAWER_PX) actions.toggleMembers();
    else if (mode === "close-members" && dx > DRAWER_PX) actions.toggleMembers();
  };
  app.addEventListener("touchend", end);
  app.addEventListener("touchcancel", reset);
}
