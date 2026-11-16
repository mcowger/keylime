import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Whether an active advisor still has primary output to review. */
export function advisorReviewPending(session: AgentSession): boolean {
  return session
    .getAdvisorStatusOverview()
    .advisors.some(
      (advisor) =>
        advisor.backlog > 0 && advisor.status === "running" && !advisor.isPaused,
    );
}
