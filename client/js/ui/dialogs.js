// Feature dialogs: add guild, guild settings, channels, server settings.

import { LIMITS } from "../protocol.js";
import { clear, h, initials } from "./dom.js";
import { closeModal, confirmModal, formModal, openModal, toast } from "./modals.js";

// Lowercase, spaces to dashes, drop anything the protocol doesn't allow.
export function normalizeChannelName(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

export function addGuildDialog(state, api) {
  let tab = "create";
  const body = h("div");
  const tabs = h("div", { class: "tabs", role: "tablist" });

  const render = () => {
    clear(tabs);
    for (const [key, label] of [["create", "Create"], ["join", "Join with code"], ["browse", "Browse"]]) {
      tabs.append(h("button", {
        class: "tab", type: "button", role: "tab", "aria-selected": String(key === tab),
        on: { click: () => { tab = key; render(); } },
      }, label));
    }
    clear(body);
    if (tab === "create") body.append(createForm());
    if (tab === "join") body.append(joinForm());
    if (tab === "browse") body.append(browseList());
    body.querySelector("input")?.focus();
  };

  const withError = (form, fn) => {
    const error = h("div", { class: "error-box", hidden: true });
    form.append(error);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await fn(new FormData(form));
        closeModal();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    return form;
  };

  const createForm = () => {
    if (state.info.guild_creation !== "on" && !state.user.is_server_owner) {
      return h("p", { class: "muted" }, "Guild creation is turned off on this server.");
    }
    return withError(h("form", { class: "stack" },
      h("label", {}, "Guild name", h("input", { name: "name", required: true, maxLength: LIMITS.GUILD_NAME_MAX, placeholder: "My friends" })),
      h("button", { class: "btn primary", type: "submit" }, "Create guild"),
    ), (fd) => api.create(String(fd.get("name")).trim()));
  };

  const joinForm = () => withError(h("form", { class: "stack" },
    h("label", {}, "Invite code", h("input", { name: "code", required: true, placeholder: "ABCD2345", spellcheck: "false", autocapitalize: "characters", class: "mono" })),
    h("button", { class: "btn primary", type: "submit" }, "Join guild"),
  ), (fd) => api.joinByCode(String(fd.get("code")).trim()));

  const browseList = () => {
    const list = h("div", { class: "public-list" }, h("p", { class: "muted" }, "Loading…"));
    api.loadPublic().then((guilds) => {
      clear(list);
      if (!guilds.length) {
        list.append(h("p", { class: "muted" }, "No public guilds on this server."));
        return;
      }
      for (const g of guilds) {
        const joined = state.guilds.has(g.guild_id) && !state.guilds.get(g.guild_id).ghost;
        list.append(h("div", { class: "public-guild" },
          h("div", { class: "guild-icon", style: "width:36px;height:36px;font-size:13px;cursor:default", "aria-hidden": "true" }, initials(g.name)),
          h("span", { class: "name" }, g.name),
          h("button", {
            class: "btn primary", type: "button", disabled: joined,
            on: {
              click: async (e) => {
                e.currentTarget.disabled = true;
                try { await api.joinById(g.guild_id); closeModal(); } catch (err) { toast(err.message, { error: true }); e.currentTarget.disabled = false; }
              },
            },
          }, joined ? "Joined" : "Join")));
      }
    }).catch((err) => clear(list, h("p", { class: "muted" }, err.message)));
    return list;
  };

  openModal({ title: "Add a guild", content: [tabs, body] });
  render();
}

export function guildSettingsDialog(guild, info, api) {
  const listedNote = info.guild_list_visible
    ? "Anyone on this server can find and join it from Browse."
    : "The server owner has hidden the public list, so this has no effect right now.";
  const inviteArea = h("div", { class: "stack" },
    h("button", {
      class: "btn", type: "button",
      on: {
        click: async () => {
          try {
            const code = await api.createInvite();
            clear(inviteArea,
              h("div", { class: "row" },
                h("div", { class: "code-display" }, code),
                h("button", {
                  class: "btn", type: "button",
                  on: { click: () => navigator.clipboard?.writeText(code).then(() => toast("Invite code copied"), () => {}) },
                }, "Copy")),
              h("p", { class: "muted small", style: "margin:0" }, "Share this code. It doesn't expire."));
          } catch (e) {
            toast(e.message, { error: true });
          }
        },
      },
    }, "Create invite code"));

  formModal({
    title: "Guild settings",
    subtitle: guild.name,
    submitLabel: "Save",
    fields: [
      h("label", {}, "Name", h("input", { name: "name", required: true, maxLength: LIMITS.GUILD_NAME_MAX, value: guild.name })),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "listed", checked: guild.listed }), "List in the public guild directory"),
      h("p", { class: "muted small", style: "margin:-6px 0 0" }, listedNote),
      h("hr"),
      h("div", { class: "section-label", style: "padding:0" }, "Invite people"),
      inviteArea,
    ],
    onSubmit: async (fd) => {
      const patch = {};
      const name = String(fd.get("name")).trim();
      const listed = fd.get("listed") === "on";
      if (name !== guild.name) patch.name = name;
      if (listed !== guild.listed) patch.listed = listed;
      if (Object.keys(patch).length) await api.save(patch);
    },
  });
}

export function leaveGuildDialog(guild, onLeave) {
  confirmModal({
    title: `Leave ${guild.name}?`,
    message: guild.ghost
      ? "You'll stop seeing this guild. Nobody is notified."
      : "You'll need a new invite to come back.",
    confirmLabel: "Leave guild",
    onConfirm: onLeave,
  });
}

export function channelNameDialog({ title, submitLabel, initial = "", onSubmit }) {
  const preview = h("p", { class: "muted small", style: "margin:-6px 0 0" });
  const input = h("input", { name: "name", required: true, maxLength: 40, value: initial, placeholder: "new-channel", spellcheck: "false", autocapitalize: "off" });
  const update = () => { preview.textContent = `Will be created as #${normalizeChannelName(input.value) || "…"}`; };
  input.addEventListener("input", update);
  update();
  formModal({
    title,
    submitLabel,
    fields: [h("label", {}, "Channel name", input), preview],
    onSubmit: async () => {
      const name = normalizeChannelName(input.value);
      if (!LIMITS.CHANNEL_NAME_RE.test(name)) throw new Error("Use letters, numbers, - or _ (up to 32).");
      await onSubmit(name);
    },
  });
}

export function deleteChannelDialog(channel, onDelete) {
  confirmModal({
    title: `Delete #${channel.name}?`,
    message: "All of its messages will be deleted too. This can't be undone.",
    confirmLabel: "Delete channel",
    onConfirm: onDelete,
  });
}

export function serverSettingsDialog(info, api) {
  const select = (name, value, options) =>
    h("select", { name }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  const overrideInput = h("input", { name: "override", placeholder: "Guild ID", spellcheck: "false", class: "mono" });
  const overrideBtn = h("button", {
    class: "btn", type: "button",
    on: {
      click: async () => {
        const id = overrideInput.value.trim();
        if (!id) return;
        overrideBtn.disabled = true;
        try {
          await api.overrideJoin(id);
          closeModal();
          toast("Joined as a ghost. Members can't see you, and you can't post.");
        } catch (e) {
          toast(e.message, { error: true });
        } finally {
          overrideBtn.disabled = false;
        }
      },
    },
  }, "Ghost join");

  formModal({
    title: "Server settings",
    subtitle: `${info.server_name} · server-owner controls`,
    fields: [
      h("label", {}, "Account creation", select("account_creation", info.account_creation, [
        ["on", "Open: anyone can register"],
        ["request", "By request: you approve new accounts"],
        ["off", "Closed"],
      ])),
      h("label", {}, "Guild creation", select("guild_creation", info.guild_creation, [
        ["on", "Anyone can create guilds"],
        ["off", "Only the server owner"],
      ])),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "guild_list_visible", checked: info.guild_list_visible }), "Allow a public guild directory"),
      h("p", { class: "muted small", style: "margin:-6px 0 0" }, "Approve account requests with: nightcord_server.py pending approve <username>"),
      h("hr"),
      h("div", { class: "section-label", style: "padding:0" }, "Ghost join any guild"),
      h("p", { class: "muted small", style: "margin:0" }, "Read-only and invisible to members. List guild IDs with: nightcord_server.py guilds"),
      h("div", { class: "row" }, overrideInput, overrideBtn),
    ],
    onSubmit: async (fd) => {
      await api.save({
        account_creation: fd.get("account_creation"),
        guild_creation: fd.get("guild_creation"),
        guild_list_visible: fd.get("guild_list_visible") === "on",
      });
      toast("Server settings saved");
    },
  });
  // Enter in the ghost-join field shouldn't submit the settings form.
  overrideInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); overrideBtn.click(); }
  });
}
