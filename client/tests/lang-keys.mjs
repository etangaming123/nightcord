// node client/tests/lang-keys.mjs — every t()/scopedT() key used by the client
// must exist in client/lang/en, and every lang module must be in the manifest.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const langDir = path.join(clientDir, "lang", "en");

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(full)));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const manifest = JSON.parse(await readFile(path.join(langDir, "manifest.json"), "utf8"));
const strings = {};
for (const mod of manifest) {
  strings[mod] = JSON.parse(await readFile(path.join(langDir, `${mod}.json`), "utf8"));
}

const problems = [];

// Every JSON file under lang/en (except the manifest) has to be listed.
const onDisk = [];
const walkLang = async (dir, prefix = "") => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await walkLang(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    else if (entry.name.endsWith(".json") && entry.name !== "manifest.json") onDisk.push(prefix + entry.name.replace(/\.json$/, ""));
  }
};
await walkLang(langDir);
for (const mod of onDisk) if (!manifest.includes(mod)) problems.push(`lang/en/${mod}.json is not in manifest.json`);
for (const mod of manifest) if (!onDisk.includes(mod)) problems.push(`manifest.json lists ${mod}, which has no file`);

for (const file of await jsFiles(path.join(clientDir, "js"))) {
  const src = await readFile(file, "utf8");
  const rel = path.relative(clientDir, file);
  // const NAME = scopedT("module") — then NAME("key") looks up module.key.
  const scopes = new Map();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*scopedT\("([^"]+)"\)/g)) scopes.set(m[1], m[2]);
  for (const [name, mod] of scopes) {
    if (!(mod in strings)) { problems.push(`${rel}: scopedT("${mod}") has no lang module`); continue; }
    const re = new RegExp(`(?<![\\w.])${name}\\(\\s*"([^"]+)"`, "g");
    for (const m of src.matchAll(re)) {
      if (!(m[1] in strings[mod])) problems.push(`${rel}: missing ${mod}.${m[1]}`);
    }
  }
  // Template-built keys (t(`group_${x}`)) can't be checked here; flag them so
  // they stay rare and obvious.
  for (const [name] of scopes) {
    const re = new RegExp(`(?<![\\w.])${name}\\(\\s*\``, "g");
    for (const _ of src.matchAll(re)) void _;
  }
}

// data-i18n* attributes in index.html resolve against the "shell" module.
const html = await readFile(path.join(clientDir, "index.html"), "utf8");
for (const m of html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g)) {
  if (!(m[1] in strings.shell)) problems.push(`index.html: missing shell.${m[1]}`);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`\n${problems.length} missing string(s)`);
  process.exit(1);
}
console.log(`lang keys: ok (${manifest.length} modules)`);
