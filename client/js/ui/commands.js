// Slash commands (PROTOCOL.md §4 Command).
//
// Two kinds. The ones whose result has to be trustworthy — /roll, /8ball,
// /coinflip, /choose — are sent to the server as `command` and rolled there,
// and the message carries what was rolled. The rest are this file rewriting
// your own text (or opening a dialog) before it goes anywhere.

import { LIMITS } from "../protocol.js";
import { h } from "./dom.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/commands");

// Backslashes and underscores in the kaomoji have to survive markdown.
const SHRUG = "¯\\\\\\_(ツ)\\_/¯";
const TABLEFLIP = "(╯°□°）╯︵ ┻━┻";
const UNFLIP = "┬─┬ノ( º _ ºノ)";
const LENNY = "( ͡° ͜ʖ ͡°)";

// kind:
//   "server"  — sent as `command`, rolled by the server
//   "text"    — replaces what you typed
//   "wrap"    — wraps the rest of the line
//   "action"  — runs something in the client instead of sending
export const COMMANDS = [
  { name: "roll", kind: "server", usage: "2d6+3" },
  { name: "8ball", kind: "server", usage: "<question>" },
  { name: "coinflip", kind: "server" },
  { name: "choose", kind: "server", usage: "a | b | c" },
  { name: "shrug", kind: "text", text: SHRUG },
  { name: "tableflip", kind: "text", text: TABLEFLIP },
  { name: "unflip", kind: "text", text: UNFLIP },
  { name: "lenny", kind: "text", text: LENNY },
  { name: "me", kind: "wrap", usage: "<something you did>", wrap: (rest) => (rest ? `*${rest}*` : "") },
  { name: "spoiler", kind: "wrap", usage: "<text>", wrap: (rest) => (rest ? `||${rest}||` : "") },
  { name: "nick", kind: "action", usage: "<nickname>", action: "nick" },
  { name: "poll", kind: "action", action: "poll" },
  { name: "remind", kind: "action", usage: "20m take the bins out", action: "remind" },
  { name: "time", kind: "action", usage: "[HH:MM]", action: "time" },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
export const findCommand = (name) => BY_NAME.get(String(name || "").toLowerCase()) || null;

export const describe = (c) => t(`desc_${c.name}`);
export const usageOf = (c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`;

// "/roll 2d6" -> { command, args }; null when the text isn't a command.
export function parseCommand(text) {
  const m = /^\/([a-z0-9]+)(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim());
  if (!m) return null;
  const command = findCommand(m[1].toLowerCase());
  return command ? { command, args: (m[2] || "").trim() } : null;
}

// What the composer should do with a typed command. Returns one of
// { send: { content, command } } | { text } | { action, args } | { error }.
export function planCommand(text) {
  const parsed = parseCommand(text);
  if (!parsed) return null;
  const { command, args } = parsed;
  if (command.kind === "server") {
    if (args.length > LIMITS.COMMAND_ARGS_MAX) return { error: t("args_too_long") };
    return { send: { content: "", command: { name: command.name, args } } };
  }
  if (command.kind === "text") return { text: command.text };
  if (command.kind === "wrap") {
    const wrapped = command.wrap(args);
    return wrapped ? { text: wrapped } : { error: t("needs_text", { usage: usageOf(command) }) };
  }
  return { action: command.action, args };
}

// Commands matching what's been typed so far, for the composer's autocomplete.
export function matchCommands(prefix) {
  const q = String(prefix || "").toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

// --- rendering ------------------------------------------------------------------

// The small "used /roll" line above a message with a server-rolled result.
export function commandHeader(command) {
  if (!command) return null;
  return h("div", { class: "cmd-head muted small" },
    h("span", { class: "cmd-slash", "aria-hidden": "true" }, "/"),
    t("used_command", { name: command.name }),
    command.args ? h("span", { class: "cmd-args" }, command.args) : null);
}

// The result itself, drawn rather than trusted to the author's own text.
export function commandResult(command) {
  const r = command?.result;
  if (!r) return null;
  if (command.name === "roll") {
    return h("div", { class: "cmd-result roll" },
      h("span", { class: "cmd-total" }, String(r.total)),
      h("span", { class: "muted small" }, t("roll_detail", {
        notation: r.notation,
        rolls: r.rolls.join(" + "),
        modifier: r.modifier ? (r.modifier > 0 ? ` + ${r.modifier}` : ` − ${-r.modifier}`) : "",
      })));
  }
  if (command.name === "coinflip") {
    return h("div", { class: "cmd-result" },
      h("span", { class: "cmd-total" }, r.side === "heads" ? t("heads") : t("tails")));
  }
  if (command.name === "8ball") {
    return h("div", { class: "cmd-result eightball" },
      h("span", { class: "cmd-ball", "aria-hidden": "true" }, "🎱"),
      h("span", {}, r.answer));
  }
  if (command.name === "choose") {
    return h("div", { class: "cmd-result" },
      h("span", { class: "cmd-total" }, r.picked),
      h("span", { class: "muted small" }, t("chose_from", { count: r.options.length })));
  }
  return null;
}
