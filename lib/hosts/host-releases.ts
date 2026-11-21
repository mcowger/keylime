import { randomUUID } from "node:crypto";
import { lstat, readdir, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DeployHostReleaseArgs,
  HostInstalledBinaryDigests,
  HostReleaseDeployFrame,
  HostReleaseList,
} from "../api-contracts/host-control-models";
import { MAX_UPLOAD_BYTES } from "../upload-limits";
import {
  abortUpload,
  putUploadChunk,
  stageHostArtifact,
  startUpload,
  UploadError,
} from "../uploads";
import { digestBinary, openBinary } from "./binary-digest";
import {
  hostArtifactActivationOp,
  hostReleaseTarget,
  readHostInstalledBinaryDigests,
} from "./hub";
import { HostOpError } from "./link-protocol";

const DAEMON = "keylime";
const RUNNER = "keylime-omp";
const CHUNK_BYTES = 1024 * 1024;

type Release = Omit<HostReleaseList["releases"][number], "status"> & {
  directory: string;
};

function binaryDigestsUnsupported(error: unknown): boolean {
  return (
    error instanceof HostOpError &&
    error.code === "host_binary_digests_unsupported"
  );
}

async function requireDifferentBuild(
  hostId: string,
  release: HostInstalledBinaryDigests,
) {
  let installed: HostInstalledBinaryDigests;
  try {
    installed = await readHostInstalledBinaryDigests(hostId);
  } catch (error) {
    if (binaryDigestsUnsupported(error)) return;
    throw error;
  }
  if (
    installed.keylime === release.keylime &&
    installed.runner === release.runner
  )
    throw new UploadError(
      409,
      "host_release_already_installed",
      "This release is already installed on the host",
    );
}

async function releaseDigest(source: FileHandle, signal?: AbortSignal) {
  try {
    return await digestBinary(source, signal);
  } catch {
    signal?.throwIfAborted();
    throw new UploadError(
      409,
      "host_release_changed",
      "The build changed or couldn't be read; reopen the release list",
    );
  }
}

async function withReleaseBinaries<T>(
  release: Release,
  run: (daemon: FileHandle, runner: FileHandle) => Promise<T>,
): Promise<T> {
  // Pin the pair before hashing or transferring either file.
  const daemon = await openBinary(join(release.directory, DAEMON));
  try {
    const runner = await openBinary(join(release.directory, RUNNER));
    try {
      return await run(daemon, runner);
    } finally {
      await runner.close();
    }
  } finally {
    await daemon.close();
  }
}

async function catalog(hostId: string): Promise<Release[]> {
  const { platform, arch } = hostReleaseTarget(hostId);
  const candidates: { name: string; directory: string }[] = [];
  if (platform === process.platform && arch === process.arch) {
    const base = join(homedir(), ".local/share/keylime/releases");
    const entries = await readdir(base, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-f0-9]{12}-\d{13}$/.test(entry.name))
        candidates.push({
          name: entry.name,
          directory: join(base, entry.name),
        });
    }
  }
  const name = `keylime-${platform}-${arch}`;
  candidates.push({
    name,
    directory: join(
      process.env.KEYLIME_PACKAGE_DIR || process.cwd(),
      "release",
      name,
    ),
  });
  const releases: Release[] = [];
  for (const { name, directory } of candidates) {
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
      const daemon = await lstat(join(directory, DAEMON));
      const runner = await lstat(join(directory, RUNNER));
      if (
        ![daemon, runner].every(
          (file) =>
            file.isFile() &&
            (file.mode & 0o111) !== 0 &&
            file.size > 0 &&
            file.size <= MAX_UPLOAD_BYTES,
        )
      )
        continue;
      const stamp = Math.max(daemon.mtimeMs, runner.mtimeMs);
      const build = /-(\d{13})$/.exec(name);
      const id = build ? name : `${name}-${Math.trunc(stamp)}`;
      releases.push({
        id,
        builtAt: new Date(build ? Number(build[1]) : stamp).toISOString(),
        directory,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return releases.sort(
    (a, b) => b.builtAt.localeCompare(a.builtAt) || a.id.localeCompare(b.id),
  );
}

export async function listHostReleases(
  hostId: string,
  signal?: AbortSignal,
): Promise<HostReleaseList> {
  const candidates = await catalog(hostId);
  if (!candidates.length) return { releases: [] };
  let unverified = false;
  const installed = await readHostInstalledBinaryDigests(hostId).catch(
    (error: unknown) => {
      unverified = binaryDigestsUnsupported(error);
      return null;
    },
  );
  const releases: HostReleaseList["releases"] = [];
  for (const release of candidates) {
    signal?.throwIfAborted();
    let status: HostReleaseList["releases"][number]["status"] = unverified
      ? "unverified"
      : "unknown";
    if (installed) {
      status = await withReleaseBinaries(release, async (daemon, runner) => {
        const keylime = (await digestBinary(daemon, signal)).sha256;
        const runnerHash = (await digestBinary(runner, signal)).sha256;
        return installed.keylime === keylime && installed.runner === runnerHash
          ? "installed"
          : "different";
      }).catch(() => "unknown");
    }
    releases.push({ id: release.id, builtAt: release.builtAt, status });
  }
  return { releases };
}

export async function deployHostRelease(
  hostId: string,
  owner: string,
  args: DeployHostReleaseArgs,
  signal: AbortSignal,
  report: (
    frame: Extract<HostReleaseDeployFrame, { type: "transfer" | "installing" }>,
  ) => void,
) {
  signal.throwIfAborted();
  const release = (await catalog(hostId)).find(
    (entry) => entry.id === args.releaseId,
  );
  if (!release)
    throw new UploadError(
      404,
      "host_release_missing",
      "That build is no longer available for this host",
    );

  return withReleaseBinaries(release, async (daemon, runner) => {
    const daemonBuild = await releaseDigest(daemon, signal);
    const runnerBuild = await releaseDigest(runner, signal);
    const digests = { keylime: daemonBuild.sha256, runner: runnerBuild.sha256 };
    await requireDifferentBuild(hostId, digests);
    signal.throwIfAborted();

    const total = daemonBuild.bytes + runnerBuild.bytes;
    report({ type: "transfer", bytes: { received: 0, total } });
    const buffer = Buffer.allocUnsafe(Math.min(total, CHUNK_BYTES));
    const send = async (
      source: FileHandle,
      name: string,
      build: { bytes: number; sha256: string },
      previous: number,
    ) => {
      const { bytes, sha256 } = build;
      const artifactId = randomUUID();
      let offset = 0;
      signal.throwIfAborted();
      try {
        await startUpload({
          id: artifactId,
          owner,
          hostId,
          name,
          size: bytes,
          type: "application/octet-stream",
          sink: { ack() {}, error() {} },
        });
        while (offset < bytes) {
          signal.throwIfAborted();
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, bytes - offset),
            offset,
          );
          if (bytesRead === 0)
            throw new UploadError(
              409,
              "host_release_changed",
              "The build changed during transfer",
            );
          const chunk = buffer.subarray(0, bytesRead);
          const { received } = await putUploadChunk(
            artifactId,
            owner,
            offset,
            chunk,
          );
          offset += bytesRead;
          report({
            type: "transfer",
            bytes: { received: previous + received, total },
          });
        }
        signal.throwIfAborted();
        await stageHostArtifact(artifactId, owner, hostId);
        return { artifactId, sha256 };
      } finally {
        // Transport cleanup does not remove the finalized host artifact.
        await abortUpload(artifactId, owner, hostId);
      }
    };
    const artifact = await send(daemon, DAEMON, daemonBuild, 0);
    const runnerArtifact = await send(
      runner,
      RUNNER,
      runnerBuild,
      daemonBuild.bytes,
    );
    // Skip restart if another operator installed this pair during the transfer.
    await requireDifferentBuild(hostId, digests);
    signal.throwIfAborted();
    report({ type: "installing" });
    return await hostArtifactActivationOp(hostId, "activateHostArtifact", {
      ...artifact,
      runner: runnerArtifact,
      operationId: args.operationId,
      target: DAEMON,
    });
  });
}
