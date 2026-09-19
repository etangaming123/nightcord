// Modal dialogs and toasts. No window.alert/confirm/prompt anywhere.

import { $, h } from "./dom.js";

let current = null;

export function closeModal() {
  if (!current) return;
  current.backdrop.remove();
  document.removeEventListener("keydown", current.onKey);
  current.restoreFocus?.focus?.();
  current = null;
}

// content: Node or array of Nodes. Returns the modal element.
export function openModal({ title, subtitle, content, actions = [], onClose }) {
  closeModal();
  const modal = h(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
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
    if (e.key === "Escape") { closeModal(); onClose?.(); }
  };
  document.addEventListener("keydown", onKey);
  current = { backdrop, onKey, restoreFocus: document.activeElement };
  $("#modal-root").append(backdrop);
  const first = modal.querySelector("input, textarea, select, button.primary");
  (first || modal).focus?.();
  return modal;
}

// A form modal. onSubmit(formData) may throw/reject to show an error inline;
// resolve to close.
export function formModal({ title, subtitle, fields, submitLabel = "Save", danger = false, onSubmit }) {
  const error = h("div", { class: "error-box", hidden: true });
  const submit = h("button", { type: "submit", class: `btn ${danger ? "danger" : "primary"}` }, submitLabel);
  const form = h("form", { class: "stack" }, fields, error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      closeModal();
    } catch (err) {
      error.textContent = err.message || String(err);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  submit.setAttribute("form", "modal-form");
  form.id = "modal-form";
  return openModal({
    title,
    subtitle,
    content: form,
    actions: [h("button", { type: "button", class: "btn", on: { click: closeModal } }, "Cancel"), submit],
  });
}

export function confirmModal({ title, message, confirmLabel = "Confirm", danger = true, onConfirm }) {
  return formModal({ title, subtitle: message, fields: [], submitLabel: confirmLabel, danger, onSubmit: onConfirm });
}

export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = h("div", { class: `toast ${error ? "error" : ""}`, role: error ? "alert" : "status" }, message);
  $("#toast-root").append(el);
  setTimeout(() => el.remove(), ms);
}
