import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface RunBunxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunBunxResult {
  stdout: string;
  stderr: string;
}

/** Invoke a package with Bun without interpreting user-controlled arguments as shell syntax. */
export async function runBunx(
  args: string[],
  opts: RunBunxOptions = {},
): Promise<RunBunxResult> {
  return execFileAsync("bun", ["x", "--bun", ...args], {
    timeout: opts.timeout,
    cwd: opts.cwd,
    env: opts.env,
  });
}
