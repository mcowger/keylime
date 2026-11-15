/** Build/dev prerequisite. A fresh Bun process prevents schema imports from surviving a source edit. */
export async function runApiGeneration(
  root: string,
  options: {
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const { signal } = options;
  if (signal?.aborted)
    throw new Error("API contract generation cancelled", {
      cause: signal.reason,
    });
  console.log("[api] Generating and validating canonical API artifacts");
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "scripts/generate-api-docs.ts"],
    {
      cwd: root,
      env: options.env ?? process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  let force: NodeJS.Timeout | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    force ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    force.unref();
  };
  signal?.addEventListener("abort", abort, { once: true });
  // Abort may have happened between the pre-spawn check and listener registration.
  if (signal?.aborted) abort();
  try {
    const code = await child.exited;
    if (signal?.aborted)
      throw new Error("API contract generation cancelled", {
        cause: signal.reason,
      });
    if (code !== 0)
      throw new Error(
        `API contract generation failed (exit ${code}); fix the source contracts before continuing`,
      );
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(force);
  }
}
