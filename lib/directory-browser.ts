import * as fsPromises from "fs/promises";
import { homedir } from "os";
import path from "path";

import type { Static } from "@sinclair/typebox";
import type { BrowsableDirectorySchema } from "./api-contracts/workspace-models";

export type BrowsableDirectory = Static<typeof BrowsableDirectorySchema>;

export function getBrowseStartDirectory(directory?: string): string {
  return directory || homedir();
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return homedir();
  if (directory.startsWith("~/"))
    return path.resolve(homedir(), directory.slice(2));
  return path.resolve(directory);
}

export function getParentDirectory(directory: string): string | null {
  const normalized = path.normalize(directory);
  const parent = path.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return fsPromises.realpath(normalizeDirectory(directory));
}

export async function listDirectories(
  directory: string,
): Promise<BrowsableDirectory[]> {
  const entries = await fsPromises.readdir(directory, { withFileTypes: true });
  // Skip broken, inaccessible, or non-directory symlinks.
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        return { name: entry.name, path: path.join(directory, entry.name) };
      }
      if (!entry.isSymbolicLink()) return null;

      try {
        const entryPath = path.join(directory, entry.name);
        const realEntryPath = await fsPromises.realpath(entryPath);
        const entryStat = await fsPromises.stat(realEntryPath);
        if (!entryStat.isDirectory()) return null;
        return { name: entry.name, path: entryPath };
      } catch {
        return null;
      }
    }),
  );

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
