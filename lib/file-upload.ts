import fs from "fs";
import path from "path";
import { isOmpSecretFile } from "./file-access";
import { HostOpError } from "./hosts/link-protocol";
import type { Static } from "@sinclair/typebox";
import type {
  UploadConflictStrategySchema,
  UploadTargetInspectionSchema,
} from "./api-contracts/workspace-models";

export const UPLOAD_CONFLICT_STRATEGIES = [
  "error",
  "overwrite",
  "skip",
] as const;
/** Existing-target policy; overwrite is limited to replaceable regular files. */
export type UploadConflictStrategy = Static<
  typeof UploadConflictStrategySchema
>;

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(
  UPLOAD_CONFLICT_STRATEGIES,
);

/** Existing names and the subset that cannot be replaced, including symlinks and directories. */
export type UploadTargetInspection = Static<
  typeof UploadTargetInspectionSchema
>;

export function parseUploadConflictStrategy(
  value: string | null,
): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? (candidate as UploadConflictStrategy)
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (
      !fileName ||
      fileName === "." ||
      fileName === ".." ||
      fileName.includes("\0")
    ) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

/** Reject protected destinations before reporting filename conflicts, including for daemon-side publication. */
export function inspectUploadTargets(
  directory: string,
  fileNames: string[],
): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    if (isOmpSecretFile(destination))
      throw new HostOpError(403, "access_denied", "Access denied");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}
