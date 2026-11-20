import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  linkHost,
  linkLocalHost,
  ompChild,
  until,
} from "./link-driver.test-helper.ts";
import type { LinkDriver } from "./link-driver.test-helper.ts";
import type { HierarchyRequest } from "../project-hierarchy-types.ts";
import { GET as searchTranscripts } from "../../app/api/sessions/search/route.ts";
import { FIRST_MESSAGE_WEIGHT } from "../session-search.ts";

type Handlers = Parameters<LinkDriver["serve"]>[0];

const hub = await import("./hub.ts");
const index = await import("./session-index.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");
const outbox = await import("../message-outbox.ts");
const { closeNotificationStore } = await import("../notification-store.ts");
const { getRpcSession } = await import("../rpc-manager.ts");
const { resolveSessionHostOr404 } = await import("../api-utils.ts");

const SHARED = "11111111-2222-4333-8444-555555555555";
const OTHER = "11111111-2222-4333-8444-666666666666";
const defaultTimings = { ...hub.linkTimings };

/** Own agent dir (so only this test's hosts are registered), optionally with one session file on this machine's disk. */
function setup(
  t: TestContext,
  { localSessionId }: { localSessionId?: string } = {},
) {
  const agentDir = mkdtempSync(join(tmpdir(), "keylime-session-index-"));
  if (localSessionId) {
    const projectDir = join(agentDir, "sessions", "-project");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      {
        type: "session",
        version: 3,
        id: localSessionId,
        cwd: tmpdir(),
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
    ];
    writeFileSync(
      join(projectDir, "2026-01-01_local.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__ompHostLists = undefined;
  invalidateSessionListCache();
  const links: LinkDriver[] = [];
  t.after(async () => {
    outbox.closeOutboxStore();
    for (const { id } of links)
      await getRpcSession(SHARED, id)?.destroyAndWait();
    closeNotificationStore();
    for (const link of links) hub.closeHostLink(link.id);
    Object.assign(hub.linkTimings, defaultTimings);
    // The hub's held link samples go to this test's agent dir, before it is gone.
    hub.flushLinkSamples();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
  /** Link a host that answers ops from `ops`; a null label links this machine's daemon. */
  return async (label: string | null, ops?: Handlers | null) => {
    const workspaceOps = ops?.hierarchy ? ["hierarchy"] : [];
    const link =
      label === null
        ? await linkLocalHost({ workspaceOps })
        : await linkHost(label, { hello: { workspaceOps } });
    links.push(link);
    if (ops) link.serve(ops);
    return link;
  };
}

/** A session-list entry as a daemon sends it. */
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  path: `/remote/sessions/${id}.jsonl`,
  id,
  cwd: "/remote/project",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hi",
  ...extra,
});

const hierarchy =
  (path: string, sessionIds: string[] = []) =>
  () => ({
    ok: true,
    value: {
      projects: [
        {
          id: `project:${path}`,
          path,
          name: path,
          kind: "directory",
          addedAt: "2026-01-01T00:00:00.000Z",
          workspaces: [
            {
              id: `workspace:${path}`,
              projectId: `project:${path}`,
              path,
              name: path,
              isDefault: true,
              sessionIds,
            },
          ],
        },
      ],
    },
  });

function serveQueuedSession(
  remote: LinkDriver,
  listSessions: Handlers[string],
  ops: Handlers = {},
) {
  const queued: string[] = [];
  const commands: { args: { message: string; clientMessageId?: string } }[] =
    [];
  const native = ompChild(remote, SHARED, {
    state: {
      isStreaming: true,
      supportsClientMessageIds: true,
      queuedMessages: { steering: [], followUp: [] },
    },
  });
  remote.serve(
    {
      ...ops,
      listSessions,
      sessionFileExists: () => true,
      invalidateSessionLists: () => null,
      // A v10 host opens a channel already past the runner's hello; a rejoin (`expectedChannel`) keeps its channel.
      open: (args) => {
        assert.ok(
          args.launch &&
            typeof args.launch === "object" &&
            "cwd" in args.launch,
        );
        return {
          ch: args.expectedChannel ?? "queued-ch",
          joined: args.expectedChannel !== undefined,
          pending: [],
          streaming: null,
          cwd: args.launch.cwd ?? "/remote/project",
          fellBack: false,
          launchAdvisor: false,
          advisorSpawned: false,
          autoApproveExtension: false,
        };
      },
    },
    async (message) => {
      if (message.type === "kill")
        return remote.post({
          type: "exit",
          ch: message.ch,
          code: 0,
          signal: null,
        });
      if (message.type === "stdin") {
        const command = JSON.parse(message.line);
        if (command.t === "cmd" && command.op === "follow_up") {
          commands.push(command);
          queued.push(command.args.message);
          await native(message);
          const event = {
            type: "queue_update",
            steering: [],
            followUp: [...queued],
            clientMessageIds: {
              steering: [],
              followUp: commands.map(
                (command) => command.args.clientMessageId ?? null,
              ),
            },
          };
          return remote.post({
            type: "stdout",
            ch: message.ch,
            line: JSON.stringify({ t: "event", event }),
          });
        }
      }
      return native(message);
    },
  );
  return { queued, commands };
}

test("the same session id is listed and resolved separately on local and remote hosts", async (t) => {
  hub.linkTimings.offlineMs = 30;
  const link = setup(t);
  let localLists = 0;
  let remoteLists = 0;
  await link(null, {
    hierarchy: hierarchy("/remote/project", [SHARED]),
    listSessions: () => {
      localLists += 1;
      return [entry(SHARED)];
    },
  });
  const remote = await link("Remote", {
    hierarchy: hierarchy("/remote/project", [SHARED, OTHER]),
    listSessions: () => {
      remoteLists += 1;
      return [entry(SHARED), entry(OTHER)];
    },
  });
  const sessions = await index.listSessionsAllHosts();
  assert.deepEqual(
    sessions.map((s) => [s.id, s.hostId]),
    [
      [SHARED, "local"],
      [SHARED, remote.id],
      [OTHER, remote.id],
    ],
  );
  index.invalidateHostSessionList("local");
  index.invalidateHostSessionList(remote.id);
  localLists = remoteLists = 0;
  assert.equal((await index.hostForSessionId(SHARED, "local"))?.id, "local");
  assert.equal(localLists, 1, "local lookup refreshes the selected daemon");
  assert.equal(remoteLists, 0, "local lookup never queries the remote daemon");
  localLists = 0;
  assert.equal(
    (await index.hostForSessionId(SHARED, remote.id))?.id,
    remote.id,
  );
  assert.equal(remoteLists, 1, "remote lookup refreshes the selected daemon");
  assert.equal(localLists, 0, "remote lookup never queries the local daemon");
  assert.equal(await index.hostForSessionId(OTHER, "local"), null);
  assert.equal((await index.hostForSessionId(OTHER, remote.id))?.id, remote.id);
  hub.closeHostLink(remote.id);
  assert.equal((await index.hostForSessionId(SHARED, "local"))?.id, "local");
  localLists = 0;
  await assert.rejects(index.hostForSessionId(SHARED, remote.id), {
    code: "host_offline",
  });
  assert.equal(
    localLists,
    0,
    "offline remote lookup never falls back to local",
  );
});

test("transcript search scores only the locally registered copy of a shared session id", async (t) => {
  const link = setup(t, { localSessionId: SHARED });
  let localSessionIds = [SHARED];
  await link(null, {
    hierarchy: () => hierarchy("/local/project", localSessionIds)(),
    listSessions: () => [entry(SHARED)],
  });
  await link("Remote", {
    hierarchy: hierarchy("/remote/project", [SHARED]),
    listSessions: () => [entry(SHARED)],
  });
  const search = async () => {
    const response = await searchTranscripts(
      new Request("http://main.test/app/api/sessions/search?q=hello"),
      { disableIdleTimeout() {} },
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("Content-Type") ?? "",
      /^application\/x-ndjson\b/,
    );
    return (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  assert.deepEqual(await search(), [
    {
      scores: [
        { hostId: "local", sessionId: SHARED, score: FIRST_MESSAGE_WEIGHT },
      ],
    },
  ]);
  localSessionIds = [];
  assert.deepEqual(await search(), [{ scores: [] }]);
});

test("this machine's sessions come from its daemon only, never from the files on disk", async (t) => {
  const link = setup(t, { localSessionId: SHARED });
  assert.deepEqual(
    await index.listSessionsAllHosts(),
    [],
    "no daemon linked: nothing is read here",
  );
  // Unknown is not gone: a 404 would make the client drop the session.
  await assert.rejects(
    index.hostForSessionId(SHARED),
    (error) =>
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      "code" in error &&
      error.status === 503 &&
      error.code === "host_offline",
  );

  await link(null, {
    hierarchy: hierarchy("/srv/app", [SHARED]),
    listSessions: () => [entry(SHARED, { cwd: "/srv/app" })],
  });
  index.invalidateHostSessionList("local");
  assert.deepEqual(
    (await index.listSessionsAllHosts()).map((s) => [s.id, s.hostId, s.path]),
    [[SHARED, "local", `/remote/sessions/${SHARED}.jsonl`]],
  );
  const host = await index.hostForSessionId(SHARED);
  assert.ok(host);
  assert.equal(host, hub.getHost("local"));
  assert.deepEqual(await index.sessionSpawnTarget(SHARED, host), {
    sessionFile: `/remote/sessions/${SHARED}.jsonl`,
    cwd: "/srv/app",
    recordedCwd: "/srv/app",
  });
});

test("a missing local session is authoritative only after the local daemon answers a list", async (t) => {
  const link = setup(t);
  let failing = true;
  await link(null, {
    listSessions: () => {
      if (failing) throw new Error("sessions dir unreadable");
      return [entry(OTHER)];
    },
  });
  await assert.rejects(
    index.hostForSessionId(SHARED),
    (error) =>
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 503,
    "linked, but its list never arrived",
  );
  failing = false;
  assert.equal(await index.hostForSessionId(SHARED), null);
  assert.equal(
    await index.hostForSessionId("not-a-session-id"),
    null,
    "a malformed id is never anyone's",
  );
});

test("a cold-cache remote session is unavailable, not missing, while only the local daemon is online", async (t) => {
  hub.linkTimings.offlineMs = 30;
  const link = setup(t);
  const local = await link(null, { listSessions: () => [] });
  const remote = await link("Laptop", { listSessions: () => [entry(SHARED)] });
  remote.drop();
  await until(
    () => hub.getHost(remote.id)?.status() === "offline",
    "remote host offline",
  );
  Object.assign(hub.linkTimings, defaultTimings);
  await local.dial();
  local.serve({ listSessions: () => [] });
  assert.equal(
    hub.getHost("local")?.status(),
    "online",
    "only the selected remote daemon is offline",
  );
  globalThis.__ompHostLists = undefined;
  const result = await resolveSessionHostOr404(SHARED, remote.id);
  assert.ok("response" in result);
  const { response } = result;
  assert.equal(
    response.status,
    503,
    "an undiscovered session on an offline host must remain retryable",
  );
  const body = await response.json();
  assert.deepEqual(
    [body.code, body.hostOffline, body.delivery],
    ["host_offline", true, "refused"],
  );
  assert.equal(
    await index.hostForSessionId("not-a-session-id"),
    null,
    "malformed ids still fail without host discovery",
  );
});

test("a cold-cache outbox message survives main restart and reaches its remote queue once the host returns", async (t) => {
  hub.linkTimings.offlineMs = 30;
  const link = setup(t);
  const local = await link(null, { listSessions: () => [] });
  const remote = await link("Laptop", { listSessions: () => [entry(SHARED)] });
  remote.drop();
  await until(
    () => hub.getHost(remote.id)?.status() === "offline",
    "remote host offline",
  );
  Object.assign(hub.linkTimings, defaultTimings);
  await local.dial();
  local.serve({ listSessions: () => [] });
  assert.equal(
    hub.getHost("local")?.status(),
    "online",
    "the local daemon has reconnected before replay",
  );
  globalThis.__ompHostLists = undefined;
  const id = "cold-cache-retained";
  const response = await outbox.runOutboxCommand(
    SHARED,
    {
      type: "outbox_add",
      id,
      scope: outbox.outboxScope(),
      mode: "followUp",
      message: "retain my message",
    },
    false,
    "owner",
    { hostId: remote.id },
  );
  assert.equal(response.status, 200, await response.clone().text());
  await until(
    () => outbox.outboxEntries(SHARED, remote.id)[0]?.state === "waiting_host",
    "durable host wait",
  );
  outbox.closeOutboxStore();
  globalThis.__ompHostLists = undefined;
  assert.equal(
    outbox.outboxEntries(SHARED, remote.id)[0].message,
    "retain my message",
    "the accepted payload survives SQLite reopening",
  );
  const waiting = Promise.withResolvers<void>();
  const unwatch = outbox.onOutboxChange(
    SHARED,
    (entries) => {
      if (
        entries.some(
          (entry) => entry.id === id && entry.state === "waiting_host",
        )
      )
        waiting.resolve();
    },
    remote.id,
  );
  t.after(unwatch);
  outbox.startOutbox();
  await waiting.promise;
  await remote.dial();
  const { queued, commands } = serveQueuedSession(remote, () => [
    entry(SHARED),
  ]);
  await until(
    () => outbox.outboxSettlements(SHARED, remote.id).settledIds.includes(id),
    "confirmed remote queue handoff",
  );
  assert.deepEqual(queued, ["retain my message"]);
  assert.equal(
    commands.length,
    1,
    "recovery never creates a second native submission",
  );
  assert.equal(
    getRpcSession(SHARED, remote.id)?.host.id,
    remote.id,
    "the destination daemon owns the recovered queue handoff",
  );
  assert.equal(getRpcSession(SHARED, local.id), undefined);
  assert.deepEqual(outbox.outboxEntries(SHARED, remote.id), []);
  const absent = await resolveSessionHostOr404(OTHER, remote.id);
  assert.ok("response" in absent);
  assert.equal(
    absent.response.status,
    404,
    "the destination's successful list still proves genuine absence",
  );
  outbox.closeOutboxStore();
  const replay = await outbox.runOutboxCommand(
    SHARED,
    {
      type: "outbox_add",
      id,
      scope: outbox.outboxScope(),
      mode: "followUp",
      message: "retain my message",
    },
    false,
    "owner",
    { hostId: remote.id },
  );
  assert.equal((await replay.json()).data.entry.state, "delivered");
  assert.equal(
    commands.length,
    1,
    "a replay after SQLite reopening returns its receipt without another native write",
  );
});

test("a failed remote refresh cannot turn a stale negative list into authoritative absence", async (t) => {
  const link = setup(t);
  await link(null, { listSessions: () => [] });
  let failing = false;
  const remote = await link("Laptop", {
    listSessions: () => {
      if (failing) throw new Error("remote sessions unavailable");
      return [entry(OTHER)];
    },
  });
  await index.listSessionsAllHosts();
  failing = true;
  const unavailable = await resolveSessionHostOr404(SHARED, remote.id);
  assert.ok("response" in unavailable);
  assert.equal(
    unavailable.response.status,
    503,
    "a failed refresh does not prove a missing session was deleted",
  );
  assert.equal(
    (await index.hostForSessionId(OTHER, remote.id))?.id,
    remote.id,
    "positive cached routing remains usable",
  );
  failing = false;
  const missing = await resolveSessionHostOr404(SHARED, remote.id);
  assert.ok("response" in missing);
  assert.equal(missing.response.status, 404);
});

// One list retry waits RETRY_MS (5 s), past bun's default 5 s test timeout.
test(
  "an accepted message retries a linked host's failed list without waiting for a new hello",
  { timeout: 15_000 },
  async (t) => {
    const link = setup(t);
    await link(null, { listSessions: () => [] });
    const remote = await link("Laptop", null);
    let failing = true;
    let requests = 0;
    const { queued, commands } = serveQueuedSession(remote, () => {
      requests += 1;
      if (failing) throw new Error("session list temporarily unavailable");
      return [entry(SHARED)];
    });
    const failedDiscovery = Promise.withResolvers<void>();
    const handedOff = Promise.withResolvers<void>();
    const id = "linked-list-recovery";
    const unwatch = outbox.onOutboxChange(
      SHARED,
      (entries) => {
        if (
          requests >= 4 &&
          entries.some((entry) => entry.id === id && entry.state === "held")
        )
          failedDiscovery.resolve();
        if (outbox.outboxSettlements(SHARED, remote.id).settledIds.includes(id))
          handedOff.resolve();
      },
      remote.id,
    );
    t.after(unwatch);
    outbox.startOutbox();
    const response = await outbox.runOutboxCommand(
      SHARED,
      {
        type: "outbox_add",
        id,
        scope: outbox.outboxScope(),
        mode: "followUp",
        message: "retry discovery",
      },
      false,
      "owner",
      { hostId: remote.id },
    );
    assert.equal(response.status, 200, await response.clone().text());
    await failedDiscovery.promise;
    failing = false;
    assert.equal(hub.getHost(remote.id)?.status(), "online");
    await handedOff.promise;
    assert.deepEqual(queued, ["retry discovery"]);
    assert.equal(commands.length, 1);
  },
);

test("stale successes from invalidated discovery requests cannot prove session absence", async (t) => {
  const link = setup(t);
  const pending: Array<(value: never[]) => void> = [];
  await link(null, {
    listSessions: () => {
      const { promise, resolve } = Promise.withResolvers<never[]>();
      pending.push(resolve);
      return promise;
    },
  });
  const rejected = assert.rejects(
    index.hostForSessionId(SHARED),
    (error) =>
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      "code" in error &&
      error.status === 503 &&
      error.code === "host_sessions_unavailable",
  );
  await until(() => pending.length === 1, "initial discovery request");
  index.invalidateHostSessionList("local");
  pending[0]([]);
  await until(() => pending.length === 2, "miss refresh request");
  index.invalidateHostSessionList("local");
  pending[1]([]);
  await rejected;
});

test("invalidating a warm successful list revokes its negative authority", async (t) => {
  const link = setup(t);
  const pending: Array<(value: never[]) => void> = [];
  let block = false;
  await link(null, {
    listSessions: () => {
      if (!block) return [];
      const { promise, resolve } = Promise.withResolvers<never[]>();
      pending.push(resolve);
      return promise;
    },
  });
  await index.listSessionsAllHosts();
  block = true;
  const rejected = assert.rejects(
    index.hostForSessionId(SHARED),
    (error) =>
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      "code" in error &&
      error.status === 503 &&
      error.code === "host_sessions_unavailable",
  );
  await until(() => pending.length > 0, "warm miss refresh");
  index.invalidateHostSessionList("local");
  pending[0]([]);
  await rejected;
});

test("the hand-driven daemon answers a failed op as keylime host does", async (t) => {
  const link = setup(t);
  const { ProjectPathError } = await import("../project-registry.ts");
  const { HostOpError } = await import("./link-protocol.ts");
  const thrown = {
    bad: new ProjectPathError("invalid_path", "Not a directory"),
    gone: new HostOpError(410, "gone", "Gone"),
    broken: new Error("disk on fire"),
  };
  const remote = await link("Strict", {
    validateCwd: ({ path }) => {
      assert.ok(typeof path === "string" && path in thrown);
      throw thrown[path as keyof typeof thrown];
    },
  });
  const { sessionOps } = hub.getHost(remote.id)!;
  const failure = async (path: string) =>
    sessionOps.validateCwd(path).then(
      () => assert.fail("resolved"),
      ({ status, code, message }) => ({ status, code, message }),
    );
  // Main prefixes the host's label.
  assert.deepEqual(await failure("bad"), {
    status: 400,
    code: "invalid_path",
    message: "Strict: Not a directory",
  });
  assert.deepEqual(await failure("gone"), {
    status: 410,
    code: "gone",
    message: "Strict: Gone",
  });
  assert.deepEqual(await failure("broken"), {
    status: 500,
    code: "host_op_failed",
    message: "Strict: disk on fire",
  });
});

test("a change on this machine's disk drops its list on the daemon and here", async (t) => {
  const link = setup(t);
  let listed = [entry(SHARED)];
  const invalidated: unknown[] = [];
  await link(null, {
    hierarchy: hierarchy("/remote/project", [SHARED, OTHER]),
    listSessions: () => listed,
    invalidateSessionLists: ({ path }) => {
      invalidated.push(path);
      return null;
    },
  });
  assert.deepEqual(
    (await index.listSessionsAllHosts()).map((s) => s.id),
    [SHARED],
  );
  listed = [entry(SHARED), entry(OTHER)];
  index.invalidateLocalSessionLists("/s/new.jsonl");
  await until(() => invalidated.length === 1, "the daemon's invalidation");
  assert.deepEqual(invalidated, ["/s/new.jsonl"]);
  assert.deepEqual(
    (await index.listSessionsAllHosts()).map((s) => s.id),
    [SHARED, OTHER],
  );
});

test("projects list this machine's daemon first, then linked hosts", async (t) => {
  const link = setup(t);
  const remote = await link("Remote", {
    hierarchy: hierarchy("/remote/project", [OTHER]),
    listSessions: () => [entry(OTHER)],
  });
  await link(null, {
    hierarchy: hierarchy(tmpdir()),
    listSessions: () => [],
  });
  assert.deepEqual(
    (await index.listProjectsAllHosts()).map((p) => [p.path, p.hostId]),
    [
      [tmpdir(), "local"],
      ["/remote/project", remote.id],
    ],
  );
});

test("an offline host keeps its last list", async (t) => {
  hub.linkTimings.offlineMs = 30;
  const link = setup(t);
  const remote = await link("Laptop", {
    hierarchy: hierarchy("/remote/project", [OTHER]),
    listSessions: () => [entry(OTHER)],
  });
  assert.deepEqual(
    (await index.listSessionsAllHosts()).map((s) => s.id),
    [OTHER],
  );
  await remote.drop();
  await until(
    () => hub.getHost(remote.id)?.status() === "offline",
    "the host to go offline",
  );
  index.invalidateHostSessionList(remote.id);
  assert.deepEqual(
    (await index.listSessionsAllHosts()).map((s) => [s.id, s.hostId]),
    [[OTHER, remote.id]],
  );
});

test("malformed remote entries are dropped and keep only known fields", async (t) => {
  const link = setup(t);
  const remote = await link("Sloppy", {
    hierarchy: hierarchy("/remote/project", [OTHER, SHARED]),
    listSessions: () => [
      entry(OTHER, { hostId: "local", extra: "x" }),
      entry("../../etc"),
      { ...entry(SHARED), messageCount: "1" },
      null,
    ],
  });
  const sessions = await index.listSessionsAllHosts();
  // As the sessions route serializes them.
  assert.deepEqual(JSON.parse(JSON.stringify(sessions)), [
    { ...entry(OTHER), hostId: remote.id },
  ]);
});

test("a route given an unknown hostId answers 404, a host that is not linked 503", async (t) => {
  setup(t);
  const { POST } = await import("../../app/api/cwd/validate/route.ts");
  const { createHost } = await import("./registry.ts");
  const validate = (hostId: string | undefined) =>
    POST(
      new Request("http://main.test/api/cwd/validate", {
        method: "POST",
        body: JSON.stringify({ cwd: "/w", hostId }),
      }),
    );
  const unknown = await validate("no-such-host");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "host_not_found");
  const { host } = createHost("Asleep");
  const offline = await validate(host.id);
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), {
    error: "Asleep is offline",
    code: "host_offline",
    hostOffline: true,
    delivery: "refused",
  });
  // No hostId is this machine: offline like any host until its daemon links.
  const local = await validate(undefined);
  assert.equal(local.status, 503);
  assert.equal((await local.json()).error, "This machine is offline");
  // A command whose link dropped after it was sent may still run there.
  const { apiErrorResponse } = await import("../../lib/api-utils.ts");
  const { WebRpcError } = await import("../../lib/rpc-manager.ts");
  assert.equal(
    (
      await apiErrorResponse(
        new WebRpcError("Asleep is offline", "host_offline", "unknown"),
      ).json()
    ).delivery,
    "unknown",
  );
});

test("a remote host's session export is always an attachment, even with inline=1", async (t) => {
  const link = setup(t);
  // Daemon output is untrusted: inline, this HTML would run on main's origin.
  const html = '<script>fetch("/api/projects")</script>';
  const remote = await link("Hostile", {
    listSessions: () => [entry(OTHER)],
    exportSession: () => ({ ok: true, value: { html, fileName: "x.html" } }),
  });
  const { GET } = await import("../../app/api/sessions/[id]/export/route.ts");
  const response = await GET(
    new Request(
      `http://main.test/api/sessions/${OTHER}/export?inline=1&hostId=${remote.id}`,
    ),
    { params: Promise.resolve({ id: OTHER }) },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /^attachment;/);
  assert.equal(await response.text(), html);
});

test("project routes register, update and unregister through the owning host hierarchy", async (t) => {
  const link = setup(t);
  const { hierarchyOperation } = await import("./project-hierarchy.ts");
  const route = await import("../../app/api/projects/route.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-project-route-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await link(null, {
    hierarchy: ({ input }) => hierarchyOperation(input as HierarchyRequest),
  });
  const request = (method: string, body: unknown) =>
    new Request("http://main.test/api/projects", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const added = await route.POST(request("POST", { cwd: root }));
  assert.equal(added.status, 200);
  assert.equal((await added.json()).project.path, root);
  const updated = await route.PATCH(
    request("PATCH", { cwd: root, alias: "Renamed" }),
  );
  assert.equal(updated.status, 200);
  assert.equal((await index.listProjectsAllHosts())[0].alias, "Renamed");
  assert.equal(
    (await route.DELETE(request("DELETE", { cwd: root }))).status,
    200,
  );
  assert.deepEqual(await index.listProjectsAllHosts(), []);
});

const archiveInfo = (id: string) => ({
  key: `-srv/${id}.jsonl.gz`,
  id,
  cwd: "/srv/app",
  created: "2026-01-01T00:00:00.000Z",
  archivedAt: "2026-01-02T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hi",
  size: 10,
});
const addTo = (sessionId: string, id: string, hostId: string) =>
  outbox.runOutboxCommand(
    sessionId,
    {
      type: "outbox_add",
      id,
      scope: outbox.outboxScope(),
      mode: "followUp",
      message: "for an archived session",
    },
    false,
    "owner",
    { hostId },
  );
const outboxState = (hostId: string) =>
  globalThis.__keylimeHostOutboxes!.get(hostId)!.state;
const settled = (calls: () => number, count: number, hostId: string) => () =>
  calls() >= count && !outboxState(hostId).busy.has(SHARED);

test("a session archived on a linked host keeps its message held, and a message for a gone session is still refused", async (t) => {
  const link = setup(t);
  await link(null, { listSessions: () => [] });
  let archives = [archiveInfo(SHARED)];
  let archiveCalls = 0;
  const remote = await link("Laptop", {
    listSessions: () => [],
    listArchives: () => {
      archiveCalls += 1;
      return archives;
    },
  });
  const response = await addTo(SHARED, "remote-archived", remote.id);
  assert.equal(response.status, 200, await response.clone().text());
  await until(
    settled(() => archiveCalls, 2, remote.id),
    "the add and the dispatcher both read the host's archive",
  );
  const [held] = outbox.outboxEntries(SHARED, remote.id);
  assert.equal(
    held.state,
    "held",
    "archived there, not gone: it waits for a restore instead of failing",
  );
  assert.equal(
    outboxState(remote.id).retries?.size ?? 0,
    0,
    "waiting for a restore is not a timed retry",
  );

  archives = [];
  outbox.pumpOutbox(SHARED, remote.id);
  await until(
    () => outbox.outboxEntries(SHARED, remote.id)[0]?.state === "failed",
    "failed once the destination no longer archives it",
  );
  const gone = await addTo(SHARED, "remote-gone", remote.id);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).code, "session_not_found");
});

test("a host that cannot list its archive is never proof the session is gone; a passing failure retries, a legacy daemon waits for its next hello", async (t) => {
  const { HostOpError } = await import("./link-protocol.ts");
  const link = setup(t);
  await link(null, { listSessions: () => [] });
  let calls = 0;
  let failure = new Error("archive temporarily unreadable");
  const remote = await link("Flaky", {
    listSessions: () => [],
    listArchives: () => {
      calls += 1;
      throw failure;
    },
  });
  const response = await addTo(SHARED, "archive-unknown", remote.id);
  assert.equal(response.status, 200, await response.clone().text());
  await until(
    settled(() => calls, 2, remote.id),
    "the add and the dispatcher both asked the failing host",
  );
  assert.equal(
    outbox.outboxEntries(SHARED, remote.id)[0].state,
    "held",
    "neither failed nor discarded",
  );
  assert.equal(
    outboxState(remote.id).retries!.size,
    1,
    "a failure that may pass is tried again later",
  );

  // As an older daemon answers the op it does not know: it may hold archives it cannot list, so the message is not
  // failed, and nothing changes until that host's next hello, so no timer polls it.
  for (const timer of outboxState(remote.id).retries!) clearTimeout(timer);
  outboxState(remote.id).retries!.clear();
  failure = new HostOpError(501, "unknown_op", "Unknown host op: listArchives");
  calls = 0;
  outbox.pumpOutbox(SHARED, remote.id);
  await until(
    () => outbox.outboxEntries(SHARED, remote.id)[0]?.state === "waiting_host",
    "waits for the host's next hello",
  );
  assert.equal(calls, 1, "asked once");
  assert.equal(outboxState(remote.id).retries!.size, 0, "no retry timer");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, "and not asked again");
  assert.equal(outbox.outboxEntries(SHARED, remote.id)[0].error, undefined);
});

test("a restore completing after its RPC timeout wakes only its now-active session through sessions_changed, without another hello", async (t) => {
  const link = setup(t);
  await link(null, { listSessions: () => [] });
  const remote = await link("Late restore");
  let restored = false;
  let archiveCalls = 0;
  const finish = Promise.withResolvers<void>();
  const restoring = Promise.withResolvers<void>();
  const archive = archiveInfo(SHARED);
  const { queued, commands } = serveQueuedSession(
    remote,
    () => (restored ? [entry(SHARED)] : []),
    {
      listArchives: () => {
        archiveCalls += 1;
        return restored ? [] : [archive, archiveInfo(OTHER)];
      },
      restoreReserve: () => ({
        ok: true,
        value: { instance: "late-restore-instance" },
      }),
      async restoreArchive() {
        restoring.resolve();
        await finish.promise;
        restored = true;
        // The daemon emits this after changing files, even though the main has stopped waiting for its RPC result.
        await remote.post({ type: "sessions_changed" });
        return { ok: true, value: { sessionId: SHARED } };
      },
    },
  );
  outbox.startOutbox();
  assert.equal((await addTo(SHARED, "late-restored", remote.id)).status, 200);
  await until(
    settled(() => archiveCalls, 2, remote.id),
    "archived message held",
  );
  assert.equal((await addTo(OTHER, "still-archived", remote.id)).status, 200);
  await until(
    () => !outboxState(remote.id).busy.has(OTHER),
    "unrelated archived message held",
  );
  assert.equal(outboxState(remote.id).retries?.size ?? 0, 0);
  const { POST } = await import("../../app/api/sessions/archive/route.ts");
  hub.linkTimings.opTimeoutMs = 100;
  const request = POST(
    new Request("http://main.test/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: remote.id, key: archive.key }),
    }),
  );
  await restoring.promise;
  const response = await request;
  assert.equal(response.status, 504, await response.clone().text());
  assert.equal(
    hub.getHost(remote.id)?.status(),
    "online",
    "no reconnect wakes the dispatcher",
  );
  const before = archiveCalls;
  Object.assign(hub.linkTimings, defaultTimings);
  finish.resolve();
  await until(
    () =>
      outbox
        .outboxSettlements(SHARED, remote.id)
        .settledIds.includes("late-restored"),
    "late restore event wakes delivery",
  );
  assert.deepEqual(queued, ["for an archived session"]);
  assert.equal(commands.length, 1);
  assert.equal(outbox.outboxEntries(OTHER, remote.id)[0].state, "held");
  assert.equal(
    archiveCalls,
    before,
    "the unrelated archived session was not pumped or rechecked",
  );
});

test(
  "sessions_changed during an in-flight list is not lost and a transient event-list failure retries without a hello",
  { timeout: 15_000 },
  async (t) => {
    const link = setup(t);
    await link(null, { listSessions: () => [] });
    const remote = await link("Changing during list");
    let active = false;
    let archiveCalls = 0;
    let phase = "archived";
    const pending = Promise.withResolvers<void>();
    const listed = Promise.withResolvers<void>();
    const { commands } = serveQueuedSession(
      remote,
      async () => {
        if (phase === "pending") {
          phase = "failed";
          listed.resolve();
          await pending.promise;
          return []; // the snapshot predates the second change
        }
        if (phase === "failed") {
          phase = "active";
          throw new Error("temporary list failure");
        }
        return active ? [entry(SHARED)] : [];
      },
      {
        listArchives: () => {
          archiveCalls += 1;
          return [archiveInfo(SHARED)];
        },
      },
    );
    outbox.startOutbox();
    assert.equal(
      (await addTo(SHARED, "event-list-race", remote.id)).status,
      200,
    );
    await until(
      settled(() => archiveCalls, 2, remote.id),
      "archived entry held",
    );
    const receipt = Promise.withResolvers<void>();
    t.after(
      outbox.onOutboxChange(
        SHARED,
        () => {
          if (
            outbox
              .outboxSettlements(SHARED, remote.id)
              .settledIds.includes("event-list-race")
          )
            receipt.resolve();
        },
        remote.id,
      ),
    );
    phase = "pending";
    await remote.post({ type: "sessions_changed" });
    await listed.promise;
    active = true;
    await remote.post({ type: "sessions_changed" });
    pending.resolve();
    await receipt.promise;
    assert.equal(commands.length, 1);
  },
);

test("a restored-session event defers one wake while dispatch is blocked on a stale archive read", async (t) => {
  const link = setup(t);
  await link(null, { listSessions: () => [] });
  const remote = await link("Restore races archive read");
  let active = false;
  const { commands } = serveQueuedSession(
    remote,
    () => (active ? [entry(SHARED)] : []),
    {
      listArchives: () => (active ? [] : [archiveInfo(SHARED)]),
    },
  );
  const ops = hub.getHost(remote.id)!.sessionOps;
  const original = ops.listArchives;
  const pending = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  let reads = 0;
  ops.listArchives = async () => {
    const snapshot = await original();
    if (++reads === 2) {
      captured.resolve();
      await pending.promise;
    }
    return snapshot;
  };
  t.after(() => {
    ops.listArchives = original;
    pending.resolve();
  });
  outbox.startOutbox();
  assert.equal((await addTo(SHARED, "busy-restored", remote.id)).status, 200);
  await captured.promise;
  assert.equal(outboxState(remote.id).busy.has(SHARED), true);
  active = true; // restore has completed on the daemon, but dispatch still holds the archived snapshot
  await remote.post({ type: "sessions_changed" });
  await until(
    () => outboxState(remote.id).wakes!.has(SHARED),
    "event records a wake for the busy dispatcher",
  );
  pending.resolve();
  await until(
    () =>
      outbox
        .outboxSettlements(SHARED, remote.id)
        .settledIds.includes("busy-restored"),
    "claim release consumes the deferred wake",
  );
  assert.equal(
    commands.length,
    1,
    "exactly one delivery, without another event or hello",
  );
  assert.equal(
    outboxState(remote.id).retries?.size ?? 0,
    0,
    "no retry timer wakes it",
  );
  assert.equal(outboxState(remote.id).wakes!.has(SHARED), false);
});

test("failed session-change listings keep at most one retry per host, and a successful event cancels it", async (t) => {
  const link = setup(t);
  await link(null, { listSessions: () => [] });
  let eventMode = false;
  let failing = true;
  let eventLists = 0;
  let archives = 0;
  const remote = await link("Retry coalescing", {
    listSessions: () => {
      if (eventMode) {
        eventLists += 1;
        if (failing) throw new Error("temporary list failure");
      }
      return [];
    },
    listArchives: () => {
      archives += 1;
      return [archiveInfo(SHARED)];
    },
  });
  outbox.startOutbox();
  assert.equal((await addTo(SHARED, "retry-coalesced", remote.id)).status, 200);
  await until(
    settled(() => archives, 2, remote.id),
    "archived entry held",
  );
  eventMode = true;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await remote.post({ type: "sessions_changed" });
    await until(
      () => eventLists === attempt,
      "one listing for each host event",
    );
  }
  failing = false;
  await remote.post({ type: "sessions_changed" });
  await until(() => eventLists === 4, "the successful event is listed");
  // Real loopback RPC remains live while the retry's wall-clock deadline passes.
  await Bun.sleep(outbox.RETRY_MS + 50);
  assert.equal(
    eventLists,
    4,
    "the successful event cancels the scheduled retry",
  );
  assert.equal(
    outbox.outboxEntries(SHARED, remote.id)[0].state,
    "held",
    "still archived, so no dispatch",
  );
  assert.equal(archives, 2, "events do not poll its archive");
});

for (const event of [false, true]) {
  test(
    `a restore removing the archive after dispatch's 404 cannot fail an accepted message (${event ? "with deferred event" : "without event"})`,
    { timeout: 15_000 },
    async (t) => {
      const link = setup(t);
      await link(null, { listSessions: () => [] });
      const remote = await link("Restored between absence checks");
      let active = false;
      const { commands } = serveQueuedSession(
        remote,
        () => (active ? [entry(SHARED)] : []),
        {
          listArchives: () => (active ? [] : [archiveInfo(SHARED)]),
        },
      );
      const ops = hub.getHost(remote.id)!.sessionOps;
      const original = ops.listArchives;
      const captured = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let reads = 0;
      ops.listArchives = async () => {
        if (++reads === 2) {
          captured.resolve(); // dispatch already received session_not_found; its archive lookup is still in flight
          await finish.promise;
        }
        return original();
      };
      t.after(() => {
        ops.listArchives = original;
        finish.resolve();
      });
      const receipt = Promise.withResolvers<void>();
      t.after(
        outbox.onOutboxChange(
          SHARED,
          (entries) => {
            assert.ok(
              entries.every((entry) => entry.state !== "failed"),
              "a restore must never turn the unsent intent into Not sent",
            );
            if (
              outbox
                .outboxSettlements(SHARED, remote.id)
                .settledIds.includes("restore-between-reads")
            )
              receipt.resolve();
          },
          remote.id,
        ),
      );
      outbox.startOutbox();
      assert.equal(
        (await addTo(SHARED, "restore-between-reads", remote.id)).status,
        200,
      );
      await captured.promise;
      active = true; // restoring moved the session out of its archive before archiveState answered
      if (event) {
        await remote.post({ type: "sessions_changed" });
        await until(
          () => outboxState(remote.id).wakes!.has(SHARED),
          "active listing defers its wake",
        );
      }
      finish.resolve();
      await receipt.promise;
      assert.equal(
        commands.length,
        1,
        "the restored session receives its message exactly once",
      );
      if (event)
        assert.equal(
          outboxState(remote.id).retries?.size ?? 0,
          0,
          "deferred wake needs no retry timer",
        );
    },
  );
}

test(
  "a linked host's restore paused in another process after archive capture keeps its outbox held until publication",
  { timeout: 20_000 },
  async (t) => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { gzipSync } = await import("node:zlib");
    const { listArchivedSessionInfos } = await import("../omp/archive.ts");
    const link = setup(t);
    await link(null, { listSessions: () => [] });
    const hostRoot = join(process.env.PI_CODING_AGENT_DIR!, "remote");
    const archiveRoot = join(hostRoot, "archive");
    const sessionsRoot = join(hostRoot, "sessions");
    const ready = join(hostRoot, "captured");
    const resume = join(hostRoot, "resume");
    const key = "-project/session.jsonl.gz";
    const transcript = join(sessionsRoot, "-project", "session.jsonl");
    mkdirSync(join(archiveRoot, "-project"), { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: SHARED,
      cwd: "/remote/project",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const message = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hi" },
    };
    writeFileSync(
      join(archiveRoot, key),
      gzipSync(
        Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(message)}\n`),
      ),
    );
    const remote = await link("Paused capture");
    let archiveCalls = 0;
    const { commands } = serveQueuedSession(
      remote,
      () => (existsSync(transcript) ? [entry(SHARED)] : []),
      {
        listArchives: () => {
          archiveCalls += 1;
          return listArchivedSessionInfos(archiveRoot);
        },
      },
    );
    outbox.startOutbox();
    assert.equal(
      (await addTo(SHARED, "captured-intent", remote.id)).status,
      200,
    );
    await until(
      settled(() => archiveCalls, 2, remote.id),
      "initial archived intent held",
    );
    const archiveModule = new URL("../omp/archive.ts", import.meta.url).href;
    const script = `
    import { mock } from "bun:test";
    const real = { ...(await import("fs")) };
    const ready = ${JSON.stringify(ready)}, resume = ${JSON.stringify(resume)};
    mock.module("fs", () => ({ ...real, renameSync(from, to) {
      const result = real.renameSync(from, to);
      if (String(to).endsWith(".restore-consume")) {
        real.writeFileSync(ready, "");
        const deadline = Date.now() + 15000;
        while (!real.existsSync(resume)) {
          if (Date.now() > deadline) throw new Error("capture barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return result;
    } }));
    const { restoreArchivedSession } = await import(${JSON.stringify(archiveModule)});
    await restoreArchivedSession(${JSON.stringify(key)}, ${JSON.stringify(sessionsRoot)}, ${JSON.stringify(archiveRoot)});
  `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    let restored = false;
    try {
      await until(
        () => existsSync(ready),
        "separate restore process paused after capture",
      );
      assert.equal(
        existsSync(join(archiveRoot, key)),
        false,
        "original archive name is no longer listed",
      );
      assert.equal(existsSync(transcript), false, "session is not active yet");
      outbox.pumpOutbox(SHARED, remote.id);
      await until(
        settled(() => archiveCalls, 3, remote.id),
        "dispatcher finishes discovery during capture",
      );
      assert.equal(
        outbox.outboxEntries(SHARED, remote.id)[0].state,
        "held",
        "private capture is an archive, not permanent absence",
      );
      assert.equal(commands.length, 0);
      assert.equal(
        outboxState(remote.id).retries?.size ?? 0,
        0,
        "capture discovery requires no timer polling",
      );
      writeFileSync(resume, "");
      assert.equal(await child.exited, 0, await stderr);
      restored = true;
      assert.equal(readFileSync(transcript, "utf8").includes(SHARED), true);
      await remote.post({ type: "sessions_changed" });
      await until(
        () =>
          outbox
            .outboxSettlements(SHARED, remote.id)
            .settledIds.includes("captured-intent"),
        "publication event delivers held intent",
      );
      assert.equal(commands.length, 1);
    } finally {
      if (!restored) {
        writeFileSync(resume, "");
        await child.exited;
        await stderr;
      }
    }
  },
);

for (const unavailable of [false, true]) {
  test(`outbox admission rechecks the selected host when restore finishes between its initial 404 and archive read (${unavailable ? "unavailable discovery" : "active discovery"})`, async (t) => {
    const { existsSync } = await import("node:fs");
    const { gzipSync } = await import("node:zlib");
    const { listArchivedSessionInfos, restoreArchivedSession } =
      await import("../omp/archive.ts");
    const link = setup(t);
    await link(null, { listSessions: () => [] });
    const hostRoot = join(process.env.PI_CODING_AGENT_DIR!, "admission-remote");
    const archiveRoot = join(hostRoot, "archive");
    const sessionsRoot = join(hostRoot, "sessions");
    const key = "-project/restored.jsonl.gz";
    const transcript = join(sessionsRoot, "-project", "restored.jsonl");
    mkdirSync(join(archiveRoot, "-project"), { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: SHARED,
      cwd: "/remote/project",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const message = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hi" },
    };
    writeFileSync(
      join(archiveRoot, key),
      gzipSync(
        Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(message)}\n`),
      ),
    );
    const remote = await link("Restored during admission");
    let restored = false;
    let failing = false;
    let missingLists = 0;
    const { commands } = serveQueuedSession(
      remote,
      () => {
        if (failing)
          throw new Error("host discovery unavailable after restore");
        if (!existsSync(transcript)) {
          missingLists += 1;
          return [];
        }
        return [entry(SHARED)];
      },
      {
        async listArchives() {
          if (!restored) {
            assert.ok(
              missingLists >= 2,
              "initial discovery confirmed absence before reading the archive",
            );
            await restoreArchivedSession(key, sessionsRoot, archiveRoot);
            restored = true;
            failing = unavailable;
            // The real event arrives before the entry was admitted; there is nothing yet for its wake to pump.
            await remote.post({ type: "sessions_changed" });
          }
          return listArchivedSessionInfos(archiveRoot);
        },
      },
    );
    outbox.startOutbox();
    const response = await addTo(SHARED, "admission-raced-restore", remote.id);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(restored, true);
    if (unavailable) {
      await until(
        () => !outboxState(remote.id).busy.has(SHARED),
        "uncertain discovery leaves the accepted intent held",
      );
      assert.equal(outbox.outboxEntries(SHARED, remote.id)[0].state, "held");
      assert.equal(commands.length, 0);
      failing = false;
      await remote.post({ type: "sessions_changed" });
    }
    await until(
      () =>
        outbox
          .outboxSettlements(SHARED, remote.id)
          .settledIds.includes("admission-raced-restore"),
      "accepted intent reaches the restored session",
    );
    assert.equal(commands.length, 1);
  });
}
