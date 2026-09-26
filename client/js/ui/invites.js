// Invites (PROTOCOL.md §5 Guilds, §4 Invite): the "Invite people" dialog,
// the invite preview card, and Guild settings → Invites.

import { LIMITS, T } from "../protocol.js";
import { can, currentGuild, state } from "../state.js";
import { add, avatar, avatarUrl, clear, displayName, fmtDateTime, h, imageEl, initials, mayAnimate } from "./dom.js";
import { closeModal, confirmAction, openModal, toast } from "./modals.js";
import { copyText } from "./profile.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/invites");

const AGE_LABEL = () => ({ 0: t("age_never"), 1800: t("age_30m"), 3600: t("age_1h"), 21600: t("age_6h"), 43200: t("age_12h"), 86400: t("age_1d"), 604800: t("age_7d") });
const USES_LABEL = (n) => (n ? t("uses_limited", { count: n }) : t("uses_unlimited"));

export function expiresIn(iso) {
  if (!iso) return t("never_expires");
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return t("expired");
  const m = Math.round(ms / 60000);
  if (m < 60) return t("expires_in_minutes", { minutes: m });
  const hrs = Math.round(m / 60);
  if (hrs < 48) return t("expires_in_hours", { hours: hrs });
  return t("expires_in_days", { days: Math.round(hrs / 24) });
}

export const usesLeft = (inv) => (inv.max_uses ? t("uses_left", { left: inv.max_uses - inv.uses, max: inv.max_uses }) : t("uses_no_limit", { count: inv.uses }));

export function guildIcon(g, cls = "") {
  const url = avatarUrl(g.icon_id);
  return h("div", { class: `guild-icon static ${cls}`, "aria-hidden": "true" },
    url ? imageEl(g.icon_id, { animate: mayAnimate(g) }) : initials(g.name));
}

function linkBox(text, label) {
  return h("div", { class: "row invite-link" },
    h("input", { value: text, readOnly: true, "aria-label": label, on: { focus: (e) => e.currentTarget.select() } }),
    h("button", { class: "btn primary", type: "button", on: { click: () => copyText(text, t("copied_toast")) } }, t("copy_btn")));
}

// Pick the options first, then make the code: nothing is created just by
// opening the dialog, and the same options never make a second code.
export function inviteDialog(actions) {
  const g = currentGuild();
  if (!g) return;
  const ageLabel = AGE_LABEL();
  const age = h("select", { name: "age" }, LIMITS.INVITE_MAX_AGES.map((v) => h("option", { value: v, selected: v === 604800 }, ageLabel[v] || t("age_seconds", { seconds: v }))));
  const uses = h("select", { name: "uses" }, LIMITS.INVITE_MAX_USES.map((v) => h("option", { value: v }, USES_LABEL(v))));
  const out = h("div", { class: "stack" });
  let made = null; // the options the shown link was made with
  const opts = () => `${age.value}/${uses.value}`;
  const generate = h("button", { class: "btn primary", type: "button" }, t("generate_btn"));
  const refresh = () => {
    generate.disabled = made === opts();
    generate.textContent = made ? t("generate_new_btn") : t("generate_btn");
  };
  generate.addEventListener("click", async () => {
    generate.disabled = true;
    try {
      const inv = await actions.createInvite({ max_age_seconds: Number(age.value), max_uses: Number(uses.value) });
      made = opts();
      clear(out,
        h("label", {}, t("share_link_label"), linkBox(actions.inviteLink(inv.code), t("invite_link_aria"))),
        h("p", { class: "muted small" }, t("or_code_before"), h("strong", { class: "mono" }, inv.code), t("invite_summary", { expires: expiresIn(inv.expires_at), uses: USES_LABEL(inv.max_uses) })));
    } catch (e) {
      toast(e.message, { error: true });
    }
    refresh();
  });
  age.addEventListener("change", refresh);
  uses.addEventListener("change", refresh);
  openModal({
    title: t("invite_to_guild_title", { guild: g.name }),
    content: h("div", { class: "stack" },
      h("div", { class: "row wrap invite-opts" }, h("label", {}, t("expire_after_label"), age), h("label", {}, t("max_uses_label"), uses)),
      h("div", { class: "row" }, generate),
      out,
      g.vanity_code ? h("label", {}, t("public_link_label"), linkBox(actions.inviteLink(g.vanity_code), t("public_invite_link_aria"))) : null),
    actions: [h("button", { class: "btn", type: "button", on: { click: closeModal } }, t("done_btn"))],
  });
}

// "You've been invited to join …" card.
export function invitePreview(p, { onJoin }) {
  const join = h("button", {
    class: "btn primary block", type: "button",
    on: {
      click: async () => {
        join.disabled = true;
        try { await onJoin(); closeModal(); } catch (e) { toast(e.message, { error: true }); join.disabled = false; }
      },
    },
  }, p.is_member ? t("open_guild_btn") : t("accept_invite_btn"));
  openModal({
    title: p.inviter ? t("invited_by_title", { name: displayName(p.inviter) }) : t("invited_generic_title"),
    content: h("div", { class: `invite-card ${p.guild.banner_id ? "has-banner" : ""}` },
      p.guild.banner_id ? h("div", { class: "invite-banner", "aria-hidden": "true" }, imageEl(p.guild.banner_id, { lazy: false })) : null,
      guildIcon(p.guild, "lg"),
      h("div", { class: "invite-name" }, p.guild.name),
      h("div", { class: "invite-counts" },
        h("span", {}, h("i", { class: "dot online", "aria-hidden": "true" }), t("online_count", { count: p.online_count })),
        h("span", {}, h("i", { class: "dot offline", "aria-hidden": "true" }), t("member_count", { count: p.member_count }))),
      p.expires_at ? h("p", { class: "muted small" }, expiresIn(p.expires_at)) : null,
      join),
    cls: "invite-modal",
  });
}

// Guild settings → Invites.
export async function invitesTab(el, actions) {
  const g = currentGuild();
  const manage = can("MANAGE_GUILD");
  const { invites } = await actions.req(T.GUILD_INVITE_LIST, { guild_id: g.guild_id });
  add(el,
    h("div", { class: "row wrap" },
      h("p", { class: "muted grow" }, manage ? t("invites_manage_intro") : t("invites_own_intro")),
      can("CREATE_INVITE") ? h("button", { class: "btn primary", type: "button", on: { click: () => inviteDialog(actions) } }, t("create_invite_btn")) : null));
  if (manage) add(el, vanityForm(g, actions));
  if (!invites.length) { add(el, h("p", { class: "muted" }, t("no_active_invites"))); return; }
  const table = h("div", { class: "list invites" });
  for (const inv of invites) {
    actions.rememberUser(inv.inviter);
    const joined = state.members.filter((m) => m.invite_code === inv.code).length;
    add(table, h("div", { class: "list-row" },
      avatar(inv.inviter, { size: "sm" }),
      h("span", { class: "meta" },
        h("span", { class: "name" }, h("span", { class: "mono" }, inv.code), h("span", { class: "muted small" }, t("invite_by_fact", { name: actions.nameOf(inv.inviter) }))),
        h("span", { class: "sub" }, t("invite_row_summary", { uses: usesLeft(inv), expires: expiresIn(inv.expires_at), joined, created: fmtDateTime(inv.created_at) }))),
      h("span", { class: "row" },
        h("button", { class: "btn", type: "button", on: { click: () => copyText(actions.inviteLink(inv.code), t("invite_link_copied_toast")) } }, t("copy_link_btn")),
        h("button", {
          class: "btn danger", type: "button",
          on: {
            click: (e) => {
              const btn = e.currentTarget;
              const row = btn.closest(".list-row");
              const revoke = async () => {
                btn.disabled = true;
                try {
                  await actions.req(T.GUILD_INVITE_REVOKE, { invite_code: inv.code });
                  row.remove();
                  toast(t("invite_revoked_toast"));
                } catch (err) {
                  btn.disabled = false;
                  throw err;
                }
              };
              confirmAction(e, {
                title: t("revoke_invite_title", { code: inv.code }),
                message: t("revoke_invite_body"),
                confirmLabel: t("revoke_btn"),
                onConfirm: revoke,
              });
            },
          },
        }, t("revoke_btn")))));
  }
  add(el, table);
}

function vanityForm(g, actions) {
  const input = h("input", { name: "vanity", value: g.vanity_code || "", placeholder: t("vanity_placeholder"), maxLength: 32, spellcheck: "false", autocapitalize: "off", "aria-label": t("vanity_code_aria") });
  const form = h("form", { class: "stack narrow vanity" },
    h("label", {}, t("public_invite_link_label"), h("span", { class: "muted small block" }, t("public_link_hint")), input),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "submit" }, t("save_public_link_btn")),
      g.vanity_code ? h("button", { class: "btn link", type: "button", on: { click: () => copyText(actions.inviteLink(g.vanity_code), t("public_link_copied_toast")) } }, t("copy_link_btn")) : null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = input.value.trim().toLowerCase();
    if (code && !LIMITS.VANITY_RE.test(code)) { toast(t("invalid_vanity_code"), { error: true }); return; }
    try {
      await actions.updateGuild({ vanity_code: code || null });
      toast(code ? t("public_link_saved_toast") : t("public_link_off_toast"));
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  return form;
}
