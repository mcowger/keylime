import assert from "node:assert/strict";
import test from "node:test";

const { encodeFilePathForApi, getFileApiUrl, getFileDirectory, getFileName } =
  await import("./file-paths.ts");

test("file paths preserve literal backslashes", () => {
  assert.equal(encodeFilePathForApi("a/b\\c.txt"), "a/b%5Cc.txt");
  assert.equal(getFileName("a/b\\c.txt"), "b\\c.txt");
  assert.equal(getFileDirectory("a/b\\c.txt"), "a");
});

test("session file URLs omit unknown host hints but retain explicit host assertions", () => {
  const sessionOnly = new URL(
    getFileApiUrl("/shared/image.png", "read", undefined, "remote-session"),
    "http://localhost",
  );
  assert.equal(sessionOnly.searchParams.get("sessionId"), "remote-session");
  assert.equal(sessionOnly.searchParams.has("hostId"), false);
  const explicit = new URL(
    getFileApiUrl("/shared/image.png", "read", "other-host", "remote-session"),
    "http://localhost",
  );
  assert.equal(explicit.searchParams.get("hostId"), "other-host");
  assert.equal(explicit.searchParams.get("sessionId"), "remote-session");
});
