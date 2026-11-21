import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ThinkingLevelCeiling } from "@oh-my-pi/pi-tui/thinking";

// The SDK exposes the ceiling when creating a session, but not on AgentSession.
const ceilings = new WeakMap<AgentSession, { ceiling?: ThinkingLevelCeiling }>();

export function registerThinkingCeiling(session: AgentSession, ceiling?: ThinkingLevelCeiling): void {
  ceilings.set(session, { ceiling });
}

export function sessionThinkingCeiling(session: AgentSession): { ceiling?: ThinkingLevelCeiling } | undefined {
  return ceilings.get(session);
}
