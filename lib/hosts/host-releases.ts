import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeployHostReleaseArgs, HostReleaseList } from "../api-contracts/host-control-models";
import { MAX_UPLOAD_BYTES } from "../upload-limits";
import { abortUpload, putUploadChunk, stageHostArtifact, startUpload, UploadError } from "../uploads";
import { hostArtifactActivationOp, hostReleaseTarget } from "./hub";

const DAEMON = "keylime";
const RUNNER = "keylime-omp";
const CHUNK_BYTES = 1024 * 1024;

type Release = HostReleaseList["releases"][number] & { directory: string };

async function catalog(hostId: string): Promise<Release[]> {
  const { platform, arch } = hostReleaseTarget(hostId);
  const candidates: { name: string; directory: string }[] = [];
  if (platform === process.platform && arch === process.arch) {
    const base = join(homedir(), ".local/share/keylime/releases");
    const entries = await readdir(base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-f0-9]{12}-\d{13}$/.test(entry.name))
        candidates.push({ name: entry.name, directory: join(base, entry.name) });
    }
  }
  const name = `keylime-${platform}-${arch}`;
  candidates.push({
    name,
    directory: join(process.env.KEYLIME_PACKAGE_DIR || process.cwd(), "release", name),
  });
  const releases: Release[] = [];
  for (const { name, directory } of candidates) {
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
      const daemon = await lstat(join(directory, DAEMON));
      const runner = await lstat(join(directory, RUNNER));
      if (![daemon, runner].every((file) => file.isFile() && (file.mode & 0o111) !== 0 && file.size > 0 && file.size <= MAX_UPLOAD_BYTES)) continue;
      const stamp = Math.max(daemon.mtimeMs, runner.mtimeMs);
      const build = /-(\d{13})$/.exec(name);
      const id = build ? name : `${name}-${Math.trunc(stamp)}`;
      releases.push({ id, builtAt: new Date(build ? Number(build[1]) : stamp).toISOString(), directory });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return releases.sort((a, b) => b.builtAt.localeCompare(a.builtAt) || a.id.localeCompare(b.id));
}

export async function listHostReleases(hostId: string): Promise<HostReleaseList> {
  return { releases: (await catalog(hostId)).map(({ id, builtAt }) => ({ id, builtAt })) };
}

export async function deployHostRelease(hostId: string, owner: string, args: DeployHostReleaseArgs, signal: AbortSignal) {
  const release = (await catalog(hostId)).find((entry) => entry.id === args.releaseId);
  if (!release)
    throw new UploadError(404, "host_release_missing", "That build is no longer available for this host");

  // Pin both files before transferring either one. Reuse one bounded upload buffer.
  const daemon = await open(join(release.directory, DAEMON), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const runner = await open(join(release.directory, RUNNER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const send = async (source: typeof daemon, name: string) => {
        const file = await source.stat();
        if (!file.isFile() || file.size < 1 || file.size > MAX_UPLOAD_BYTES)
          throw new UploadError(409, "host_release_changed", "The build changed; reopen the release list");
        const artifactId = randomUUID();
        const hash = createHash("sha256");
        let offset = 0;
        signal.throwIfAborted();
        try {
          await startUpload({
            id: artifactId, owner, hostId, name, size: file.size,
            type: "application/octet-stream", sink: { ack() {}, error() {} },
          });
          while (offset < file.size) {
            signal.throwIfAborted();
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
            if (bytesRead === 0)
              throw new UploadError(409, "host_release_changed", "The build changed during transfer");
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await putUploadChunk(artifactId, owner, offset, chunk);
            offset += bytesRead;
          }
          signal.throwIfAborted();
          await stageHostArtifact(artifactId, owner, hostId);
          return { artifactId, sha256: hash.digest("hex") };
        } finally {
          // Transport cleanup does not remove the finalized host artifact.
          await abortUpload(artifactId, owner, hostId);
        }
      };
      const artifact = await send(daemon, DAEMON);
      const runnerArtifact = await send(runner, RUNNER);
      signal.throwIfAborted();
      return await hostArtifactActivationOp(hostId, "activateHostArtifact", {
        ...artifact, runner: runnerArtifact, operationId: args.operationId, target: DAEMON,
      });
    } finally {
      await runner.close();
    }
  } finally {
    await daemon.close();
  }
}
