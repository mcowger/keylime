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
