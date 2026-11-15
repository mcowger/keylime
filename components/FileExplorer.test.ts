import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { FileExplorer } = await import("./FileExplorer");

function render(
  props: Partial<React.ComponentProps<typeof FileExplorer>> = {},
) {
  return renderToStaticMarkup(
    React.createElement(FileExplorer, {
      cwd: "/tmp/project",
      hostId: "local",
      onOpenFile() {},
      ...props,
    }),
  );
}

test("renders the search input only while the search panel is open", () => {
  const closed = render();
  assert.doesNotMatch(
    closed,
    /aria-label="(Search files|fileExplorer\.searchFiles)"/,
  );

  const open = render({ fileSearchOpen: true });
  assert.match(open, /aria-label="(Search files|fileExplorer\.searchFiles)"/);
  assert.match(
    open,
    /placeholder="(Search files\.\.\.|fileExplorer\.searchPlaceholder)"/,
  );
});

test("keeps the regular file tree visible while the search query is empty", () => {
  // An open panel with no query must not hide the tree behind an empty
  // search-results state.
  const open = render({ fileSearchOpen: true });
  assert.match(open, /role="tree"/);
  assert.match(open, /(Loading files\.\.\.|fileExplorer\.loadingFiles)/);
  assert.doesNotMatch(
    open,
    /(No matching files|fileExplorer\.noMatchingFiles)/,
  );
});
