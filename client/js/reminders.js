// /remind — a note to yourself, kept in localStorage per account so it
// survives a reload. Purely a client thing: the server never sees it, so a
// reminder only fires on the device that set it and only while a tab is open.

import { playSound, showDesktopNotification } from "./notify.js";
import { state } from "./state.js";
import { rawGet, rawSet } from "./storage.js";
import { toast } from "./ui/modals.js";
import { scopedT } from "./strings.js";

const t = scopedT("actions");

const KEY = "nightcord.reminders";
const MAX = 50;

let timers = new Map(); // id -> timeout handle

function load() {
  try {
    const raw = JSON.parse(rawGet(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.text === "string" && typeof r.at === "number") : [];
  } catch {
    return [];
  }
}

function save(list) {
  rawSet(KEY, JSON.stringify(list.slice(-MAX)));
}

// Reminders belong to the account that set them, on the server it set them on.
const mine = (r) => r.url === state.url && r.userId === state.user?.user_id;

export const listReminders = () => load().filter(mine).sort((a, b) => a.at - b.at);

function fire(reminder) {
  timers.delete(reminder.id);
  save(load().filter((r) => r.id !== reminder.id));
  toast(t("reminder", { text: reminder.text }), { ms: 10000 });
  playSound("message");
  showDesktopNotification(t("reminder_title"), reminder.text);
}

function arm(reminder) {
  const wait = reminder.at - Date.now();
  if (wait <= 0) { fire(reminder); return; }
  // setTimeout caps out around 24.8 days; re-arm in chunks past that.
  const step = Math.min(wait, 2 ** 31 - 1);
  timers.set(reminder.id, setTimeout(() => (step === wait ? fire(reminder) : arm(reminder)), step));
}

export function addReminder(text, ms) {
  const reminder = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: state.url,
    userId: state.user?.user_id,
    text,
    at: Date.now() + ms,
  };
  save([...load(), reminder]);
  arm(reminder);
  return reminder;
}

export function cancelReminder(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  save(load().filter((r) => r.id !== id));
}

// Called after logging in: pick up anything this account left behind.
export function restoreReminders() {
  for (const handle of timers.values()) clearTimeout(handle);
  timers = new Map();
  for (const reminder of listReminders()) arm(reminder);
}
