// node client/tests/markdown.test.mjs — tokenizer checks (no DOM needed).
import assert from "node:assert/strict";
import { jumboCount, parse, parseDocument, parseInline, plainText } from "../js/ui/markdown.js";

const t = (text) => ({ type: "text", text });

assert.deepEqual(parseInline("plain"), [t("plain")]);
assert.deepEqual(parseInline("**b** *i* __u__ ~~s~~"), [
  { type: "bold", children: [t("b")] }, t(" "),
  { type: "italic", children: [t("i")] }, t(" "),
  { type: "underline", children: [t("u")] }, t(" "),
  { type: "strike", children: [t("s")] },
]);
assert.deepEqual(parseInline("**bold *nested***"), [
  { type: "bold", children: [t("bold "), { type: "italic", children: [t("nested")] }] },
]);
assert.deepEqual(parseInline("`**not bold**`"), [{ type: "code", text: "**not bold**" }]);
assert.deepEqual(parseInline("snake_case_name stays"), [t("snake_case_name stays")]);
assert.deepEqual(parseInline("_it_"), [{ type: "italic", children: [t("it")] }]);
assert.deepEqual(parseInline("\\*not italic\\*"), [t("*not italic*")]);
assert.deepEqual(parseInline("2 * 3 * 4"), [t("2 * 3 * 4")]);
assert.deepEqual(parseInline("hi <@123> and @everyone"), [
  t("hi "), { type: "mention", id: "123" }, t(" and "), { type: "everyone" },
]);
assert.deepEqual(parseInline("mail@everyone.com"), [t("mail@everyone.com")]);
assert.deepEqual(parseInline("see https://example.com/a?b=1."), [
  t("see "), { type: "link", href: "https://example.com/a?b=1" }, t("."),
]);
assert.deepEqual(parseInline("javascript:alert(1)"), [t("javascript:alert(1)")]);
assert.deepEqual(parseInline("||secret||"), [{ type: "spoiler", children: [t("secret")] }]);
assert.deepEqual(parseInline("<script>alert(1)</script>"), [t("<script>alert(1)</script>")]);

assert.deepEqual(parse("a\n```js\nx = 1\n```\nb"), [
  t("a"), { type: "codeblock", lang: "js", text: "x = 1" }, t("b"),
]);
assert.deepEqual(parse("> quoted\n> more\nafter"), [
  { type: "quote", children: [t("quoted\nmore")] }, t("after"),
]);
assert.deepEqual(parse(">>> all\nof it"), [{ type: "quote", children: [t("all\nof it")] }]);
assert.deepEqual(parse("```\nno lang\n```"), [{ type: "codeblock", lang: null, text: "no lang" }]);

// Every token is a known type and text is never interpreted as markup.
const KNOWN = new Set(["text", "code", "codeblock", "bold", "italic", "underline", "strike", "spoiler", "mention", "everyone", "link", "quote", "emoji"]);
const walk = (toks) => toks.forEach((x) => { assert.ok(KNOWN.has(x.type), x.type); if (x.children) walk(x.children); });
walk(parse("**__~~||*deep* `x` <@1> <:pan:2> https://a.b||~~__** > q\n> q2\n```x```"));

// Pathological input stays fast.
for (const s of ["*".repeat(2000), "**".repeat(1000) + "x", "_".repeat(2000), "||".repeat(1000), "`".repeat(2000), "> ".repeat(1000)]) {
  const start = performance.now();
  parse(s);
  assert.ok(performance.now() - start < 500, `slow parse: ${s.slice(0, 10)}…`);
}
console.log("markdown tokenizer: ok");

// Documents (Terms of Service / Privacy Policy).
const doc = parseDocument("# Rules\n\nBe **nice**.\nReally.\n\n- one\n- two\n\n1. first\n2. second\n\n---\nSee [our site](https://example.com) and [bad](javascript:alert(1)).");
assert.deepEqual(doc[0], { type: "heading", level: 1, children: [t("Rules")] });
assert.deepEqual(doc[1], { type: "paragraph", children: [t("Be "), { type: "bold", children: [t("nice")] }, t(".\nReally.")] });
assert.deepEqual(doc[2], { type: "list", ordered: false, items: [[t("one")], [t("two")]] });
assert.deepEqual(doc[3], { type: "list", ordered: true, items: [[t("first")], [t("second")]] });
assert.deepEqual(doc[4], { type: "hr" });
assert.deepEqual(doc[5].children[1], { type: "link", href: "https://example.com", children: [t("our site")] });
assert.ok(!JSON.stringify(doc[5]).includes('"href":"javascript'));
assert.deepEqual(parseDocument("<h1>x</h1>"), [{ type: "paragraph", children: [t("<h1>x</h1>")] }]);

// Custom emoji (PROTOCOL.md §4 Emoji).
const E = (name, id, animated = false) => ({ type: "emoji", animated, name, id });
assert.deepEqual(parse("hi <:pan_cake:123>"), [t("hi "), E("pan_cake", "123")]);
assert.deepEqual(parse("<a:dance:9>"), [E("dance", "9", true)]);
assert.deepEqual(parse("\\<:pan:1>"), [t("<:pan:1>")]); // escaped
assert.deepEqual(parse("`<:pan:1>`"), [{ type: "code", text: "<:pan:1>" }]); // in code
assert.deepEqual(parse("<:p:1> <:has space:1> <:ok:x>"), [t("<:p:1> <:has space:1> <:ok:x>")]); // malformed
assert.deepEqual(parse("**<:pan:1>**"), [{ type: "bold", children: [E("pan", "1")] }]);
assert.equal(plainText("I <3 <:pan:1>"), "I <3 :pan:");
assert.equal(jumboCount("<:pan:1> 🥞 👍🏽"), 3);
assert.equal(jumboCount("hi 🥞"), 0);
assert.equal(jumboCount("123"), 0);
assert.equal(jumboCount("🥞".repeat(28)), 0);
console.log("custom emoji: ok");
