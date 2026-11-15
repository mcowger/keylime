import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "./types";

async function loadSubject() {
  return import("./session-file-references-core");
}

test("detects exact external file paths referenced in session entries", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See [/home/me/.codex/config.toml:12](/home/me/.codex/config.toml:12)",
          },
        ],
      },
    },
  ];

  assert.equal(
    isFilePathReferencedByEntries(
      "/home/me/.codex/config.toml",
      entries as unknown as SessionEntry[],
    ),
    true,
  );
});

test("does not authorize sibling files by prefix match", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See /home/me/.codex/config.toml.bak",
          },
        ],
      },
    },
  ];

  assert.equal(
    isFilePathReferencedByEntries(
      "/home/me/.codex/config.toml",
      entries as unknown as SessionEntry[],
    ),
    false,
  );
});

test("authorizes full output only from a bash execution message", async () => {
  const { isBashOutputPathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/pi-bash-ab12.log";
  const bashEntry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "printf test",
      output: "test",
      fullOutputPath: outputPath,
    },
  };
  const assistantEntry = {
    type: "message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `mentioned ${outputPath}` }],
    },
  };

  assert.equal(
    isBashOutputPathReferencedByEntries(outputPath, [
      bashEntry,
    ] as unknown as SessionEntry[]),
    true,
  );
  assert.equal(
    isBashOutputPathReferencedByEntries(outputPath, [
      assistantEntry,
    ] as unknown as SessionEntry[]),
    false,
  );
  assert.equal(
    isBashOutputPathReferencedByEntries("/tmp/pi-bash-other.log", [
      bashEntry,
    ] as unknown as SessionEntry[]),
    false,
  );
});

test("validates session ids before resolving session paths", async () => {
  const { isValidSessionId } = await loadSubject();

  assert.equal(isValidSessionId("not-a-session-id"), false);
  assert.equal(isValidSessionId("../../sessions/foo"), false);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
});

test("a ~/ mention authorizes exactly that file under the server user's home", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Saved `~/shots/a.png`." }],
      },
    },
  ];

  assert.equal(
    isFilePathReferencedByEntries(
      "/home/me/shots/a.png",
      entries as unknown as SessionEntry[],
      "/home/me",
    ),
    true,
  );
  assert.equal(
    isFilePathReferencedByEntries(
      "/home/me/shots/a.png",
      entries as unknown as SessionEntry[],
    ),
    false,
    "no home, no expansion",
  );
  assert.equal(
    isFilePathReferencedByEntries(
      "/home/other/shots/a.png",
      entries as unknown as SessionEntry[],
      "/home/me",
    ),
    false,
  );
  assert.equal(
    isFilePathReferencedByEntries(
      "/home/me/shots/a.png.bak",
      entries as unknown as SessionEntry[],
      "/home/me",
    ),
    false,
  );
});
