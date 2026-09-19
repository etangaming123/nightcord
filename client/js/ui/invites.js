// Invites (PROTOCOL.md §5 Guilds, §4 Invite): the "Invite people" dialog,
// the invite preview card, and Guild settings → Invites.

import { LIMITS, T } from "../protocol.js";
import { can, currentGuild, state } from "../state.js";
import { add, avatar, avatarUrl, clear, displayName, fmtDateTime, h, imageEl, initials, mayAnimate } from "./dom.js";
import { closeModal, openModal, toast } from "./modals.js";
import { copyText } from "./profile.js";

const AGE_LABEL = { 0: "Never", 1800: "30 minutes", 3600: "1 hour", 21600: "6 hours", 43200: "12 hours", 86400: "1 day", 604800: "7 days" };
const USES_LABEL = (n) => (n ? `${n} use${n === 1 ? "" : "s"}` : "No limit");

export function expiresIn(iso) {
  if (!iso) return "Never expires";
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return "Expired";
  const m = Math.round(ms / 60000);
  if (m < 60) return `Expires in ${m} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `Expires in ${hrs} h`;
  return `Expires in ${Math.round(hrs / 24)} days`;
}

export const usesLeft = (inv) => (inv.max_uses ? `${inv.max_uses - inv.uses} of ${inv.max_uses} uses left` : `${inv.uses} use${inv.uses === 1 ? "" : "s"} · no limit`);

export function guildIcon(g, cls = "") {
  const url = avatarUrl(g.icon_id);
  return h("div", { class: `guild-icon static ${cls}`, "aria-hidden": "true" },
    url ? imageEl(g.icon_id, { animate: mayAnimate(g) }) : initials(g.name));
}

function linkBox(text, label) {
  return h("div", { class: "row invite-link" },
    h("input", { value: text, readOnly: true, "aria-label": label, on: { focus: (e) => e.currentTarget.select() } }),
    h("button", { class: "btn primary", type: "button", on: { click: () => copyText(text, "Copied") } }, "Copy"));
}

export function inviteDialog(actions) {
  const g = currentGuild();
  if (!g) return;
  const age = h("select", { name: "age" }, LIMITS.INVITE_MAX_AGES.map((v) => h("option", { value: v, selected: v === 604800 }, AGE_LABEL[v] || `${v}s`)));
  const uses = h("select", { name: "uses" }, LIMITS.INVITE_MAX_USES.map((v) => h("option", { value: v }, USES_LABEL(v))));
  const out = h("div", { class: "stack" });
  const make = async () => {
    try {
      const inv = await actions.createInvite({ max_age_seconds: Number(age.value), max_uses: Number(uses.value) });
      clear(out,
        h("label", {}, "Share this link", linkBox(actions.inviteLink(inv.code), "Invite link")),
        h("p", { class: "muted small" }, `Or the code `, h("strong", { class: "mono" }, inv.code), ` · ${expiresIn(inv.expires_at)} · ${USES_LABEL(inv.max_uses)}`));
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  age.addEventListener("change", make);
  uses.addEventListener("change", make);
  openModal({
    title: `Invite friends to ${g.name}`,
    content: h("div", { class: "stack" },
      out,
      h("div", { class: "row wrap invite-opts" }, h("label", {}, "Expire after", age), h("label", {}, "Max number of uses", uses)),
      g.vanity_code ? h("label", {}, "Public link (never expires)", linkBox(actions.inviteLink(g.vanity_code), "Public invite link")) : null),
    actions: [h("button", { class: "btn", type: "button", on: { click: closeModal } }, "Done")],
  });
  make();
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
  }, p.is_member ? "Open guild" : "Accept invite");
  openModal({
    title: p.inviter ? `${displayName(p.inviter)} invited you to join` : "You've been invited to join",
    content: h("div", { class: `invite-card ${p.guild.banner_id ? "has-banner" : ""}` },
      p.guild.banner_id ? h("div", { class: "invite-banner", "aria-hidden": "true" }, imageEl(p.guild.banner_id, { lazy: false })) : null,
      guildIcon(p.guild, "lg"),
      h("div", { class: "invite-name" }, p.guild.name),
      h("div", { class: "invite-counts" },
        h("span", {}, h("i", { class: "dot online", "aria-hidden": "true" }), `${p.online_count} online`),
        h("span", {}, h("i", { class: "dot offline", "aria-hidden": "true" }), `${p.member_count} member${p.member_count === 1 ? "" : "s"}`)),
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
      h("p", { class: "muted grow" }, manage ? "Every active invite in this guild. Revoke any you don't want used." : "Your active invites."),
      can("CREATE_INVITE") ? h("button", { class: "btn primary", type: "button", on: { click: () => inviteDialog(actions) } }, "Create invite") : null));
  if (manage) add(el, vanityForm(g, actions));
  if (!invites.length) { add(el, h("p", { class: "muted" }, "No active invites.")); return; }
  const table = h("div", { class: "list invites" });
  for (const inv of invites) {
    actions.rememberUser(inv.inviter);
    const joined = state.members.filter((m) => m.invite_code === inv.code).length;
    add(table, h("div", { class: "list-row" },
      avatar(inv.inviter, { size: "sm" }),
      h("span", { class: "meta" },
        h("span", { class: "name" }, h("span", { class: "mono" }, inv.code), h("span", { class: "muted small" }, ` by ${actions.nameOf(inv.inviter)}`)),
        h("span", { class: "sub" }, `${usesLeft(inv)} · ${expiresIn(inv.expires_at)} · ${joined} joined · created ${fmtDateTime(inv.created_at)}`)),
      h("span", { class: "row" },
        h("button", { class: "btn", type: "button", on: { click: () => copyText(actions.inviteLink(inv.code), "Invite link copied") } }, "Copy link"),
        h("button", {
          class: "btn danger", type: "button",
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                await actions.req(T.GUILD_INVITE_REVOKE, { invite_code: inv.code });
                btn.closest(".list-row").remove();
                toast("Invite revoked");
              } catch (err) {
                btn.disabled = false;
                toast(err.message, { error: true });
              }
            },
          },
        }, "Revoke"))));
  }
  add(el, table);
}

function vanityForm(g, actions) {
  const input = h("input", { name: "vanity", value: g.vanity_code || "", placeholder: "my-guild", maxLength: 32, spellcheck: "false", autocapitalize: "off", "aria-label": "Public invite code" });
  const form = h("form", { class: "stack narrow vanity" },
    h("label", {}, "Public invite link", h("span", { class: "muted small block" }, "A permanent code anyone can use — handy for sharing publicly. Leave empty to turn it off."), input),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "submit" }, "Save public link"),
      g.vanity_code ? h("button", { class: "btn link", type: "button", on: { click: () => copyText(actions.inviteLink(g.vanity_code), "Public link copied") } }, "Copy link") : null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = input.value.trim().toLowerCase();
    if (code && !LIMITS.VANITY_RE.test(code)) { toast("Use 3–32 characters: a-z, 0-9 and -", { error: true }); return; }
    try {
      await actions.updateGuild({ vanity_code: code || null });
      toast(code ? "Public link saved" : "Public link turned off");
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  return form;
}
