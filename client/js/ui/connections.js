// Settings → Connections: link this account to Discord through the server's
// own Discord bot (PROTOCOL.md §5 Discord link). Only shown when the server
// has one (server.info → discord_link).

import { T } from "../protocol.js";
import { state } from "../state.js";
import { APP_BASE, ENABLED } from "../router.js";
import { add, fmtDate, h } from "./dom.js";
import { confirmAction, fullscreenSection, refreshFullscreen, toast } from "./modals.js";
import { copyText } from "./profile.js";
import { icon } from "./icons.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/connections");

const KINDS = ["mentions", "dms", "message_requests", "friend_requests", "announcements"];
const FIELDS = ["display_name", "avatar", "banner"];

// The code on show while you're linking, kept across redraws: { code, expires_at }.
let pending = null;
// The last sync's report, shown under the button until the page is left.
let report = null;

export const discordAvailable = () => !!state.info?.discord_link;

// discord.link.updated: redraw if Connections is open, and say so when a
// code just worked.
export function applyDiscordLink(link) {
  if (link && pending) {
    pending = null;
    toast(t("linked_toast", { name: link.discord_username }));
  }
  if (fullscreenSection() === "connections") refreshFullscreen();
}

export async function connections(el, actions) {
  const { bot, link } = await actions.req(T.DISCORD_GET);
  add(el, h("p", { class: "muted" }, t("intro", { bot: bot.name || t("the_bot") })));
  if (!bot.online) add(el, h("p", { class: "error-box info" }, t("bot_offline")));
  if (link) linked(el, actions, link);
  else unlinked(el, actions, bot);
}

// --- not linked yet ----------------------------------------------------------------

function unlinked(el, actions, bot) {
  report = null;
  const expired = pending && Date.parse(pending.expires_at) < Date.now();
  if (expired) pending = null;
  const getCode = async () => {
    try {
      pending = await actions.req(T.DISCORD_LINK_START, {
        app_url: ENABLED ? new URL(APP_BASE, location.origin).href : undefined,
        server: actions.serverParam() || undefined,
      });
      refreshFullscreen();
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  const command = pending ? `/nightcord link code:${pending.code}` : null;
  const install = /^https:\/\/discord\.com\//.test(bot.install_url || "") ? bot.install_url : null;
  add(el,
    h("ol", { class: "link-steps" },
      h("li", {},
        h("strong", {}, t("step_add_title")),
        h("span", { class: "muted small block" }, t("step_add_body")),
        install
          ? h("a", { class: "btn", href: install, target: "_blank", rel: "noopener noreferrer" },
            icon("external-link"), " ", t("step_add_button", { bot: bot.name || t("the_bot") }))
          : h("span", { class: "muted small block" }, t("step_add_no_link"))),
      h("li", {},
        h("strong", {}, t("step_code_title")),
        pending
          ? h("div", { class: "discord-code" },
            h("div", { class: "row" },
              h("code", { class: "discord-code-value mono" }, pending.code),
              h("button", { class: "btn", type: "button", on: { click: () => copyText(command, t("copied_toast")) } },
                icon("copy"), " ", t("copy_command"))),
            h("span", { class: "muted small block" }, t("code_expires", { time: new Date(pending.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })))
          : h("span", { class: "muted small block" }, t("step_code_body")),
        h("button", { class: `btn ${pending ? "" : "primary"}`, type: "button", on: { click: getCode } },
          pending ? t("new_code") : t("get_code"))),
      h("li", {},
        h("strong", {}, t("step_send_title")),
        h("span", { class: "muted small block" }, t("step_send_body")),
        command ? h("code", { class: "mono discord-command" }, command) : null)),
    h("p", { class: "muted small" }, t("privacy_note")));
}

// --- linked --------------------------------------------------------------------------

function linked(el, actions, link) {
  const save = async (patch) => {
    try {
      await actions.req(T.DISCORD_SETTINGS_SET, patch);
    } catch (e) {
      toast(e.message, { error: true });
      refreshFullscreen();
    }
  };
  const check = (checked, label, hint, onChange) => h("label", { class: "check" },
    h("input", { type: "checkbox", checked, on: { change: (e) => onChange(e.currentTarget.checked) } }),
    h("span", {}, label, hint ? h("span", { class: "muted small block" }, hint) : null));

  add(el,
    h("div", { class: "list" }, h("div", { class: "list-row" },
      h("span", { class: "list-icon", "aria-hidden": "true" }, icon("link")),
      h("span", { class: "meta" },
        h("span", { class: "name" }, link.discord_username, " ", h("span", { class: "tag ok" }, t("linked_tag"))),
        h("span", { class: "sub" }, t("linked_since", { date: fmtDate(link.linked_at) }))),
      h("button", {
        class: "btn danger", type: "button",
        on: {
          click: (e) => confirmAction(e, {
            title: t("unlink_title"),
            message: t("unlink_body", { name: link.discord_username }),
            confirmLabel: t("unlink"),
            onConfirm: async () => {
              try {
                await actions.req(T.DISCORD_UNLINK);
                toast(t("unlinked_toast"));
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          }),
        },
      }, t("unlink")))),
    link.dm_refused ? h("p", { class: "error-box" }, t("dm_refused")) : null);

  // Sync
  const picked = new Set(FIELDS);
  const syncBtn = h("button", {
    class: "btn primary", type: "button",
    on: {
      click: async () => {
        if (!picked.size) return;
        syncBtn.disabled = true;
        try {
          const res = await actions.req(T.DISCORD_SYNC, { fields: [...picked] });
          actions.setSelf(res.user);
          report = res;
          toast(res.synced.length ? t("synced_toast") : t("nothing_synced_toast"));
        } catch (e) {
          toast(e.message, { error: true });
        } finally {
          syncBtn.disabled = false;
          refreshFullscreen();
        }
      },
    },
  }, t("sync_button"));
  add(el,
    h("h3", {}, t("sync_heading")),
    h("p", { class: "muted small" }, t("sync_intro")),
    h("div", { class: "check-list" }, FIELDS.map((f) => check(true, t(`field_${f}`), null, (on) => {
      if (on) picked.add(f); else picked.delete(f);
      syncBtn.disabled = !picked.size;
    }))),
    h("div", { class: "row wrap gap discord-actions" }, syncBtn),
    report && Object.keys(report.skipped).length
      ? h("div", { class: "error-box info" }, Object.entries(report.skipped).map(([f, why]) =>
        h("div", {}, t("skipped_line", { field: t(`field_${f}`), reason: why }))))
      : null,
    h("p", { class: "muted small" }, t("sync_note")));

  // Notifications
  add(el,
    h("h3", {}, t("notify_heading")),
    h("p", { class: "muted small" }, t("notify_intro")),
    h("div", { class: "check-list" }, KINDS.map((k) => check(link.notify[k], t(`kind_${k}`), t(`kind_${k}_hint`),
      (on) => save({ notify: { [k]: on } })))),
    h("div", { class: "check-list discord-options" },
      check(link.only_when_away, t("only_when_away"), t("only_when_away_hint"), (on) => save({ only_when_away: on })),
      check(link.include_content, t("include_content"), t("include_content_hint"), (on) => save({ include_content: on }))),
    h("p", { class: "muted small" }, t("dnd_note")),
    h("div", { class: "row wrap gap discord-actions" }, h("button", {
      class: "btn", type: "button",
      on: {
        click: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const { delivered } = await actions.req(T.DISCORD_TEST);
            toast(delivered ? t("test_sent_toast") : t("test_refused_toast"), { error: !delivered });
          } catch (err) {
            toast(err.message, { error: true });
          } finally {
            btn.disabled = false;
          }
        },
      },
    }, icon("bell"), " ", t("test_button"))));
}
