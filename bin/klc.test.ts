import { describe, expect, test } from "bun:test";
import {
  Api,
  inventory,
  isPickerExit,
  matches,
  serverUrl,
  terminalCleanup,
  terminalFrameOutput,
  terminalStatus,
} from "../runner/src/klc";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

describe("klc", () => {
  test("requires explicit opt-in for remote plaintext and rejects credential-bearing origins", () => {
    expect(serverUrl("http://127.0.0.1:30177", false).hostname).toBe(
      "127.0.0.1",
    );
    expect(() => serverUrl("http://example.com", false)).toThrow("--insecure");
    expect(serverUrl("http://example.com", true).hostname).toBe("example.com");
    expect(() =>
      serverUrl("https://user:password@example.com", true),
    ).toThrow();
    expect(() => serverUrl("https://example.com/prefix", false)).toThrow();
  });

  test("searches all metadata terms case-insensitively", () => {
    const entry = {
      target: { id: "id", hostId: "local" },
      title: "Title",
      detail: "detail",
      search: "Title Remote /workspace branch",
    };
    expect(matches(entry, "REMOTE branch")).toBe(true);
    expect(matches(entry, "remote missing")).toBe(false);
  });

  test("Ctrl-] exits the picker rather than entering search", () => {
    expect(isPickerExit("\x1d")).toBe(true);
    expect(isPickerExit("]")).toBe(false);
    expect(isPickerExit("n")).toBe(false);
  });
  test("shows a sanitized status without moving the terminal cursor", () => {
    const status = terminalStatus("Use Ctrl-] to detach\x1b[2J", 80, 24);
    expect(status).toStartWith("\x1b7\x1b[24;1H");
    expect(status).toEndWith("\x1b[0m\x1b8");
    expect(status).toContain("Use Ctrl-] to detach");
    expect(status).not.toContain("\x1b[2J");
  });

  test("keeps notices out of the mirrored terminal and only renders output after a snapshot", () => {
    expect(terminalFrameOutput({ type: "notice" }, true)).toBeUndefined();
    expect(
      terminalFrameOutput({ type: "output", data: "partial" }, false),
    ).toBeUndefined();
    expect(
      terminalFrameOutput({ type: "snapshot", data: "screen" }, false),
    ).toEndWith("screen");
    expect(terminalFrameOutput({ type: "output", data: "update" }, true)).toBe(
      "update",
    );
  });

  test("replays normal-buffer history into scrollback rather than the alternate screen", async () => {
    const source = new Terminal({
      cols: 40,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    const first = Promise.withResolvers<void>();
    source.write(
      Array.from({ length: 20 }, (_, i) => `history-${i}\r\n`).join(""),
      first.resolve,
    );
    await first.promise;
    const client = new Terminal({
      cols: 40,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });
    const alternate = Promise.withResolvers<void>();
    client.write(
      "\x1b[?1049h\x1b[?6h\x1b[4h\x1b[2;4r\x1b[?7l",
      alternate.resolve,
    );
    await alternate.promise;
    const snapshot = Promise.withResolvers<void>();
    client.write(
      terminalFrameOutput(
        { type: "snapshot", data: serializer.serialize() },
        false,
      )!,
      snapshot.resolve,
    );
    await snapshot.promise;
    expect(client.buffer.active.type).toBe("normal");
    expect(client.modes.originMode).toBe(false);
    expect(client.modes.insertMode).toBe(false);
    expect(client.modes.wraparoundMode).toBe(true);
    expect(client.buffer.normal.length).toBeGreaterThan(5);
    expect(client.buffer.normal.getLine(0)?.translateToString(true)).toContain(
      "history-0",
    );
    client.dispose();
    source.dispose();
  });

  test("restores terminal input modes before leaving the alternate screen", () => {
    for (const mode of [
      1000, 1002, 1003, 1005, 1006, 1007, 1015, 1016, 1004, 2004, 1, 6,
    ]) {
      expect(terminalCleanup).toContain(`\x1b[?${mode}l`);
    }
    expect(terminalCleanup).toContain("\x1b[4l");
    expect(terminalCleanup).toContain("\x1b[r");
    expect(terminalCleanup).toContain("\x1b[?25h");
    expect(terminalCleanup).toEndWith("\x1b[?1049l");
  });

  test("lists idle live runtimes and reports unavailable host inventories", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/sessions")
          return Response.json({
            sessions: [
              {
                id: "idle",
                hostId: "local",
                path: "/x",
                cwd: "/repo",
                created: "2026",
                modified: "2026",
                messageCount: 0,
                firstMessage: "",
              },
            ],
            runningSessionIds: [],
          });
        if (path === "/api/sessions/archive")
          return Response.json({ archives: [], unavailableHosts: [] });
        if (
          path === "/api/hierarchy" &&
          new URL(request.url).searchParams.get("host") === "local"
        )
          return Response.json({
            projects: [
              {
                id: "p",
                name: "Project",
                path: "/repo",
                workspaces: [
                  {
                    id: "default",
                    projectId: "p",
                    path: "/repo",
                    name: "main",
                    isDefault: true,
                    sessionIds: [],
                  },
                  {
                    id: "feature",
                    projectId: "p",
                    path: "/worktrees/feature",
                    name: "feature",
                    branch: "feature",
                    isDefault: false,
                    sessionIds: [],
                  },
                ],
              },
            ],
          });
        if (path === "/api/hosts")
          return Response.json({
            hosts: [
              { id: "local", label: "Local" },
              { id: "remote", label: "Remote" },
            ],
          });
        if (path === "/api/hosts/local/terminal-sessions")
          return Response.json({ sessionIds: ["idle", "unsaved"] });
        return Response.json({ error: "offline" }, { status: 503 });
      },
    });
    try {
      const result = await inventory(new Api(new URL(server.url)));
      expect(result.entries.running.map((entry) => entry.target.id)).toEqual([
        "idle",
        "unsaved",
      ]);
      expect(
        result.entries.workspaces.map((entry) => entry.workspace?.path),
      ).toEqual(["/repo", "/worktrees/feature"]);
      expect(result.entries.workspaces[1]?.target.hostId).toBe("local");
      expect(result.entries.workspaces[1]?.search).toContain("feature");
      expect(result.notice).toContain("Remote");
      expect(result.notice).toContain("Workspaces unavailable");
    } finally {
      server.stop(true);
    }
  });

  test("a host-scoped picker requests only the selected host inventories", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname, search } = new URL(request.url);
        paths.push(pathname + search);
        if (pathname === "/api/hosts")
          return Response.json({
            hosts: [
              { id: "local", label: "Local" },
              { id: "remote", label: "Remote" },
            ],
          });
        if (pathname === "/api/sessions")
          return Response.json({ sessions: [] });
        if (pathname === "/api/sessions/archive")
          return Response.json({ archives: [], unavailableHosts: [] });
        if (pathname === "/api/hierarchy")
          return Response.json({ projects: [] });
        return Response.json({ sessionIds: ["same-id"] });
      },
    });
    try {
      const result = await inventory(new Api(new URL(server.url)), "remote");
      expect(result.entries.running.map((entry) => entry.target)).toEqual([
        { id: "same-id", hostId: "remote", live: true },
      ]);
      expect(paths.sort()).toEqual([
        "/api/hierarchy?host=remote",
        "/api/hosts",
        "/api/hosts/remote/terminal-sessions",
        "/api/sessions/archive?hostId=remote",
        "/api/sessions?hostId=remote",
      ]);
    } finally {
      server.stop(true);
    }
  });
});
