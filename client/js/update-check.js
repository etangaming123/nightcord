// Standalone-only update check: compares the embedded build version against
// GitHub's latest release. Local-only — this never touches the app's own
// server or the websocket protocol; it's a single unauthenticated GET to
// GitHub's public release API. Gated behind __NIGHTCORD_BUILD_VERSION__ (only
// set by build-standalone.mjs) so this never runs in the hosted/dev client,
// and behind the "auto update checker" pref (see prefs.js / ui/settings.js
// "Local Options"). See README "Standalone client" for user-facing disclosure.

import { getPrefs } from "./prefs.js";
import { invalidate } from "./render.js";
import { state } from "./state.js";
import { rawGet, rawSet } from "./storage.js";
import { toast } from "./ui/modals.js";
import { scopedT } from "./strings.js";

const t = scopedT("notify");
const REPO = "etangaming123/nightcord";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const NOTIFIED_KEY = "nightcord.updateNotifiedVersion";

let updateInfo = null; // { latest, current } once a real newer release is confirmed

export const getUpdateInfo = () => updateInfo;

// The login screens draw a big banner; they subscribe here since the check
// finishes after they're first shown.
const listeners = [];
export const onUpdateInfo = (fn) => { listeners.push(fn); };

// "v1.0.1" -> [1,0,1]; null for anything that doesn't match (e.g. "dev" local
// builds, or a branch name when release.yml runs via workflow_dispatch off a
// branch instead of a tag push — GITHUB_REF_NAME won't be a semver tag then).
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const isNewer = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);

export async function checkForUpdate() {
  const current = globalThis.__NIGHTCORD_BUILD_VERSION__;
  if (!current || !getPrefs().autoUpdateCheck) return;
  const currentParsed = parseVersion(current);
  if (!currentParsed) return; // "dev" / non-tag build: nothing meaningful to compare

  let latestTag;
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return; // rate-limited (60/hr unauthenticated) or API hiccup: silent no-op
    latestTag = (await res.json()).tag_name;
  } catch {
    return; // offline / blocked / CORS quirk: never surface an error to the user
  }

  const latestParsed = parseVersion(latestTag);
  if (!latestParsed || !isNewer(latestParsed, currentParsed)) return;

  updateInfo = { latest: latestTag, current };
  for (const fn of listeners) fn(updateInfo);
  invalidate("chat"); // redraw Friends/Inbox if it's already open (no-op pre-login)

  if (!getPrefs().updateNotifier) return;
  let notified = [];
  try {
    notified = JSON.parse(rawGet(NOTIFIED_KEY) || "[]");
  } catch {
    /* ignore */
  }
  if (notified.includes(latestTag)) return; // toast already shown for this version
  // Before logging in there is no Inbox to point at.
  toast(t(state.user ? "update_toast_inbox" : "update_toast", { latest: latestTag }), { ms: 6000 });
  rawSet(NOTIFIED_KEY, JSON.stringify([...notified, latestTag].slice(-10)));
}
