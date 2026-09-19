// node client/tests/markdown.test.mjs — tokenizer checks (no DOM needed).
import assert from "node:assert/strict";
import { parse, parseInline } from "../js/ui/markdown.js";

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
const KNOWN = new Set(["text", "code", "codeblock", "bold", "italic", "underline", "strike", "spoiler", "mention", "everyone", "link", "quote"]);
const walk = (toks) => toks.forEach((x) => { assert.ok(KNOWN.has(x.type), x.type); if (x.children) walk(x.children); });
walk(parse("**__~~||*deep* `x` <@1> https://a.b||~~__** > q\n> q2\n```x```"));

// Pathological input stays fast.
for (const s of ["*".repeat(2000), "**".repeat(1000) + "x", "_".repeat(2000), "||".repeat(1000), "`".repeat(2000), "> ".repeat(1000)]) {
  const start = performance.now();
  parse(s);
  assert.ok(performance.now() - start < 500, `slow parse: ${s.slice(0, 10)}…`);
}
console.log("markdown tokenizer: ok");
