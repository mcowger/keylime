import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { ThinkingMarkdown } from "./ThinkingMarkdown";

function render(text: string) {
  return renderToStaticMarkup(
    React.createElement(ThinkingMarkdown, { children: text }),
  );
}

test("renders the supported thinking subset", () => {
  const html = render(
    "A **bold** and *italic* paragraph with `code`.\n\n- first\n- second\n\n```js\nhello()\n```",
  );
  assert.match(html, /<p[^>]*>A <strong>bold<\/strong> and <em>italic<\/em>/);
  assert.match(html, /<code[^>]*>code<\/code>/);
  assert.match(html, /<ul[^>]*>/);
  assert.match(html, /<li[^>]*>first<\/li>/);
  assert.match(html, /<pre[^>]*><code[^>]*>hello\(\)/);
});

test("leaves unsupported constructs literal without external content", () => {
  const html = render(
    "# Heading\n\n| a | b |\n| - | - |\n| c | d |\n\n![alt](https://example.com/image.png)\n\n$x^2$\n\n```mermaid\ngraph TD; A-->B\n```",
  );
  assert.match(html, /# Heading/);
  assert.match(html, /\| a \| b \|/);
  assert.match(
    html,
    /<span style="white-space:pre-wrap;font-size:inherit">\| a \| b \|\n\| - \| - \|\n\| c \| d \|<\/span>/,
  );
  assert.match(html, /!\[alt\]\(https:\/\/example.com\/image.png\)/);
  assert.match(html, /\$x\^2\$/);
  assert.match(html, /<pre[^>]*><code[^>]*>graph TD; A--&gt;B/);
  assert.doesNotMatch(html, /<(?:h[1-6]|table|img|svg)\b|katex|mermaid/i);
});

test("renders incomplete streaming syntax without losing visible content", () => {
  const cases: Array<[string, string]> = [
    ["partial **bold", "partial **bold"],
    ["![alt](https://example.com", "![alt](https://example.com"],
    ["```mermaid\ngraph TD", "graph TD"],
    ["- one\n- tw", "one tw"],
  ];
  for (const [text, expected] of cases) {
    const html = render(text);
    const visible = new JSDOM(html).window.document.body.textContent;
    assert.equal(visible?.replace(/\s+/g, " ").trim(), expected);
    assert.doesNotMatch(html, /<img\b|<svg\b/);
  }
});

test("wait output retains spacing between thinking blocks but not after the last", () => {
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    `<style>${css}</style><div class="tool-call-output-markdown">${render("First\n\nSecond")}</div>`,
    { url: "https://omp.test/" },
  );
  const paragraphs = dom.window.document.querySelectorAll(
    ".thinking-markdown > p",
  );
  assert.equal(
    dom.window.getComputedStyle(paragraphs[0]).marginBottom,
    "0.6em",
  );
  assert.equal(dom.window.getComputedStyle(paragraphs[1]).marginBottom, "0px");
});
