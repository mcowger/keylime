import assert from "node:assert/strict";
import test from "node:test";
import type { Host } from "./hosts/host";
import type { HierarchySnapshot } from "./project-hierarchy-types";
import {
  getWorkspacePrForSession,
  monitorWorkspacePrForSession,
} from "./ship-monitor-start";

const chat = "11111111-1111-4111-8111-111111111111";
const snapshot = (): HierarchySnapshot => ({
  projects: [
    {
      id: "project",
      path: "/project",
      name: "Project",
      kind: "git",
      addedAt: "now",
      workspaces: [
        {
          id: "workspace",
          projectId: "project",
          path: "/worktree",
          name: "Worktree",
          isDefault: false,
          sessionIds: [chat],
          ship: {
            pr: {
              number: 42,
              url: "https://github.com/test/repo/pull/42",
              state: "open",
              checks: "none",
              autoMerge: false,
              cleanup: false,
              checkedAt: "now",
            },
          },
        },
      ],
    },
  ],
});

function hostFor(value: HierarchySnapshot, supported = true): Host {
  return {
    id: "local",
    supportsWorkspaceOp: (name: string) => name !== "hierarchy" || supported,
    workspaceOps: { hierarchy: async () => ({ ok: true, value }) },
  } as unknown as Host;
}

test("monitor lookup refuses missing, ambiguous, unsupported or unsuitable workspaces", async () => {
  const s = snapshot();
  const workspace = s.projects[0].workspaces[0];
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), ""),
    /calling chat/,
  );
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s, false), chat),
    /Update or restart/,
  );
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), "other"),
    /unique registered workspace/,
  );
  s.projects[0].workspaces.push({ ...workspace, id: "other" });
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), chat),
    /unique registered workspace/,
  );
  s.projects[0].workspaces.pop();
  workspace.isDefault = true;
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), chat),
    /linked Git worktree/,
  );
  workspace.isDefault = false;
  workspace.unavailable = true;
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), chat),
    /linked Git worktree/,
  );
  workspace.unavailable = false;
  s.projects[0].kind = "directory";
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), chat),
    /linked Git worktree/,
  );
  s.projects[0].kind = "git";
  workspace.ship = undefined;
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), chat),
    /register_workspace_pr/,
  );
  workspace.ship = snapshot().projects[0].workspaces[0].ship;
  workspace.ship!.pr!.state = "closed";
  await assert.rejects(
    monitorWorkspacePrForSession(hostFor(s), chat),
    /register_workspace_pr/,
  );
});

test("monitor lookup propagates hierarchy errors and reports another chat's watch", async () => {
  const s = snapshot();
  const failed = hostFor(s);
  failed.workspaceOps.hierarchy = async () => ({
    ok: false,
    status: 503,
    code: "host_offline",
    error: "link unavailable",
  });
  await assert.rejects(
    monitorWorkspacePrForSession(failed, chat),
    /link unavailable/,
  );
  s.projects[0].workspaces[0].ship!.pr!.monitor = {
    id: "watch",
    state: "watching",
  };
  assert.deepEqual(await monitorWorkspacePrForSession(hostFor(s), chat), {
    status: "already_monitoring",
    message:
      "This PR is already monitored; the existing watch may deliver to another chat.",
  });
});

test("PR lookup returns the recorded PR and public watch without mutations", async () => {
  const s = snapshot();
  const pr = s.projects[0].workspaces[0].ship!.pr!;
  pr.monitor = { id: "watch", state: "watching" };
  const before = structuredClone(s);
  const host = hostFor(s);
  let calls = 0;
  host.workspaceOps.hierarchy = async (input) => {
    calls++;
    assert.deepEqual(input, { action: "list" });
    return { ok: true, value: s };
  };
  assert.deepEqual(await getWorkspacePrForSession(host, chat), {
    pr: {
      number: 42,
      url: "https://github.com/test/repo/pull/42",
      state: "open",
      checks: "none",
      autoMerge: false,
      cleanup: false,
      checkedAt: "now",
      monitor: { id: "watch", state: "watching" },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(s, before);
  for (const state of ["closed", "merged"] as const) {
    pr.state = state;
    assert.deepEqual(await getWorkspacePrForSession(host, chat), { pr });
  }
});

test("PR lookup reports absence for identifiable workspaces without a record", async () => {
  const s = snapshot();
  const workspace = s.projects[0].workspaces[0];
  workspace.ship = undefined;
  assert.deepEqual(await getWorkspacePrForSession(hostFor(s), chat), {
    pr: null,
  });
  workspace.ship = {};
  workspace.isDefault = true;
  assert.deepEqual(await getWorkspacePrForSession(hostFor(s), chat), {
    pr: null,
  });
  s.projects[0].kind = "directory";
  assert.deepEqual(await getWorkspacePrForSession(hostFor(s), chat), {
    pr: null,
  });
});

test("PR lookup rejects unavailable, ambiguous, unsupported and malformed hierarchy", async () => {
  const s = snapshot();
  const host = hostFor(s);
  await assert.rejects(getWorkspacePrForSession(host, ""), /calling chat/);
  await assert.rejects(
    getWorkspacePrForSession(hostFor(s, false), chat),
    /Update or restart/,
  );
  await assert.rejects(
    getWorkspacePrForSession(host, "other"),
    /unique registered workspace/,
  );
  const workspace = s.projects[0].workspaces[0];
  s.projects[0].workspaces.push({ ...workspace, id: "other" });
  await assert.rejects(
    getWorkspacePrForSession(host, chat),
    /unique registered workspace/,
  );
  s.projects[0].workspaces.pop();
  workspace.unavailable = true;
  await assert.rejects(
    getWorkspacePrForSession(host, chat),
    /workspace is unavailable/,
  );
  const failed = hostFor(s);
  failed.workspaceOps.hierarchy = async () => ({
    ok: false,
    status: 503,
    code: "host_offline",
    error: "link unavailable",
  });
  await assert.rejects(
    getWorkspacePrForSession(failed, chat),
    /link unavailable/,
  );
  const malformed = hostFor({ projects: [{}] } as unknown as HierarchySnapshot);
  await assert.rejects(
    getWorkspacePrForSession(malformed, chat),
    /invalid workspace hierarchy/,
  );
});
