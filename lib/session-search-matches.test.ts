import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageView } from "../components/MessageView";
import type { AgentMessage } from "./types";

// setup-dom leaves these out; jsdom has no CSS.escape (entry ids are hex here).
globalThis.NodeFilter = window.NodeFilter;
if (!globalThis.CSS)
  Object.defineProperty(globalThis, "CSS", {
    value: { escape: (value: string) => value },
    configurable: true,
  });

const { compileSearchQuery, findSearchMatches } =
  await import("./session-search.ts");
const { SEARCH_MATCH_PAGE_SIZE } = await import("./session-search-matches.ts");
const { listSessionMatches, renderedTextNodes } =
  await import("./session-match-listing.ts");
const { elementHits, findTarget } =
  await import("../hooks/useChatSearchHighlights.ts");

function compiled(query: string) {
  const result = compileSearchQuery(query);
  assert.ok(result);
  return result;
}

const marked = (query: string, text: string) =>
  findSearchMatches(text, compiled(query)).map(({ start, end }) =>
    text.slice(start, end),
  );

test("marks exact, partial and typo hits; partial hits mark only the typed term", () => {
  assert.deepEqual(
    marked("pineapple", "Pineapple, pineapples and a pinapple"),
    ["Pineapple", "pineapple", "pinapple"],
  );
  assert.deepEqual(marked("apple", "pineapple"), ["apple"]);
  assert.deepEqual(marked("cat", "car"), []);
});

test("one matching term is enough, and phrases mark verbatim across whitespace without overlapping words", () => {
  assert.deepEqual(marked("login payments", "the login page"), ["login"]);
  assert.deepEqual(marked('"login  page" page', "Login\npage, then page"), [
    "Login\npage",
    "page",
  ]);
  assert.deepEqual(marked('"a.b"', "a.b axb"), ["a.b"]);
  // A blank line (new paragraph) or a hard break renders the words apart, where the chat cannot match a phrase.
  assert.deepEqual(marked('"login page"', "login \n \npage"), []);
  assert.deepEqual(marked('"login page"', "login  \npage"), []);
  assert.deepEqual(marked('"login page"', "login\\\npage"), []);
  assert.deepEqual(marked('"login page"', "login \npage"), ["login \npage"]);
});

test("lists hits best match first, then newest message first, with per-message ordinals", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "pinapple then pineapple", timestamp: 1 },
    {
      role: "assistant",
      model: "test",
      provider: "test",
      content: [
        { type: "text", text: "pineapple" },
        { type: "thinking", thinking: "pineapple" },
        { type: "text", text: "a pineapple" },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "test",
      content: [{ type: "text", text: "pineapple" }],
      timestamp: 3,
    },
  ];
  const { matches, total } = listSessionMatches(
    messages,
    ["u1", "a1", "t1"],
    "pineapple",
  );
  assert.equal(total, 4);
  assert.deepEqual(
    matches.map((hit) => [hit.entryId, hit.ordinal, hit.quality]),
    [
      ["a1", 0, 1],
      ["a1", 1, 1],
      ["u1", 1, 1],
      ["u1", 0, 0.45],
    ],
  );
  assert.deepEqual(
    [matches[3].before, matches[3].match, matches[3].after],
    ["", "pinapple", " then pineapple"],
  );
});

test("returns the best prefix of the ranking and skips malformed messages", () => {
  const messages = [
    { role: "assistant", timestamp: 1 },
    { role: "assistant", content: "kiwi as a bare string", timestamp: 2 },
    { role: "user", timestamp: 3 },
    {
      role: "user",
      content: [
        { type: "text", text: "kiwi kiwi kiwi kiwi kiwi kiwi" },
        { type: "image" },
        { type: "text", text: "kiwi kiwi kiwi kiwi kiwi" },
      ],
      timestamp: 4,
    },
  ];
  const entryIds = ["a1", "a2", "u1", "u2"];
  const first = listSessionMatches(
    messages as unknown as AgentMessage[],
    entryIds,
    "kiwi",
  );
  const more = listSessionMatches(
    messages as unknown as AgentMessage[],
    entryIds,
    "kiwi",
    2 * SEARCH_MATCH_PAGE_SIZE,
  );
  assert.equal(first.total, 12);
  assert.equal(first.matches.length, SEARCH_MATCH_PAGE_SIZE);
  // The user message's text blocks are one body: ordinals continue across them.
  assert.deepEqual(
    first.matches.map((hit) => hit.ordinal),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(
    more.matches.slice(0, SEARCH_MATCH_PAGE_SIZE),
    first.matches,
  );
  assert.deepEqual(
    more.matches
      .slice(SEARCH_MATCH_PAGE_SIZE)
      .map((hit) => [hit.entryId, hit.ordinal]),
    [
      ["u2", 10],
      ["a2", 0],
    ],
  );
});

test("a sidebar phrase match jumps to submitted skill text, not the instructions", () => {
  const message: AgentMessage = {
    role: "custom",
    customType: "skill-prompt",
    display: true,
    content: "Compare default retention.",
    details: { prompt: "Check **expired upload receipts** first." },
  };
  const entryId = "a1";
  const query = '"expired upload receipts"';
  const { matches, total } = listSessionMatches([message], [entryId], query);
  assert.equal(total, 1);
  assert.equal(matches[0]?.match, "expired upload receipts");
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    React.createElement(MessageView, { message, entryId }),
  );
  const { range } = findTarget(container, compiled(query), {
    sessionId: "s",
    entryId: matches[0].entryId,
    ordinal: matches[0].ordinal,
  });
  assert.equal(range?.toString(), "expired upload receipts");
  assert.equal(
    listSessionMatches([message], [entryId], '"default retention"').total,
    0,
  );
});

test("the chat counts a message's hits like the server: code-block chrome and charts are not message text", () => {
  const text = "Copy the text, then copy again.";
  const container = document.createElement("div");
  container.innerHTML = `
    <div data-message-text data-entry-id="a1">
      <div class="markdown-code-header"><span class="markdown-code-lang">text</span><button>Copy</button></div>
      <p>${text.replace("copy again", "<strong>copy</strong> again")}</p>
      <section data-table-chart><span>copy text</span></section>
    </div>`;
  const query = compiled("copy text");
  const { matches } = listSessionMatches(
    [
      {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [{ type: "text", text }],
      },
    ],
    ["a1"],
    "copy text",
  );
  const messageElement = container.querySelector("[data-message-text]");
  assert.ok(messageElement);
  const rendered = elementHits(messageElement, query).map(String);
  assert.deepEqual(rendered, ["Copy", "text", "copy"]);
  for (const match of matches)
    assert.equal(
      String(
        findTarget(container, query, {
          sessionId: "s",
          entryId: "a1",
          ordinal: match.ordinal,
        }).range,
      ),
      match.match,
    );
  assert.equal(
    findTarget(container, query, { sessionId: "s", entryId: "a1", ordinal: 9 })
      .range,
    null,
  );
  // A highlighted code block's line-number gutter is not in the source either.
  const code = document.createElement("div");
  code.innerHTML = `<pre><code><span class="linenumber">2</span><span>x = 2</span></code></pre>`;
  assert.deepEqual(elementHits(code, compiled("2")).map(String), ["2"]);
  assert.equal(
    elementHits(code, compiled("2"))[0].startContainer.parentElement?.className,
    "",
  );
  // GFM footnotes: the generated number, back-link and heading are not in the source; the body is.
  const notes = document.createElement("div");
  notes.innerHTML = `<p>See note<sup><a data-footnote-ref>1</a></sup>. Literal 1 here.</p>
    <section data-footnotes><h2>Footnotes</h2><ol><li><p>body 1 <a data-footnote-backref>↩</a></p></li></ol></section>`;
  assert.deepEqual(
    elementHits(notes, compiled("1")).map(
      (range) => range.startContainer.nodeValue,
    ),
    [". Literal 1 here.", "body 1 "],
  );
  assert.deepEqual(elementHits(notes, compiled("footnotes")), []);
  // The server skips the footnote syntax that rendering replaces, so its ordinals land on the same hits.
  const source = "See note[^1]. Literal 1 here.\n\n[^1]: body 1";
  const { matches: noteMatches } = listSessionMatches(
    [
      {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [{ type: "text", text: source }],
      },
    ],
    ["n1"],
    "1",
  );
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<div data-message-text data-entry-id="n1">${notes.innerHTML}</div>`;
  assert.equal(noteMatches.length, 2);
  for (const match of noteMatches) {
    const range = findTarget(wrapper, compiled("1"), {
      sessionId: "s",
      entryId: "n1",
      ordinal: match.ordinal,
    }).range;
    assert.ok(range);
    assert.equal(
      range.startContainer.nodeValue,
      match.ordinal === 0 ? ". Literal 1 here." : "body 1 ",
    );
  }
  // Footnote syntax written inside code is literal text in the chat, so the server keeps its hits.
  const literal = "Use `[^1]` then 1 more.\n\n```\n[^1]: x\n```";
  const { matches: literalMatches } = listSessionMatches(
    [
      {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [{ type: "text", text: literal }],
      },
    ],
    ["c1"],
    "1",
  );
  const codeDom = document.createElement("div");
  codeDom.innerHTML = `<div data-message-text data-entry-id="c1"><p>Use <code>[^1]</code> then 1 more.</p><pre><code>[^1]: x</code></pre></div>`;
  assert.equal(literalMatches.length, 3);
  for (const match of literalMatches) {
    const range = findTarget(codeDom, compiled("1"), {
      sessionId: "s",
      entryId: "c1",
      ordinal: match.ordinal,
    }).range;
    assert.ok(range);
    assert.equal(
      range.startContainer.nodeValue,
      ["[^1]", " then 1 more.", "[^1]: x"][match.ordinal],
    );
  }
});

test("the server counts only text the chat renders: no link targets, image alt text, math or unreferenced footnotes", () => {
  const source =
    "[pineapple](https://pineapple.example) ![pineapple](p.png) $pineapple$ then **pine**apple pineapple[^b]\n\n[^a]: unused pineapple\n[^b]: noted pineapple";
  assert.deepEqual(renderedTextNodes(source), [
    "pineapple",
    " ",
    " ",
    " then ",
    "pine",
    "apple pineapple",
    "noted pineapple",
  ]);
  const { matches } = listSessionMatches(
    [
      {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [{ type: "text", text: source }],
      },
    ],
    ["p1"],
    "pineapple",
  );
  const dom = document.createElement("div");
  dom.innerHTML = `<div data-message-text data-entry-id="p1"><p><a href="https://pineapple.example">pineapple</a> <img alt="pineapple"> <span class="katex"><span class="katex-html">pineapple</span></span> then <strong>pine</strong>apple pineapple<sup><a data-footnote-ref>1</a></sup></p><section data-footnotes><h2>Footnotes</h2><ol><li><p>noted pineapple <a data-footnote-backref>↩</a></p></li></ol></section></div>`;
  const query = compiled("pineapple");
  assert.equal(matches.length, 3);
  for (const match of matches)
    assert.equal(
      String(
        findTarget(dom, query, {
          sessionId: "s",
          entryId: "p1",
          ordinal: match.ordinal,
        }).range,
      ),
      "pineapple",
    );
  assert.ok(dom.firstElementChild);
  assert.deepEqual(
    elementHits(dom.firstElementChild, query).map(
      (range) => range.startContainer.nodeValue,
    ),
    ["pineapple", "apple pineapple", "noted pineapple "],
  );
  // The snippet shows rendered text, not markdown.
  assert.equal(
    matches.find((match) => match.ordinal === 0)?.after,
    " then pine apple pineapple noted pineapple",
  );
});
