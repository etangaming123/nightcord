// Per-device client preferences (appearance, notifications). Stored locally;
// server-synced preferences live in notify.prefs (PROTOCOL.md §5).

import { DEFAULT_CUSTOM, applyTheme } from "./themes.js";

const KEY = "nightcord.prefs";

const DEFAULTS = {
  theme: "dark", // dark | light | system
  fontSize: 15,
  compact: false,
  desktopNotifications: false,
  sound: true,
  frequentEmoji: [],
  themePreset: "default", // themes.js PRESETS id (needs the server's client_themes perk)
  customTheme: DEFAULT_CUSTOM,
  autoReconnect: true, // open the last server again on startup (main.js boot)
  autoUpdateCheck: true, // standalone-only: ping GitHub's release API on load
  updateNotifier: true, // standalone-only: toast when an update is found
  trustedDomains: [], // link hosts that skip the leaving-site dialog (ui/links.js)
  touchGrass: true, // the parody nudge after hours of unbroken use (main.js)
  homeServerReveal: "hidden", // Home page server line: hidden | name | address (ui/home.js)
  twemoji: true, // Discord-style emoji font instead of the OS one (styles.css)
};

let prefs = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const getPrefs = () => prefs;

export function setPrefs(patch) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable; prefs last for this page load only */
  }
  applyPrefs();
}

export function applyPrefs() {
  const root = document.documentElement;
  let theme = prefs.theme;
  if (theme === "system") theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  theme = applyTheme(prefs, theme);
  root.dataset.theme = theme;
  root.style.setProperty("--font-size", `${prefs.fontSize}px`);
  root.classList.toggle("compact", !!prefs.compact);
  root.classList.toggle("native-emoji", !prefs.twemoji);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
}

export function noteEmojiUse(emoji) {
  const list = [emoji, ...prefs.frequentEmoji.filter((e) => e !== emoji)].slice(0, 16);
  setPrefs({ frequentEmoji: list });
}
