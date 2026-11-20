import assert from "node:assert/strict";
import test from "node:test";
import type { HostStatus } from "@/lib/hosts/host";

import { buildSessionTree, livePlace } from "./SessionSidebar-helpers";
import { groupProjectsByHost } from "../lib/project-ordering";

const hosts = [
  { id: "local", label: "This machine" },
  { id: "h1", label: "Build box" },
];
const selected = { cwd: "/here", hostId: "local" };

test("a running remote session's placeholder project groups under its host, not This machine", () => {
  const place = livePlace(
    "h1:remote-run",
    null,
    { "h1:remote-run": { cwd: "/srv/app", hostId: "h1" } },
    new Map(),
    new Map(),
    selected,
  );
  assert.deepEqual(place, { cwd: "/srv/app", hostId: "h1" });
  const groups = groupProjectsByHost(
    [{ path: place.cwd, hostId: place.hostId }],
    hosts,
  );
  assert.deepEqual(
    groups.map(({ host, projects }) => [host.id, projects.map((p) => p.path)]),
    [
      ["local", []],
      ["h1", ["/srv/app"]],
    ],
  );
});

test("a live session's place comes from the freshest source, with that source's host", () => {
  const optimistic = { id: "s", cwd: "/opt", hostId: "h1" };
  const running = { "h1:s": { cwd: "/run" } };
  const exited = new Map([["h1:s", { cwd: "/exit", hostId: "h1" }]]);
  const known = new Map([["h1:s", { cwd: "/known", hostId: "h1" }]]);
  assert.deepEqual(
    livePlace("h1:s", optimistic, running, exited, known, selected),
    optimistic,
  );
  assert.deepEqual(livePlace("h1:s", null, running, exited, known, selected), {
    cwd: "/run",
  });
  assert.deepEqual(livePlace("h1:s", null, {}, exited, known, selected), {
    cwd: "/exit",
    hostId: "h1",
  });
  assert.deepEqual(livePlace("h1:s", null, {}, new Map(), known, selected), {
    cwd: "/known",
    hostId: "h1",
  });
  // Nothing knows it: the selected workspace, host included.
  assert.deepEqual(
    livePlace("h1:s", null, {}, new Map(), new Map(), selected),
    selected,
  );
});

test("hostsCameOnline: a link-up transition, or a remote host already linked at the first snapshot", async () => {
  const { hostsCameOnline } = await import("./SessionSidebar-helpers");
  const row = (id: string, status: HostStatus) => ({ id, status });
  const local = row("local", "online");
  assert.equal(
    hostsCameOnline(null, [local]),
    false,
    "first snapshot, this machine only: the load has its sessions",
  );
  assert.equal(
    hostsCameOnline(null, [local, row("h1", "offline")]),
    false,
    "first snapshot, remote host offline",
  );
  assert.equal(
    hostsCameOnline(null, [local, row("h1", "online")]),
    true,
    "first snapshot, remote host linked after the load",
  );
  assert.equal(
    hostsCameOnline(
      [local, row("h1", "offline")],
      [local, row("h1", "online")],
    ),
    true,
    "offline -> online",
  );
  assert.equal(
    hostsCameOnline(
      [local, row("h1", "needs-upgrade")],
      [local, row("h1", "omp-missing")],
    ),
    true,
    "linked but unusable -> linked",
  );
  assert.equal(
    hostsCameOnline([local], [local, row("h2", "online")]),
    true,
    "a new host appearing online",
  );
  assert.equal(
    hostsCameOnline([local], [local, row("h2", "offline")]),
    false,
    "a new host appearing offline",
  );
  assert.equal(
    hostsCameOnline([local, row("h1", "online")], [local, row("h1", "online")]),
    false,
    "no status change",
  );
  assert.equal(
    hostsCameOnline(
      [local, row("h1", "online")],
      [local, row("h1", "offline")],
    ),
    false,
    "going offline",
  );
});

test("scores and ancestry do not leak to an identical session id on another host", () => {
  const base = {
    path: "",
    cwd: "/repo",
    created: "",
    modified: "",
    messageCount: 1,
    firstMessage: "",
  };
  const roots = buildSessionTree(
    [
      { ...base, id: "shared", hostId: "h1" },
      { ...base, id: "child", hostId: "h2", parentSessionId: "shared" },
      { ...base, id: "shared" },
    ],
    new Map([["local:shared", 100]]),
  );
  assert.deepEqual(
    roots.map(({ session, children }) => [
      session.id,
      session.hostId,
      children.length,
    ]),
    [
      ["shared", undefined, 0],
      ["shared", "h1", 0],
      ["child", "h2", 0],
    ],
  );
});
