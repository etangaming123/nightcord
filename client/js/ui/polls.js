// Polls attached to a message (PROTOCOL.md §4 Poll): bars, percentages,
// who voted, time left, and End poll for whoever may close it.

import { LIMITS } from "../protocol.js";
import { can, currentChannel, isDm, nameOf, state, userById } from "../state.js";
import { add, clear, h } from "./dom.js";
import { emojiGlyph } from "./emoji.js";
import { confirmAction } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/polls");

const pct = (count, total) => (total ? Math.round((count / total) * 100) : 0);

// "3 days left", "12 minutes left", "less than a minute left".
function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t("closing");
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return t("left_under_a_minute");
  if (minutes < 60) return t("left_minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("left_hours", { count: hours });
  return t("left_days", { count: Math.round(hours / 24) });
}

function voterNames(userIds) {
  if (!userIds.length) return t("nobody_yet");
  const names = userIds.slice(0, 12).map((id) => nameOf(userById(id) || { username: t("someone") }));
  const more = userIds.length - names.length;
  return more > 0 ? t("voters_and_more", { names: names.join(", "), count: more }) : names.join(", ");
}

// Anyone who can end this poll: its author, or a message manager here.
export function canEndPoll(m) {
  if (!m.poll || m.poll.ended_at) return false;
  const channel = currentChannel();
  if (!channel) return false;
  return m.author?.user_id === state.user?.user_id || (!isDm(channel) && can("MANAGE_MESSAGES", channel));
}

export function renderPoll(m, actions) {
  const poll = m.poll;
  if (!poll) return null;
  const me = state.user?.user_id;
  const closed = !!poll.ended_at;
  const total = poll.total_votes;
  // Results are hidden until you've voted, like Discord — unless it's over.
  const voted = poll.answers.some((a) => a.user_ids.includes(me));
  const showResults = closed || voted;
  const leader = Math.max(0, ...poll.answers.map((a) => a.count));
  const box = h("div", { class: `poll ${closed ? "closed" : ""}` },
    h("div", { class: "poll-head" },
      h("span", { class: "poll-kind" }, poll.multi ? t("multi_label") : t("single_label")),
      h("span", { class: "poll-question" }, poll.question)),
    h("div", { class: "poll-answers" }, poll.answers.map((a) => {
      const mine = a.user_ids.includes(me);
      const share = pct(a.count, total);
      return h("button", {
        class: `poll-answer ${mine ? "mine" : ""} ${showResults && closed && a.count === leader && leader > 0 ? "winner" : ""}`,
        type: "button",
        disabled: closed || !state.connected,
        title: showResults ? voterNames(a.user_ids) : t("vote_to_see"),
        "aria-pressed": String(mine),
        on: {
          click: () => {
            const chosen = poll.multi
              ? (mine ? poll.answers.filter((x) => x.user_ids.includes(me) && x !== a) : poll.answers.filter((x) => x.user_ids.includes(me)).concat(a))
              : (mine ? [] : [a]);
            actions.votePoll(m, chosen.map((x) => x.answer_id));
          },
        },
      },
      showResults ? h("span", { class: "poll-bar", style: `width:${share}%` }) : null,
      h("span", { class: "poll-tick", "aria-hidden": "true" }, mine ? "✓" : ""),
      a.emoji ? emojiGlyph(a.emoji, { cls: "poll-emoji" }) : null,
      h("span", { class: "poll-text" }, a.text),
      showResults ? h("span", { class: "poll-count" }, `${share}%`) : null);
    })),
    h("div", { class: "poll-foot muted small" },
      h("span", {}, t("vote_count", { count: total })),
      h("span", {}, closed ? t("closed") : timeLeft(poll.expires_at)),
      canEndPoll(m)
        ? h("button", {
          class: "btn link", type: "button",
          on: {
            click: (e) => confirmAction(e, {
              title: t("end_title"),
              message: t("end_body"),
              confirmLabel: t("end_poll"),
              danger: false,
              onConfirm: () => actions.endPoll(m),
            }),
          },
        }, t("end_poll"))
        : null));
  return box;
}

// --- the composer's poll dialog ------------------------------------------------

const DURATIONS = () => LIMITS.POLL_DURATIONS.map((d) => [d, t(`duration_${d}`)]);

export function pollDialog(onSend, { formModal, openEmojiPicker }) {
  const rows = h("div", { class: "poll-rows" });
  const answers = [];

  const draw = () => {
    clear(rows);
    answers.forEach((a, i) => {
      const emojiBtn = h("button", {
        class: "btn small poll-emoji-btn", type: "button", title: t("answer_emoji"),
        on: {
          click: (e) => openEmojiPicker(e.currentTarget, (picked) => {
            a.emoji = picked;
            draw();
          }, { custom: false, placement: "bottom", key: `poll-emoji-${i}` }),
        },
      }, a.emoji ? emojiGlyph(a.emoji) : "☺");
      add(rows, h("div", { class: "poll-row" },
        emojiBtn,
        h("input", {
          name: `answer_${i}`, value: a.text, maxLength: LIMITS.POLL_ANSWER_MAX,
          placeholder: t("answer_placeholder", { n: i + 1 }), "aria-label": t("answer_placeholder", { n: i + 1 }),
          on: { input: (e) => { a.text = e.currentTarget.value; } },
        }),
        answers.length > LIMITS.POLL_MIN_ANSWERS
          ? h("button", {
            class: "icon-btn", type: "button", title: t("remove_answer"), "aria-label": t("remove_answer"),
            on: { click: () => { answers.splice(i, 1); draw(); } },
          }, "✕")
          : null));
    });
    if (answers.length < LIMITS.POLL_MAX_ANSWERS) {
      add(rows, h("button", {
        class: "btn small", type: "button",
        on: { click: () => { answers.push({ text: "", emoji: null }); draw(); } },
      }, t("add_answer")));
    }
  };
  for (let i = 0; i < LIMITS.POLL_MIN_ANSWERS; i++) answers.push({ text: "", emoji: null });
  draw();

  return formModal({
    title: t("dialog_title"),
    submitLabel: t("send_poll"),
    fields: [
      h("label", {}, t("question_label"),
        h("input", { name: "question", required: true, maxLength: LIMITS.POLL_QUESTION_MAX, placeholder: t("question_placeholder") })),
      h("div", { class: "field" }, h("span", { class: "field-label" }, t("answers_label")), rows),
      h("label", {}, t("duration_label"),
        h("select", { name: "duration" }, DURATIONS().map(([v, label]) => h("option", { value: v, selected: v === "1d" }, label)))),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "multi" }), t("multi_hint")),
    ],
    onSubmit: async (fd) => {
      const filled = answers.filter((a) => a.text.trim());
      if (filled.length < LIMITS.POLL_MIN_ANSWERS) throw new Error(t("need_two_answers"));
      await onSend({
        question: String(fd.get("question")).trim(),
        answers: filled.map((a) => ({ text: a.text.trim(), emoji: a.emoji || undefined })),
        multi: fd.get("multi") === "on",
        duration: String(fd.get("duration")),
      });
    },
  });
}

