import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getHost } from "@/lib/hosts/hub";
import {
  createThumbnail,
  existingThumbnail,
  imageMimeType,
  mediaFilePath,
} from "@/lib/media-cache";

function image(body: Uint8Array, type: string, immutable = true): Response {
  // A view, not a copy: these buffers come from readFile/Bun.Image, never a SharedArrayBuffer.
  return new Response(
    new Uint8Array(
      body.buffer as ArrayBuffer,
      body.byteOffset,
      body.byteLength,
    ),
    {
      headers: {
        "Content-Type": type,
        // Content-addressed: the bytes behind a hash never change.
        "Cache-Control": immutable
          ? "private, max-age=31536000, immutable"
          : "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** GET /api/media/<sha256>[?thumb=1] — a tool-result image, or its small WebP preview. */
/**
 * @apiContract workspaceMediaGet
 * @apiUsage Fetch a content-addressed tool-result image or thumbnail.
 * @apiInputs hash is a SHA-256 content identifier; thumb requests a preview; hostId selects the source and defaults to local.
 * @apiInvariants Remote bytes must match the hash; non-images return 415 and missing images return 404.
 * @apiEffects Only the selected host is read. Local thumbnails may be cached on disk; images are privately immutable-cached.
 * @apiRecovery If thumbnail generation fails the full image is served without immutable caching, allowing a later preview.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  const query = new URL(req.url).searchParams;
  const hostId = query.get("hostId") ?? "local";
  const thumb = query.has("thumb");
  const local = hostId === "local";
  if (!/^[a-f0-9]{64}$/.test(hash))
    return new Response("Not found", { status: 404 });
  const cached = local && thumb ? existingThumbnail(hash) : null;
  const cachedBytes = cached ? await readIfPresent(cached) : null;
  if (cachedBytes) return image(cachedBytes, "image/webp");

  let bytes: Buffer | null = null;
  if (local) {
    // Retry on a race between our copy being swept and omp's blob taking over.
    for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
      const file = mediaFilePath(hash);
      if (!file) break;
      bytes = await readIfPresent(file);
    }
  } else {
    const result = await getHost(hostId)?.sessionOps.readMedia(hash);
    if (
      result?.ok &&
      createHash("sha256").update(result.value).digest("hex") === hash
    ) {
      const remote = result.value;
      bytes = Buffer.from(remote.buffer, remote.byteOffset, remote.byteLength);
    }
  }
  if (!bytes) return new Response("Not found", { status: 404 });
  const type = imageMimeType(bytes);
  if (!type) return new Response("Not an image", { status: 415 });
  if (thumb) {
    const preview = await createThumbnail(hash, bytes, local);
    if (preview) return image(preview, "image/webp");
    // Full image standing in for a preview: not cached, so a later preview can replace it.
    return image(bytes, type, false);
  }
  return image(bytes, type);
}
