import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Linkified } from "./Linkified.tsx";
import { Markdown } from "./Markdown.tsx";
import { MentionScope, MentionText } from "./Mentions.tsx";

const people = [
  { id: "joe", name: "Joe Liang" },
  { id: "huy", name: "Huy Ngo" },
];
const inScope = (child: React.ReactElement) => renderToStaticMarkup(createElement(MentionScope, { people, me: "joe" }, child));

test("@Names of people in the space are marked, and a mention of you more strongly", () => {
  assert.equal(
    inScope(createElement(MentionText, { text: "@Huy Ngo and @Joe, see joe@x.test" })),
    '<span class="mention">@Huy Ngo</span> and <span class="mention you" title="Mentions you">@Joe</span>, see joe@x.test',
  );
  assert.equal(inScope(createElement(MentionText, { text: "@Nobody here" })), "@Nobody here");
  // With no space around it, text is left as it is.
  assert.equal(renderToStaticMarkup(createElement(MentionText, { text: "@Joe" })), "@Joe");
});

test("chat links and markdown comments mark mentions too, but not inside code or links", () => {
  assert.equal(
    inScope(createElement(Linkified, { text: "@Huy see https://x.test/a." })),
    '<span class="mention">@Huy</span> see <a href="https://x.test/a" target="_blank" rel="noreferrer">https://x.test/a</a>.',
  );
  const md = inScope(createElement(Markdown, { text: "**@Joe Liang** look at `@Huy` and [@Huy](https://x.test)\nthen @Huy", breaks: true }));
  assert.match(md, /<strong><span class="mention you">@Joe Liang<\/span><\/strong>/);
  assert.match(md, /<code>@Huy<\/code>/);
  assert.match(md, /<a [^>]*>@Huy<\/a>/);
  assert.match(md, /<br\/>\s*then <span class="mention">@Huy<\/span>/);
});
