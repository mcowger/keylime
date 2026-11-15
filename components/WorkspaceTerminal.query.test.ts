import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";
import React, { act } from "react";
import { workspaceHarness } from "../lib/hosts/workspace-test-helper.ts";
import type { WorkspaceOps } from "../lib/workspace-types";
import type { TerminalEvent } from "../lib/terminal-types";
import type { RenderResult } from "@testing-library/react";

const { render, cleanup, fireEvent } =
  await import("@testing-library/react/pure.js");
let host: {
  op: WorkspaceOps["terminals"];
  onTerminal: (id: string, cb: (event: TerminalEvent) => void) => () => void;
};
type Stream = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  detach?: () => void;
  close(): void;
};
const streams = new Set<Stream>();
mock.module("@/lib/event-stream", () => ({
  EVENT_STREAM_CLOSED: 2,
  openEventStream({ terminalId }: { terminalId: string }) {
    const stream: Stream = {
      onopen: null,
      onmessage: null,
      onerror: null,
      readyState: 1,
      close() {
        this.detach?.();
        streams.delete(this);
      },
    };
    stream.detach = host.onTerminal(terminalId, (event) =>
      stream.onmessage?.({ data: JSON.stringify(event) }),
    );
    streams.add(stream);
    queueMicrotask(() => stream.onopen?.());
    return stream;
  },
}));
mock.module("@/lib/terminal-client", () => ({
  async terminalSnapshot(id: string) {
    const result = await host.op("snapshot", { id });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  async terminalCommand(
    id: string,
    _hostId: string,
    { action, ...input }: { action: string; [key: string]: unknown },
  ) {
    const result = await host.op(action, { id, ...input });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia = (media) => ({
  media,
  matches: false,
  onchange: null,
  dispatchEvent: () => true,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
window.HTMLCanvasElement.prototype.getContext = (() => ({
  fillStyle: "#000000",
  fillRect() {},
  clearRect() {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  measureText: () => ({ width: 8 }),
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
Object.defineProperty(document, "fonts", {
  value: { ready: Promise.resolve() },
  configurable: true,
});
const { WorkspaceTerminal } = await import("./WorkspaceTerminal");

test(
  "terminal queries get one daemon reply with zero, one or two viewers",
  { timeout: 60000 },
  async (t) => {
    const f = await workspaceHarness();
    t.after(async () => {
      cleanup();
      await f.close();
    });
    const owner = await f.startHost();
    const hub = await import("../lib/hosts/hub");
    host = {
      op: (action: string, input: Record<string, unknown>) =>
        owner.host.workspaceOps.terminals(action, input),
      onTerminal: (id: string, cb: (event: TerminalEvent) => void) =>
        hub.onTerminalEvent(owner.host.id, id, cb),
    };
    assert.equal(
      (
        await owner.host.workspaceOps.hierarchy({
          action: "registerProject",
          path: owner.project,
        })
      ).ok,
      true,
    );
    const created = await host.op("create", {
      cwd: owner.project,
      cols: 120,
      rows: 24,
    });
    assert.equal(created.ok, true);
    const terminal = created.value.terminal;
    assert.ok(terminal);
    const views: RenderResult[] = [];
    for (const count of [0, 1, 2]) {
      if (count) {
        await act(async () => {
          views.push(
            render(
              React.createElement(WorkspaceTerminal, {
                terminal,
                hostId: owner.host.id,
                active: true,
              }),
            ),
          );
        });
        await new Promise((r) => setTimeout(r, 300));
      }
      const script = `
process.stdin.setRawMode(true); let data = Buffer.alloc(0);
process.stdin.on('data', c => { data = Buffer.concat([data, c]); });
process.stdout.write('\\x1b[c\\x1b[>c\\x1b[5n\\x1b[4$p\\x1b[?25$p\\x1bP$qm\\x1b\\\\\\x1b]4;1;?\\x07\\x1b]10;?\\x07\\x1b]11;?\\x07\\x1b]12;?\\x07READY_${count}');
await Bun.sleep(1200); process.stdin.setRawMode(false);
console.log('MATRIX_${count}:' + data.toString('hex')); process.exit(0);
`;
      const command = `"${process.execPath}" -e "eval('(async()=>{'+atob('${Buffer.from(script).toString("base64")}')+'})()')"\n`;
      assert.equal(
        (await host.op("input", { id: terminal.id, data: command })).ok,
        true,
      );
      const pastedColor = "\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\";
      const pastedFocus = "\x1b[I";
      if (count === 2) {
        const deadline = Date.now() + 5000;
        let ready = false;
        while (Date.now() < deadline) {
          const snapshot = await host.op("snapshot", { id: terminal.id });
          if (
            snapshot.ok &&
            snapshot.value.snapshot?.includes(`READY_${count}`)
          ) {
            ready = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(ready, "terminal probe did not start");
        const textarea = views[1].container.querySelector(
          ".xterm-helper-textarea",
        );
        assert.ok(textarea);
        await act(async () => {
          for (const value of [pastedColor, pastedFocus])
            fireEvent.paste(textarea, {
              clipboardData: { getData: () => value },
            });
        });
      }
      let match;
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
        const snapshot = await host.op("snapshot", { id: terminal.id });
        match =
          snapshot.ok &&
          new RegExp(`MATRIX_${count}:([0-9a-f]+)`).exec(
            snapshot.value.snapshot ?? "",
          );
        if (match) break;
      }
      assert.ok(match, `missing result for ${count} viewers`);
      assert.equal(
        Buffer.from(match[1], "hex").toString(),
        "\x1b[?1;2c\x1b[>0;276;0c\x1b[0n\x1b[4;2$y\x1b[?25;1$y\x1bP1$r0m\x1b\\\x1b]4;1;rgb:cccc/0000/0000\x1b\\\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\\x1b]12;rgb:ffff/ffff/ffff\x1b\\" +
          (count === 2 ? pastedColor + pastedFocus : ""),
      );
    }
    for (const view of views) view.unmount();
    await host.op("close", { id: terminal.id });
  },
);
