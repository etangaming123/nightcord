// Modal dialogs, popovers/menus, full-screen settings pages and toasts.
// No window.alert/confirm/prompt anywhere.

import { $, add, clear, h } from "./dom.js";
import { hasIcon, icon } from "./icons.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/modals");
const tc = scopedT("common");

let current = null;

export function closeModal() {
  if (!current) return;
  current.backdrop.remove();
  document.removeEventListener("keydown", current.onKey, true);
  current.restoreFocus?.focus?.();
  current = null;
}

export const modalOpen = () => !!current;

// content: Node or array of Nodes. Returns the modal element.
// dismissable: false keeps it open on Escape / backdrop clicks (a decision is required).
export function openModal({ title, subtitle, content, actions = [], onClose, wide = false, dismissable = true, cls = "" }) {
  closeModal();
  closePopover();
  const modal = h(
    "div",
    { class: `modal ${wide ? "wide" : ""} ${cls}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("h2", {}, title),
    subtitle ? h("p", { class: "sub" }, subtitle) : null,
    content,
    actions.length ? h("div", { class: "actions" }, actions) : null,
  );
  const backdrop = h("div", {
    class: "modal-backdrop",
    on: { mousedown: (e) => { if (dismissable && e.target === backdrop) { closeModal(); onClose?.(); } } },
  }, modal);
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); if (dismissable) { closeModal(); onClose?.(); } }
  };
  document.addEventListener("keydown", onKey, true);
  current = { backdrop, onKey, restoreFocus: document.activeElement };
  $("#modal-root").append(backdrop);
  // First field to fill in, else the button that says yes (so Enter confirms).
  const first = modal.querySelector("input:not([type=checkbox]), textarea, select, button.primary, button[type=submit]");
  (first || modal).focus?.();
  return modal;
}

// A form modal. onSubmit(formData, form) may throw/reject to show an error
// inline; resolve to close (or resolve `false` to keep it open).
export function formModal({ title, subtitle, fields, submitLabel, danger = false, onSubmit, wide = false }) {
  submitLabel ??= tc("save");
  const error = h("div", { class: "error-box", hidden: true });
  const submit = h("button", { type: "submit", class: `btn ${danger ? "danger" : "primary"}` }, submitLabel);
  const form = h("form", { class: "stack", id: "modal-form" }, fields, error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      if ((await onSubmit(new FormData(form), form)) !== false) closeModal();
    } catch (err) {
      error.textContent = err.message || String(err);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  submit.setAttribute("form", "modal-form");
  return openModal({
    title,
    subtitle,
    wide,
    content: form,
    actions: [h("button", { type: "button", class: "btn", on: { click: closeModal } }, tc("cancel")), submit],
  });
}

// code: true adds a random 4-digit number that has to be typed back before
// the button works — for things that can't be undone (deleting a guild or an
// account). Otherwise Enter on the focused button is enough.
export function confirmModal({ title, message, confirmLabel, danger = true, onConfirm, fields = [], code = false }) {
  confirmLabel ??= tc("confirm");
  if (!code) return formModal({ title, subtitle: message, fields, submitLabel: confirmLabel, danger, onSubmit: onConfirm });
  const wanted = String(Math.floor(1000 + Math.random() * 9000));
  const input = h("input", {
    name: "confirm_code", inputmode: "numeric", autocomplete: "off", spellcheck: "false",
    maxLength: 4, class: "mono code-input", "aria-label": t("type_code_aria", { code: wanted }),
  });
  const field = h("label", {},
    t("type_code_label"), h("span", { class: "code-display inline" }, wanted), input);
  const modal = formModal({
    title,
    subtitle: message,
    fields: [...fields, field],
    submitLabel: confirmLabel,
    danger,
    onSubmit: (fd, form) => {
      if (input.value.trim() !== wanted) throw new Error(t("code_mismatch"));
      return onConfirm(fd, form);
    },
  });
  const submit = modal.querySelector("button[type=submit]");
  submit.disabled = true;
  input.addEventListener("input", () => { submit.disabled = input.value.trim() !== wanted; });
  input.focus();
  return modal;
}

// Shift+click skips the question, the way deleting a message already does.
export function confirmAction(event, opts) {
  if (!event?.shiftKey) return confirmModal(opts);
  Promise.resolve(opts.onConfirm()).catch((e) => toast(e.message || String(e), { error: true }));
  return null;
}

// --- popovers & menus ------------------------------------------------------

// Popovers form a stack: one opened from inside another (Friend ▾ inside a
// profile card, ⋯ inside the account switcher) sits on top of its parent
// instead of replacing it. A `key` makes a trigger toggle: clicking it again
// while its own popover is open closes it rather than reopening it.
let stack = [];
let wired = false;

function unwire() {
  if (!wired) return;
  document.removeEventListener("mousedown", onDocDown, true);
  document.removeEventListener("keydown", onDocKey, true);
  window.removeEventListener("resize", onDocResize);
  wired = false;
}

// depth 0 closes everything; depth n keeps the bottom n levels.
export function closePopover(depth = 0) {
  while (stack.length > depth) {
    const p = stack.pop();
    p.el.remove();
    p.onClose?.();
  }
  if (!stack.length) unwire();
}

export const popoverOpen = () => stack.length > 0;

// The deepest level that should survive a click on `node`: a level survives
// when the click landed inside it or on the trigger that opened a level above.
function keepLevel(node) {
  let keep = 0;
  for (let i = 0; i < stack.length; i++) {
    if (stack[i].el.contains(node) || stack[i].anchor?.contains?.(node)) keep = i + 1;
  }
  return keep;
}

function onDocDown(e) {
  const keep = keepLevel(e.target);
  if (keep < stack.length) closePopover(keep);
}

function onDocKey(e) {
  if (e.key !== "Escape" || !stack.length) return;
  e.stopPropagation();
  closePopover(stack.length - 1);
}

const onDocResize = () => closePopover();

// anchor: an element, or {x, y} (e.g. a contextmenu event position).
// key: identifies the trigger, so clicking it again closes its popover.
// Returns the popover element, or null when the call toggled one shut.
export function openPopover(anchor, content, { cls = "", placement = "right", onClose, key = null } = {}) {
  if (key) {
    const open = stack.findIndex((p) => p.key === key);
    if (open >= 0) { closePopover(open); return null; }
  }
  const anchorEl = anchor instanceof Element ? anchor : null;
  // Opened from inside another popover: stack on top of it. Anything else
  // replaces whatever was open.
  let parent = 0;
  for (let i = 0; i < stack.length; i++) if (anchorEl && stack[i].el.contains(anchorEl)) parent = i + 1;
  closePopover(parent);
  const el = h("div", { class: `popover ${cls}`, role: "dialog" }, content);
  $("#popover-root").append(el);
  const place = () => {
    const r = anchorEl ? anchorEl.getBoundingClientRect()
      : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x;
    let y;
    if (placement === "top") { x = r.left; y = r.top - hgt - 8; }
    else if (placement === "bottom") { x = r.left; y = r.bottom + 8; }
    else if (placement === "left") { x = r.left - w - 8; y = r.top; }
    else { x = r.right + 8; y = r.top; }
    if (placement === "right" && x + w > vw - 8) x = r.left - w - 8;
    if (placement === "top" && y < 8) y = r.bottom + 8;
    x = Math.max(8, Math.min(x, vw - w - 8));
    y = Math.max(8, Math.min(y, vh - hgt - 8));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  place();
  if (!wired) {
    // setTimeout: the click that opened this popover must not close it again.
    setTimeout(() => {
      if (stack.length) document.addEventListener("mousedown", onDocDown, true);
    });
    document.addEventListener("keydown", onDocKey, true);
    window.addEventListener("resize", onDocResize);
    wired = true;
  }
  stack.push({ el, anchor: anchorEl, key, onClose, place });
  return el;
}

export const repositionPopover = () => stack[stack.length - 1]?.place();

// items: [{ label, onClick, danger?, checked?, disabled?, hint? } | "-" | { heading }]
// close: shuts whatever the list sits in before the item runs.
function menuList(items, close) {
  const list = h("div", { class: "menu", role: "menu" });
  let sep = false;
  for (const item of items) {
    if (!item) continue;
    // No separator first, last or twice in a row when items around it drop out.
    if (item === "-") { sep = list.childElementCount > 0; continue; }
    if (sep) { add(list, h("div", { class: "menu-sep", role: "separator" })); sep = false; }
    if (item.heading) { add(list, h("div", { class: "menu-heading" }, item.heading)); continue; }
    add(list, h("button", {
      class: `menu-item ${item.danger ? "danger" : ""}`, type: "button", role: "menuitem",
      disabled: item.disabled,
      on: { click: (e) => { close(); item.onClick?.(e); } },
    },
    item.icon ? h("span", { class: "menu-icon", "aria-hidden": "true" }, hasIcon(item.icon) ? icon(item.icon) : item.icon) : null,
    h("span", { class: "menu-label" }, item.label),
    item.checked !== undefined ? h("span", { class: "menu-check", "aria-hidden": "true" }, item.checked ? icon("status-online") : icon("status-invisible")) : null,
    item.hint ? h("span", { class: "menu-hint" }, item.hint) : null));
  }
  return list;
}

export function openMenu(anchor, items, opts = {}) {
  const list = menuList(items, () => closePopover());
  const el = openPopover(anchor, list, { placement: "bottom", ...opts, cls: `menu-pop ${opts.cls || ""}` });
  if (!el) return null;
  el.querySelector(".menu-item:not([disabled])")?.focus();
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = [...list.querySelectorAll(".menu-item:not([disabled])")];
    const i = btns.indexOf(document.activeElement);
    btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
  });
  return el;
}

// --- bottom sheets (touch) ----------------------------------------------------
// What a long-press opens on a phone: a panel that slides up from the bottom,
// Discord-mobile style. Closes on the scrim, a drag down, Escape or Back.

let sheet = null;
const SHEET_DRAG_CLOSE_PX = 80;

export const sheetOpen = () => !!sheet;

export function closeSheet() {
  if (!sheet) return;
  const { el, onKey, onClose } = sheet;
  sheet = null;
  overlayListener("sheet", false);
  document.removeEventListener("keydown", onKey, true);
  el.classList.remove("open");
  const gone = () => el.remove();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) gone();
  else { el.addEventListener("transitionend", gone, { once: true }); setTimeout(gone, 300); }
  onClose?.();
}

// top: an optional row above the items (e.g. quick reactions).
export function openSheet({ label, top = null, items = [], onClose } = {}) {
  closeSheet();
  closePopover();
  const panel = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": label },
    h("div", { class: "sheet-handle", "aria-hidden": "true" }),
    top,
    menuList(items, closeSheet));
  const el = h("div", { class: "sheet-root", on: { click: (e) => { if (e.target === el) closeSheet(); } } }, panel);
  // Drag the panel down to dismiss it (only from its top, so lists can scroll).
  let startY = null;
  panel.addEventListener("touchstart", (e) => {
    startY = panel.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = Math.max(0, e.touches[0].clientY - startY);
    panel.style.transform = dy ? `translateY(${dy}px)` : "";
  }, { passive: true });
  panel.addEventListener("touchend", (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    panel.style.transform = "";
    if (dy > SHEET_DRAG_CLOSE_PX) closeSheet();
  });
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); } };
  document.addEventListener("keydown", onKey, true);
  sheet = { el, onKey, onClose };
  $("#popover-root").append(el);
  overlayListener("sheet", true);
  void el.offsetHeight; // lay it out closed first, so opening slides
  el.classList.add("open");
  return panel;
}

// --- full-screen pages (User Settings, Guild Settings, …) ---------------------

let page = null;

// router.js follows settings pages and the sheet, so they get an address
// and Back closes them. Set from there to keep modals.js import-free of it.
let overlayListener = () => {};
export const setOverlayListener = (fn) => { overlayListener = fn; };

// reopening: another page is replacing this one, so it isn't really closing.
export function closeFullscreen({ reopening = false } = {}) {
  if (!page) return;
  page.el.remove();
  document.removeEventListener("keydown", page.onKey);
  page.onClose?.();
  page = null;
  if (reopening !== true) overlayListener("fullscreen", null);
}

// sections: [{ id, label, render(container) } | { heading } | { label, onClick, danger }]
// route: what router.js puts in the address, e.g. { kind: "settings" }; the
// open section is added to it.
export function openFullscreen({ sections, initial, onClose, title, route = null }) {
  closeFullscreen({ reopening: true });
  closePopover();
  const nav = h("nav", { class: "fs-nav", "aria-label": title });
  const body = h("div", { class: "fs-body" });
  const content = h("div", { class: "fs-content" });
  add(body, content);
  const el = h("div", { class: "fullscreen", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "fs-side" }, nav),
    h("div", { class: "fs-main" },
      body,
      h("button", { class: "fs-close", type: "button", title: t("close_esc_title"), "aria-label": tc("close"), on: { click: closeFullscreen } }, icon("x"))));
  let active = null;
  // Named form controls the user has touched since this section was drawn.
  // A re-render (an upload finishing, an event arriving) must not wipe them.
  let touched = new Set();
  content.addEventListener("input", (e) => {
    const name = e.target?.name;
    if (name) touched.add(name);
  }, true);
  const snapshot = () => {
    const out = [];
    for (const name of touched) {
      for (const field of content.querySelectorAll(`[name="${CSS.escape(name)}"]`)) {
        if (field.type === "file" || field.type === "password") continue;
        out.push([name, field.type === "checkbox" || field.type === "radio" ? field.checked : field.value, field.value]);
      }
    }
    return out;
  };
  const restore = (saved) => {
    for (const [name, value, raw] of saved) {
      const fields = [...content.querySelectorAll(`[name="${CSS.escape(name)}"]`)];
      const field = fields.length > 1 ? fields.find((f) => f.value === raw) : fields[0];
      if (!field) continue;
      if (field.type === "checkbox" || field.type === "radio") field.checked = value;
      else field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  const show = (id, { keepEdits = false } = {}) => {
    // sections may hold nulls (an entry that doesn't apply to this build/role).
    const section = sections.find((s) => s?.id === id);
    if (!section) return;
    const saved = keepEdits && id === active ? snapshot() : null;
    if (!saved) touched = new Set();
    active = id;
    for (const btn of nav.querySelectorAll(".fs-tab")) btn.setAttribute("aria-current", btn.dataset.id === id ? "page" : "false");
    clear(content, h("h2", { class: "fs-title" }, section.title || section.label));
    const inner = h("div", { class: "fs-section" });
    add(content, inner);
    el.classList.remove("nav-open");
    if (route) overlayListener("fullscreen", { ...route, section: id });
    Promise.resolve(section.render(inner, { show })).then(
      () => saved && restore(saved),
      (e) => add(inner, h("div", { class: "error-box" }, e.message || String(e))),
    );
    if (!saved) body.scrollTop = 0;
  };
  for (const s of sections) {
    if (!s) continue;
    if (s.heading) add(nav, h("div", { class: "fs-heading" }, s.heading));
    else if (s.id) {
      add(nav, h("button", {
        class: "fs-tab", type: "button", dataset: { id: s.id },
        on: { click: () => show(s.id) },
      }, s.label, s.badge ? h("span", { class: "badge" }, String(s.badge)) : null));
    } else if (s.separator) add(nav, h("div", { class: "fs-sep" }));
    else {
      add(nav, h("button", { class: `fs-tab ${s.danger ? "danger" : ""}`, type: "button", on: { click: s.onClick } }, s.label));
    }
  }
  const onKey = (e) => {
    if (e.key === "Escape" && !modalOpen() && !popoverOpen()) closeFullscreen();
  };
  document.addEventListener("keydown", onKey);
  $("#fullscreen-root").append(el);
  page = { el, onKey, onClose, show, active: () => active };
  // initial may come from the address bar, so it might not exist here.
  show(sections.some((s) => s?.id && s.id === initial) ? initial : sections.find((s) => s?.id)?.id);
  return page;
}

export const fullscreenOpen = () => !!page;
// Redraws the open section, keeping anything the user has typed but not saved.
export const refreshFullscreen = () => page && page.show(page.active(), { keepEdits: true });

// --- toasts ----------------------------------------------------------------

export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = h("div", { class: `toast ${error ? "error" : ""}`, role: error ? "alert" : "status" }, message);
  $("#toast-root").append(el);
  setTimeout(() => el.remove(), ms);
}
