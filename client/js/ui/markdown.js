// Message markdown (PROTOCOL.md §4 Message): **bold**, *italic*, __underline__,
// ~~strike~~, `code`, ```blocks```, > quotes, ||spoilers||, links, <@id>
// mentions, @everyone and custom emoji <:name:id>. Documents (Terms of Service, Privacy Policy;
// PROTOCOL.md §8b) also get headings, paragraphs, lists, rules and
// [label](https://…) links.
//
// parse() turns text into a token tree without touching the DOM (so it can be
// tested in node); render() builds DOM nodes from it with text nodes only —
// never innerHTML — so message content can't inject markup.

import { h, mediaUrl } from "./dom.js";
import { scopedT } from "../strings.js";

// Named `ts`, not `t`: this file uses `t` as the token-object parameter name everywhere.
const ts = scopedT("ui/markdown");

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
    "<(a?):([A-Za-z0-9_]{2,32}):(\\d{1,20})>", // 13,14,15: custom emoji
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
    else if (m[15] !== undefined) push({ type: "emoji", animated: m[13] === "a", name: m[14], id: m[15] });
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

// Flat text of a token list, for places that can't hold elements.
function tokensText(tokens) {
  return tokens.map((t) => (t.text ?? (t.children ? tokensText(t.children) : t.href ?? ""))).join("");
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
        class: "md-spoiler", role: "button", tabindex: "0", title: ts("spoiler_hint"),
        on: {
          click: (e) => { e.stopPropagation(); el.classList.add("shown"); },
          keydown: (e) => { if (e.key === "Enter") el.classList.add("shown"); },
        },
      }, renderTokens(t.children, ctx));
      return el;
    }
    case "mention": {
      const user = ctx.user?.(t.id);
      const label = user ? `@${user.display_name || user.username}` : ts("unknown_user_mention");
      const el = h("span", {
        class: `mention ${ctx.meId === t.id ? "me" : ""}`, role: "button", tabindex: "0",
        on: { click: (e) => { e.stopPropagation(); ctx.onMention?.(t.id, el); } },
      }, label);
      return el;
    }
    case "everyone":
      return h("span", { class: "mention everyone" }, "@everyone");
    case "emoji": {
      const label = `:${t.name}:`;
      const src = ctx.emojiUrl ? ctx.emojiUrl(t.id) : mediaUrl(t.id);
      if (!src) return document.createTextNode(label);
      const img = h("img", {
        class: "cemoji", src, alt: label, title: label, draggable: "false", loading: "lazy",
        tabindex: ctx.onEmoji ? "0" : null, role: ctx.onEmoji ? "button" : null,
        on: {
          // A deleted emoji's image is gone: show its name instead.
          error: () => img.replaceWith(document.createTextNode(label)),
          click: (e) => { if (ctx.onEmoji) { e.stopPropagation(); ctx.onEmoji(t, img); } },
        },
      });
      return img;
    }
    case "link":
      // plainLinks: somewhere a link can't be clicked anyway (the header
      // topic is itself a button), so draw the text and skip the anchor.
      if (ctx.plainLinks) return document.createTextNode(t.children ? tokensText(t.children) : t.href);
      return h("a", { href: t.href, target: "_blank", rel: "noopener noreferrer nofollow" },
        t.children ? renderTokens(t.children, ctx) : t.href);
    case "heading":
      return h(`h${Math.min(6, t.level + 1)}`, { class: "doc-h" }, renderTokens(t.children, ctx));
    case "paragraph":
      return h("p", {}, renderTokens(t.children, ctx));
    case "list":
      return h(t.ordered ? "ol" : "ul", {}, t.items.map((item) => h("li", {}, renderTokens(item, ctx))));
    case "hr":
      return h("hr");
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
      case "emoji": return `:${t.name}:`;
      case "mention": {
        const u = ctx.user?.(t.id);
        return u ? `@${u.display_name || u.username}` : ts("unknown_user_mention");
      }
      case "spoiler": return "▒▒▒";
      default: return walk(t.children || []);
    }
  }).join("");
  return walk(parse(content));
}

// Messages made only of emoji (up to 27, custom or unicode) are shown large.
const EMOJI_RUN = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}#*0-9])+$/u;
export function jumboCount(content) {
  const tokens = parse(content);
  let count = 0;
  for (const t of tokens) {
    if (t.type === "emoji") { count++; continue; }
    if (t.type !== "text") return 0;
    for (const word of t.text.split(/\s+/).filter(Boolean)) {
      if (!EMOJI_RUN.test(word) || /^[#*0-9]+$/.test(word)) return 0;
      const seg = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter().segment(word)].length : [...word].length;
      count += seg;
    }
  }
  return count <= 27 ? count : 0;
}

// --- documents -------------------------------------------------------------

const DOC_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>"']+)\)/g;

// Inline markdown plus [label](url) links.
export function parseDocInline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(DOC_LINK)) {
    out.push(...parseInline(text.slice(last, m.index)));
    out.push({ type: "link", href: m[2], children: parseInline(m[1]) });
    last = m.index + m[0].length;
  }
  out.push(...parseInline(text.slice(last)));
  return out.filter((t) => t.type !== "text" || t.text);
}

// Block structure of a Markdown document, as tokens.
export function parseDocument(text) {
  const blocks = [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let para = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: "paragraph", children: parseDocInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```([A-Za-z0-9_+-]{0,20})\s*$/.exec(line);
    if (fence) {
      flushPara();
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ type: "codeblock", lang: fence[1] || null, text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: "heading", level: heading[1].length, children: parseDocInline(heading[2].trim()) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); blocks.push({ type: "hr" }); continue; }
    const item = /^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const ordered = !!item[2];
      const items = [];
      while (i < lines.length) {
        const m = /^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || !!m[2] !== ordered) break;
        items.push(parseDocInline(m[3]));
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (line.startsWith("> ") || line === ">") {
      flushPara();
      const quoted = [];
      for (; i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">"); i++) quoted.push(lines[i].slice(2));
      i--;
      blocks.push({ type: "quote", children: parseDocInline(quoted.join("\n")) });
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return blocks;
}

export function renderDocument(text, ctx = {}) {
  return h("div", { class: "doc" }, renderTokens(parseDocument(text), ctx));
}
