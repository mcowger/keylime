import {
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { HostChannel } from "./channel";
import { isHeadless } from "./headless";
import { registerThinkingCeiling } from "./thinking-ceiling";

/**
 * omp's session factory, plus the `keylime host` channel: the host receives the session's events
 * and drives it through the same `AgentSession` the TUI uses, and dialogs open on both sides.
 * A headless omp serves the host on stdio instead, from `headless.ts`.
 */
export async function createHostedAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  // A non-interactive launch throws when a resumed session's model cannot be restored; keylime instead
  // opens it on the default model, or none, so a logged-out user can still open old sessions and log in from them.
  const result = await createAgentSession(
    isHeadless() ? { ...options, allowSessionModelFallback: true } : options,
  );
  registerThinkingCeiling(result.session, options.thinkingLevelCeiling);
  if (isHeadless()) return result;
  // Only the TUI is a session the web may drive; `-p`, json and acp runs leave `hasUI` unset (rpc modes never reach here).
  if (!options.hasUI) return result;
  const channel = await HostChannel.connect(
    result.session,
    result.subagentEventBus,
  );
  return {
    ...result,
    setToolUIContext: (ui, hasUI) =>
      result.setToolUIContext(channel.wrapUi(ui), hasUI),
  };
}
