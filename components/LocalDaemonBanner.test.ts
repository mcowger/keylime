import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { createElement } from "react";
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react/pure.js");

const { LocalDaemonBanner, LOCAL_DAEMON_BANNER_DISMISSED_KEY } =
  await import("./LocalDaemonBanner");

const originalWorker = globalThis.Worker;
const workers: FakeWorker[] = [];
type OpenMessage = { id: number; op: string; channel: { kind: string } };
class FakeWorker {
  onmessage:
    | ((event: { data: { id: number; type: string; data: string } }) => void)
    | null = null;
  onerror = null;
  posted: OpenMessage[] = [];
  constructor() {
    workers.push(this);
  }
  postMessage(message: OpenMessage) {
    this.posted.push(message);
  }
}
beforeEach(() => {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.Worker = originalWorker;
});

const local = (fields: {
  status?: string;
  hostVersion?: number;
  daemonManaged?: boolean;
}) => ({
  id: "local",
  label: "",
  status: "offline",
  ompVersion: null,
  platform: null,
  lastSeenAt: null,
  hostVersion: null,
  serverVersion: 3,
  serverPlatform: "linux",
  daemonManaged: true,
  ...fields,
});
const send = (hosts: object[]) => {
  const message = workers[0].posted.findLast(
    (message) => message.op === "open" && message.channel.kind === "hosts",
  );
  assert.ok(message);
  const { id } = message;
  act(() =>
    workers[0].onmessage!({
      data: { id, type: "message", data: JSON.stringify({ hosts }) },
    }),
  );
};
const opens = () =>
  workers[0]?.posted.filter((message) => message.op === "open").length ?? 0;
// The event-stream transport keeps its first worker, so a new mount shows up as one more open.
const mount = async () => {
  const before = opens();
  render(createElement(LocalDaemonBanner));
  await waitFor(() => assert.ok(opens() > before));
};
const text = /needs the keylime-host service/;

test("the install banner appears after 90 s offline, once: dismissing it keeps it away", async (t) => {
  await mount();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  send([local({})]);
  act(() => t.mock.timers.tick(89_999));
  assert.equal(screen.queryByText(text), null);
  act(() => t.mock.timers.tick(1));
  assert.ok(
    screen
      .getByText(text)
      .textContent?.startsWith(
        "This machine needs the keylime-host service. Install it with:",
      ),
  );
  // A foreground keylime has no service: it needs `keylime host` running beside it.
  assert.deepEqual(
    [...screen.getByRole("status").querySelectorAll("code")].map(
      (code) => code.textContent,
    ),
    ["keylime systemd install", "keylime host"],
  );
  assert.match(
    screen.getByRole("status").textContent ?? "",
    /in a terminal or with bunx/,
  );

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  assert.equal(screen.queryByText(text), null);
  assert.ok(localStorage.getItem(LOCAL_DAEMON_BANNER_DISMISSED_KEY));

  cleanup();
  t.mock.timers.reset(); // waitFor needs real timers
  await mount();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  send([local({})]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);
});

test("the live region stays mounted while the banner is hidden", async () => {
  await mount();
  send([local({})]);
  assert.ok(screen.getByRole("status"));
  assert.equal(screen.getByRole("status").childElementCount, 0);
});

test("no banner when the daemon links within 90 s, or has linked before, or in dev mode", async (t) => {
  await mount();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  send([local({})]);
  act(() => t.mock.timers.tick(30_000));
  send([local({ status: "online", hostVersion: 3 })]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);

  // A daemon that linked earlier and dropped is the offline banner's job, not an install hint.
  send([local({ hostVersion: 3 })]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);

  // Dev mode: this machine is offline by design.
  send([local({ daemonManaged: false })]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);
});
