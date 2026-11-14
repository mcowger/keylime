import assert from "node:assert/strict";
import test from "node:test";

const { normalizeForComparison, samePath, projectIdentityKey } = await import("./paths.ts");


test("normalizes POSIX paths without folding case or backslashes", () => {
  assert.equal(normalizeForComparison("/Users/Me/Projects/"), "/Users/Me/Projects");
  assert.equal(normalizeForComparison("/Users/Me\\Projects"), "/Users/Me\\Projects");
});

test("samePath respects POSIX path casing and backslashes", () => {
  assert.equal(samePath("/home/user/app", "/home/user/app/"), true);
  assert.equal(samePath("/home/user/App", "/home/user/app"), false);
  assert.equal(samePath("/home/user/a\\b", "/home/user/a/b"), false);
});

test("projectIdentityKey matches normalizeForComparison", () => {
  assert.equal(projectIdentityKey("/foo/bar/"), "/foo/bar");
});
