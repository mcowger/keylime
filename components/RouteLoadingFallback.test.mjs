import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteLoadingFallback } from "./RouteLoadingFallback";

const indexHtml = () =>
  readFile(new URL("../app/index.html", import.meta.url), "utf8");

function semanticNode(node) {
  if (node.nodeType === 3)
    return node.textContent.replace(/\s+/g, " ").trim() || null;
  if (node.nodeType !== 1) return null;
  return {
    tag: node.tagName,
    attributes: [...node.attributes]
      .map(({ name, value }) => [
        name,
        name === "style"
          ? value
              .replace(/\s+/g, " ")
              .replace(/\s*:\s*/g, ":")
              .replace(/\s*;\s*/g, ";")
              .replace(/;$/, "")
              .trim()
          : value,
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
    children: [...node.childNodes].map(semanticNode).filter(Boolean),
  };
}

test("app/index.html carries the RouteLoadingFallback markup in #root", async () => {
  const document = new JSDOM(await indexHtml()).window.document;
  const actual = document.querySelector("#root > .route-fallback");
  const expected = JSDOM.fragment(
    renderToStaticMarkup(createElement(RouteLoadingFallback)),
  ).firstElementChild;
  assert.ok(actual, "no static skeleton in #root");
  assert.deepEqual(
    semanticNode(actual),
    semanticNode(expected),
    "the static skeleton differs from the component",
  );
});

test("the static skeleton stays on app pages and is gone on /login before any bundle runs", async () => {
  const html = await indexHtml();
  for (const [url, shown] of [
    ["http://localhost/", true],
    ["http://localhost/?session=x", true],
    ["http://localhost/login?next=%2F", false],
  ]) {
    // Inline scripts only: JSDOM loads neither the stylesheet nor the module script.
    const { window } = new JSDOM(html, { url, runScripts: "dangerously" });
    assert.equal(
      window.document.querySelector("#root .route-fallback") !== null,
      shown,
      url,
    );
    window.close();
  }
});
