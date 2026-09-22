// Before a message, announcement or bio sends you somewhere else, say where.
// Rendered markdown links carry .md-link; one delegated listener catches them
// all, so nothing has to remember to wire this up.
//
// Trusted domains are a per-device preference (prefs.js), listed with remove
// buttons in Settings → Privacy. They never leave this browser.
import { getPrefs, setPrefs } from "../prefs.js";
import { h } from "./dom.js";
import { closeModal, openModal } from "./modals.js";
import { scopedT } from "../strings.js";
const t = scopedT("ui/links");
export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
// example.com covers www.example.com and docs.example.com, nothing else.
export function isTrustedHost(host, list = getPrefs().trustedDomains) {
  if (!host) return false;
  return (list || []).some((d) => host === d || host.endsWith(`.${d}`));
}
export function trustDomain(host) {
  if (!host) return;
  const list = (getPrefs().trustedDomains || []).filter((d) => d !== host);
  setPrefs({ trustedDomains: [...list, host].slice(-100) });
}
export function untrustDomain(host) {
  setPrefs({ trustedDomains: (getPrefs().trustedDomains || []).filter((d) => d !== host) });
}
// A label that itself looks like a link to somewhere else is worth pointing
// out: "https://your-bank.example" pointing at evil.example.
export function misleadingLabel(label, href) {
  const text = String(label || "").trim();
  if (!text) return false;
  const guess = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  const shown = hostOf(guess);
  if (!shown || !shown.includes(".")) return false;
  return shown !== hostOf(href);
}
export function leavingDialog(href, label) {
  const host = hostOf(href);
  const go = () => window.open(href, "_blank", "noopener,noreferrer");
  openModal({
    title: t("leaving_title", { host }),
    content: h("div", { class: "stack leaving-body" },
      h("p", { class: "leaving-host" }, host),
      h("p", { class: "muted small leaving-url" }, href),
      misleadingLabel(label, href)
        ? h("p", { class: "error-box" }, t("mismatch_warning", { label: String(label).trim() }))
        : null,
      h("p", { class: "muted small" }, t("leaving_note"))),
    actions: [
      h("button", { class: "btn", type: "button", on: { click: closeModal } }, t("go_back")),
      h("button", {
        class: "btn", type: "button",
        on: { click: () => { trustDomain(host); closeModal(); go(); } },
      }, t("trust_domain", { host })),
      h("button", { class: "btn primary", type: "button", on: { click: () => { closeModal(); go(); } } }, t("proceed")),
    ],
  });
}
export function setupLinkGuard() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a.md-link[href]");
    if (!a) return;
    const href = a.href;
    if (!/^https?:$/.test(new URL(href, location.href).protocol)) return;
    if (isTrustedHost(hostOf(href))) return;
    e.preventDefault();
    e.stopPropagation();
    leavingDialog(href, a.textContent);
  }, true);
}
