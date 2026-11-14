import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

export type ModelActivity = {
  kind: "idle" | "waiting" | "streaming" | "tools";
  startedAt: number;
  rate: number;
  epoch: number;
  version: number;
};

const trackers = new WeakMap<AgentSession, ActivityTracker>();

export class ActivityTracker {
  private state: ModelActivity = {
    kind: "idle",
    startedAt: 0,
    rate: 0,
    version: 0,
    epoch: Date.now(),
  };
  private samples: Array<{ at: number; chars: number }> = [];
  private tools = new Set<string>();
  constructor(private emit: (activity: ModelActivity) => void) {}
  snapshot(): ModelActivity {
    return this.state;
  }
  private update(
    kind: ModelActivity["kind"],
    startedAt = this.state.startedAt,
    rate = 0,
  ) {
    this.state = {
      kind,
      startedAt,
      rate,
      version: this.state.version + 1,
      epoch: this.state.epoch,
    };
    this.emit(this.state);
  }
  request(at = Date.now()) {
    this.tools.clear();
    this.samples = [];
    this.update("waiting", at);
  }
  output(delta: string, at = Date.now()) {
    if (
      !delta ||
      (this.state.kind !== "waiting" && this.state.kind !== "streaming")
    )
      return;
    this.samples.push({ at, chars: delta.length });
    this.samples = this.samples.filter((sample) => sample.at >= at - 5000);
    const chars = this.samples.reduce((sum, sample) => sum + sample.chars, 0);
    const seconds = Math.max(1, (at - this.samples[0].at) / 1000);
    this.update("streaming", this.state.startedAt, chars / 4 / seconds);
  }
  toolStart(id: string) {
    this.tools.add(id);
    this.update("tools");
  }
  toolEnd(id: string) {
    if (!this.tools.delete(id)) return;
    if (!this.tools.size) this.update("idle", 0);
  }
  reset() {
    this.tools.clear();
    this.samples = [];
    this.update("idle", 0);
  }
}

export function activityFor(session: AgentSession): ModelActivity | undefined {
  return trackers.get(session)?.snapshot();
}
export function resetActivity(session: AgentSession): void {
  trackers.get(session)?.reset();
}

export function trackActivity(
  session: AgentSession,
  emit: (activity: ModelActivity) => void,
): () => void {
  const tracker = new ActivityTracker(emit);
  trackers.set(session, tracker);
  const original = session.agent.streamFn;
  const wrapped: typeof original = (...args) => {
    tracker.request();
    return original(...args);
  };
  session.agent.streamFn = wrapped;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        if (event.message.role !== "assistant") break;
        const update = event.assistantMessageEvent;
        if (
          update.type === "text_delta" ||
          update.type === "thinking_delta" ||
          update.type === "toolcall_delta"
        )
          tracker.output(update.delta);
        break;
      }
      case "tool_execution_start":
        tracker.toolStart(event.toolCallId);
        break;
      case "tool_execution_end":
        tracker.toolEnd(event.toolCallId);
        break;
      case "agent_end":
        tracker.reset();
        break;
    }
  });
  return () => {
    unsubscribe();
    if (session.agent.streamFn === wrapped) session.agent.streamFn = original;
    trackers.delete(session);
  };
}
