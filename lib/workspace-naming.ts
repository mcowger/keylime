import { randomBytes } from "node:crypto";
import { workspacePromptNames } from "./workspace-prompt";

export async function automaticWorkspaceNames(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ name: string; branch: string }> {
  const deadline = AbortSignal.timeout(10_000);
  const namingSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const { promise: aborted, reject: rejectAbort } =
    Promise.withResolvers<never>();
  const onAbort = () => rejectAbort(namingSignal.reason);
  if (namingSignal.aborted) onAbort();
  else namingSignal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      workspacePromptNames(prompt, namingSignal),
      aborted,
    ]);
  } catch {
    return {
      name: "Workspace",
      branch: `workspace-${randomBytes(4).toString("hex")}`,
    };
  } finally {
    namingSignal.removeEventListener("abort", onAbort);
  }
}
