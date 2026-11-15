import { AsyncLocalStorage } from "node:async_hooks";
import { completeSimple } from "@oh-my-pi/pi-ai";
import path from "node:path";
import type { VcsHunkSelection } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
  runCommitAgentSession,
  type ExistingChangelogEntries,
} from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import { generateFallbackProposal } from "@oh-my-pi/pi-coding-agent/commit/agentic/fallback";
import { assignLockFilesToPlan } from "@oh-my-pi/pi-coding-agent/commit/agentic/lock-files";
import type {
  CommitAgentState,
  SplitCommitGroup,
} from "@oh-my-pi/pi-coding-agent/commit/agentic/state";
import { computeDependencyOrder } from "@oh-my-pi/pi-coding-agent/commit/agentic/topo-sort";
import { detectTrivialChange } from "@oh-my-pi/pi-coding-agent/commit/agentic/trivial";
import { applyChangelogProposals } from "@oh-my-pi/pi-coding-agent/commit/changelog";
import { detectChangelogBoundaries } from "@oh-my-pi/pi-coding-agent/commit/changelog/detect";
import { parseUnreleasedSection } from "@oh-my-pi/pi-coding-agent/commit/changelog/parse";
import { formatCommitMessage } from "@oh-my-pi/pi-coding-agent/commit/message";
import { resolvePrimaryModel } from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { extractTextContent } from "@oh-my-pi/pi-coding-agent/commit/utils";
import { discoverContextFiles } from "@oh-my-pi/pi-coding-agent/sdk";
import { isSessionSettled } from "@oh-my-pi/pi-coding-agent/session/session-settle";
import { CommandError, type CommandContext, type CommandTable } from "./types";

// Wire contract: lib/workspace-ship-types.ts (runner cannot import from lib).
interface PlanCommit {
  message: string;
  files: string[];
  changes?: VcsHunkSelection[];
  dependencies?: number[];
}
interface Changelog {
  path: string;
  entries: Record<string, string[]>;
  deletions?: Record<string, string[]>;
}
interface Plan {
  kind: "single" | "split";
  commits: PlanCommit[];
  changelog: Changelog[];
  warnings: string[];
  usedFallback: boolean;
}

function settled(ctx: CommandContext) {
  if (!isSessionSettled(ctx.session))
    throw new CommandError("Session is busy", "session_busy");
}
function optionalString(value: unknown, name: string): string | undefined {
  if (value !== undefined && typeof value !== "string")
    throw new Error(`${name} must be a string`);
  return value as string | undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
function entries(value: unknown): value is Record<string, string[]> {
  return record(value) && Object.values(value).every(strings);
}
function selection(value: unknown): value is VcsHunkSelection {
  if (
    !record(value) ||
    typeof value.path !== "string" ||
    !value.path ||
    typeof value.kind !== "string"
  )
    return false;
  if (
    !Object.keys(value).every((k) =>
      ["path", "kind", "indices", "start", "end"].includes(k),
    )
  )
    return false;
  const integer = (n: unknown) => Number.isInteger(n) && (n as number) >= 1;
  if (value.kind === "all")
    return (
      value.indices === undefined &&
      value.start === undefined &&
      value.end === undefined
    );
  if (value.kind === "indices")
    return (
      Array.isArray(value.indices) &&
      value.indices.length > 0 &&
      value.indices.every(integer) &&
      value.start === undefined &&
      value.end === undefined
    );
  if (value.kind === "lines")
    return (
      integer(value.start) &&
      integer(value.end) &&
      (value.start as number) <= (value.end as number) &&
      value.indices === undefined
    );
  return false;
}
function parsePlan(value: unknown): Plan {
  if (
    !record(value) ||
    (value.kind !== "single" && value.kind !== "split") ||
    !Array.isArray(value.commits) ||
    value.commits.length === 0 ||
    !Array.isArray(value.changelog) ||
    !strings(value.warnings) ||
    typeof value.usedFallback !== "boolean"
  )
    throw new Error("Invalid commit plan");
  if (value.kind === "single" && value.commits.length !== 1)
    throw new Error("Invalid single commit plan");
  for (const commit of value.commits) {
    if (
      !record(commit) ||
      typeof commit.message !== "string" ||
      !commit.message.trim() ||
      !strings(commit.files)
    )
      throw new Error("Invalid commit plan commit");
    if (
      value.kind === "split" &&
      (!Array.isArray(commit.changes) ||
        !commit.changes.length ||
        !commit.changes.every(selection) ||
        !Array.isArray(commit.dependencies) ||
        !commit.dependencies.every(
          (v: unknown) => Number.isInteger(v) && (v as number) >= 0,
        ))
    )
      throw new Error("Invalid split commit changes or dependencies");
    if (
      value.kind === "single" &&
      (commit.changes !== undefined || commit.dependencies !== undefined)
    )
      throw new Error("Invalid single commit changes");
  }
  for (const item of value.changelog)
    if (
      !record(item) ||
      typeof item.path !== "string" ||
      !item.path ||
      !entries(item.entries) ||
      (item.deletions !== undefined && !entries(item.deletions))
    )
      throw new Error("Invalid changelog proposal");
  return value as unknown as Plan;
}

// Omp's commit agent renders progress unconditionally. Filter only its async context, leaving concurrent runner
// NDJSON writes untouched. Restore whatever was installed before (headless already points stdout at stderr).
const quiet = new AsyncLocalStorage<boolean>();
let quietUsers = 0;
let previousWrite: typeof process.stdout.write | undefined;
async function quietAgent<T>(fn: () => Promise<T>): Promise<T> {
  if (quietUsers++ === 0) {
    const write = process.stdout.write.bind(process.stdout);
    previousWrite = process.stdout.write;
    process.stdout.write = ((
      chunk: unknown,
      encoding?: unknown,
      callback?: unknown,
    ) => {
      if (!quiet.getStore())
        return write(
          chunk as string,
          encoding as BufferEncoding,
          callback as (error?: Error | null) => void,
        );
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") queueMicrotask(() => done());
      return true;
    }) as typeof process.stdout.write;
  }
  try {
    return await quiet.run(true, fn);
  } finally {
    if (--quietUsers === 0 && previousWrite) {
      process.stdout.write = previousWrite;
      previousWrite = undefined;
    }
  }
}

async function existingEntries(
  paths: string[],
): Promise<ExistingChangelogEntries[]> {
  const result: ExistingChangelogEntries[] = [];
  for (const file of paths) {
    try {
      const parsed = parseUnreleasedSection(await Bun.file(file).text());
      const sections = Object.entries(parsed.entries)
        .filter(([, items]) => items.length > 0)
        .map(([name, items]) => ({ name, items }));
      if (sections.length) result.push({ path: file, sections });
    } catch {
      /* Missing or unparseable changelogs have no existing entries. */
    }
  }
  return result;
}

async function planCommit(ctx: CommandContext, args: Record<string, unknown>) {
  settled(ctx);
  const context = optionalString(args.context, "context");
  if (args.changelog !== undefined && typeof args.changelog !== "boolean")
    throw new Error("changelog must be a boolean");
  const { session } = ctx;
  const cwd = session.sessionManager.getCwd();
  const repo = vcs.requireGit(cwd);
  // Ship commits the whole workspace: stage everything, partially staged or not.
  await repo.stageFiles([]);
  const files = await repo.changedFiles({ cached: true });
  if (!files.length) return { plan: null };
  const [boundaries, contextFiles, stats, diff] = await Promise.all([
    args.changelog === false ? [] : detectChangelogBoundaries(cwd, files),
    discoverContextFiles(cwd),
    repo.numstat({ cached: true }),
    repo.diffText({ cached: true }),
  ]);
  const numstat = stats.map((e) => ({
    path: e.path,
    additions: e.added ?? 0,
    deletions: e.removed ?? 0,
  }));
  const targets = boundaries.map((b) => b.changelogPath);
  const existing = targets.length ? await existingEntries(targets) : undefined;
  let state: CommitAgentState = {};
  let usedFallback = false;
  const trivial = detectTrivialChange(diff);
  if (process.env.PI_COMMIT_TEST_FALLBACK?.toLowerCase() === "true") {
    state.proposal = generateFallbackProposal(numstat);
    usedFallback = true;
  } else if (trivial) {
    state.proposal = {
      analysis: { type: trivial.type, scope: null, details: [], issueRefs: [] },
      summary: trivial.summary,
      warnings: [],
    };
  } else {
    try {
      const { model, thinkingLevel } = await resolvePrimaryModel(
        undefined,
        session.settings,
        session.modelRegistry,
      );
      state = await quietAgent(() =>
        runCommitAgentSession({
          cwd,
          model,
          thinkingLevel,
          settings: session.settings,
          modelRegistry: session.modelRegistry,
          authStorage: session.modelRegistry.authStorage,
          userContext: context,
          contextFiles,
          changelogTargets: targets,
          requireChangelog: targets.length > 0,
          diffText: diff,
          existingChangelogEntries: targets.length ? existing : undefined,
        }),
      );
    } catch {
      state = {};
    }
    if (!state.proposal && !state.splitProposal) {
      state.proposal = generateFallbackProposal(numstat);
      usedFallback = true;
    }
    if (!usedFallback && targets.length && !state.changelogProposal)
      throw new Error("Commit agent did not provide changelog entries");
  }
  const changelog = state.changelogProposal?.entries ?? [];
  if (state.proposal)
    return {
      plan: {
        kind: "single",
        commits: [
          {
            message: formatCommitMessage(
              state.proposal.analysis,
              state.proposal.summary,
            ),
            files,
          },
        ],
        changelog,
        warnings: state.proposal.warnings,
        usedFallback,
      } satisfies Plan,
    };
  const split = state.splitProposal!;
  assignLockFilesToPlan(split, files);
  const commits = split.commits.map((group) => ({
    message: formatCommitMessage(
      {
        type: group.type,
        scope: group.scope,
        details: group.details,
        issueRefs: group.issueRefs,
      },
      group.summary,
    ),
    files: [...new Set(group.changes.map((c) => c.path))],
    changes: group.changes,
    dependencies: group.dependencies,
  }));
  return {
    plan: {
      kind: "split",
      commits,
      changelog,
      warnings: split.warnings,
      usedFallback,
    } satisfies Plan,
  };
}

async function applyCommit(ctx: CommandContext, args: Record<string, unknown>) {
  settled(ctx);
  const plan = parsePlan(args.plan);
  const cwd = ctx.session.sessionManager.getCwd();
  const repo = vcs.requireGit(cwd);
  const groups = plan.commits.map((c) => ({
    changes: c.changes ?? [],
    dependencies: c.dependencies ?? [],
  })) as SplitCommitGroup[];
  const order = computeDependencyOrder(groups);
  if (!Array.isArray(order)) throw new Error(order.error);
  if (plan.kind === "split") {
    const files = await repo.changedFiles({ cached: true });
    const planned = new Set(
      groups.flatMap((g) => g.changes.map((c) => c.path)),
    );
    const missing = files.filter((file) => !planned.has(file));
    if (missing.length)
      throw new Error(
        `Split commit plan missing staged files: ${missing.join(", ")}`,
      );
  }
  const updated = await applyChangelogProposals({
    cwd,
    proposals: plan.changelog,
    dryRun: false,
  });
  const changelogFiles = updated.map((file) => path.relative(cwd, file));
  const commits: Array<{ sha: string; subject: string }> = [];
  if (plan.kind === "single") {
    const message = plan.commits[0].message;
    const sha = await repo.commitCreate(message, {});
    commits.push({ sha, subject: message.split("\n", 1)[0] });
  } else {
    const planned = new Set(
      groups.flatMap((g) => g.changes.map((c) => c.path)),
    );
    for (const file of changelogFiles)
      if (!planned.has(file))
        groups[order[order.length - 1]].changes.push({
          path: file,
          kind: "all",
        });
    const diff = await repo.diffText({ cached: true, binary: true });
    await repo.unstage([]);
    for (const index of order) {
      await repo.stageHunks(groups[index].changes, diff);
      const message = plan.commits[index].message;
      const sha = await repo.commitCreate(message, {});
      commits.push({ sha, subject: message.split("\n", 1)[0] });
      await repo.unstage([]);
    }
  }
  return { commits, changelogFiles };
}

/** Output past `limit` characters is dropped; `truncated` says so. */
async function git(
  cwd: string,
  args: string[],
  limit = 20_000,
): Promise<string> {
  return (await gitBounded(cwd, args, limit)).text;
}
async function gitBounded(
  cwd: string,
  args: string[],
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const readBounded = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (text.length >= limit) {
        truncated = true;
        continue;
      }
      const chunk = decoder.decode(value, { stream: true });
      if (text.length + chunk.length > limit) truncated = true;
      text += chunk.slice(0, limit - text.length);
    }
    return { text, truncated };
  };
  const [output, error, exit] = await Promise.all([
    readBounded(proc.stdout),
    readBounded(proc.stderr),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error(error.text.trim() || `git ${args[0]} failed`);
  return output;
}

const PR_SYSTEM_PROMPT = `You write GitHub pull request descriptions from a branch's commits and diff. Describe the resulting change as finished work: what it does and why it matters, as a reviewer needs it. Never describe how the work was done (steps, attempts, investigation). When the author's original request is given, use it only to explain why the change exists; the diff is what changed, and where the two differ the diff wins. Answer only with a JSON object {"title":"...","body":"..."}: a concise conventional-commit-style title, and a markdown body with Summary (2-4 sentences), Changes (bullets, each traceable to the diff) and Testing (only tests the diff adds or changes; otherwise "Not stated").`;
async function prDescription(
  ctx: CommandContext,
  args: Record<string, unknown>,
) {
  const base = optionalString(args.base, "base");
  const context = optionalString(args.context, "context");
  if (args.plannedMessages !== undefined && !strings(args.plannedMessages))
    throw new Error("plannedMessages must be an array of strings");
  const plannedMessages = (args.plannedMessages as string[] | undefined) ?? [];
  if (!base || base.startsWith("-"))
    throw new Error("base must be a valid git ref");
  const cwd = ctx.session.sessionManager.getCwd();
  await git(cwd, ["check-ref-format", "--allow-onelevel", base]);
  const mergeBase = (await git(cwd, ["merge-base", base, "HEAD"])).trim();
  const [log, stat, diff] = await Promise.all([
    git(cwd, ["log", "--reverse", "--format=%s%n%n%b", `${base}..HEAD`]),
    git(cwd, ["diff", "--cached", "--stat", mergeBase]),
    gitBounded(cwd, ["diff", "--cached", "--no-color", mergeBase], 60_000),
  ]);
  if (!log.trim() && !diff.text.trim())
    throw new CommandError("No changes to describe", "no_commits");
  // The outcome (commits and diff) plus the request that started the session, for the why; never the conversation.
  let request = "";
  for (const entry of ctx.session.sessionManager.getBranch()) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "user" ||
      entry.message.attribution === "agent"
    )
      continue;
    const { content } = entry.message;
    request = (
      typeof content === "string"
        ? content
        : content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
    )
      .trim()
      .slice(0, 4000);
    if (request) break;
  }
  const { model, apiKey } = await resolvePrimaryModel(
    undefined,
    ctx.session.settings,
    ctx.session.modelRegistry,
  );
  const userPrompt = `${request ? `Author's original request:\n${request}\n\n` : ""}${context ? `Requester's note: ${context}\n\n` : ""}Commits (oldest first):\n${log}\nPlanned commit messages:\n${plannedMessages.join("\n\n")}\nDiff stat:\n${stat}\nDiff${diff.truncated ? " (truncated)" : ""}:\n${diff.text}`;
  const message = await completeSimple(
    model,
    {
      systemPrompt: [PR_SYSTEM_PROMPT],
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 4096, signal: AbortSignal.timeout(110_000) },
  );
  if (message.stopReason === "error")
    throw new Error(message.errorMessage ?? "PR description generation failed");
  const replyText = extractTextContent(message);
  try {
    const stripped = replyText.replace(/```(?:json)?/gi, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
    if (
      record(parsed) &&
      typeof parsed.title === "string" &&
      parsed.title.trim() &&
      typeof parsed.body === "string" &&
      parsed.body.trim()
    )
      return { title: parsed.title.trim(), body: parsed.body.trim() };
  } catch {
    /* Fall back to the commit log. */
  }
  return { title: log.trim() ? log.split("\n")[0] : plannedMessages[0]?.split("\n")[0] || "Changes", body: `## Changes\n\n${log.trim() || stat.trim()}` };
}

export const gitCommands: CommandTable = {
  commit_plan: planCommit,
  commit_apply: applyCommit,
  generate_pr_description: prDescription,
};
