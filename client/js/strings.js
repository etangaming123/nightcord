// Runtime string loader: fetches per-module JSON from lang/<lang>/ and exposes
// scoped t(key, vars) lookups so UI copy lives outside the JS source.

let cache = null;

function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? vars[name] : m));
}

function t(mod, key, vars) {
  let raw = cache?.[mod]?.[key];
  if (raw === undefined) {
    console.error(`[strings] missing ${mod}.${key}`);
    return `⟦${mod}.${key}⟧`;
  }
  if (typeof raw === "object" && raw !== null) {
    raw = (vars?.count === 1 ? raw.one : raw.other) ?? raw.other ?? "";
  }
  return vars ? interpolate(raw, vars) : raw;
}

export async function loadStrings(lang = "en") {
  cache = {};
  let manifest;
  try {
    manifest = await fetch(`lang/${lang}/manifest.json`).then((r) => r.json());
  } catch (e) {
    console.error("[strings] failed to load manifest", e);
    manifest = [];
  }
  await Promise.all(
    manifest.map(async (mod) => {
      try {
        cache[mod] = await fetch(`lang/${lang}/${mod}.json`).then((r) => r.json());
      } catch (e) {
        console.error(`[strings] failed to load ${mod}`, e);
        cache[mod] = {};
      }
    })
  );
}

export function scopedT(modulePath) {
  return (key, vars) => t(modulePath, key, vars);
}
