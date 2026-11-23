import { useEffect, useRef, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import type { components } from "./generated/browser-link";
import {
  MAX_ATTACHED_IMAGES,
  MAX_TOTAL_ATTACHED_IMAGE_BYTES,
} from "../lib/image-attachments";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_MESSAGE,
} from "../lib/upload-limits";
import {
  nativeFileChunk,
  nativeRequest,
  newUploadId,
  pasteNativeAttachment,
  pickNativeFiles,
  pickNativePhotos,
  readNativeAttachment,
  removeNativeAttachment,
  type NativeAttachmentSelection,
  type NativePickedFile,
} from "./native-network";
import { lightTheme, theme } from "./theme";

type Prompt = Extract<
  components["schemas"]["BrowserCommand"]["command"],
  { type: "prompt" }
>;
export type AttachmentPayload = Pick<
  Prompt,
  "images" | "uploads" | "uploadProofs"
>;
type ImagePayload = NonNullable<AttachmentPayload["images"]>[number];
type Status = "reading" | "uploading" | "done" | "error";
export type ChatAttachment = NativePickedFile & {
  id: string;
  mode: "inline" | "file";
  status: Status;
  received: number;
  proof?: string;
  data?: string;
  error?: string;
  controller?: AbortController;
};
type Draft = {
  items: ChatAttachment[];
  picking: boolean;
  error: string | null;
  disposed: boolean;
};

const MAX_IMAGES = MAX_ATTACHED_IMAGES;
const MAX_IMAGE_BYTES = MAX_TOTAL_ATTACHED_IMAGE_BYTES;
const MAX_FILES = MAX_UPLOADS_PER_MESSAGE;

const supportsInlineImage = (mimeType: string) =>
  ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
    mimeType.toLowerCase(),
  );
const CHUNK = 1024 * 1024;

class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function answer(
  response: Response,
  size: number,
  from: number,
): Promise<{ received: number; proof?: string }> {
  const body = (await response.json().catch(() => ({}))) as {
    received?: unknown;
    proof?: unknown;
    error?: string;
    code?: string;
  };
  if (
    !response.ok &&
    !(response.status === 409 && body.code === "upload_offset")
  )
    throw new UploadError(
      body.error || `Upload failed (HTTP ${response.status})`,
      response.status,
      body.code,
    );
  const received = body.received;
  if (
    typeof received !== "number" ||
    !Number.isSafeInteger(received) ||
    received < 0 ||
    received > size ||
    received === from
  )
    throw new UploadError(
      "The server reported an invalid upload offset",
      response.status,
    );
  return {
    received,
    ...(response.ok && received === size && typeof body.proof === "string"
      ? { proof: body.proof }
      : {}),
  };
}

async function upload(
  origin: string,
  hostId: string,
  item: ChatAttachment,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<string | undefined> {
  const response = await nativeRequest(origin, "/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: item.id,
      host: hostId,
      name: item.name,
      size: item.size,
      type: item.mimeType,
    }),
    signal,
  });
  let result = await answer(response, item.size, -1);
  progress(result.received);
  while (result.received < item.size) {
    if (signal.aborted) throw new Error("Upload cancelled");
    const offset = result.received;
    result = await answer(
      await nativeFileChunk(
        origin,
        `/api/uploads/${item.id}?offset=${offset}`,
        item.file,
        offset,
        Math.min(CHUNK, item.size - offset),
        signal,
      ),
      item.size,
      offset,
    );
    progress(result.received);
  }
  return result.proof;
}

function discard(origin: string, hostId: string, id: string) {
  void nativeRequest(
    origin,
    `/api/uploads/${id}?host=${encodeURIComponent(hostId)}`,
    { method: "DELETE" },
  ).catch(() => {});
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  // React Native's Promise fallback does not provide Promise.withResolvers.
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Upload cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("Upload cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export type ChatAttachmentsController = {
  items: readonly ChatAttachment[];
  error: string | null;
  picking: boolean;
  canSend: boolean;
  payload: AttachmentPayload;
  pickFiles: () => Promise<void>;
  pickPhotos: () => Promise<void>;
  paste: () => Promise<void>;
  remove: (id: string) => void;
  retry: (id: string) => void;
  switchMode: (id: string) => void;
  clear: (consumed?: boolean) => void;
};

export function useChatAttachments(
  origin: string,
  hostId: string | null | undefined,
  draftKey: string,
): ChatAttachmentsController {
  const drafts = useRef(new Map<string, Draft>());
  const key = JSON.stringify([origin, hostId, draftKey]);
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(true);
  const [, render] = useState(0);
  const notify = () => {
    if (mounted.current) render((n) => n + 1);
  };
  let draft = drafts.current.get(key);
  if (!draft) {
    draft = { items: [], picking: false, error: null, disposed: false };
    drafts.current.set(key, draft);
  }
  const active = draft;
  const host = hostId ?? "";

  useEffect(
    () => () => {
      mounted.current = false;
      for (const [scope, target] of drafts.current) {
        const [savedOrigin, savedHost] = JSON.parse(scope) as [
          string,
          string | null,
          string,
        ];
        target.disposed = true;
        for (const item of target.items) {
          item.controller?.abort();
          if (item.mode === "file")
            discard(savedOrigin, savedHost ?? "", item.id);
          void removeNativeAttachment(item.file).catch(() => {});
        }
      }
      drafts.current.clear();
    },
    [],
  );

  const contains = (item: ChatAttachment) =>
    !active.disposed && active.items.includes(item);
  const startUpload = (item: ChatAttachment) => {
    const controller = new AbortController();
    const uploadItem = { ...item };
    item.controller = controller;
    item.status = "uploading";
    item.error = undefined;
    notify();
    void (async () => {
      let failures = 0;
      let outage = 0;
      let highest = item.received;
      try {
        while (true) {
          try {
            const proof = await upload(
              origin,
              host,
              uploadItem,
              controller.signal,
              (received) => {
                if (!contains(item) || item.controller !== controller) return;
                if (received > highest) {
                  highest = received;
                  failures = 0;
                  outage = 0;
                }
                item.received = received;
                item.error = undefined;
                notify();
              },
            );
            if (!contains(item) || item.controller !== controller) return;
            item.proof = proof;
            item.status = "done";
            item.controller = undefined;
            notify();
            return;
          } catch (error) {
            if (controller.signal.aborted) {
              discard(origin, host, uploadItem.id);
              return;
            }
            const transient =
              !(error instanceof UploadError) ||
              error.status === 408 ||
              error.status === 429 ||
              error.status >= 500;
            if (!transient) throw error;
            if (!outage) outage = Date.now();
            if (Date.now() - outage >= 5 * 60_000) throw error;
            if (contains(item)) {
              item.error =
                error instanceof Error ? error.message : "Upload interrupted";
              notify();
            }
            await pause(
              [1000, 2000, 5000, 10000, 15000][Math.min(failures++, 4)],
              controller.signal,
            );
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          discard(origin, host, uploadItem.id);
          return;
        }
        if (!contains(item) || item.controller !== controller) return;
        if (error instanceof UploadError && error.status === 410)
          item.id = newUploadId();
        item.status = "error";
        item.controller = undefined;
        item.error = error instanceof Error ? error.message : "Upload failed";
        notify();
      }
    })();
  };

  const readImage = (item: ChatAttachment) => {
    const controller = new AbortController();
    item.controller = controller;
    item.mode = "inline";
    item.status = "reading";
    item.error = undefined;
    notify();
    void readNativeAttachment(item.file).then(
      (data) => {
        if (
          !contains(item) ||
          item.mode !== "inline" ||
          item.controller !== controller
        )
          return;
        item.controller = undefined;
        item.data = data;
        item.status = "done";
        notify();
      },
      (error: unknown) => {
        if (
          !contains(item) ||
          item.mode !== "inline" ||
          item.controller !== controller
        )
          return;
        item.controller = undefined;
        item.status = "error";
        item.error =
          error instanceof Error ? error.message : "Could not read image";
        notify();
      },
    );
  };
  const fitsInline = (size: number, except?: ChatAttachment) => {
    const images = active.items.filter(
      (item) => item !== except && item.mode === "inline",
    );
    return (
      images.length < MAX_IMAGES &&
      images.reduce((sum, image) => sum + image.size, 0) + size <=
        MAX_IMAGE_BYTES
    );
  };
  const select = async (source: () => Promise<NativeAttachmentSelection>) => {
    if (!host || active.picking) return;
    active.picking = true;
    active.error = null;
    notify();
    try {
      const { files, errors } = await source();
      if (active.disposed || current.current !== key) {
        for (const file of files)
          void removeNativeAttachment(file.file).catch(() => {});
        return;
      }
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          errors.push(`${file.name}: files must be 2 GB or smaller.`);
          void removeNativeAttachment(file.file).catch(() => {});
          continue;
        }
        const inline =
          supportsInlineImage(file.mimeType) &&
          file.size > 0 &&
          fitsInline(file.size);
        if (
          !inline &&
          active.items.filter((item) => item.mode === "file").length >=
            MAX_FILES
        ) {
          errors.push(
            `${file.name}: a message can attach at most ${MAX_FILES} files.`,
          );
          void removeNativeAttachment(file.file).catch(() => {});
          continue;
        }
        const item: ChatAttachment = {
          ...file,
          id: newUploadId(),
          mode: inline ? "inline" : "file",
          status: inline ? "reading" : "uploading",
          received: 0,
        };
        active.items.push(item);
        if (
          file.mimeType.startsWith("image/") &&
          !supportsInlineImage(file.mimeType)
        )
          errors.push(
            `${file.name} was attached as a file because ${file.mimeType} is not supported inline.`,
          );
        if (inline) readImage(item);
        else startUpload(item);
      }
      active.error = errors.length ? errors.join("\n") : null;
    } catch (error) {
      if (!active.disposed && current.current === key)
        active.error =
          error instanceof Error ? error.message : "Could not pick files";
    } finally {
      active.picking = false;
      notify();
    }
  };
  const remove = (id: string) => {
    const item = active.items.find((entry) => entry.id === id);
    if (!item) return;
    active.items = active.items.filter((entry) => entry !== item);
    item.controller?.abort();
    if (item.mode === "file") discard(origin, host, item.id);
    void removeNativeAttachment(item.file).catch(() => {});
    notify();
  };
  const retry = (id: string) => {
    const item = active.items.find((entry) => entry.id === id);
    if (!item || item.status !== "error") return;
    if (item.mode === "inline") readImage(item);
    else startUpload(item);
  };
  const switchMode = (id: string) => {
    const item = active.items.find((entry) => entry.id === id);
    if (!item || !item.mimeType.startsWith("image/")) return;
    if (item.mode === "file") {
      if (!supportsInlineImage(item.mimeType)) {
        active.error = `${item.mimeType} images cannot be sent inline. Keep this image attached as a file.`;
        notify();
        return;
      }
      if (!fitsInline(item.size, item) || item.size === 0) {
        active.error = "This image exceeds the inline image limit.";
        notify();
        return;
      }
      item.controller?.abort();
      discard(origin, host, item.id);
      item.controller = undefined;
      item.proof = undefined;
      readImage(item);
    } else {
      if (
        active.items.filter((entry) => entry.mode === "file").length >=
        MAX_FILES
      ) {
        active.error = `A message can attach at most ${MAX_FILES} files.`;
        notify();
        return;
      }
      item.controller?.abort();
      item.mode = "file";
      item.data = undefined;
      item.id = newUploadId();
      item.received = 0;
      startUpload(item);
    }
  };
  const canSend =
    !active.picking && active.items.every((item) => item.status === "done");
  const images: ImagePayload[] = active.items
    .filter(
      (item) => item.mode === "inline" && item.status === "done" && item.data,
    )
    .map((item) => ({
      type: "image",
      data: item.data!,
      mimeType: item.mimeType,
    }));
  const files = active.items.filter(
    (item) => item.mode === "file" && item.status === "done",
  );
  const proofs = Object.fromEntries(
    files.flatMap((item) => (item.proof ? [[item.id, item.proof]] : [])),
  );
  const payload: AttachmentPayload = canSend
    ? {
        ...(images.length ? { images } : {}),
        ...(files.length ? { uploads: files.map((item) => item.id) } : {}),
        ...(Object.keys(proofs).length ? { uploadProofs: proofs } : {}),
      }
    : {};
  const snapshot = active.items.map((item) => ({
    item,
    id: item.id,
    mode: item.mode,
  }));
  const clear = (consumed = false) => {
    for (const saved of snapshot) {
      const item = saved.item;
      if (
        !active.items.includes(item) ||
        item.id !== saved.id ||
        item.mode !== saved.mode
      )
        continue;
      active.items = active.items.filter((entry) => entry !== item);
      item.controller?.abort();
      if (item.mode === "file" && !consumed) discard(origin, host, item.id);
      void removeNativeAttachment(item.file).catch(() => {});
    }
    if (!active.items.length && !active.picking) {
      active.disposed = true;
      if (drafts.current.get(key) === active) drafts.current.delete(key);
    }
    notify();
  };
  return {
    items: active.items,
    error: active.error,
    picking: active.picking,
    canSend,
    payload,
    pickFiles: () => select(pickNativeFiles),
    pickPhotos: () =>
      select(() => {
        const inline = active.items.filter(
          (item) => item.mode === "inline",
        ).length;
        const files = active.items.length - inline;
        return pickNativePhotos(
          Math.max(0, MAX_IMAGES - inline) + Math.max(0, MAX_FILES - files),
        );
      }),
    paste: () =>
      select(async () => {
        const file = await pasteNativeAttachment();
        return { files: file ? [file] : [], errors: [] };
      }),
    remove,
    retry,
    switchMode,
    clear,
  };
}

function formatSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes,
    unit = 0;
  while (value >= 1000 && unit < 3) {
    value /= 1000;
    unit++;
  }
  return unit ? `${value.toFixed(1)} ${units[unit]}` : `${bytes} B`;
}

export function ChatAttachmentChips({
  controller,
}: {
  controller: ChatAttachmentsController;
}) {
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? {
        text: theme.text,
        muted: theme.muted,
        border: theme.border,
        background: theme.hover,
        error: "#F0A3A0",
      }
    : {
        text: lightTheme.text,
        muted: lightTheme.muted,
        border: lightTheme.border,
        background: lightTheme.hover,
        error: "#9E3434",
      };
  if (!controller.items.length && !controller.error && !controller.picking)
    return null;
  return (
    <View>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
      >
        {controller.items.map((item) => (
          <View
            key={item.file}
            style={[
              styles.chip,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
          >
            {item.mode === "inline" && item.data ? (
              <Image
                source={{ uri: `data:${item.mimeType};base64,${item.data}` }}
                style={styles.preview}
              />
            ) : (
              <Text style={[styles.icon, { color: colors.muted }]}>▤</Text>
            )}
            <View style={styles.details}>
              <Text
                numberOfLines={1}
                style={[styles.name, { color: colors.text }]}
              >
                {item.name}
              </Text>
              <Text
                style={[
                  styles.meta,
                  {
                    color:
                      item.status === "error" ? colors.error : colors.muted,
                  },
                ]}
              >
                {item.status === "uploading"
                  ? `Uploading ${Math.floor((item.received * 100) / Math.max(1, item.size))}%`
                  : item.status === "reading"
                    ? "Reading…"
                    : item.status === "error"
                      ? item.error
                      : formatSize(item.size)}
              </Text>
              {item.status === "error" && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Retry ${item.name}`}
                  onPress={() => controller.retry(item.id)}
                >
                  <Text style={{ color: colors.text }}>Retry</Text>
                </Pressable>
              )}
              {item.mimeType.startsWith("image/") && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Send ${item.name} ${item.mode === "inline" ? "as file" : "inline"}`}
                  onPress={() => controller.switchMode(item.id)}
                >
                  <Text style={[styles.meta, { color: colors.muted }]}>
                    {item.mode === "inline" ? "Inline ▾" : "As file ▾"}
                  </Text>
                </Pressable>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.name}`}
              onPress={() => controller.remove(item.id)}
              style={styles.remove}
            >
              <Text style={{ color: colors.muted, fontSize: 19 }}>×</Text>
            </Pressable>
          </View>
        ))}
        {controller.picking && (
          <Text style={{ color: colors.muted }}>Selecting files…</Text>
        )}
      </ScrollView>
      {!!controller.error && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: colors.error }]}
        >
          {controller.error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8, paddingHorizontal: 10, paddingTop: 10 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 9,
    padding: 8,
    maxWidth: 240,
    gap: 8,
  },
  preview: { width: 40, height: 40, borderRadius: 5 },
  icon: { fontSize: 24 },
  details: { flexShrink: 1, minWidth: 50 },
  name: { fontSize: 13, fontWeight: "600" },
  meta: { fontSize: 12, marginTop: 2 },
  remove: { paddingHorizontal: 4, alignSelf: "flex-start" },
  error: { fontSize: 12, paddingHorizontal: 10, paddingTop: 6 },
});
