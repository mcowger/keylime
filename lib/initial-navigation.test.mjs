import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(
    new URLSearchParams({
      cwd: " /work/project ",
      session: "saved-session",
    }),
  );

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session" },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(
      new URLSearchParams({ cwd: "  ", session: "saved-session" }),
    ),
    { requestedCwd: null, sessionId: "saved-session" },
  );
});

test("a URL workspace retains its host instead of validating the same path locally", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(
    new URLSearchParams({ cwd: "/projects/remote", hostId: "remote-host" }),
  );
  assert.equal(result.hostId, "remote-host");
  assert.equal(result.requestedCwd, "/projects/remote");
});
