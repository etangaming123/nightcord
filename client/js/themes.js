// Client themes (PROTOCOL.md §8d `client_themes`): colour presets and a
// custom gradient of 1–5 colours. Themes live in this browser only; the
// server's customisation settings decide whether they apply.

import { userCan } from "./perks.js";
import { scopedT } from "./strings.js";

const t = scopedT("themes");

export const MAX_THEME_COLORS = 5;

// Each preset sets the palette tokens from styles.css :root. `name` is a
// lazy getter (not a literal) so it isn't resolved until strings are loaded.
const PRESET_DATA = [
  { id: "default", nameKey: "preset_default", swatch: ["#1a1b26", "#7aa2f7"] },
  {
    id: "midnight", nameKey: "preset_midnight", base: "dark", swatch: ["#000000", "#8a8fff"],
    vars: { "--bg-0": "#000000", "--bg-1": "#060608", "--bg-2": "#0b0b10", "--bg-3": "#17171f", "--bg-4": "#22222d", "--panel": "#030305", "--line": "#1b1b24", "--accent": "#8a8fff", "--code-bg": "#050507" },
  },
  {
    id: "ash", nameKey: "preset_ash", base: "dark", swatch: ["#2b2d31", "#949cf7"],
    vars: { "--bg-0": "#1e1f22", "--bg-1": "#2b2d31", "--bg-2": "#313338", "--bg-3": "#3a3c42", "--bg-4": "#44474e", "--panel": "#232428", "--line": "#3f4147", "--text": "#dbdee1", "--text-2": "#b5bac1", "--muted": "#80848e", "--accent": "#949cf7", "--code-bg": "#2b2d31" },
  },
  {
    id: "forest", nameKey: "preset_forest", base: "dark", swatch: ["#142019", "#7fd49a"],
    vars: { "--bg-0": "#0d1510", "--bg-1": "#132019", "--bg-2": "#18271f", "--bg-3": "#22362b", "--bg-4": "#2b4436", "--panel": "#101b14", "--line": "#23372b", "--text": "#dbeee0", "--text-2": "#a9c8b2", "--muted": "#6f8f79", "--accent": "#7fd49a", "--code-bg": "#0f1912" },
  },
  {
    id: "ocean", nameKey: "preset_ocean", base: "dark", swatch: ["#0f1d2e", "#4cc9f0"],
    vars: { "--bg-0": "#0a1522", "--bg-1": "#0f1d2e", "--bg-2": "#132438", "--bg-3": "#1c3350", "--bg-4": "#244060", "--panel": "#0c1827", "--line": "#1d3452", "--text": "#dbe9f7", "--text-2": "#a6bfd9", "--muted": "#6d88a6", "--accent": "#4cc9f0", "--code-bg": "#0b1623" },
  },
  {
    id: "sunset", nameKey: "preset_sunset", base: "dark", swatch: ["#2a1627", "#ff8a5b"],
    vars: { "--bg-0": "#1b0f1a", "--bg-1": "#241422", "--bg-2": "#2b1828", "--bg-3": "#3a2237", "--bg-4": "#472a43", "--panel": "#1f111d", "--line": "#3d2539", "--text": "#f6e3ec", "--text-2": "#d6b3c3", "--muted": "#a07f90", "--accent": "#ff8a5b", "--code-bg": "#1e101c" },
  },
  {
    id: "sakura", nameKey: "preset_sakura", base: "light", swatch: ["#fff0f5", "#e2558c"],
    vars: { "--bg-0": "#f7dce7", "--bg-1": "#fcebf1", "--bg-2": "#fff7fa", "--bg-3": "#f7e1ea", "--bg-4": "#f0cddb", "--panel": "#f9e3ec", "--line": "#efd3de", "--text": "#3a2130", "--text-2": "#6b4a5b", "--muted": "#9a7a8a", "--accent": "#e2558c", "--code-bg": "#fbeef3" },
  },
  { id: "custom", nameKey: "preset_custom", swatch: null },
];

// Each preset's `name` is resolved on access (via a getter), never eagerly,
// so this module-level array never calls t() at load time.
export const PRESETS = PRESET_DATA.map(({ nameKey, ...rest }) =>
  Object.defineProperty(rest, "name", { get: () => t(nameKey), enumerable: true }));

export const DEFAULT_CUSTOM = { colors: ["#6d28d9", "#db2777", "#f59e0b"], angle: 135, strength: 55, base: "dark", accent: null };

// Every property applyTheme may set, so switching themes clears the last one.
const KEYS = new Set(["--grad", "--glass", "--accent-2", "--pill-bg", "--pill-text", "--accent-ink"]);
for (const p of PRESETS) for (const k of Object.keys(p.vars || {})) KEYS.add(k);

export const themesAllowed = () => userCan("client_themes");

export function normalizeCustom(c) {
  const colors = (Array.isArray(c?.colors) ? c.colors : DEFAULT_CUSTOM.colors)
    .filter((x) => /^#[0-9a-f]{6}$/i.test(x)).slice(0, MAX_THEME_COLORS);
  return {
    colors: colors.length ? colors : [DEFAULT_CUSTOM.colors[0]],
    angle: Number.isFinite(c?.angle) ? Math.round(c.angle) % 360 : DEFAULT_CUSTOM.angle,
    strength: Math.min(90, Math.max(10, Number(c?.strength) || DEFAULT_CUSTOM.strength)),
    base: c?.base === "light" ? "light" : "dark",
    accent: /^#[0-9a-f]{6}$/i.test(c?.accent || "") ? c.accent : null,
  };
}

// CSS for a gradient of 1-5 colours (one colour is a flat tint).
export function gradientCss({ colors, angle }) {
  return colors.length === 1 ? colors[0] : `linear-gradient(${angle}deg, ${colors.join(", ")})`;
}

// Dark or light text on an accent colour, whichever reads better.
function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? "#11131c" : "#ffffff";
}

function setAccent(style, accent, base) {
  const toward = base === "light" ? "black" : "white";
  style.setProperty("--accent", accent);
  style.setProperty("--accent-ink", inkFor(accent));
  style.setProperty("--accent-2", `color-mix(in srgb, ${accent} 82%, ${toward})`);
  style.setProperty("--pill-bg", `color-mix(in srgb, ${accent} 20%, transparent)`);
  style.setProperty("--pill-text", `color-mix(in srgb, ${accent} ${base === "light" ? 75 : 55}%, ${toward})`);
}

// Applies prefs.themePreset / prefs.customTheme on top of the base light/dark
// theme. Returns the base theme actually in use.
export function applyTheme(prefs, baseTheme) {
  const root = document.documentElement;
  const style = root.style;
  for (const k of KEYS) style.removeProperty(k);
  root.classList.remove("grad-theme");
  delete root.dataset.preset;
  const preset = PRESETS.find((p) => p.id === prefs.themePreset);
  if (!preset || preset.id === "default" || !themesAllowed()) return baseTheme;
  root.dataset.preset = preset.id;
  if (preset.id === "custom") {
    const c = normalizeCustom(prefs.customTheme);
    root.classList.add("grad-theme");
    style.setProperty("--grad", gradientCss(c));
    // How much of the gradient shows through the app's panels.
    style.setProperty("--glass", `${100 - c.strength}%`);
    setAccent(style, c.accent || c.colors[0], c.base);
    return c.base;
  }
  for (const [k, v] of Object.entries(preset.vars)) style.setProperty(k, v);
  setAccent(style, preset.vars["--accent"], preset.base);
  return preset.base;
}
