// Account switcher: every account saved on this device, grouped by server.
// Picking one reconnects as that account; each server can hold several,
// up to its advisory max_accounts_per_client (PROTOCOL.md §4 Server config).

import { state } from "../state.js";
import * as store from "../storage.js";
import { add, avatar, h, iconBtn } from "./dom.js";
import { closePopover, confirmModal, openMenu, openPopover } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/accounts");

// Stored accounts carry just enough to draw them offline (no avatar image:
// that lives on a server we may not be connected to).
function accountRow(server, account, actions) {
  const current = server.url === state.url && account.user_id === state.user?.user_id;
  const shown = current ? state.user : { user_id: account.user_id, username: account.username || "?", display_name: account.display_name, avatar_color: account.avatar_color };
  const pick = () => { closePopover(); actions.switchAccount(server.url, account.user_id); };
  return h("div", {
    class: `account-row-item ${current ? "current" : ""}`, role: "button", tabindex: "0", "aria-current": current ? "true" : null,
    title: current ? t("current_account") : t("switch_to", { name: shown.username }),
    on: {
      click: (e) => { if (!e.target.closest(".icon-btn") && !current) pick(); },
      keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget && !current) pick(); },
    },
  },
  avatar(shown, { size: "sm" }),
  h("span", { class: "meta" },
    h("span", { class: "name" }, shown.display_name || shown.username || t("unknown_account")),
    h("span", { class: "sub" }, shown.username || "")),
  current ? h("span", { class: "tick", "aria-hidden": "true" }, "✓") : null,
  iconBtn("⋯", t("account_options"), (e) => openMenu(e.currentTarget, [
    current ? null : { label: t("switch"), icon: "⇄", onClick: pick },
    {
      label: current ? t("log_out") : t("forget"),
      icon: "🚪",
      danger: true,
      onClick: (ev) => {
        const go = () => { closePopover(); actions.forgetAccount(server.url, account.user_id); };
        if (ev?.shiftKey) { go(); return; }
        confirmModal({
          title: current ? t("log_out_title") : t("forget_title", { name: shown.username || "" }),
          message: current ? t("log_out_body") : t("forget_body"),
          confirmLabel: current ? t("log_out") : t("forget"),
          onConfirm: go,
        });
      },
    },
  ].filter(Boolean), { placement: "right", key: `account:${server.url}:${account.user_id}` })));
}

export function openAccountSwitcher(anchor, actions) {
  const body = h("div", { class: "account-switcher" }, h("div", { class: "switcher-title" }, t("title")));
  const servers = store.getServers();
  // The connected server first.
  servers.sort((a, b) => (a.url === state.url ? -1 : b.url === state.url ? 1 : 0));
  for (const server of servers) {
    const accounts = store.getAccounts(server.url).filter((a) => a.user_id);
    const limit = server.url === state.url ? state.info?.max_accounts_per_client || 0 : server.maxAccounts || 0;
    const full = limit > 0 && accounts.length >= limit;
    add(body, h("div", { class: "account-server" },
      h("div", { class: "section-label" },
        h("span", {}, server.label, server.url === state.url ? h("span", { class: "tag" }, t("connected")) : null),
        limit ? h("span", { class: "muted small" }, t("limit", { count: accounts.length, limit })) : null),
      accounts.map((a) => accountRow(server, a, actions)),
      full
        ? h("p", { class: "muted small pad-x" }, t("limit_reached"))
        : h("button", {
          class: "btn link add-account", type: "button",
          on: { click: () => { closePopover(); actions.addAccount(server.url); } },
        }, t("add_account"))));
  }
  add(body, h("div", { class: "account-footer" },
    h("button", { class: "btn small", type: "button", on: { click: () => { closePopover(); actions.switchServer(); } } }, t("other_server"))));
  openPopover(anchor, body, { placement: "top", cls: "accounts-pop", key: "accounts" });
}
