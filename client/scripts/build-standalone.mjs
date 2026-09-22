// Bundles the client into one self-contained .html file: no server, no
// build step for anyone but us. Bundles the ES module graph, inlines the
// stylesheet, embeds the logo/sounds as data: URIs, and embeds the en
// strings so nothing needs fetch() at runtime (fetch() of local files is
// blocked under file://, which is how this file is meant to be opened).
//
// Usage: node scripts/build-standalone.mjs
// Output: dist/nightcord-standalone.html

import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.join(clientDir, "dist", "nightcord-standalone.html");

// Set by GitHub Actions to the pushed tag on a release build (e.g. "v1.0.1"),
// or the branch name on a workflow_dispatch run; "dev" for a local build.
// Read by client/js/update-check.js to know its own version.
const buildVersion = process.env.GITHUB_REF_NAME || "dev";

const MIME = { ".png": "image/png", ".wav": "audio/wav" };

async function dataUri(relPath) {
  const bytes = await readFile(path.join(clientDir, relPath));
  return `data:${MIME[path.extname(relPath)]};base64,${bytes.toString("base64")}`;
}

async function embeddedLang() {
  const langDir = path.join(clientDir, "lang", "en");
  const manifest = JSON.parse(await readFile(path.join(langDir, "manifest.json"), "utf8"));
  const modules = {};
  for (const mod of manifest) {
    modules[mod] = JSON.parse(await readFile(path.join(langDir, `${mod}.json`), "utf8"));
  }
  return { en: modules };
}

async function main() {
  const [html, css, lang, result] = await Promise.all([
    readFile(path.join(clientDir, "index.html"), "utf8"),
    readFile(path.join(clientDir, "css", "styles.css"), "utf8"),
    embeddedLang(),
    build({
      entryPoints: [path.join(clientDir, "js", "main.js")],
      bundle: true,
      minify: true,
      format: "iife",
      write: false,
    }),
  ]);

  const [logoUri, messageUri, mentionUri, voiceJoinUri, voiceLeaveUri] = await Promise.all([
    dataUri("assets/logo.png"),
    dataUri("assets/sounds/message.wav"),
    dataUri("assets/sounds/mention.wav"),
    dataUri("assets/sounds/voice-join.wav"),
    dataUri("assets/sounds/voice-leave.wav"),
  ]);

  let script = result.outputFiles[0].text;
  script = script
    .replaceAll("assets/sounds/message.wav", messageUri)
    .replaceAll("assets/sounds/mention.wav", mentionUri)
    .replaceAll("assets/sounds/voice-join.wav", voiceJoinUri)
    .replaceAll("assets/sounds/voice-leave.wav", voiceLeaveUri)
    .replaceAll("assets/logo.png", logoUri);

  let out = html
    .replace(
      '<link rel="stylesheet" href="css/styles.css">',
      `<style>\n${css}\n</style>`
    )
    .replaceAll('href="assets/logo.png"', `href="${logoUri}"`)
    .replaceAll('src="assets/logo.png"', `src="${logoUri}"`)
    .replace(
      '<script type="module" src="js/main.js"></script>',
      // The original is a module script, deferred until the DOM is parsed by
      // spec. This inline replacement sits in <head> too, so it needs the
      // same deferral or every document.getElementById() below runs too early.
      `<script>window.__NIGHTCORD_LANG__ = ${JSON.stringify(lang)}; window.__NIGHTCORD_BUILD_VERSION__ = ${JSON.stringify(buildVersion)};</script>\n` +
        `<script>document.addEventListener("DOMContentLoaded", function () {\n${script}\n});</script>`
    );

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, out);

  const { size } = await import("node:fs").then((fs) => fs.promises.stat(outFile));
  console.log(`wrote ${path.relative(clientDir, outFile)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
