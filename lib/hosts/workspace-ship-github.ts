import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitEnvironment } from "../project-command-env";
import { isRecord } from "../type-guards";

const execFileAsync = promisify(execFile);

/** Ship discovers GitHub.com repos only. Do not let a URL pick another API host. */
export function githubShipPr(value: string, expectedNumber?: number) {
  const match =
    /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})\/pull\/([1-9]\d*)\/?$/i.exec(
      value.trim(),
    );
  if (!match || match[2] === "." || match[2] === "..")
    throw new Error("Invalid GitHub pull request URL");
  const number = Number(match[3]);
  if (
    !Number.isSafeInteger(number) ||
    (expectedNumber !== undefined && number !== expectedNumber)
  )
    throw new Error("GitHub pull request URL does not match its number");
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

async function ghRead(cwd: string, args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    env: createGitEnvironment({ GH_PROMPT_DISABLED: "1" }),
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

interface ShipPrStatus {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt?: string | null;
  autoMergeRequest?: unknown;
  statusCheckRollup?:
    | {
        status?: string;
        conclusion?: string;
        state?: string;
      }[]
    | null;
}

export async function readShipPrStatus(
  cwd: string,
  prUrl: string,
  number: number,
): Promise<ShipPrStatus> {
  const pinned = githubShipPr(prUrl, number);
  const data = await ghRead(cwd, [
    "pr",
    "view",
    pinned.url,
    "--json",
    "state,mergedAt,url,number,autoMergeRequest,statusCheckRollup",
  ]);
  if (
    !isRecord(data) ||
    data.number !== pinned.number ||
    typeof data.url !== "string" ||
    githubShipPr(data.url).url !== pinned.url ||
    (data.state !== "OPEN" &&
      data.state !== "MERGED" &&
      data.state !== "CLOSED")
  )
    throw new Error("Unexpected GitHub pull request status");
  return data as unknown as ShipPrStatus;
}

const sources = [
  {
    kind: "conversation",
    path: "issues",
    resource: "comments",
    anchor: "issuecomment-",
  },
  {
    kind: "inline",
    path: "pulls",
    resource: "comments",
    anchor: "discussion_r",
  },
  {
    kind: "review",
    path: "pulls",
    resource: "reviews",
    anchor: "pullrequestreview-",
  },
] as const;

export interface ShipFeedback {
  key: string;
  id: number;
  at: number;
  url: string;
}

export async function readShipFeedback(
  cwd: string,
  prUrl: string,
): Promise<ShipFeedback[]> {
  const pr = githubShipPr(prUrl);
  const groups = await Promise.all(
    sources.map(async ({ kind, path, resource, anchor }) => {
      const pages = await ghRead(cwd, [
        "api",
        "--hostname",
        "github.com",
        "--paginate",
        "--slurp",
        `repos/${pr.repo}/${path}/${pr.number}/${resource}?per_page=100`,
      ]);
      if (!Array.isArray(pages) || !pages.length)
        throw new Error("Invalid GitHub feedback response");
      const events: ShipFeedback[] = [];
      for (const page of pages) {
        if (!Array.isArray(page))
          throw new Error("Invalid GitHub feedback page");
        for (const row of page as unknown[]) {
          if (!isRecord(row)) throw new Error("Invalid GitHub feedback entry");
          if (kind === "review" && row.state === "PENDING") continue;
          const id = row.id;
          const timestamp =
            kind === "review" ? row.submitted_at : row.created_at;
          const at =
            typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
          if (
            typeof id !== "number" ||
            !Number.isSafeInteger(id) ||
            id <= 0 ||
            !Number.isFinite(at)
          )
            throw new Error("Invalid GitHub feedback identity or timestamp");
          // Never take link text, URLs or other user-authored content from a response.
          events.push({
            key: `${kind}:${id}`,
            id,
            at,
            url: `${pr.url}#${anchor}${id}`,
          });
        }
      }
      return events;
    }),
  );
  return groups
    .flat()
    .sort(
      (a, b) =>
        a.at - b.at ||
        a.id - b.id ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
}
