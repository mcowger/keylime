import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * OMP queues reviews in an asynchronous turn-end hook, after publishing turn_end.
 * Its backlog also drains before all resulting advisor cards finish processing.
 * Keep one shared state for events and get_state across both boundaries.
 */
class AdvisorReviewTracker {
  #boundary = false;
  #pending = false;
  #catchingUp = false;
  #listeners = new Set<(pending: boolean) => void>();
  readonly #session: AgentSession;

  constructor(session: AgentSession) {
    this.#session = session;
  }

  #canReview(): boolean {
    return this.#session.getAdvisorStatusOverview().advisors.some(
      (advisor) => advisor.status === "running" || (advisor.status === "error" && !advisor.yielded),
    );
  }

  #hasBacklog(): boolean {
    return this.#session.getAdvisorStatusOverview().advisors.some(
      // An advisor can report error after a dropped batch while later queued
      // batches still run; yielded distinguishes that from a hard stop.
      (advisor) => advisor.backlog > 0 && !advisor.yielded,
    );
  }

  #setPending(pending: boolean): void {
    if (this.#pending === pending) return;
    this.#pending = pending;
    for (const listener of this.#listeners) listener(pending);
  }

  check(): boolean {
    if (this.#boundary || this.#hasBacklog()) this.#setPending(true);
    if (this.#pending && !this.#boundary && !this.#catchingUp) {
      this.#catchingUp = true;
      void this.#catchUp();
    }
    return this.#pending;
  }

  async #catchUp(): Promise<void> {
    try {
      // This native drain includes advisor card event processing, not just the
      // review backlog. Keep waiting through recoverable advisor failures.
      const caughtUp = await this.#session.waitForAdvisorCatchup(2_147_483_647, {
        waitThroughRecovery: true,
      });
      if (!caughtUp) {
        // A terminal failure releases catchup even with abandoned backlog. Idle
        // still waits for card events, so it cannot hide a late advisor card.
        await this.#session.waitForIdle();
      }
      if (!this.#boundary && !this.#hasBacklog()) this.#setPending(false);
    } catch {
      // A failed drain is not proof that advisor work finished.
    } finally {
      this.#catchingUp = false;
    }
  }

  observe(event: AgentEvent): void {
    if (event.type === "turn_end") {
      // A terminal tool yield can report an aborted message yet still runs
      // OMP's turn-end hook, so the boundary is not gated on stopReason.
      this.#boundary = this.#canReview();
    } else if (event.type === "turn_start" || event.type === "agent_end") {
      // The next loop event is emitted only after the turn-end hook returns.
      this.#boundary = false;
    }
    this.check();
  }

  resetBoundary(): void {
    this.#boundary = false;
    this.check();
  }

  subscribe(listener: (pending: boolean) => void): () => void {
    const wasPending = this.#pending;
    this.#listeners.add(listener);
    const unsubscribe = this.#session.agent.subscribe((event) => this.observe(event));
    const timer = setInterval(() => this.check(), 100);
    timer.unref();
    this.check();
    if (wasPending) listener(true);
    return () => {
      clearInterval(timer);
      unsubscribe();
      this.#listeners.delete(listener);
    };
  }
}

const trackers = new WeakMap<AgentSession, AdvisorReviewTracker>();
function trackerFor(session: AgentSession): AdvisorReviewTracker {
  let tracker = trackers.get(session);
  if (!tracker) {
    tracker = new AdvisorReviewTracker(session);
    trackers.set(session, tracker);
  }
  return tracker;
}

/** Whether review, turn-boundary evaluation, or advisor card delivery is pending. */
export function advisorReviewPending(session: AgentSession): boolean {
  return trackerFor(session).check();
}

export function subscribeAdvisorReview(
  session: AgentSession,
  listener: (pending: boolean) => void,
): () => void {
  return trackerFor(session).subscribe(listener);
}

/** A session switch can detach a run without its terminal agent_end. */
export function resetAdvisorBoundary(session: AgentSession): void {
  trackers.get(session)?.resetBoundary();
}
