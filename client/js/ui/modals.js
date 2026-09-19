// Modal dialogs, popovers/menus, full-screen settings pages and toasts.
// No window.alert/confirm/prompt anywhere.

import { $, add, clear, h } from "./dom.js";

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
export function openModal({ title, subtitle, content, actions = [], onClose, wide = false }) {
  closeModal();
  closePopover();
  const modal = h(
    "div",
    { class: `modal ${wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("h2", {}, title),
    subtitle ? h("p", { class: "sub" }, subtitle) : null,
    content,
    actions.length ? h("div", { class: "actions" }, actions) : null,
  );
  const backdrop = h("div", {
    class: "modal-backdrop",
    on: { mousedown: (e) => { if (e.target === backdrop) { closeModal(); onClose?.(); } } },
  }, modal);
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeModal(); onClose?.(); }
  };
  document.addEventListener("keydown", onKey, true);
  current = { backdrop, onKey, restoreFocus: document.activeElement };
  $("#modal-root").append(backdrop);
  const first = modal.querySelector("input:not([type=checkbox]), textarea, select, button.primary");
  (first || modal).focus?.();
  return modal;
}

// A form modal. onSubmit(formData, form) may throw/reject to show an error
// inline; resolve to close (or resolve `false` to keep it open).
export function formModal({ title, subtitle, fields, submitLabel = "Save", danger = false, onSubmit, wide = false }) {
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
    actions: [h("button", { type: "button", class: "btn", on: { click: closeModal } }, "Cancel"), submit],
  });
}

export function confirmModal({ title, message, confirmLabel = "Confirm", danger = true, onConfirm, fields = [] }) {
  return formModal({ title, subtitle: message, fields, submitLabel: confirmLabel, danger, onSubmit: onConfirm });
}

// --- popovers & menus ------------------------------------------------------

let popover = null;

export function closePopover() {
  if (!popover) return;
  popover.el.remove();
  document.removeEventListener("mousedown", popover.onDown, true);
  document.removeEventListener("keydown", popover.onKey, true);
  window.removeEventListener("resize", popover.onResize);
  popover.onClose?.();
  popover = null;
}

// anchor: an element, or {x, y} (e.g. a contextmenu event position).
export function openPopover(anchor, content, { cls = "", placement = "right", onClose } = {}) {
  // Measure first: the anchor may live inside the popover being replaced.
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    if (popover?.el.contains(anchor)) anchor = { x: r.left, y: r.top, rect: r };
  }
  closePopover();
  const el = h("div", { class: `popover ${cls}`, role: "dialog" }, content);
  $("#popover-root").append(el);
  const place = () => {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect()
      : anchor.rect || { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
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
  const onDown = (e) => {
    if (!el.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) closePopover();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closePopover(); }
  };
  const onResize = () => closePopover();
  setTimeout(() => document.addEventListener("mousedown", onDown, true));
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  popover = { el, onDown, onKey, onResize, onClose, place };
  return el;
}

export const repositionPopover = () => popover?.place();

// items: [{ label, onClick, danger?, checked?, disabled?, hint? } | "-" | { heading }]
export function openMenu(anchor, items, opts = {}) {
  const list = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (!item) continue;
    if (item === "-") { add(list, h("div", { class: "menu-sep", role: "separator" })); continue; }
    if (item.heading) { add(list, h("div", { class: "menu-heading" }, item.heading)); continue; }
    add(list, h("button", {
      class: `menu-item ${item.danger ? "danger" : ""}`, type: "button", role: "menuitem",
      disabled: item.disabled,
      on: { click: () => { closePopover(); item.onClick?.(); } },
    },
    item.icon ? h("span", { class: "menu-icon", "aria-hidden": "true" }, item.icon) : null,
    h("span", { class: "menu-label" }, item.label),
    item.checked !== undefined ? h("span", { class: "menu-check", "aria-hidden": "true" }, item.checked ? "●" : "○") : null,
    item.hint ? h("span", { class: "menu-hint" }, item.hint) : null));
  }
  const el = openPopover(anchor, list, { placement: "bottom", ...opts, cls: `menu-pop ${opts.cls || ""}` });
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

// --- full-screen pages (User Settings, Guild Settings, …) ---------------------

let page = null;

export function closeFullscreen() {
  if (!page) return;
  page.el.remove();
  document.removeEventListener("keydown", page.onKey);
  page.onClose?.();
  page = null;
}

// sections: [{ id, label, render(container) } | { heading } | { label, onClick, danger }]
export function openFullscreen({ sections, initial, onClose, title }) {
  closeFullscreen();
  closePopover();
  const nav = h("nav", { class: "fs-nav", "aria-label": title });
  const body = h("div", { class: "fs-body" });
  const content = h("div", { class: "fs-content" });
  add(body, content);
  const el = h("div", { class: "fullscreen", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "fs-side" }, nav),
    h("div", { class: "fs-main" },
      body,
      h("button", { class: "fs-close", type: "button", title: "Close (Esc)", "aria-label": "Close", on: { click: closeFullscreen } }, "✕")));
  let active = null;
  const show = (id) => {
    const section = sections.find((s) => s.id === id);
    if (!section) return;
    active = id;
    for (const btn of nav.querySelectorAll(".fs-tab")) btn.setAttribute("aria-current", btn.dataset.id === id ? "page" : "false");
    clear(content, h("h2", { class: "fs-title" }, section.title || section.label));
    const inner = h("div", { class: "fs-section" });
    add(content, inner);
    el.classList.remove("nav-open");
    Promise.resolve(section.render(inner, { show })).catch((e) => {
      add(inner, h("div", { class: "error-box" }, e.message || String(e)));
    });
    body.scrollTop = 0;
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
    if (e.key === "Escape" && !modalOpen() && !popover) closeFullscreen();
  };
  document.addEventListener("keydown", onKey);
  $("#fullscreen-root").append(el);
  page = { el, onKey, onClose, show, active: () => active };
  show(initial || sections.find((s) => s?.id)?.id);
  return page;
}

export const fullscreenOpen = () => !!page;
export const refreshFullscreen = () => page && page.show(page.active());

// --- toasts ----------------------------------------------------------------

export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = h("div", { class: `toast ${error ? "error" : ""}`, role: error ? "alert" : "status" }, message);
  $("#toast-root").append(el);
  setTimeout(() => el.remove(), ms);
}
