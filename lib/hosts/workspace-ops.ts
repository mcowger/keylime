import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authorizeFileAccess } from "../file-authorization";
import {
  existingPathWithinRootsChecker,
  isAbsoluteFileRequestPath,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "../file-access";
import { resolveDirentIsDirectory } from "../file-dirent";
import { indexWorkspaceFiles } from "../file-index";
import { inspectUploadTargets, validateUploadFileNames } from "../file-upload";
import type { StagedUploads } from "./uploads";
import { MAX_RESULT_LIMIT } from "../file-fuzzy";
import {
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileLanguage,
  getImageMime,
  TEXT_PREVIEW_MAX_BYTES,
} from "../file-types";
import {
  MAX_INLINE_BASH_OUTPUT_BYTES,
  openRegularFileNoFollow,
  readUtf8FileWithinLimit,
  resolveBashOutputPath,
} from "../bash-output";
import { isBashOutputPathReferencedBySession } from "../session-file-references";
import { isRecord } from "../type-guards";
import type {
  GitOrigin,
  GitAction,
  GitActionResponse,
  WorkspaceFileEvent,
  WorkspaceFileInfo,
  WorkspaceFileRequest,
  WorkspaceOps,
} from "../workspace-types";
import { HostOpError } from "./link-protocol";
import type { OpResult } from "./session-ops";
import {
  authorizeWorkspaceDirectory,
  getWorkspaceRoots,
} from "./workspace-roots";
import { WorkspaceReads } from "./workspace-reads";
import { WorkspaceWatches } from "./workspace-watch";
import { getGitFileDiff, getGitStatus } from "../git-changes";
import { resolveGithubRepo } from "../github-repo";
import { repositoryKey } from "../git-clone";
import { createGitEnvironment } from "../project-command-env";
import {
  findCurrentWorktreePath,
  listWorktrees,
  resolveProject,
  type WorktreeInfo,
} from "../worktree";
import { projectIdentityKey } from "../paths";
import { grantWorkspaceRoot } from "./workspace-roots";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  resolveDirectory,
} from "../directory-browser";
import { WorkspaceClones } from "./workspace-clone";
import { parseLocalUri } from "../local-uri";
import { resolveSessionLocalFile } from "../session-local-files";
import { filePathApiSegments } from "../file-paths";
import { hierarchyOperation } from "./project-hierarchy";
import { isEffortPath } from "./systems";
import {
  registerShipPr,
  shipPreview,
  startShip,
  startShipMonitor,
  shipStatus,
  shipFinish,
  stopShipMonitor,
  shipMonitorStatus,
} from "./workspace-ship";
import {
  createWorkspace,
  workspaceCreationStatus,
  workspaceCreationSettings,
  workspaceBranches,
  removeRegisteredWorktree,
  workspaceCreationBusy,
  recoverWorkspaceCreation,
} from "./workspace-creation";

const invalid = () =>
  new HostOpError(400, "invalid_request", "Invalid workspace request");
async function result<T>(action: () => Promise<T>): Promise<OpResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    if (error instanceof HostOpError)
      return {
        ok: false,
        status: error.status,
        code: error.code,
        error: error.message,
      };
    throw error;
  }
}

const MAX_GIT_ORIGIN_PATHS = 500;
const MAX_GIT_ORIGIN_PATH_LENGTH = 4096;
const MAX_GIT_ORIGIN_LENGTH = 2048;
const NO_GIT_ORIGIN = { origin: null, mainCheckout: false } as const;
/** Tests shorten the budget. */
export const gitOriginLimits = { concurrency: 8, budgetMs: 20_000 };
const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      env: createGitEnvironment({ LC_ALL: "C" }),
    })
  ).stdout;

const gitActionArgs: Record<GitAction, readonly string[]> = {
  push: ["push"],
  pull: ["pull", "--no-edit"],
  fetch: ["fetch"],
  "rebase-main": ["rebase", "refs/heads/main"],
  "rebase-origin-main": ["rebase", "refs/remotes/origin/main"],
};

async function runGitAction(
  cwd: string,
  action: GitAction,
): Promise<GitActionResponse> {
  if (typeof action !== "string" || !Object.hasOwn(gitActionArgs, action))
    throw invalid();
  try {
    const { promise, resolve, reject } = Promise.withResolvers<{
      stdout: string;
      stderr: string;
    }>();
    let timedOut = false;
    let outputBytes = 0;
    let overflow = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn("git", ["-C", cwd, ...gitActionArgs[action]], {
      detached: true,
      env: createGitEnvironment({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "false",
        SSH_ASKPASS: "false",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_MERGE_AUTOEDIT: "no",
      }),
    });
    const terminate = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 20_000);
    timer.unref?.();
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        overflow = true;
        terminate();
      } else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
      if (code !== 0 || signal || timedOut || overflow) {
        reject(
          Object.assign(new Error("Git action failed"), output, {
            timedOut,
            signal,
            code: overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code,
          }),
        );
      } else resolve(output);
    });
    child.stdin.end();
    const { stdout, stderr } = await promise;
    return {
      output: [stdout, stderr].filter(Boolean).join("\n").slice(0, 32768),
    };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      code?: string | number;
      timedOut?: boolean;
    };
    const details = [failure.stderr, failure.stdout]
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(0, 30000);
    if (
      failure.timedOut ||
      failure.killed ||
      failure.signal ||
      failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      throw new HostOpError(
        504,
        "git_outcome_unknown",
        `Git did not finish normally; its outcome may be unknown. Inspect the repository and remote before deciding what to do.${details ? `\n${details}` : ""}`,
      );
    throw new HostOpError(
      409,
      "git_action_failed",
      details || failure.message || "Git action failed",
    );
  }
}

/** Unauthorized, missing and non-repository paths answer the same as a plain folder. */
async function gitOrigin(requested: string): Promise<Omit<GitOrigin, "path">> {
  try {
    const directory = await authorizeWorkspaceDirectory(requested);
    // --show-cdup is empty only at a worktree's top (and in a bare repository, which is not inside one): no comparison
    // between Git's and the caller's path spelling (8.3 names, drive-letter case, separators), as pool preparation does.
    const atTop =
      (
        await git(
          directory,
          "rev-parse",
          "--is-inside-work-tree",
          "--show-cdup",
        )
      ).trim() === "true";
    const dotGit = fs.lstatSync(path.join(directory, ".git"), {
      throwIfNoEntry: false,
    });
    const mainCheckout = !!dotGit?.isDirectory() && atTop;
    const urls = await git(
      directory,
      "config",
      "--null",
      "--get-all",
      "remote.origin.url",
    ).catch(() => "");
    const values = urls.split("\0").slice(0, -1);
    const [value] = values;
    // Only a plain repository URL (no credentials, no local path) of sane length is reported.
    return {
      origin:
        values.length === 1 &&
        value.length <= MAX_GIT_ORIGIN_LENGTH &&
        repositoryKey(value) !== null
          ? value
          : null,
      mainCheckout,
    };
  } catch {
    return NO_GIT_ORIGIN;
  }
}

function fileInfo(filePath: string, stat: fs.Stats): WorkspaceFileInfo {
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    isDirectory: stat.isDirectory(),
    language: getFileLanguage(filePath),
    mime:
      getImageMime(filePath) ??
      getAudioMime(filePath) ??
      getDocumentMime(filePath) ??
      "text/plain",
    previewKind: documentPreviewKind(filePath),
  };
}
async function access(input: WorkspaceFileRequest, reference: boolean) {
  if (
    !isRecord(input) ||
    !Array.isArray(input.segments) ||
    !input.segments.every((part) => typeof part === "string") ||
    !(input.sessionId === null || typeof input.sessionId === "string") ||
    !(
      input.sessionFile === undefined ||
      input.sessionFile === null ||
      typeof input.sessionFile === "string"
    )
  )
    throw invalid();
  if (input.owner && input.owner.sessionId !== input.sessionId) throw invalid();
  const checked = await authorizeFileAccess(
    input.segments,
    input.sessionId,
    reference,
    await getWorkspaceRoots(input.owner),
    input.sessionFile,
  );
  if (!checked.ok)
    throw new HostOpError(checked.status, checked.code, checked.error);
  return checked;
}
async function listDirectory(input: WorkspaceFileRequest, root: string | null) {
  if (root !== null && typeof root !== "string") throw invalid();
  const checked = await access(input, false);
  if (!checked.stat.isDirectory())
    throw new HostOpError(400, "not_a_directory", "Not a directory");
  let insideRoot: ((target: string) => boolean) | null = null;
  if (root !== null) {
    // The listed path is authorized already; the root can only narrow it.
    if (!isAbsoluteFileRequestPath(root))
      throw new HostOpError(403, "outside_root", "Outside the explorer root");
    insideRoot = existingPathWithinRootsChecker(new Set([root]));
    if (!insideRoot(checked.filePath))
      throw new HostOpError(403, "outside_root", "Outside the explorer root");
  }
  const entries = fs
    .readdirSync(checked.filePath, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(checked.filePath, entry.name);
      const isDir = resolveDirentIsDirectory(entry, entryPath);
      const isLink = entry.isSymbolicLink();
      if (isDir === null && !isLink) return [];
      let linkTarget: string | undefined;
      if (isLink) {
        try {
          linkTarget = fs.readlinkSync(entryPath);
        } catch {
          /* Replaced since readdir: list it without a target. */
        }
      }
      const outsideRoot =
        insideRoot !== null && isLink && !insideRoot(entryPath);
      return [
        {
          name: entry.name,
          isDir: isDir ?? false,
          size: 0,
          modified: "",
          ...(linkTarget !== undefined && { linkTarget }),
          ...(outsideRoot && { outsideRoot }),
        },
      ];
    })
    .sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    );
  return { path: checked.filePath, entries };
}
async function openFile(input: WorkspaceFileRequest) {
  const checked = await access(input, true);
  if (!checked.stat.isFile())
    throw new HostOpError(400, "not_a_file", "Not a file");
  const opened = await openRegularFileNoFollow(
    fs.realpathSync(checked.filePath),
  );
  if (
    opened.fileInfo.dev !== checked.stat.dev ||
    opened.fileInfo.ino !== checked.stat.ino
  ) {
    await opened.handle.close();
    throw new HostOpError(
      409,
      "file_changed",
      "The file changed while it was being opened",
    );
  }
  return {
    handle: opened.handle,
    info: fileInfo(checked.filePath, opened.fileInfo),
  };
}
async function bashPath(sessionId: string, requested: string): Promise<string> {
  if (typeof sessionId !== "string" || typeof requested !== "string")
    throw invalid();
  const resolved = resolveBashOutputPath(requested, tmpdir());
  if (!resolved)
    throw new HostOpError(400, "invalid_path", "Invalid bash output path");
  if (!(await isBashOutputPathReferencedBySession(resolved, sessionId)))
    throw new HostOpError(403, "access_denied", "Access denied");
  return resolved;
}

export interface WorkspaceService {
  ops: Omit<
    WorkspaceOps,
    "terminals" | "systems" | "planning" | "workspaceScripts"
  >;
  busy(): boolean;
  onDisconnect(): void;
  stop(): Promise<void>;
}

export function createWorkspaceService(
  uploads: StagedUploads,
  emit: (id: string, epoch: string, event: WorkspaceFileEvent) => void,
  {
    shipOwner,
    assertShipMonitorAvailable,
  }: {
    shipOwner?: string;
    assertShipMonitorAvailable?: (path: string) => void;
  } = {},
): WorkspaceService {
  recoverWorkspaceCreation();
  const reads = new WorkspaceReads();
  const clones = new WorkspaceClones();
  let epoch = 0;
  const watches = new WorkspaceWatches(async (input) => {
    const checked = await access(input, true);
    return fileInfo(checked.filePath, checked.stat);
  }, emit);
  const ops: WorkspaceService["ops"] = {
    hierarchy: hierarchyOperation,
    shipPreview: (input) => result(() => shipPreview(input)),
    registerShipPr: (input) =>
      result(() => registerShipPr(input, assertShipMonitorAvailable)),
    startShip: (input) => result(() => startShip(input, shipOwner)),
    startShipMonitor: (input) =>
      result(() =>
        startShipMonitor(input, shipOwner, assertShipMonitorAvailable),
      ),
    stopShipMonitor: (input) =>
      result(async () => {
        if (!shipOwner)
          throw new HostOpError(
            403,
            "access_denied",
            "No authenticated server link",
          );
        return stopShipMonitor(input, shipOwner);
      }),
    shipMonitorStatus: (input) =>
      result(() => shipMonitorStatus(input, shipOwner)),
    shipStatus: (id) => result(() => shipStatus(id)),
    shipFinish: (input) => result(() => shipFinish(input)),
    createWorkspace: (input) => result(() => createWorkspace(input)),
    workspaceCreationStatus: (id) => result(() => workspaceCreationStatus(id)),
    workspaceCreationSettings: (input) =>
      result(() => workspaceCreationSettings(input)),
    workspaceBranches: (projectPath) =>
      result(() => workspaceBranches(projectPath)),
    removeRegisteredWorktree: (input) =>
      result(() => removeRegisteredWorktree(input)),
    home: () => result(async () => ({ home: homedir() })),
    browseDirectories: (requested) =>
      result(async () => {
        if (requested !== null && typeof requested !== "string")
          throw invalid();
        const input = requested?.trim();
        let directory: string;
        try {
          directory = await resolveDirectory(getBrowseStartDirectory(input));
        } catch {
          throw new HostOpError(
            404,
            "directory_not_found",
            "Directory does not exist",
          );
        }
        if (!fs.statSync(directory).isDirectory())
          throw new HostOpError(
            400,
            "not_a_directory",
            "Path is not a directory",
          );
        return {
          path: directory,
          parentPath: getParentDirectory(directory),
          directories: await listDirectories(directory),
        };
      }),
    defaultCwd: () =>
      result(async () => {
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const directory = path.join(homedir(), `omp-cwd-${date}`);
        fs.mkdirSync(directory, { recursive: true });
        const cwd = fs.realpathSync(directory);
        grantWorkspaceRoot(cwd);
        return { cwd };
      }),
    startClone: (id, parent, url) =>
      result(() => clones.start(id, parent, url)),
    readClone: (id, cursor) => result(() => clones.read(id, cursor)),
    cancelClone: (id) => result(() => clones.cancel(id)),
    resolveLocalFile: (id, uri, sessionFile) =>
      result(async () => {
        if (
          typeof id !== "string" ||
          typeof uri !== "string" ||
          !(sessionFile === null || typeof sessionFile === "string")
        )
          throw invalid();
        // Parsed again here: this host's platform decides what an absolute or drive-lettered name is.
        const parsed = parseLocalUri(uri);
        if (!parsed.ok)
          throw new HostOpError(400, "invalid_local_uri", parsed.error);
        const located = await resolveSessionLocalFile(
          id,
          parsed.relative,
          sessionFile,
        );
        if (!located.ok)
          throw new HostOpError(located.status, located.code, located.error);
        return { path: located.path };
      }),
    gitStatus: (cwd, owner) =>
      result(async () =>
        getGitStatus(await authorizeWorkspaceDirectory(cwd, owner)),
      ),
    gitAction: (cwd, action, owner) =>
      result(async () =>
        runGitAction(await authorizeWorkspaceDirectory(cwd, owner), action),
      ),
    gitDiff: (cwd, requested, owner) =>
      result(async () => {
        const directory = await authorizeWorkspaceDirectory(cwd, owner);
        if (typeof requested !== "string" || !path.isAbsolute(requested))
          throw invalid();
        const checked = await access(
          {
            segments: filePathApiSegments(requested),
            sessionId: owner?.sessionId ?? null,
            owner,
          },
          false,
        );
        return getGitFileDiff(directory, checked.filePath);
      }),
    githubRepo: (cwd) =>
      result(async () => ({
        repo: await resolveGithubRepo(await authorizeWorkspaceDirectory(cwd)),
      })),
    gitOrigins: (paths) =>
      result(async () => {
        if (
          !Array.isArray(paths) ||
          paths.length > MAX_GIT_ORIGIN_PATHS ||
          !paths.every(
            (entry) =>
              typeof entry === "string" &&
              entry.length > 0 &&
              entry.length <= MAX_GIT_ORIGIN_PATH_LENGTH,
          )
        )
          throw invalid();
        const deadline = Date.now() + gitOriginLimits.budgetMs;
        const origins: GitOrigin[] = new Array(paths.length);
        let next = 0;
        // A path whose turn starts after the budget is spent answers like a plain folder, so the op outlasts neither a stalled mount nor the link deadline.
        const worker = async () => {
          for (let index = next++; index < paths.length; index = next++) {
            origins[index] = {
              path: paths[index],
              ...(Date.now() < deadline
                ? await gitOrigin(paths[index])
                : NO_GIT_ORIGIN),
            };
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(gitOriginLimits.concurrency, paths.length) },
            worker,
          ),
        );
        return { origins };
      }),
    listWorktrees: (cwd) =>
      result(async () => {
        const directory = await authorizeWorkspaceDirectory(cwd);
        const project = await resolveProject(directory);
        let worktrees: WorktreeInfo[] = [];
        let isGit = true;
        try {
          worktrees = await listWorktrees(
            fs.existsSync(path.join(directory, ".git"))
              ? directory
              : project.projectRoot,
          );
        } catch {
          isGit = false;
        }
        worktrees = worktrees.filter(
          (tree) =>
            !isEffortPath(tree.path) &&
            !fs.lstatSync(tree.path).isSymbolicLink(),
        );
        for (const tree of worktrees) grantWorkspaceRoot(tree.path);
        return {
          projectRoot: project.projectRoot,
          projectKey: projectIdentityKey(project.projectRoot),
          isGit,
          isTopLevel: project.isTopLevel,
          currentWorktreePath: findCurrentWorktreePath(worktrees, directory),
          worktrees,
        };
      }),
    watchFile: (id, epoch, input) =>
      result(() => watches.watch(id, epoch, input)),
    unwatchFile: (id, epoch) =>
      result(async () => {
        watches.unwatch(id, epoch);
        return null;
      }),
    inspectUploads: (directory, names, owner) =>
      result(async () => {
        if (
          !Array.isArray(names) ||
          names.length > 1000 ||
          !names.every((name) => typeof name === "string")
        )
          throw invalid();
        const error = validateUploadFileNames(names);
        if (error) throw new HostOpError(400, "invalid_file_name", error);
        return inspectUploadTargets(
          await authorizeWorkspaceDirectory(directory, owner),
          names,
        );
      }),
    publishUpload: (id, directory, name, conflict, owner) =>
      result(() => uploads.publish(id, directory, name, conflict, owner)),
    listFiles: (input, showHidden) =>
      result(async () => {
        if (typeof showHidden !== "boolean") throw invalid();
        return listDirectory(input, null);
      }),
    listFilesInRoot: (input, root) => result(() => listDirectory(input, root)),
    fileInfo: (input) =>
      result(async () => {
        const checked = await access(input, true);
        return fileInfo(checked.filePath, checked.stat);
      }),
    openFile: (input) =>
      result(async () => {
        const started = epoch;
        const opened = await openFile(input);
        if (started !== epoch) {
          await opened.handle.close();
          throw new HostOpError(503, "host_offline", "The owner link closed");
        }
        return reads.add(opened.handle, opened.info);
      }),
    readFileChunk: (id, offset, length) =>
      result(() => reads.read(id, offset, length)),
    closeFile: (id) =>
      result(async () => {
        if (typeof id !== "string") throw invalid();
        await reads.close(id);
        return null;
      }),
    readTextFile: (input) =>
      result(async () => {
        const started = epoch;
        const opened = await openFile(input);
        if (started !== epoch) {
          await opened.handle.close();
          throw new HostOpError(503, "host_offline", "The owner link closed");
        }
        const ticket = reads.add(opened.handle, opened.info);
        try {
          if (opened.info.size > TEXT_PREVIEW_MAX_BYTES)
            throw new HostOpError(
              413,
              "file_too_large_preview",
              "File too large for preview (>256KB)",
            );
          const content =
            opened.info.size === 0
              ? ""
              : (await reads.read(ticket.id, 0, opened.info.size)).toString(
                  "utf8",
                );
          return {
            content,
            language: opened.info.language,
            size: opened.info.size,
          };
        } finally {
          await reads.close(ticket.id);
        }
      }),
    fileIndex: (cwd, query, limit, kind, refresh, owner) =>
      result(async () => {
        if (typeof cwd !== "string" || !path.isAbsolute(cwd))
          throw new HostOpError(
            400,
            "cwd_must_be_absolute",
            "cwd must be an absolute path",
          );
        if (
          typeof query !== "string" ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > MAX_RESULT_LIMIT ||
          (kind !== "all" && kind !== "file") ||
          typeof refresh !== "boolean"
        )
          throw invalid();
        const roots = await getWorkspaceRoots(owner);
        if (!isFilePathAllowed(cwd, roots))
          throw new HostOpError(403, "access_denied", "Access denied");
        let stat: fs.Stats;
        try {
          stat = fs.statSync(cwd);
        } catch {
          throw new HostOpError(
            404,
            "directory_not_found",
            "Directory not found",
          );
        }
        if (!stat.isDirectory())
          throw new HostOpError(400, "not_a_directory", "Not a directory");
        if (!isExistingFilePathAllowed(cwd, roots))
          throw new HostOpError(403, "access_denied", "Access denied");
        return indexWorkspaceFiles(
          cwd,
          query.slice(0, 500),
          limit,
          kind,
          refresh,
        );
      }),
    readBashOutput: (id, requested) =>
      result(async () => {
        const read = await readUtf8FileWithinLimit(
          await bashPath(id, requested),
        );
        return read.tooLarge
          ? {
              tooLarge: true as const,
              size: read.size,
              maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES,
            }
          : { tooLarge: false as const, output: read.content };
      }),
    openBashOutput: (id, requested) =>
      result(async () => {
        const started = epoch;
        const resolved = await bashPath(id, requested);
        const opened = await openRegularFileNoFollow(resolved);
        if (started !== epoch) {
          await opened.handle.close();
          throw new HostOpError(503, "host_offline", "The owner link closed");
        }
        return reads.add(opened.handle, fileInfo(resolved, opened.fileInfo));
      }),
  };
  return {
    ops,
    busy: () => reads.size > 0 || clones.busy() || workspaceCreationBusy(),
    onDisconnect: () => {
      epoch++;
      watches.closeAll();
      void reads.closeAll().catch(() => {});
    },
    stop: async () => {
      epoch++;
      watches.closeAll();
      await Promise.all([reads.closeAll(), clones.stop()]);
    },
  };
}
