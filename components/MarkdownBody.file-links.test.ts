import assert from "node:assert/strict";
import "../tests/setup-dom.ts";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react/pure.js");

const { MarkdownBody } = await import("./MarkdownBody");

afterEach(cleanup);

function renderChat(markdown: string, opened: string[] = []) {
  return render(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      onOpenFile: (file) => opened.push(file),
      children: markdown,
    }),
  );
}

test("an inline-code path opens the cleaned path in the file panel", () => {
  const opened: string[] = [];
  const { container } = renderChat(
    "Shot: `/var/tmp/omp-sshots-1.webp`, see `src/app.ts:12`, `~/notes/a.md`.",
    opened,
  );
  const links = [...container.querySelectorAll("a")];

  assert.deepEqual(
    links.map((a) => a.textContent),
    ["/var/tmp/omp-sshots-1.webp", "src/app.ts:12", "~/notes/a.md"],
  );
  assert.ok(
    links.every(
      (a) =>
        a.firstElementChild?.tagName === "CODE" && !a.hasAttribute("target"),
    ),
  );
  for (const link of links)
    assert.equal(
      fireEvent.click(link, { button: 0 }),
      false,
      "click default must be prevented",
    );
  assert.deepEqual(opened, [
    "/var/tmp/omp-sshots-1.webp",
    "/home/me/project/src/app.ts",
    "~/notes/a.md",
  ]);
});

test("an inline screenshot and its link resolve from the chat cwd, including parent directories", () => {
  const opened: string[] = [];
  const { container } = renderChat(
    '<img src="../../../var/tmp/omp-sshots-1.webp" alt="Branch picker">\n\n' +
      "[Open screenshot](../../../var/tmp/omp-sshots-1.webp)",
    opened,
  );

  assert.equal(
    container.querySelector('img[alt="Branch picker"]')?.getAttribute("src"),
    "/api/files/var/tmp/omp-sshots-1.webp?type=read&hostId=local",
  );
  assert.equal(
    fireEvent.click(container.querySelector("a")!, { button: 0 }),
    false,
  );
  assert.deepEqual(opened, ["/var/tmp/omp-sshots-1.webp"]);
});

test("a session-local screenshot link opens the file for the resolved session, not its alias", async (t) => {
  const uri = "local://shots/Search%20results%20%231.png";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://keylime.test");
    if (
      url.pathname !== "/api/sessions/alias/local-file" ||
      url.searchParams.get("uri") !== uri
    )
      return new Response(null, { status: 404 });
    return Response.json({
      path: "/remote/session/local/shots/Search results #1.png",
      sessionId: "owner",
    });
  });
  const opened: [string, string | undefined][] = [];
  const { getByRole } = render(
    React.createElement(MarkdownBody, {
      cwd: "/unrelated/workspace",
      sourceSessionId: "alias",
      onOpenFile: (file, owner) => opened.push([file, owner]),
      children: `[Open full-size screenshot](${uri})`,
    }),
  );

  assert.deepEqual(opened, []);
  assert.equal(
    fireEvent.click(getByRole("link", { name: "Open full-size screenshot" })),
    false,
  );
  await waitFor(() =>
    assert.deepEqual(opened, [
      ["/remote/session/local/shots/Search results #1.png", "owner"],
    ]),
  );
});

test("session-local images use the file API, and a missing image is reported inline", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://keylime.test");
    if (
      url.pathname === "/api/sessions/alias/local-file" &&
      url.searchParams.get("uri") === "local://shot.png"
    )
      return Response.json({
        path: "/remote/session/local/shot.png",
        sessionId: "owner",
      });
    return Response.json({ error: "File not found" }, { status: 404 });
  });
  const { findByRole } = render(
    React.createElement(MarkdownBody, {
      sourceSessionId: "alias",
      children:
        "![Screenshot](local://shot.png)\n\n![Missing](local://gone.png)",
    }),
  );

  const preview = await findByRole("img", { name: "Screenshot" });
  assert.equal(
    preview.getAttribute("src"),
    "/api/files/remote/session/local/shot.png?type=read&sessionId=owner",
  );
  assert.match(
    (await findByRole("status")).textContent ?? "",
    /Image unavailable: local:\/\/gone\.png/,
  );
});

test("ordinary code, scheme handles, fenced blocks and escaping paths stay unlinked", () => {
  const opened: string[] = [];
  const { container } = renderChat(
    [
      "`foo.bar()` `foo.bar` `a/b` `x => y` `/compact` `rm -rf /tmp/x` `../outside.ts` `/api/files/a.ts`",
      "`history://abc` `proc://1` `local://plan.md` `https://x.test/a.png` `file:///tmp/a.png`",
      "```\n/var/tmp/a.png\n```",
    ].join("\n\n"),
    opened,
  );

  assert.equal(container.querySelector("a"), null);
  assert.deepEqual(opened, []);
});

test("inline-code paths stay code outside a file-opening view and inside existing links", () => {
  const plain = render(
    React.createElement(MarkdownBody, { children: "`/var/tmp/a.png`" }),
  );
  assert.equal(plain.container.querySelector("a"), null);
  cleanup();

  const { container } = renderChat("[`/var/tmp/a.png`](https://x.test)");
  const links = container.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://x.test");
});

test("an Attached files line opens its upload whatever the name holds", () => {
  const opened: string[] = [];
  const { container } = renderChat(
    [
      "Attached files (this session's local:// directory):",
      "- [`local://uploads/a (1) #2 &amp; 50%.txt`](/home/u/s/local/uploads/a%20%281%29%20%232%20%26amp;%2050%25.txt) (/home/u/s/local/uploads/a (1) #2 &amp; 50%.txt, 10 B, text/plain)",
    ].join("\n"),
    opened,
  );
  const links = [...container.querySelectorAll("a")];
  assert.deepEqual(
    links.map((a) => a.textContent),
    ["local://uploads/a (1) #2 &amp; 50%.txt"],
  );
  for (const link of links)
    assert.equal(
      fireEvent.click(link, { button: 0 }),
      false,
      "click default must be prevented",
    );
  assert.equal(
    fireEvent.click(links[0], { button: 0, ctrlKey: true }),
    false,
    "a modified click opens the file too",
  );
  for (const link of links) {
    const middleClick = new MouseEvent("auxclick", {
      button: 1,
      bubbles: true,
      cancelable: true,
    });
    assert.equal(
      fireEvent(link, middleClick),
      false,
      "middle-click must not navigate to the filesystem href",
    );
  }
  assert.deepEqual(opened, [
    "/home/u/s/local/uploads/a (1) #2 &amp; 50%.txt",
    "/home/u/s/local/uploads/a (1) #2 &amp; 50%.txt",
  ]);
});

test("without a file panel (a remote host's session) a path link renders as its text, not an app URL", () => {
  const { container } = render(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      children:
        "- [`local://uploads/a.txt`](/remote/s/local/uploads/a.txt) (x) and [site](https://x.test)",
    }),
  );
  const links = [...container.querySelectorAll("a")];
  assert.deepEqual(
    links.map((a) => a.getAttribute("href")),
    ["https://x.test"],
  );
  assert.match(container.textContent ?? "", /local:\/\/uploads\/a\.txt/);
});
