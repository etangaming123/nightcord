// Message markdown (PROTOCOL.md §4 Message): **bold**, *italic*, __underline__,
// ~~strike~~, `code`, ```blocks```, > quotes, ||spoilers||, links, <@id>
// mentions and @everyone.
//
// parse() turns text into a token tree without touching the DOM (so it can be
// tested in node); render() builds DOM nodes from it with text nodes only —
// never innerHTML — so message content can't inject markup.

import { h } from "./dom.js";

const MAX_DEPTH = 6;

const INLINE = new RegExp(
  [
    "\\\\([*_~`|\\\\<>@])", // 1: backslash escape
    "(`+)([\\s\\S]*?[^`])\\2(?!`)", // 2,3: inline code
    "\\*\\*([\\s\\S]+?)\\*\\*(?!\\*)", // 4: bold
    "__([\\s\\S]+?)__(?!_)", // 5: underline
    "\\*(?=\\S)([\\s\\S]*?\\S)\\*(?!\\*)", // 6: italic
    "(?<![A-Za-z0-9_])_(?=\\S)([\\s\\S]*?\\S)_(?![A-Za-z0-9_])", // 7: italic
    "~~([\\s\\S]+?)~~", // 8: strike
    "\\|\\|([\\s\\S]+?)\\|\\|", // 9: spoiler
    "<@(\\d{1,20})>", // 10: user mention
    "(?<![\\w`@])(@everyone)\\b", // 11: @everyone
    "(https?:\\/\\/[^\\s<>\"']+[^\\s<>\"'.,;:!?)\\]])", // 12: link
  ].join("|"),
  "g",
);

export function parseInline(text, depth = 0) {
  const out = [];
  let last = 0;
  const push = (tok) => out.push(tok);
  const pushText = (s) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === "text") prev.text += s;
    else out.push({ type: "text", text: s });
  };
  if (depth > MAX_DEPTH) return [{ type: "text", text }];
  let m;
  const re = new RegExp(INLINE.source, "g"); // fresh lastIndex: parseInline recurses
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = (s) => parseInline(s, depth + 1);
    if (m[1] !== undefined) pushText(m[1]);
    else if (m[3] !== undefined) push({ type: "code", text: m[3].replace(/^ (.*) $/s, "$1") });
    else if (m[4] !== undefined) push({ type: "bold", children: inner(m[4]) });
    else if (m[5] !== undefined) push({ type: "underline", children: inner(m[5]) });
    else if (m[6] !== undefined) push({ type: "italic", children: inner(m[6]) });
    else if (m[7] !== undefined) push({ type: "italic", children: inner(m[7]) });
    else if (m[8] !== undefined) push({ type: "strike", children: inner(m[8]) });
    else if (m[9] !== undefined) push({ type: "spoiler", children: inner(m[9]) });
    else if (m[10] !== undefined) push({ type: "mention", id: m[10] });
    else if (m[11] !== undefined) push({ type: "everyone" });
    else if (m[12] !== undefined) push({ type: "link", href: m[12] });
  }
  pushText(text.slice(last));
  return out;
}

// Splits plain (non-code-block) text into quote blocks and inline runs.
function parseLines(text) {
  const out = [];
  const lines = text.split("\n");
  let plain = [];
  const flush = () => {
    if (!plain.length) return;
    out.push(...parseInline(plain.join("\n")));
    plain = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(">>> ")) {
      flush();
      out.push({ type: "quote", children: parseInline([line.slice(4), ...lines.slice(i + 1)].join("\n")) });
      return out;
    }
    if (line.startsWith("> ") || line === ">") {
      flush();
      const quoted = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoted.push(lines[i].slice(2));
        i++;
      }
      i--;
      out.push({ type: "quote", children: parseInline(quoted.join("\n")) });
      continue;
    }
    plain.push(line);
  }
  flush();
  return out;
}

const FENCE = /```(?:([A-Za-z0-9_+-]{1,20})\n)?([\s\S]*?)```/g;

export function parse(content) {
  const out = [];
  let last = 0;
  for (const m of content.matchAll(FENCE)) {
    const before = content.slice(last, m.index).replace(/\n$/, "");
    if (before) out.push(...parseLines(before));
    out.push({ type: "codeblock", lang: m[1] || null, text: m[2].replace(/^\n/, "").replace(/\n$/, "") });
    last = m.index + m[0].length;
    if (content[last] === "\n") last++;
  }
  const rest = content.slice(last);
  if (rest) out.push(...parseLines(rest));
  return out;
}

// ctx: { user(id) -> PublicUser|undefined, onMention(id, el) }
export function render(content, ctx = {}) {
  return renderTokens(parse(content), ctx);
}

function renderTokens(tokens, ctx) {
  return tokens.map((t) => renderToken(t, ctx));
}

function renderToken(t, ctx) {
  switch (t.type) {
    case "text":
      return document.createTextNode(t.text);
    case "code":
      return h("code", { class: "md-code" }, t.text);
    case "codeblock":
      return h("pre", { class: "md-pre" }, h("code", { dataset: t.lang ? { lang: t.lang } : undefined }, t.text));
    case "bold":
      return h("strong", {}, renderTokens(t.children, ctx));
    case "italic":
      return h("em", {}, renderTokens(t.children, ctx));
    case "underline":
      return h("u", {}, renderTokens(t.children, ctx));
    case "strike":
      return h("s", {}, renderTokens(t.children, ctx));
    case "quote":
      return h("blockquote", { class: "md-quote" }, renderTokens(t.children, ctx));
    case "spoiler": {
      const el = h("span", {
        class: "md-spoiler", role: "button", tabindex: "0", title: "Spoiler — click to reveal",
        on: {
          click: (e) => { e.stopPropagation(); el.classList.add("shown"); },
          keydown: (e) => { if (e.key === "Enter") el.classList.add("shown"); },
        },
      }, renderTokens(t.children, ctx));
      return el;
    }
    case "mention": {
      const user = ctx.user?.(t.id);
      const label = user ? `@${user.display_name || user.username}` : "@unknown-user";
      const el = h("span", {
        class: `mention ${ctx.meId === t.id ? "me" : ""}`, role: "button", tabindex: "0",
        on: { click: (e) => { e.stopPropagation(); ctx.onMention?.(t.id, el); } },
      }, label);
      return el;
    }
    case "everyone":
      return h("span", { class: "mention everyone" }, "@everyone");
    case "link":
      return h("a", { href: t.href, target: "_blank", rel: "noopener noreferrer nofollow" }, t.href);
    default:
      return document.createTextNode("");
  }
}

// Plain-text version for notifications, reply previews and search: mentions
// become @names, formatting markers are dropped.
export function plainText(content, ctx = {}) {
  const walk = (tokens) => tokens.map((t) => {
    switch (t.type) {
      case "text": case "code": case "codeblock": return t.text;
      case "link": return t.href;
      case "everyone": return "@everyone";
      case "mention": {
        const u = ctx.user?.(t.id);
        return u ? `@${u.display_name || u.username}` : "@unknown-user";
      }
      case "spoiler": return "▒▒▒";
      default: return walk(t.children || []);
    }
  }).join("");
  return walk(parse(content));
}
