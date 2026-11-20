import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { TestContext } from "node:test";
import { createElement } from "react";
const { act, cleanup, render, screen, waitFor, within } =
  await import("@testing-library/react/pure.js");

const { HostsConfig } = await import("./HostsConfig");

const originalWorker = globalThis.Worker;
// The event-stream transport keeps the first worker it was given for the whole file.
type WorkerPost = { op: string; id: number; channel: { kind: string } };
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage:
    | ((event: { data: { id: number; type: string; data: string } }) => void)
    | null = null;
  onerror = null;
  posted: WorkerPost[] = [];
  constructor() {
    workers.push(this);
  }
  postMessage(message: WorkerPost) {
    this.posted.push(message);
  }
}
afterEach(() => {
  cleanup();
  globalThis.Worker = originalWorker;
});

const member = (hostId: string) => ({
  hostId,
  projectsRoot: `/srv/${hostId}/keylime-cluster`,
  provisioned: true,
  draining: false,
});
const cluster = (...hostIds: string[]) => [
  {
    id: "cluster",
    label: "Cluster",
    enabled: true,
    members: hostIds.map(member),
    projects: [],
  },
];
const hostRow = (overrides: Record<string, unknown> = {}) => ({
  id: "local",
  label: "",
  status: "online",
  ompVersion: "omp/15.13.1",
  platform: "linux",
  hostVersion: 10,
  serverVersion: 10,
  lastSeenAt: null,
  workspaceOps: ["gitOrigins"],
  ...overrides,
});
const linked = (
  id: string,
  label: string,
  overrides: Record<string, unknown> = {},
) =>
  hostRow({
    id,
    label,
    allowAgentStart: false,
    shareCredentials: false,
    ...overrides,
  });
type Pools = ReturnType<typeof cluster>;
type PoolAnswer = Pools | null;
type HostOptions = {
  hosts: ReturnType<typeof hostRow>[];
  pools?:
    | PoolAnswer
    | "pending"
    | Promise<PoolAnswer>
    | (() => PoolAnswer | Promise<PoolAnswer>);
  home?: string | null;
  respond?: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
};

/** `pools: null` makes GET /api/hosts fail, `"pending"` never answers it, a promise answers it once settled (null failing), and a function
 * is asked on every request (null failing); `home: null` makes GET /api/home fail. Other requests go to `respond`. */
async function showHosts(
  t: TestContext,
  {
    hosts,
    pools = [],
    home = "/home/andre",
    respond = async () => Response.json({ pools }),
  }: HostOptions,
) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let snapshot: RequestInit | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url) === "/api/hosts" && method === "GET") {
        snapshot = init;
        if (pools === "pending") return new Promise<Response>(() => {});
        const answer = await (typeof pools === "function" ? pools() : pools);
        return answer === null
          ? new Response("{}", { status: 500 })
          : Response.json({ hosts: [], pools: answer });
      }
      if (String(url).startsWith("/api/home?")) {
        calls.push({ method, url: String(url) });
        return home === null
          ? Response.json({ error: "Host offline" }, { status: 409 })
          : Response.json({ home });
      }
      if (String(url).includes("/updates"))
        return Response.json({ keylime: null, omp: null, operation: null });
      calls.push({
        method,
        url: String(url),
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return respond(url, init);
    },
  );
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  render(createElement(HostsConfig));
  await waitFor(() =>
    assert.ok(
      workers[0].posted.some(
        (message) => message.op === "open" && message.channel.kind === "hosts",
      ),
    ),
  );
  const opened = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  );
  assert.ok(opened);
  const { id } = opened;
  act(() =>
    workers[0].onmessage!({
      data: { id, type: "message", data: JSON.stringify({ hosts }) },
    }),
  );
  await screen.findByRole("button", { name: "Rename This machine" });
  const frame = (data: Record<string, unknown>) =>
    act(() =>
      workers[0].onmessage!({
        data: { id, type: "message", data: JSON.stringify(data) },
      }),
    );
  return {
    calls,
    frame,
    snapshotAborted: () => snapshot?.signal?.aborted === true,
  };
}

const rowOf = (name: string) =>
  screen.getByRole("button", { name: `Rename ${name}` }).closest("li")!;

test("this machine's row names the master and has no switch, only while a cluster exists", async (t) => {
  await showHosts(t, {
    hosts: [hostRow(), linked("h1", "Laptop")],
    pools: cluster("local", "h2"),
  });
  const local = rowOf("This machine");
  assert.ok(within(local).getByText("Cluster master"));
  assert.equal(
    within(local).queryByRole("switch", { name: /in the cluster/ }),
    null,
  );
});

test("without a cluster this machine's row has no master label", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: [] });
  assert.equal(screen.queryByText("Cluster master"), null);
  assert.equal(within(rowOf("Laptop")).queryByRole("switch"), null);
});

test("a first pool without this machine gives its row no master label", async (t) => {
  await showHosts(t, {
    hosts: [hostRow(), linked("h1", "Laptop")],
    pools: cluster("h1"),
  });
  assert.equal(screen.queryByText("Cluster master"), null);
});


const configState = (fields: Record<string, unknown> = {}) => ({
  version: "a".repeat(64),
  files: "current",
  plugins: "current",
  error: null,
  missingCommands: [],
  owned: true,
  current: true,
  ...fields,
});
const configLines = (name: string) =>
  within(rowOf(name))
    .queryAllByText(
      /^(Configuration:|Not installed on this host:|Update key lime on this host first)/,
    )
    .map((line) => line.textContent);

for (const [label, overrides, lines] of <
  [string, Record<string, unknown>, string[]][]
>[
  [
    "current",
    { clusterConfig: configState() },
    ["Configuration: same as the master"],
  ],
  [
    "updating",
    { clusterConfig: configState({ plugins: "pending", current: false }) },
    ["Configuration: updating…"],
  ],
  ["not reported yet", {}, ["Configuration: updating…"]],
  [
    "failed",
    {
      clusterConfig: configState({
        files: "failed",
        error: "the master answered 500 for the manifest",
        current: false,
      }),
    },
    ["Configuration: failed — the master answered 500 for the manifest"],
  ],
  [
    "held by another server",
    { clusterConfig: configState({ owned: false, current: false }) },
    [
      "Configuration: held by another key lime server; remove it from that server's cluster first",
    ],
  ],
  [
    "current, with commands it lacks",
    { clusterConfig: configState({ missingCommands: ["uvx", "docker"] }) },
    [
      "Configuration: same as the master",
      "Not installed on this host: uvx, docker",
    ],
  ],
  [
    "offline, with its last report",
    {
      status: "offline",
      clusterConfig: configState({ missingCommands: ["uvx"] }),
    },
    [],
  ],
  ["offline, never reported", { status: "offline" }, []],
]) {
  test(`a member's row states its configuration: ${label}`, async (t) => {
    await showHosts(t, {
      hosts: [hostRow(), linked("h1", "Laptop", overrides)],
    });
    assert.deepEqual(configLines("Laptop"), lines);
  });
}

const MASTER_ERROR = {
  code: "file_too_large",
  message: "rules/big.md is 6000000 bytes, over the 5242880 byte limit",
};
const masterErrors = () =>
  screen
    .queryAllByText(/^Members cannot get this machine's configuration/)
    .map((line) => line.textContent);

test("a master configuration the members cannot get is said once, above the member rows, until it works again", async (t) => {
  const hosts = [hostRow(), linked("h1", "Laptop"), linked("h2", "Desk")];
  const { frame } = await showHosts(t, {
    hosts,
    pools: cluster("local", "h1", "h2"),
  });
  assert.deepEqual(masterErrors(), []);
  frame({ hosts, masterConfigError: MASTER_ERROR });
  assert.deepEqual(masterErrors(), [
    `Members cannot get this machine's configuration: ${MASTER_ERROR.message}`,
  ]);
  const [line] = screen.getAllByText(/^Members cannot get/);
  assert.ok(
    line.compareDocumentPosition(rowOf("Laptop")) & 4,
    "before the rows",
  );
  frame({ hosts });
  assert.deepEqual(masterErrors(), []);
});

test("without linked hosts the server configuration error is not shown", async (t) => {
  const hosts = [hostRow()];
  const { frame } = await showHosts(t, { hosts });
  frame({ hosts, masterConfigError: MASTER_ERROR });
  assert.deepEqual(masterErrors(), []);
});

test("while members cannot get this machine's configuration, no member row says it is updating", async (t) => {
  const hosts = [
    hostRow(),
    linked("h1", "Laptop"),
    linked("h2", "Desk", {
      clusterConfig: configState({ plugins: "pending", current: false }),
    }),
  ];
  const { frame } = await showHosts(t, {
    hosts,
    pools: cluster("local", "h1", "h2"),
  });
  assert.deepEqual(
    [configLines("Laptop"), configLines("Desk")],
    [["Configuration: updating…"], ["Configuration: updating…"]],
  );
  frame({ hosts, masterConfigError: MASTER_ERROR });
  assert.deepEqual([configLines("Laptop"), configLines("Desk")], [[], []]);
});

test("a linked host reports server configuration without cluster membership", async (t) => {
  await showHosts(t, {
    hosts: [
      hostRow(),
      linked("h1", "Laptop", {
        clusterConfig: configState({ owned: false, missingCommands: ["uvx"] }),
      }),
    ],
    pools: cluster("local"),
  });
  assert.equal(configLines("Laptop").length, 2);
  assert.deepEqual(configLines("This machine"), []);
});

