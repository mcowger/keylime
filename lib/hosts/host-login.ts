// The daemon's saved controller login, shared by `keylime host` and local-bootstrap.
// Pure Node: no daemon/spawn code, `next/*` or `@/` imports.
import { randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  readFileSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

const loginFile = () => join(getAgentDir(), "keylime", "host.json");
const trimUrl = (url: string) => url.replace(/\/+$/, "");

export type HostLink = { url: string; token: string };
type HostConfig = Record<string, unknown> & {
  url?: string;
  token?: string;
};

export const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(\.\d{1,3}){3}$/.test(hostname);

/** Existing configuration must never be confused with a first login. */
export class HostLoginUnreadableError extends Error {
  readonly name = "HostLoginUnreadableError";
}

function normalizeLink(link: HostLink): HostLink {
  const { protocol } = new URL(link.url);
  if (protocol !== "https:" && protocol !== "http:")
    throw new Error("The server URL must start with https:// or http://");
  const token = link.token.trim();
  if (!token) throw new Error("The host token is empty");
  return { url: trimUrl(link.url), token };
}

function readConfig(): HostConfig {
  const file = loginFile();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new HostLoginUnreadableError(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let saved: unknown;
  try {
    saved = JSON.parse(text);
    if (!isRecord(saved) || "links" in saved) throw new Error();
    if ("url" in saved || "token" in saved) {
      if (typeof saved.url !== "string" || typeof saved.token !== "string")
        throw new Error();
      normalizeLink({ url: saved.url, token: saved.token });
    }
  } catch {
    throw new HostLoginUnreadableError(
      `${file} is not valid host link configuration`,
    );
  }
  return saved as HostConfig;
}

function configLogin(saved: HostConfig): HostLink | null {
  return saved.url !== undefined && saved.token !== undefined
    ? normalizeLink({ url: saved.url, token: saved.token })
    : null;
}

export function readHostLogin(): HostLink | null {
  return configLogin(readConfig());
}

function ownerExited(text: string): boolean {
  const owner: unknown = JSON.parse(text);
  if (
    !isRecord(owner) ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0
  )
    return false;
  try {
    process.kill(owner.pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** A lock's age proves nothing: only ESRCH proves that its owner has exited.
 * Recovery is serialized by an exclusive `.recover` file so it can never unlink a lock a faster recoverer's successor just took. */
function recoverLock(lock: string): void {
  const mutex = `${lock}.recover`;
  try {
    const before = lstatSync(lock);
    if (!before.isFile()) return;
    const text = readFileSync(lock, "utf8");
    if (!ownerExited(text)) return;
    // Published by link(): the mutex never exists without its owner's pid, so a crash cannot leave an unreadable one.
    const temp = `${mutex}.${process.pid}.${randomUUID()}`;
    writeFileSync(temp, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
      flag: "wx",
    });
    let ours: Stats;
    try {
      ours = lstatSync(temp);
      linkSync(temp, mutex);
    } catch (error) {
      // Another recoverer holds the mutex; only a proven-dead one is displaced.
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        ownerExited(readFileSync(mutex, "utf8"))
      )
        unlinkSync(mutex);
      return;
    } finally {
      unlinkSync(temp);
    }
    try {
      const current = lstatSync(lock);
      if (
        current.dev === before.dev &&
        current.ino === before.ino &&
        readFileSync(lock, "utf8") === text
      )
        unlinkSync(lock);
    } finally {
      try {
        const now = lstatSync(mutex);
        if (now.dev === ours.dev && now.ino === ours.ino) unlinkSync(mutex);
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Another writer may have released/recovered it; unreadable ownership is never a stale lock.
  }
}

async function mutateConfig(
  update: (saved: HostConfig) => void,
): Promise<void> {
  const file = loginFile();
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + 5_000;
  let lease: FileHandle;
  for (;;) {
    try {
      lease = await open(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      recoverLock(lock);
      if (Date.now() >= deadline)
        throw new Error(`Host configuration lock timed out: ${lock}`);
      await sleep(50);
    }
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let failure: { error: unknown } | undefined;
  try {
    await lease.writeFile(JSON.stringify({ pid: process.pid }));
    const saved = readConfig();
    const before = JSON.stringify(saved);
    update(saved);
    if (JSON.stringify(saved) !== before) {
      // Exclusive creation prevents a stale or substituted temp file from widening token permissions.
      const output = await open(temp, "wx", 0o600);
      try {
        await output.writeFile(`${JSON.stringify(saved)}\n`);
      } finally {
        await output.close();
      }
      await rename(temp, file);
    }
  } catch (error) {
    failure = { error };
  }
  // Release never throws mid-way, and a release error never masks the update's own.
  try {
    await rm(temp, { force: true });
  } catch (error) {
    failure ??= { error };
  }
  try {
    const held = await lease.stat();
    const current = lstatSync(lock);
    if (current.dev === held.dev && current.ino === held.ino) unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      failure ??= { error };
  }
  try {
    await lease.close();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}

/** Replace the controller, preserving unrelated config. Bootstrap selects the token under this lock. */
export async function loginHost(
  input: HostLink | ((saved: HostLink | null) => HostLink),
): Promise<void> {
  await mutateConfig((saved) => {
    Object.assign(
      saved,
      normalizeLink(
        typeof input === "function" ? input(configLogin(saved)) : input,
      ),
    );
  });
}

export async function removeHostLink(url: string): Promise<void> {
  await mutateConfig((saved) => {
    if (configLogin(saved)?.url !== trimUrl(url)) return;
    delete saved.url;
    delete saved.token;
  });
}
