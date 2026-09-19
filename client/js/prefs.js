// Per-device client preferences (appearance, notifications). Stored locally;
// server-synced preferences live in notify.prefs (PROTOCOL.md §5).

const KEY = "nightcord.prefs";

const DEFAULTS = {
  theme: "dark", // dark | light | system
  fontSize: 15,
  compact: false,
  desktopNotifications: false,
  sound: true,
  frequentEmoji: [],
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
  root.dataset.theme = theme;
  root.style.setProperty("--font-size", `${prefs.fontSize}px`);
  root.classList.toggle("compact", !!prefs.compact);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
}

export function noteEmojiUse(emoji) {
  const list = [emoji, ...prefs.frequentEmoji.filter((e) => e !== emoji)].slice(0, 16);
  setPrefs({ frequentEmoji: list });
}
