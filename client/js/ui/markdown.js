// Message markdown (PROTOCOL.md §4 Message): **bold**, *italic*, __underline__,
// ~~strike~~, `code`, ```blocks```, > quotes, ||spoilers||, # headings,
// -# subtext, - and 1. lists, links (bare, <quiet> and [masked](url)),
// <t:unix> timestamps, <#channel> chips, <@id> mentions, @everyone and custom
// emoji <:name:id>. Documents (Terms of Service, Privacy Policy;
// PROTOCOL.md §8b) also get paragraphs and rules.
//
// parse() turns text into a token tree without touching the DOM (so it can be
// tested in node); render() builds DOM nodes from it with text nodes only —
// never innerHTML — so message content can't inject markup.

import { fmtRelative, h, mediaUrl } from "./dom.js";
import { scopedT } from "../strings.js";

// Named `ts`, not `t`: this file uses `t` as the token-object parameter name everywhere.
const ts = scopedT("ui/markdown");

const MAX_DEPTH = 6;

// One alternation, named groups, tried left to right at each position. Order
// matters: <https://…> and [label](…) have to win over the bare-link rule.
const INLINE = new RegExp(
  [
    "\\\\(?<esc>[*_~`|\\\\<>@#\\[\\]:-])", // backslash escape
    "(?<ticks>`+)(?<code>[\\s\\S]*?[^`])\\k<ticks>(?!`)", // inline code
    "\\*\\*(?<bold>[\\s\\S]+?)\\*\\*(?!\\*)",
    "__(?<underline>[\\s\\S]+?)__(?!_)",
    "\\*(?=\\S)(?<italic>[\\s\\S]*?\\S)\\*(?!\\*)",
    "(?<![A-Za-z0-9_])_(?=\\S)(?<italicU>[\\s\\S]*?\\S)_(?![A-Za-z0-9_])",
    "~~(?<strike>[\\s\\S]+?)~~",
    "\\|\\|(?<spoiler>[\\s\\S]+?)\\|\\|",
    "<@(?<mention>\\d{1,20})>",
    "(?<![\\w`@])(?<everyone>@everyone)\\b",
    "<#(?<channel>\\d{1,20})>",
    "<t:(?<stamp>-?\\d{1,15})(?::(?<stampStyle>[tTdDfFR]))?>",
    "\\[(?<quietLabel>[^\\[\\]\\n]{1,200})\\]\\(<(?<quietHref>https?:\\/\\/[^\\s<>]+)>\\)",
    "\\[(?<maskLabel>[^\\[\\]\\n]{1,200})\\]\\((?<maskHref>https?:\\/\\/[^\\s)<>\"']+)\\)",
    "<(?<quiet>https?:\\/\\/[^\\s<>]+)>",
    "(?<link>https?:\\/\\/[^\\s<>\"']+)",
    "<(?<anim>a?):(?<emojiName>[A-Za-z0-9_]{2,32}):(?<emojiId>\\d{1,20})>",
  ].join("|"),
  "g",
);

// Where a bare URL really ends. Sentence punctuation isn't part of it, and a
// closing bracket only is when the URL opened one itself — so Wikipedia's
// .../Foo_(bar) keeps its ")" but "(see https://a.b)" doesn't.
export function trimUrl(url) {
  let s = url;
  for (;;) {
    const before = s;
    s = s.replace(/[.,;:!?'"]+$/, "");
    const close = s.slice(-1);
    if (close === ")" || close === "]") {
      const open = close === ")" ? "(" : "[";
      let opens = 0;
      let closes = 0;
      for (const c of s) {
        if (c === open) opens++;
        else if (c === close) closes++;
      }
      if (closes > opens) s = s.slice(0, -1);
    }
    if (s === before) return s;
  }
}

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
    const g = m.groups;
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = (s) => parseInline(s, depth + 1);
    if (g.esc !== undefined) pushText(g.esc);
    else if (g.code !== undefined) push({ type: "code", text: g.code.replace(/^ (.*) $/s, "$1") });
    else if (g.bold !== undefined) push({ type: "bold", children: inner(g.bold) });
    else if (g.underline !== undefined) push({ type: "underline", children: inner(g.underline) });
    else if (g.italic !== undefined) push({ type: "italic", children: inner(g.italic) });
    else if (g.italicU !== undefined) push({ type: "italic", children: inner(g.italicU) });
    else if (g.strike !== undefined) push({ type: "strike", children: inner(g.strike) });
    else if (g.spoiler !== undefined) push({ type: "spoiler", children: inner(g.spoiler) });
    else if (g.mention !== undefined) push({ type: "mention", id: g.mention });
    else if (g.everyone !== undefined) push({ type: "everyone" });
    else if (g.channel !== undefined) push({ type: "channel", id: g.channel });
    else if (g.stamp !== undefined) push({ type: "timestamp", at: Number(g.stamp), style: g.stampStyle || "f" });
    else if (g.quietHref !== undefined) push({ type: "link", href: g.quietHref, children: inner(g.quietLabel), embed: false });
    else if (g.maskHref !== undefined) push({ type: "link", href: g.maskHref, children: inner(g.maskLabel) });
    else if (g.quiet !== undefined) push({ type: "link", href: g.quiet, embed: false });
    else if (g.link !== undefined) {
      // The regex is greedy; trimUrl decides where the link stops and the
      // sentence starts, and the rest is rescanned as text.
      const href = trimUrl(g.link);
      push({ type: "link", href });
      last = m.index + href.length;
      re.lastIndex = last;
    } else if (g.emojiId !== undefined) push({ type: "emoji", animated: g.anim === "a", name: g.emojiName, id: g.emojiId });
  }
  pushText(text.slice(last));
  return out;
}

// --- block structure --------------------------------------------------------

const HEADING = /^(#{1,3})\s+(\S.*)$/;
const SUBTEXT = /^-#\s+(\S.*)$/;
// Up to 8 leading spaces so one level of nesting can be told apart.
const LIST_ITEM = /^( {0,8})(?:([-*])|(\d{1,3})[.)])\s+(.*)$/;

// Reads a run of list lines from `start`. Indented items become one nested
// list inside the item above them; anything deeper joins that nested list.
function takeList(lines, start, depth = 0) {
  const first = LIST_ITEM.exec(lines[start]);
  const ordered = !!first[3];
  const indent = first[1].length;
  const list = { type: "list", ordered, items: [] };
  if (ordered && first[3] !== "1") list.start = Number(first[3]);
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m) break;
    const at = m[1].length;
    if (at < indent) break;
    if (at > indent && depth === 0 && list.items.length) {
      const [sub, next] = takeList(lines, i, depth + 1);
      list.items[list.items.length - 1].push(sub);
      i = next;
      continue;
    }
    if (at === indent && !!m[3] !== ordered) break;
    list.items.push(parseInline(m[4]));
    i++;
  }
  return [list, i];
}

// Splits plain (non-code-block) text into block tokens (quotes, headings,
// subtext, lists) and inline runs.
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
    const sub = SUBTEXT.exec(line);
    if (sub) {
      flush();
      out.push({ type: "subtext", children: parseInline(sub[1]) });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2].trim()) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const [list, next] = takeList(lines, i);
      out.push(list);
      i = next - 1;
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

// --- <t:unix[:style]> timestamps --------------------------------------------

// Formats are Discord's: t/T time, d/D date, f/F date and time, R relative.
// Everything is rendered in the viewer's own zone and locale.
const STAMP_FORMATS = {
  t: { timeStyle: "short" },
  T: { timeStyle: "medium" },
  d: { dateStyle: "short" },
  D: { dateStyle: "long" },
  f: { dateStyle: "long", timeStyle: "short" },
  F: { dateStyle: "full", timeStyle: "short" },
};
const stampFmt = new Map();
const stampFull = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

const relativeStamp = (date) => fmtRelative(date);

function stampText(date, style) {
  if (style === "R") return relativeStamp(date);
  if (!stampFmt.has(style)) stampFmt.set(style, new Intl.DateTimeFormat(undefined, STAMP_FORMATS[style] || STAMP_FORMATS.f));
  return stampFmt.get(style).format(date);
}

// Relative stamps keep counting. One timer redraws every live one each minute
// and drops the ones whose element has left the page.
const liveStamps = new Set();
let stampTimer = null;

function tickStamps() {
  for (const entry of liveStamps) {
    if (!entry.el.isConnected) liveStamps.delete(entry);
    else entry.el.textContent = relativeStamp(entry.date);
  }
  if (!liveStamps.size) {
    clearInterval(stampTimer);
    stampTimer = null;
  }
}

// ctx: { user(id) -> PublicUser|undefined, onMention(id, el),
//        channel(id) -> Channel|undefined, onChannel(id), plainLinks }
export function render(content, ctx = {}) {
  return renderTokens(parse(content), ctx);
}

// Inline-only rendering (bios): no headings, lists or block quotes.
export function renderInline(text, ctx = {}) {
  return renderTokens(parseInline(String(text || "")), ctx);
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
      // A bare link to another message becomes a quote card instead.
      if (!t.children && ctx.quote) {
        const card = ctx.quote(t.href);
        if (card) return card;
      }
      // md-link is what ui/links.js watches for, to warn before leaving.
      return h("a", { class: "md-link", href: t.href, target: "_blank", rel: "noopener noreferrer nofollow" },
        t.children ? renderTokens(t.children, ctx) : t.href);
    case "channel": {
      const channel = ctx.channel?.(t.id);
      const name = channel ? `#${channel.name || channel.title || t.id}` : ts("deleted_channel");
      if (!channel || !ctx.onChannel) return h("span", { class: "md-channel gone" }, name);
      return h("button", {
        class: "md-channel", type: "button",
        on: { click: (e) => { e.stopPropagation(); ctx.onChannel(t.id); } },
      }, name);
    }
    case "timestamp": {
      const date = new Date(t.at * 1000);
      if (Number.isNaN(date.getTime())) return document.createTextNode(`<t:${t.at}>`);
      const el = h("time", { class: "md-ts", datetime: date.toISOString(), title: stampFull.format(date) },
        stampText(date, t.style));
      if (t.style === "R") {
        liveStamps.add({ el, date });
        stampTimer ??= setInterval(tickStamps, 60000);
      }
      return el;
    }
    case "heading":
      return h(`h${Math.min(6, t.level + 1)}`, { class: `doc-h md-h md-h${t.level}` }, renderTokens(t.children, ctx));
    case "subtext":
      return h("div", { class: "md-subtext" }, renderTokens(t.children, ctx));
    case "paragraph":
      return h("p", {}, renderTokens(t.children, ctx));
    case "list":
      return h(t.ordered ? "ol" : "ul", { class: "md-list", start: t.start || null },
        t.items.map((item) => h("li", {}, renderTokens(item, ctx))));
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
      case "link": return t.children ? walk(t.children) : t.href;
      case "channel": {
        const c = ctx.channel?.(t.id);
        return c ? `#${c.name || c.title || t.id}` : ts("deleted_channel");
      }
      case "timestamp": return stampText(new Date(t.at * 1000), t.style);
      case "list": return t.items.map((item) => walk(item)).join(" ");
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

// Inline markdown; [label](url) links now live in parseInline() itself.
export function parseDocInline(text) {
  return parseInline(text).filter((t) => t.type !== "text" || t.text);
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
