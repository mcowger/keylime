/**
 * omp's root `launch` command (`commands/launch.ts`), with two changes: the agent session factory
 * hosts the session for keylime, and `--headless` boots omp for `keylime host` on stdio (see
 * `headless.ts`). Keep it in step with upstream's copy on every omp bump.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getCapability, listCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import {
  type Args,
  parseArgs,
  reportCliUsageError,
} from "@oh-my-pi/pi-coding-agent/cli/args";
import { launchHelp } from "@oh-my-pi/pi-coding-agent/commands/launch-help";
import { prepareAcpTerminalAuthArgs } from "@oh-my-pi/pi-coding-agent/modes/acp/terminal-auth";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { enterHeadless, isHeadless, runHeadless } from "./headless";
import { createHostedAgentSession } from "./session";

export default class Index extends Command {
  static description = launchHelp.description;
  static hidden = launchHelp.hidden;
  static args = launchHelp.args;
  static flags = launchHelp.flags;
  static examples = launchHelp.examples;

  static strict = false;

  async run(): Promise<void> {
    const argv = this.argv.includes("--headless")
      ? enterHeadless(this.argv)
      : this.argv;
    const { args } = prepareAcpTerminalAuthArgs(argv);
    let parsed: Args;
    try {
      parsed = parseArgs(args);
    } catch (error) {
      if (reportCliUsageError(error)) {
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    if (parsed.mode === "rpc" || parsed.mode === "rpc-ui") {
      process.stderr.write(
        "Error: keylime-omp has no RPC mode; keylime host starts it with --headless\n",
      );
      process.exitCode = 2;
      return;
    }
    // Startup boundary, as upstream: the session graph loads only once argv is accepted.
    const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
    // A non-repo workspace can otherwise walk through the daemon's real home,
    // treating its global .agents/skills as project skills under the scoped HOME.
    const hostHome = process.env.KEYLIME_MIRROR_HOST_HOME;
    if (hostHome) {
      for (const id of listCapabilities()) {
        for (const provider of getCapability(id)?.providers ?? []) {
          const load = provider.load.bind(provider);
          provider.load = (ctx) => {
            const rel = relative(hostHome, ctx.cwd);
            if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
              return load(ctx);
            const boundary = resolve(hostHome, rel.split(sep)[0]!);
            if (ctx.repoRoot === boundary || ctx.repoRoot?.startsWith(boundary + sep))
              return load(ctx);
            return load({ ...ctx, repoRoot: boundary });
          };
        }
      }
    }
    try {
      await runRootCommand(parsed, args, {
        createAgentSession: createHostedAgentSession,
        runSessionHost: isHeadless() ? runHeadless : undefined,
      });
    } catch (error) {
      if (reportCliUsageError(error)) process.exit(2);
      throw error;
    }
  }
}
