import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { MAX_UPLOAD_BYTES } from "../upload-limits";

const CHUNK_BYTES = 1024 * 1024;
const MAX_CACHED_DIGESTS = 128;
const digests = new Map<string, string>();

export function openBinary(path: string): Promise<FileHandle> {
  return open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
}

export async function digestBinary(file: FileHandle, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const before = await file.stat({ bigint: true });
  const bytes = Number(before.size);
  if (
    !before.isFile() ||
    !(Number(before.mode) & 0o111) ||
    bytes < 1 ||
    bytes > MAX_UPLOAD_BYTES
  )
    throw new Error("Expected a nonempty executable within the upload limit");
  const key = `${before.dev}:${before.ino}:${bytes}:${before.mtimeNs}:${before.ctimeNs}`;
  const cached = digests.get(key);
  if (cached) return { bytes, sha256: cached };

  const buffer = Buffer.allocUnsafe(Math.min(bytes, CHUNK_BYTES));
  const hash = new Bun.CryptoHasher("sha256");
  for (let offset = 0; offset < bytes;) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, bytes - offset),
      offset,
    );
    if (!bytesRead) throw new Error("The binary changed while reading it");
    hash.update(
      bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
    );
    offset += bytesRead;
  }
  const after = await file.stat({ bigint: true });
  if (
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new Error("The binary changed while reading it");

  const sha256 = hash.digest("hex");
  if (digests.size >= MAX_CACHED_DIGESTS) {
    const oldest = digests.keys().next();
    if (!oldest.done) digests.delete(oldest.value);
  }
  digests.set(key, sha256);
  return { bytes, sha256 };
}
