import assert from "node:assert/strict";
import test from "node:test";
import { translate, translatePlural } from "./i18n/index.tsx";

test("English copy substitutes template variables without interpreting replacement syntax", () => {
  assert.equal(
    translate("sessionSidebar.exitSignal", { signal: "$&" }),
    "signal $&",
  );
});

test("English plural copy selects singular and plural counts", () => {
  assert.equal(
    translatePlural("fileViewer.unchangedLines", 1),
    "... 1 unchanged line ...",
  );
  assert.equal(
    translatePlural("fileViewer.unchangedLines", 2),
    "... 2 unchanged lines ...",
  );
});
