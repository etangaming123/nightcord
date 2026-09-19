// Terms of Service / Privacy Policy (PROTOCOL.md §8b): the pre-join screen,
// the "documents changed" prompt, and the owner's editor lives in admin.js.

import { add, clear, h } from "./dom.js";
import { renderDocument } from "./markdown.js";
import { openModal } from "./modals.js";

export const DOC_NAMES = { terms: "Terms of Service", privacy: "Privacy Policy" };

// Tabs + the rendered document into `tabs` / `body`. Returns the shown names.
export function renderLegalTabs(docs, tabs, body) {
  const names = Object.keys(DOC_NAMES).filter((k) => docs[k]);
  let current = names[0];
  const draw = () => {
    clear(tabs, names.length > 1 ? names.map((k) => h("button", {
      class: "tab", type: "button", role: "tab", "aria-selected": String(k === current),
      on: { click: () => { current = k; draw(); } },
    }, DOC_NAMES[k])) : null);
    tabs.hidden = names.length < 2;
    clear(body, current ? renderDocument(docs[current]) : h("p", { class: "muted" }, "This server has no documents."));
    body.scrollTop = 0;
  };
  draw();
  return names;
}

// Read-only viewer (from the auth screen's links, or settings).
export function showLegalModal(docs, which = null) {
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const body = h("div", { class: "legal-doc scroll", tabindex: "0" });
  const ordered = which ? { [which]: docs[which], ...docs } : docs;
  renderLegalTabs(ordered, tabs, body);
  openModal({ title: "Server rules", content: [tabs, body], wide: true, cls: "legal-modal" });
}

// Blocking prompt after the documents changed: accept or log out.
export function legalUpdateModal(docs, { onAccept, onLogout }) {
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const body = h("div", { class: "legal-doc scroll", tabindex: "0" });
  renderLegalTabs(docs, tabs, body);
  const error = h("div", { class: "error-box", hidden: true });
  const accept = h("button", {
    class: "btn primary", type: "button",
    on: {
      click: async () => {
        accept.disabled = true;
        try { await onAccept(); } catch (e) { error.textContent = e.message; error.hidden = false; accept.disabled = false; }
      },
    },
  }, "I agree");
  openModal({
    title: "This server updated its rules",
    subtitle: "Read the new version to keep using the server.",
    content: [tabs, body, error],
    actions: [h("button", { class: "btn", type: "button", on: { click: onLogout } }, "Log out"), accept],
    wide: true,
    dismissable: false,
    cls: "legal-modal",
  });
}

// Links under the auth form: "Terms of Service · Privacy Policy".
export function legalLinks(info, onOpen) {
  if (!info?.legal_version) return null;
  const links = Object.keys(DOC_NAMES).filter((k) => info[`has_${k}`]).map((k) => h("button", {
    class: "btn link", type: "button", on: { click: () => onOpen(k) },
  }, DOC_NAMES[k]));
  const out = h("p", { class: "muted small legal-links" });
  links.forEach((l, i) => add(out, i ? " · " : null, l));
  return out;
}
