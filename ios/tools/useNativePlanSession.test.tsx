import "../../tests/setup-dom.ts";
import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type * as ReactTypes from "react";
import type {
  BrowserCommand,
  BrowserLink,
  BrowserLinkHandlers,
  BrowserReply,
} from "../browser-link";

const React = createRequire(new URL("../../package.json", import.meta.url))(
  "react",
) as typeof ReactTypes;

// The native app has its own React installation; render the hook with the DOM
// renderer's React instance in this isolated test process.
mock.module(
  createRequire(new URL("../useChatSession.ts", import.meta.url)).resolve(
    "react",
  ),
  () => React,
);
class BrowserLinkError extends Error {
  constructor(
    readonly code: "transport_unavailable" | "transport_lost",
    message: string,
  ) {
    super(message);
  }
}
class KeylimeHttpError extends Error {
  kind = "http";
  status = 500;
}
mock.module("../browser-link", () => ({ BrowserLinkError }));
mock.module("../keylime-http", () => ({
  KeylimeHttpError,
  // Keep history loading, so these tests also exercise unbuffered plan frames.
  requestJson: () => new Promise<never>(() => {}),
}));
// Install the DOM and native transport mocks before loading the renderer and hook.
const { act, cleanup, renderHook } =
  await import("@testing-library/react/pure.js");
const { useChatSession } = await import("../useChatSession");

const proposal = (id: string) => ({
  id,
  title: `Plan ${id}`,
  content: `Content ${id}`,
  planFilePath: `/tmp/${id}`,
});
const reply = (data: unknown) =>
  ({
    type: "reply",
    rid: "r",
    seq: 1,
    status: 200,
    at: 0,
    recvAt: 0,
    deduped: false,
    data: { success: true, data },
  }) as unknown as BrowserReply;

class FakeLink {
  handlers?: BrowserLinkHandlers;
  reads: PromiseWithResolvers<BrowserReply>[] = [];
  decisions: {
    command: BrowserCommand;
    response: PromiseWithResolvers<BrowserReply>;
  }[] = [];
  subscribe(channel: { kind: string }, handlers: BrowserLinkHandlers) {
    if (channel.kind === "session") this.handlers = handlers;
    return () => {};
  }
  command(_session: string, _host: string, command: BrowserCommand) {
    const response = Promise.withResolvers<BrowserReply>();
    if (command.type === "get_plan_state") this.reads.push(response);
    else if (command.type === "respond_plan_proposal")
      this.decisions.push({ command, response });
    else throw new Error(`Unexpected command ${command.type}`);
    return response.promise;
  }
  open() {
    this.handlers?.onOpen?.();
  }
  end() {
    this.handlers?.onEnd?.("disconnected");
  }
  event(data: unknown) {
    this.handlers?.onEvent?.(data);
  }
}

function mount(link: FakeLink) {
  return renderHook(() =>
    useChatSession({
      origin: "https://example.test",
      hostId: "host",
      sessionId: "session",
      openSessionKeys: new Set([
        JSON.stringify(["https://example.test", "host", "session"]),
      ]),
      link: link as unknown as BrowserLink,
    }),
  );
}

test("plan events fence older snapshots and decision replies", async () => {
  const link = new FakeLink();
  const view = mount(link);
  try {
    act(() => link.open());
    expect(link.reads).toHaveLength(1);
    act(() =>
      link.event({
        type: "plan_state_changed",
        enabled: true,
        proposal: proposal("a"),
      }),
    );
    await act(async () => {
      link.reads[0].resolve(reply({ enabled: false }));
    });
    expect(view.result.current.planProposal).toEqual(proposal("a"));
    act(() =>
      link.event({
        type: "plan_state_changed",
        enabled: false,
        proposal: { id: "broken" },
      }),
    );
    expect(view.result.current.planProposal).toEqual(proposal("a"));
    act(() =>
      link.event({
        type: "plan_state_changed",
        enabled: false,
        proposal: proposal("invalid"),
      }),
    );
    expect(view.result.current.planProposal).toEqual(proposal("a"));

    let decision!: Promise<boolean>;
    act(() => {
      decision = view.result.current.respondPlanProposal("a", true);
    });
    expect(view.result.current.planCommandPending).toBe(true);
    expect(await view.result.current.respondPlanProposal("a", true)).toBe(
      false,
    );
    act(() =>
      link.event({
        type: "plan_state_changed",
        enabled: true,
        proposal: proposal("b"),
      }),
    );
    await act(async () => {
      link.decisions[0].response.resolve(reply({ enabled: false }));
    });
    expect(link.reads).toHaveLength(2);
    expect(view.result.current.planProposal).toEqual(proposal("b"));
    await act(async () => {
      link.reads[1].resolve(reply({ enabled: true, proposal: proposal("b") }));
    });
    expect(await decision).toBe(true);
    expect(view.result.current.planProposal).toEqual(proposal("b"));
    expect(view.result.current.planCommandPending).toBe(false);
  } finally {
    view.unmount();
    cleanup();
  }
});

test("uncertain decisions remain locked across reconnect until authority resolves them", async () => {
  const link = new FakeLink();
  const view = mount(link);
  try {
    act(() => link.open());
    await act(async () => {
      link.reads[0].resolve(reply({ enabled: true, proposal: proposal("a") }));
    });
    let decision!: Promise<boolean>;
    act(() => {
      decision = view.result.current.respondPlanProposal(
        "a",
        false,
        "Revise it",
      );
    });
    expect(link.decisions[0].command).toEqual({
      type: "respond_plan_proposal",
      id: "a",
      approved: false,
      feedback: "Revise it",
    });
    await act(async () => {
      link.decisions[0].response.reject(
        new BrowserLinkError("transport_lost", "unknown"),
      );
    });
    expect(link.reads).toHaveLength(2);
    await act(async () => {
      link.reads[1].reject(new Error("offline"));
    });
    expect(await decision).toBe(false);
    expect(view.result.current.planProposal).toEqual(proposal("a"));
    expect(view.result.current.planCommandPending).toBe(true);
    act(() => {
      link.end();
      link.open();
    });
    await act(async () => {
      link.reads[2].resolve(reply({ enabled: true, proposal: proposal("a") }));
    });
    expect(view.result.current.planCommandPending).toBe(true);
    expect(await view.result.current.respondPlanProposal("a", true)).toBe(
      false,
    );
    expect(link.decisions).toHaveLength(1);
    act(() => link.event({ type: "plan_state_changed", enabled: true }));
    expect(view.result.current.planProposal).toBeUndefined();
    expect(view.result.current.planCommandPending).toBe(false);
    expect(await view.result.current.respondPlanProposal("a", true)).toBe(
      false,
    );
    act(() => link.event({ type: "process_exit" }));
    expect(view.result.current.planEnabled).toBe(false);
  } finally {
    view.unmount();
    cleanup();
  }
});
