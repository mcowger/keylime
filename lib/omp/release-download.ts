import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

async function readRelease(
  url: string,
  maxBytes: number,
  timeout: number,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "ompweb-runner-fetch" },
    });
    if (!response.ok || !response.body)
      throw new Error(`Release request failed (${response.status})`);
    if (
      response.url &&
      (!response.url.startsWith("https://") ||
        ![
          "raw.githubusercontent.com",
          "api.github.com",
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
        ].includes(new URL(response.url).hostname))
    )
      throw new Error("Unexpected release download destination");
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new Error("Release response is too large");
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxBytes) throw new Error("Release response is too large");
        onChunk(item.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}
export async function fetchReleaseBytes(
  url: string,
  maxBytes: number,
  timeout = 5000,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  await readRelease(url, maxBytes, timeout, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}
/** Streams the response into a new `file` (never whole in memory); returns its `sha256:<hex>` digest. */
export async function downloadReleaseFile(
  url: string,
  file: string,
  maxBytes: number,
  timeout = DOWNLOAD_TIMEOUT_MS,
): Promise<string> {
  const hash = createHash("sha256");
  const fd = openSync(file, "wx", 0o600);
  try {
    await readRelease(url, maxBytes, timeout, (chunk) => {
      writeSync(fd, chunk);
      hash.update(chunk);
    });
  } finally {
    closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}
