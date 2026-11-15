import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspacePaseoPreview } from "../workspace-creation-types";

const MAX_FILE = 1024 * 1024;
function readRegular(file: string, optional = false): string {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error(`Not a bounded regular file: ${file}`);
    const content = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error(`File too large: ${file}`);
    return content;
  } finally { fs.closeSync(fd); }
}

export function readPaseo(projectPath: string): WorkspacePaseoPreview {
  const recipePath = path.join(projectPath, "paseo.json");
  const includePath = path.join(projectPath, ".worktreeinclude");
  const preview: WorkspacePaseoPreview = { path: recipePath, setup: [], teardown: [], includePath, includePatterns: [], unsupportedFeatures: [] };
  try {
    let raw: string;
    try {
      raw = readRegular(recipePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") preview.missing = true;
      throw error;
    }
    const include = readRegular(includePath, true);
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("paseo.json must contain an object");
    const config = data as Record<string, unknown>;
    const worktree = config.worktree === undefined ? {} : config.worktree;
    if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) throw new Error("worktree must be an object");
    const hooks = worktree as Record<string, unknown>;
    const commands = (value: unknown, name: string): string[] => {
      if (value === undefined) return [];
      if (typeof value === "string") return value.trim() ? [value] : [];
      if (Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim())) return value;
      throw new Error(`worktree.${name} must be a string or an array of nonempty strings`);
    };
    // String setup is selectable per nonempty line; array entries remain whole shell commands.
    preview.setup = typeof hooks.setup === "string"
      ? hooks.setup.split(/\r?\n/).filter((line) => !!line.trim())
      : commands(hooks.setup, "setup");
    preview.teardown = commands(hooks.teardown, "teardown");
    preview.includePatterns = include.split(/\r?\n/);
    if (preview.includePatterns.at(-1) === "") preview.includePatterns.pop();
    if (config.scripts !== undefined) preview.unsupportedFeatures.push("scripts and services");
    if (hooks.terminals !== undefined) preview.unsupportedFeatures.push("terminals");
    preview.unsupportedFeatures.push("port allocation and service runtime");
    preview.fingerprint = createHash("sha256").update(raw).update("\0").update(include).digest("hex");
  } catch (error) { preview.error = `Cannot read Paseo recipe: ${error instanceof Error ? error.message : String(error)}`; }
  return preview;
}

/** Match with Git's own ignore engine, independently of the source repository's ignore rules. */
export function copyPaseoIncludes(projectPath: string, destination: string, recipe: WorkspacePaseoPreview): void {
  if (!recipe.includePatterns.length) return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "keylime-paseo-"));
  try {
    execFileSync("git", ["init", "-q", temp], { stdio: "ignore" });
    const excludes = path.join(temp, "patterns");
    fs.writeFileSync(excludes, recipe.includePatterns.join("\n") + "\n");
    const ignored = execFileSync("git", ["-C", projectPath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { maxBuffer: 32 * 1024 * 1024 });
    if (!ignored.length) return;
    let matched: Buffer;
    try {
      matched = execFileSync("git", ["-C", temp, "-c", `core.excludesFile=${excludes}`, "check-ignore", "--no-index", "-z", "--stdin"], { input: ignored, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 1) return;
      throw error;
    }
    for (const relative of matched.toString().split("\0").filter(Boolean)) {
      const parts = relative.split("/");
      if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) throw new Error(`Unsafe included path: ${relative}`);
      let source = projectPath;
      let target = destination;
      for (let i = 0; i < parts.length; i++) {
        source = path.join(source, parts[i]);
        target = path.join(target, parts[i]);
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe included path: ${relative}`);
        if (i < parts.length - 1) {
          try { fs.mkdirSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          const dst = fs.lstatSync(target);
          if (!dst.isDirectory() || dst.isSymbolicLink()) throw new Error(`Unsafe destination path: ${relative}`);
        }
      }
      try {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
