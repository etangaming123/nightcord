// The cheat sheet (Ctrl/Cmd+/ , or Settings → Appearance).

import { GROUPS, SHORTCUTS, keyLabel } from "../shortcuts.js";
import { h } from "./dom.js";
import { openModal } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/shortcuts");

export function shortcutSheet() {
  const groups = GROUPS.map((group) => {
    const rows = SHORTCUTS.filter((s) => s.group === group);
    return h("section", { class: "shortcut-group" },
      h("h3", {}, t(`group_${group}`)),
      h("dl", { class: "shortcut-list" }, rows.flatMap((s) => [
        h("dt", {}, s.keys.length
          ? s.keys.map((part, i) => [i ? h("span", { class: "key-plus" }, "+") : null, h("kbd", {}, keyLabel(part))])
          : h("span", { class: "muted" }, t("any_key"))),
        h("dd", {}, t(`do_${s.id}`)),
      ])));
  });
  return openModal({
    title: t("title"),
    wide: true,
    cls: "shortcut-sheet",
    content: h("div", { class: "shortcut-groups" }, groups),
  });
}
