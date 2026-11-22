import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { TestContext } from "node:test";
import { createElement } from "react";
import en from "../lib/i18n/locales/en.json";
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { HostsConfig } = await import("./HostsConfig.tsx");

const originalWorker = globalThis.Worker;
// The event-stream transport keeps the first worker it was given for the whole file.
type OpenMessage = { id: string; op: string; channel: { kind: string } };
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage!: (event: {
    data: { id: string; type: string; data: string };
  }) => void;
  onerror = null;
  posted: OpenMessage[] = [];
  constructor() {
    workers.push(this);
  }
  postMessage(message: OpenMessage) {
    this.posted.push(message);
  }
}
afterEach(() => {
  cleanup();
  globalThis.Worker = originalWorker;
});

function mockHostRequests(
  t: TestContext,
  respond: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      // Configuration discovery is separate from each test's mutation requests.
      if (String(url) === "/api/hosts" && (init?.method ?? "GET") === "GET")
        return Response.json({ hosts: [], pools: [] });
      if (
        String(url).startsWith("/api/worktrees?") &&
        (init?.method ?? "GET") === "GET"
      )
        return Response.json({
          defaults: {
            pre: [],
            create: [],
            postBlocking: [],
            postNonBlocking: [],
          },
          override: null,
          source: "manual",
          paseoBlocking: [],
        });
      return respond(url, init);
    },
  );
}

test("the one-time host token survives Escape; only Done closes it", async (t) => {
  // The hosts list rides the shared event-stream worker; a silent one keeps it idle.
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  mockHostRequests(t, async () =>
    Response.json({
      host: { id: "h1", label: "Laptop" },
      token: "tok-once",
      command: "keylime host login --url https://omp.test",
    }),
  );
  render(createElement(HostsConfig));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add host" }));
  const enrollment = within(screen.getByRole("dialog", { name: "Add a host" }));
  assert.ok(
    enrollment.getByText(
      /the host uses its own provider credentials and setup/i,
    ),
  );
  assert.ok(
    enrollment.getByText(
      /this server can run sessions and access files on the host/i,
    ),
  );
  await user.type(screen.getByPlaceholderText("Build server"), "Laptop");
  await user.click(screen.getByRole("button", { name: "Create host" }));
  await screen.findByText("tok-once");

  await user.keyboard("{Escape}");
  // Escape and an outside press both reach onOpenChange(false).
  assert.ok(
    screen.queryByText("tok-once"),
    "Escape must not discard the only copy of the token",
  );

  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => assert.equal(screen.queryByText("tok-once"), null));
});

test("this machine can be renamed but not revoked", async (t) => {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const patches: unknown[] = [];
  mockHostRequests(t, async (url, init) => {
    patches.push([
      init?.method,
      JSON.parse((init?.body as string | undefined) ?? "null"),
    ]);
    return Response.json({});
  });
  render(createElement(HostsConfig));
  const row = (fields: Record<string, unknown>) => ({
    status: "online",
    ompVersion: null,
    platform: null,
    lastSeenAt: null,
    hostVersion: null,
    serverVersion: 3,
    workspaceOps: [],
    ...fields,
  });
  const hosts = [
    row({ id: "local", label: "" }),
    row({ id: "h1", label: "Laptop", allowAgentStart: false }),
  ];
  await waitFor(() =>
    assert.ok(
      workers[0].posted.some(
        (message) => message.op === "open" && message.channel.kind === "hosts",
      ),
    ),
  );
  const { id } = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  )!;
  act(() =>
    workers[0].onmessage({
      data: { id, type: "message", data: JSON.stringify({ hosts }) },
    }),
  );

  const localRow = (
    await screen.findByRole("button", { name: "Rename This machine" })
  ).closest("li");
  assert.ok(localRow);
  assert.equal(
    within(localRow).queryByRole("button", { name: "Revoke" }),
    null,
  );
  assert.ok(
    screen
      .getByRole("button", { name: "Rename Laptop" })
      .closest("li")!
      .textContent!.includes("Revoke"),
  );

  // An empty name is allowed here: it resets to the default.
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Rename This machine" }));
  await user.type(screen.getByPlaceholderText("This machine"), "Desk");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    assert.deepEqual(patches, [["PATCH", { id: "local", label: "Desk" }]]),
  );

  // With a custom name the card and its rename button use it.
  act(() =>
    workers[0].onmessage({
      data: {
        id,
        type: "message",
        data: JSON.stringify({ hosts: [row({ id: "local", label: "Desk" })] }),
      },
    }),
  );
  await screen.findByRole("button", { name: "Rename Desk" });
});

test("an offline this-machine row says to start the service, with the server's install command", async (t) => {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  mockHostRequests(t, async () => Response.json({}));
  render(createElement(HostsConfig));
  const row = (fields: Record<string, unknown>) => ({
    id: "local",
    label: "",
    status: "offline",
    ompVersion: null,
    platform: null,
    lastSeenAt: null,
    hostVersion: null,
    serverVersion: 3,
    workspaceOps: [],
    serverPlatform: "darwin",
    daemonManaged: true,
    ...fields,
  });
  await waitFor(() =>
    assert.ok(
      workers[0].posted.some(
        (message) => message.op === "open" && message.channel.kind === "hosts",
      ),
    ),
  );
  const { id } = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  )!;
  const send = (hosts: ReturnType<typeof row>[]) =>
    act(() =>
      workers[0].onmessage({
        data: { id, type: "message", data: JSON.stringify({ hosts }) },
      }),
    );

  send([row({})]);
  const hint = await screen.findByText(/keylime-host service/);
  const hintRow = hint.closest("li");
  assert.ok(hintRow);
  assert.deepEqual(
    [...hintRow.querySelectorAll("code")].map((code) => code.textContent),
    ["keylime launchd install", "keylime host"],
  );
  assert.match(hintRow.textContent!, /in a terminal or with bunx/);
  // The commands are copyable; the local row still has no Revoke.
  assert.equal(within(hintRow).queryByRole("button", { name: "Revoke" }), null);

  send([row({ serverPlatform: "linux" })]);
  assert.equal(
    (await screen.findByText(/keylime-host service/))
      .closest("li")!
      .querySelector("code")!.textContent,
    "keylime systemd install",
  );

  // Dev mode: offline by design, nothing to install.
  send([row({ daemonManaged: false })]);
  await waitFor(() =>
    assert.equal(screen.queryByText(/keylime-host service/), null),
  );

  send([row({ status: "online", hostVersion: 2, serverVersion: 3 })]);
  await waitFor(() =>
    assert.equal(screen.queryByText(/keylime-host service/), null),
  );
  // The daemon's protocol on its row, the web app's in the header; a needs-upgrade status already names both.
  assert.match(
    screen.getByRole("button", { name: "Rename This machine" }).closest("li")!
      .textContent!,
    /link protocol v2/,
  );
  screen.getByText("This web app expects link protocol v3.");
  send([row({ status: "needs-upgrade", hostVersion: 2, serverVersion: 3 })]);
  await waitFor(() =>
    assert.doesNotMatch(
      screen.getByRole("button", { name: "Rename This machine" }).closest("li")!
        .textContent!,
      /link protocol v2/,
    ),
  );
});

test("the local name hint is the input's description, not part of its label", async (t) => {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  mockHostRequests(t, async () => Response.json({}));
  render(createElement(HostsConfig));
  const row = {
    id: "local",
    label: "",
    status: "online",
    ompVersion: null,
    platform: null,
    lastSeenAt: null,
    hostVersion: 3,
    serverVersion: 3,
    workspaceOps: [],
    serverPlatform: "linux",
    daemonManaged: true,
  };
  await waitFor(() =>
    assert.ok(
      workers[0].posted.some(
        (message) => message.op === "open" && message.channel.kind === "hosts",
      ),
    ),
  );
  const { id } = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  )!;
  act(() =>
    workers[0].onmessage({
      data: { id, type: "message", data: JSON.stringify({ hosts: [row] }) },
    }),
  );
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "Rename This machine" }));
  // The label stays just "Name": the hint is not inside it.
  screen.getByRole("textbox", { name: "Name" });
  assert.equal(
    screen.getByRole("textbox").getAttribute("aria-describedby"),
    screen.getByText(/Leave empty/).id,
  );
});

const hostRow = (overrides: Record<string, unknown> = {}) => ({
  id: "local",
  label: "",
  status: "online",
  ompVersion: "1.0.0",
  platform: "linux",
  hostVersion: 3,
  serverVersion: 3,
  lastSeenAt: null as string | null,
  workspaceOps: [],
  ...overrides,
});
async function showHosts(hosts: ReturnType<typeof hostRow>[]) {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const view = render(createElement(HostsConfig));
  await waitFor(() =>
    assert.ok(
      workers[0].posted.some(
        (message) => message.op === "open" && message.channel.kind === "hosts",
      ),
    ),
  );
  const { id } = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  )!;
  act(() =>
    workers[0].onmessage({
      data: { id, type: "message", data: JSON.stringify({ hosts }) },
    }),
  );
  return view;
}

test("staging shows the host recovery path when the confirmation body stalls", async (t) => {
  let uploadId = "";
  mockHostRequests(t, async (url, init) => {
    if (String(url) === "/api/uploads") {
      const upload = JSON.parse(String(init?.body));
      uploadId = upload.id;
      return Response.json({ received: upload.size });
    }
    assert.equal(String(url), "/api/hosts/local/artifacts");
    const signal = init?.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      }),
    );
  });
  const user = userEvent.setup();
  await showHosts([hostRow({ canStageArtifact: true })]);
  await user.click(
    screen.getByRole("button", { name: "Stage artifact on This machine" }),
  );
  const dialog = within(screen.getByRole("dialog"));
  await user.upload(
    dialog.getByLabelText("Local file"),
    new File(["bytes"], "runner"),
  );
  const form = dialog.getByRole<HTMLButtonElement>("button", {
    name: "Stage artifact",
  }).form!;

  t.mock.timers.enable({ apis: ["setTimeout"] });
  await act(async () => {
    fireEvent.submit(form);
  });
  assert.ok(dialog.getByText("Finishing on the host…"));
  await act(async () => t.mock.timers.tick(40_000));
  t.mock.timers.reset();

  assert.match(
    dialog.getByRole("alert").textContent ?? "",
    /couldn't be confirmed/,
  );
  assert.ok(dialog.getByText(`<agent dir>/keylime/host-artifacts/${uploadId}`));
  await user.click(dialog.getByRole("button", { name: "Close" }));
  assert.equal(screen.queryByRole("dialog"), null);
});

test("staged artifact install review warns about interrupted host work", async (t) => {
  mockHostRequests(t, async (url, init) => {
    if (String(url) === "/api/uploads") {
      const upload = JSON.parse(String(init?.body));
      return Response.json({ received: upload.size });
    }
    assert.equal(String(url), "/api/hosts/h1/artifacts");
    return Response.json({ path: "/tmp/staged/runner" });
  });
  const user = userEvent.setup();
  await showHosts([
    hostRow({
      id: "h1",
      label: "Laptop",
      canStageArtifact: true,
      canActivateArtifact: true,
    }),
  ]);
  await user.click(
    screen.getByRole("button", { name: "Stage artifact on Laptop" }),
  );
  const dialog = within(screen.getByRole("dialog"));
  await user.upload(
    dialog.getByLabelText("Local file"),
    new File(["bytes"], "runner"),
  );
  fireEvent.submit(
    dialog.getByRole<HTMLButtonElement>("button", { name: "Stage artifact" })
      .form!,
  );
  await dialog.findByText("File staged. Nothing was installed or restarted.");
  await user.type(
    dialog.getByLabelText("Expected SHA-256 (64 hex digits)"),
    "a".repeat(64),
  );
  await user.click(dialog.getByRole("button", { name: "Review install" }));
  assert.ok(
    dialog.getByText(
      "Replace Keylime on Laptop with the staged file and restart the Keylime service? The restart stops active agent sessions, terminals, and host work. Pending work and results may be interrupted or lost.",
    ),
  );
  assert.ok(dialog.getByRole("button", { name: "Install & restart" }));
});

test("unverified releases require review and can be deployed", async (t) => {
  const deployments: unknown[] = [];
  mockHostRequests(t, async (url, init) => {
    assert.equal(String(url), "/api/hosts/h1/releases");
    if (init?.method === "POST") {
      deployments.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ type: "result", result: { state: "succeeded" } }) +
          "\n",
      );
    }
    return Response.json({
      releases: [
        {
          id: "build-a",
          builtAt: "2026-11-20T00:00:00Z",
          status: "unverified",
        },
        {
          id: "build-b",
          builtAt: "2026-11-19T00:00:00Z",
          status: "unknown",
        },
        {
          id: "build-c",
          builtAt: "2026-11-18T00:00:00Z",
          status: "installed",
        },
      ],
    });
  });
  const user = userEvent.setup();
  await showHosts([
    hostRow({
      id: "h1",
      label: "Laptop",
      arch: "x64",
      canActivateArtifact: true,
    }),
  ]);
  const deploy = screen.getByRole<HTMLButtonElement>("button", {
    name: "Deploy release to Laptop",
  });
  await screen.findByText(en["hostsConfig.releaseComparisonUnverified"]);
  assert.equal(deploy.disabled, false);
  assert.equal(
    screen.queryByText(en["hostsConfig.releaseComparisonDifferent"]),
    null,
  );
  await user.click(deploy);
  const dialog = within(screen.getByRole("dialog"));
  assert.ok(dialog.getByText(en["hostsConfig.releaseComparisonUnverified"]));
  const review = dialog.getByRole<HTMLButtonElement>("button", {
    name: "Review deployment",
  });
  assert.equal(review.disabled, false);

  assert.equal(deployments.length, 0);
  await user.click(review);
  assert.ok(
    dialog.getByText(
      "Deploy build-a to Laptop? This replaces the Keylime daemon and runner and restarts the Keylime host service. The restart stops active agent sessions, terminals, and host work. Pending work and results may be interrupted or lost.",
    ),
  );
  assert.ok(dialog.getByText(en["hostsConfig.releaseUnverifiedWarning"]));
  assert.equal(deployments.length, 0);
  await user.click(dialog.getByRole("button", { name: "Deploy & restart" }));
  await waitFor(() => assert.equal(deployments.length, 1));
  assert.match(JSON.stringify(deployments[0]), /"releaseId":"build-a"/);
  await dialog.findByText(
    "Deployed build-a to Laptop and confirmed the restart.",
  );
});

test("unknown and installed newest releases cannot be deployed", async (t) => {
  mockHostRequests(t, async (url) => {
    const status = String(url).includes("/h1/") ? "unknown" : "installed";
    return Response.json({
      releases: [{ id: "build-a", builtAt: "2026-11-20T00:00:00Z", status }],
    });
  });
  await showHosts([
    hostRow({
      id: "h1",
      label: "Laptop",
      arch: "x64",
      canActivateArtifact: true,
    }),
    hostRow({
      id: "h2",
      label: "Server",
      arch: "x64",
      canActivateArtifact: true,
    }),
  ]);
  await screen.findByText(en["hostsConfig.releaseComparisonFailed"]);
  await screen.findByText(en["hostsConfig.releaseComparisonCurrent"]);
  assert.equal(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Deploy release to Laptop",
    }).disabled,
    true,
  );
  assert.equal(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Deploy release to Server",
    }).disabled,
    true,
  );
});

test("a same-version host replacement refreshes its build comparison", async (t) => {
  let requests = 0;
  mockHostRequests(t, async (url) => {
    assert.equal(String(url), "/api/hosts/h1/releases");
    requests++;
    return Response.json({
      releases: [
        {
          id: "build-a",
          builtAt: "2026-11-20T00:00:00Z",
          status: requests === 1 ? "unverified" : "installed",
        },
      ],
    });
  });
  const host = {
    ...hostRow({
      id: "h1",
      label: "Laptop",
      arch: "x64",
      canActivateArtifact: true,
    }),
    connectionId: "first",
    lastSeenAt: "2026-11-21T01:00:00Z",
  };
  await showHosts([host]);
  await screen.findByText(en["hostsConfig.releaseComparisonUnverified"]);
  const { id } = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  )!;
  act(() =>
    workers[0].onmessage({
      data: {
        id,
        type: "message",
        data: JSON.stringify({
          hosts: [{ ...host, lastSeenAt: "2026-11-21T02:00:00Z" }],
        }),
      },
    }),
  );
  assert.equal(requests, 1);
  act(() =>
    workers[0].onmessage({
      data: {
        id,
        type: "message",
        data: JSON.stringify({
          hosts: [{ ...host, connectionId: "replacement" }],
        }),
      },
    }),
  );
  await screen.findByText(en["hostsConfig.releaseComparisonCurrent"]);
  assert.equal(requests, 2);
});

test("release catalog requests are aborted when the card unmounts", async (t) => {
  const signals: AbortSignal[] = [];
  mockHostRequests(t, async (url, init) => {
    assert.equal(String(url), "/api/hosts/h1/releases");
    const signal = init?.signal;
    assert.ok(signal);
    signals.push(signal);
    const { promise, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
    return promise;
  });
  const view = await showHosts([
    hostRow({
      id: "h1",
      label: "Laptop",
      arch: "x64",
      canActivateArtifact: true,
    }),
  ]);
  await waitFor(() => assert.equal(signals.length, 1));
  assert.equal(signals[0].aborted, false);
  view.unmount();
  assert.equal(signals[0].aborted, true);
});

test("building an empty release catalog refreshes it without deploying", async (t) => {
  const pending = Promise.withResolvers<Response>();
  const methods: string[] = [];
  mockHostRequests(t, async (url, init) => {
    assert.equal(String(url), "/api/hosts/h1/releases");
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "PUT") return pending.promise;
    return Response.json({
      releases: methods.includes("PUT")
        ? [
            {
              id: "built",
              builtAt: "2026-11-20T00:00:00Z",
              status: "different",
            },
          ]
        : [],
    });
  });
  const host = hostRow({
    id: "h1",
    label: "Laptop",
    arch: "x64",
    canActivateArtifact: true,
    connectionId: "first",
  });
  await showHosts([host]);
  const button = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Build release for Laptop",
  });
  fireEvent.click(button);
  assert.equal(button.disabled, true);
  assert.ok(screen.getByText(en["hostsConfig.buildReleaseBuilding"]));
  fireEvent.click(button);
  assert.deepEqual(methods, ["GET", "PUT"]);

  const { id } = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  )!;
  act(() =>
    workers[0].onmessage({
      data: {
        id,
        type: "message",
        data: JSON.stringify({
          hosts: [{ ...host, lastSeenAt: "2026-11-21T02:00:00Z" }],
        }),
      },
    }),
  );
  assert.equal(button.disabled, true);
  await act(async () => pending.resolve(Response.json({ ok: true })));
  await screen.findByText(en["hostsConfig.releaseComparisonDifferent"]);
  assert.equal(
    screen.queryByRole("button", { name: "Build release for Laptop" }),
    null,
  );
  assert.equal(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Deploy release to Laptop",
    }).disabled,
    false,
  );
  assert.deepEqual(methods, ["GET", "PUT", "GET"]);
});

test("release build errors are shown and can be retried", async (t) => {
  let builds = 0;
  mockHostRequests(t, async (_url, init) => {
    if (init?.method === "PUT") {
      builds++;
      return Response.json(
        { error: "Install the source archive on the server." },
        { status: 400 },
      );
    }
    return Response.json({ releases: [] });
  });
  await showHosts([
    hostRow({
      id: "h1",
      label: "Laptop",
      arch: "x64",
      canActivateArtifact: true,
    }),
  ]);
  const button = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Build release for Laptop",
  });
  fireEvent.click(button);
  assert.equal(
    (await screen.findByRole("alert")).textContent,
    "Install the source archive on the server.",
  );
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  await waitFor(() => assert.equal(builds, 2));
});

test("build progress and failures stay with their host", async (t) => {
  const pending = Promise.withResolvers<Response>();
  const requests: string[] = [];
  mockHostRequests(t, async (url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (method === "PUT") {
      return path.includes("/h1/")
        ? pending.promise
        : Response.json({ ok: false });
    }
    return Response.json({ releases: [] });
  });
  await showHosts([
    hostRow({
      id: "h1",
      label: "Laptop",
      arch: "x64",
      canActivateArtifact: true,
    }),
    hostRow({
      id: "h2",
      label: "Server",
      arch: "x64",
      canActivateArtifact: true,
    }),
  ]);
  const laptop = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Build release for Laptop",
  });
  const server = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Build release for Server",
  });
  fireEvent.click(laptop);
  assert.equal(laptop.disabled, true);
  assert.equal(server.disabled, false);
  fireEvent.click(server);
  assert.equal(
    (await screen.findByRole("alert")).textContent,
    en["hostsConfig.buildReleaseFailed"],
  );
  assert.equal(laptop.disabled, true);
  assert.equal(server.disabled, false);
  await act(async () => pending.resolve(Response.json({ ok: true })));
  await waitFor(() =>
    assert.equal(
      requests.filter((item) => item === "GET /api/hosts/h1/releases").length,
      2,
    ),
  );
  assert.equal(
    requests.filter((item) => item === "GET /api/hosts/h2/releases").length,
    1,
  );
});

test("release builds abort on disconnect and ignore stale results", async (t) => {
  const pending = Promise.withResolvers<Response>();
  let signal: AbortSignal | undefined;
  let catalogs = 0;
  mockHostRequests(t, async (_url, init) => {
    if (init?.method === "PUT") {
      signal = init.signal ?? undefined;
      return pending.promise;
    }
    catalogs++;
    return Response.json({ releases: [] });
  });
  const host = hostRow({
    id: "h1",
    label: "Laptop",
    arch: "x64",
    canActivateArtifact: true,
    connectionId: "first",
  });
  await showHosts([host]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Build release for Laptop" }),
  );
  assert.ok(signal && !signal.aborted);
  const { id } = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  )!;
  act(() =>
    workers[0].onmessage({
      data: {
        id,
        type: "message",
        data: JSON.stringify({ hosts: [{ ...host, status: "offline" }] }),
      },
    }),
  );
  assert.equal(signal.aborted, true);
  assert.equal(
    screen.queryByRole("button", { name: "Build release for Laptop" }),
    null,
  );
  await act(async () => pending.resolve(Response.json({ ok: true })));
  assert.equal(catalogs, 1);
  act(() =>
    workers[0].onmessage({
      data: {
        id,
        type: "message",
        data: JSON.stringify({ hosts: [{ ...host, connectionId: "second" }] }),
      },
    }),
  );
  const button = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Build release for Laptop",
  });
  assert.equal(button.disabled, false);
  assert.equal(catalogs, 2);
});

test("release builds abort when their host card unmounts", async (t) => {
  const pending = Promise.withResolvers<Response>();
  let signal: AbortSignal | undefined;
  mockHostRequests(t, async (_url, init) => {
    if (init?.method === "PUT") {
      signal = init.signal ?? undefined;
      return pending.promise;
    }
    return Response.json({ releases: [] });
  });
  const view = await showHosts([
    hostRow({
      id: "h1",
      label: "Laptop",
      arch: "x64",
      canActivateArtifact: true,
    }),
  ]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Build release for Laptop" }),
  );
  assert.ok(signal && !signal.aborted);
  view.unmount();
  assert.equal(signal.aborted, true);
  await act(async () => pending.resolve(Response.json({ ok: true })));
});
