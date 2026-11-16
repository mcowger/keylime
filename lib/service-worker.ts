/// <reference lib="webworker" />
import type { LocalOutboxEntry } from "./event-stream";
import { isRecord } from "./type-guards";

const worker = self as unknown as ServiceWorkerGlobalScope;
type SyncEvent = ExtendableEvent & { tag: string };

// keylime service worker: shows notifications and opens their session on click, and sends the message outbox a closed
// tab left (Background Sync). It does not cache anything; the app stays online-only.

worker.addEventListener("install", () => worker.skipWaiting());
worker.addEventListener("activate", (event) =>
  event.waitUntil(worker.clients.claim()),
);

worker.addEventListener("message", (event) => {
  if (event.data?.type === "omp-outbox-capability")
    event.ports[0]?.postMessage({ type: "omp-outbox-capability", version: 2 });
});

worker.addEventListener("push", (event) => {
  let data: {
    type?: string;
    title?: string;
    body?: string;
    tag?: string;
    sessionId?: string;
    url?: string;
  } = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Unreadable payload: still show something (iOS revokes silent pushes).
  }
  const shown = {
    type: data.type === "error" ? "error" : "info",
    title: data.title || "key lime",
    body: data.body || "",
    tag: data.tag || "",
    sessionId: data.sessionId || "",
  };
  event.waitUntil(
    (async () => {
      await worker.registration.showNotification(shown.title, {
        body: shown.body,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        tag: shown.tag || undefined,
        renotify: Boolean(shown.tag),
        data: { url: data.url || "/", sessionId: shown.sessionId },
      } as NotificationOptions & { renotify: boolean });
      // Open tabs list it in their Notifications tab, like a notification the page showed itself.
      const windows = await worker.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows)
        client.postMessage({
          type: "omp-notification-shown",
          notification: shown,
        });
    })(),
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url = "/", sessionId = "" } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const client =
        windows.find((candidate) => candidate.focused) ||
        windows.find((candidate) => candidate.visibilityState === "visible") ||
        windows[0];
      if (client) {
        try {
          await client.focus();
          // The app selects the session in place, keeping its live state. Any
          // other page (the sign-in screen after the cookie expired) loads the
          // session URL, which the sign-in screen carries through as `next`.
          if (new URL(client.url).pathname === "/") {
            if (sessionId)
              client.postMessage({ type: "omp-open-session", sessionId });
          } else {
            await client.navigate(url);
          }
          return;
        } catch {
          // focus() or navigate() can be refused; open a window instead.
        }
      }
      await worker.clients.openWindow(url);
    })(),
  );
});

// Background Sync (docs/specs/2026-11-04-message-outbox-design.md O2): the browser fires it once online, even with no
// tab open. The event-stream worker's IndexedDB outbox (lib/event-stream-worker.ts) is sent like the worker sends it.
worker.addEventListener("sync", ((event: SyncEvent) => {
  if (event.tag === "omp-outbox") event.waitUntil(flushOutbox());
}) as EventListener);

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function markOutboxFailed(db: IDBDatabase, id: string, error: string) {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("entries", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(
        transaction.error || new Error("Could not save the outbox failure"),
      );
    const store = transaction.objectStore("entries");
    const request = store.get(id);
    request.onsuccess = () => {
      const entry = request.result;
      // Another sender may have accepted and deleted it while this request was in flight.
      if (entry?.state === "sending")
        store.put({ ...entry, state: "failed", error });
    };
  });
}

// Adapted from keylime 13d8eb21095f: closed-page delivery must retire only proven retry lineage, while retaining upload proofs in the outgoing request.
/** Remove the accepted local add and its same-session, exact-intent retry lineage atomically. */
function deleteOutboxEntry(
  db: IDBDatabase,
  id: string,
  replaces: string | undefined,
  sessionId: string,
  intent: LocalOutboxEntry,
) {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("entries", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(
        transaction.error || new Error("Could not remove the outbox entry"),
      );
    const store = transaction.objectStore("entries");
    const request = store.getAll();
    request.onsuccess = () => {
      const entries: LocalOutboxEntry[] = request.result;
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      let lineageRoot = replaces;
      if (lineageRoot === undefined && intent.replaces !== undefined) {
        const root = replacementRoot(intent, byId);
        const original = root === null ? undefined : byId.get(root);
        if (
          root !== null &&
          original?.sessionId === sessionId &&
          original.state === "failed" &&
          sameOutboxIntent(original, intent)
        )
          lineageRoot = root;
      }
      for (const entry of entries) {
        if (entry.sessionId !== sessionId) continue;
        if (entry.id === id) {
          store.delete(entry.id);
          continue;
        }
        if (
          lineageRoot === undefined ||
          !sameOutboxIntent(entry, intent) ||
          (entry.id !== lineageRoot &&
            replacementRoot(entry, byId) !== lineageRoot)
        )
          continue;
        store.delete(entry.id);
      }
    };
  });
}

// The immutable intent used by the server's retry digest: mode, text, images and upload IDs.
function sameOutboxIntent(a: LocalOutboxEntry, b: LocalOutboxEntry) {
  if (a.mode !== b.mode || a.message !== b.message) return false;
  const aImages = a.images;
  const bImages = b.images;
  const imageCount = aImages?.length ?? 0;
  if (imageCount !== (bImages?.length ?? 0)) return false;
  for (let index = 0; index < imageCount; index++) {
    const left = aImages?.[index];
    const right = bImages?.[index];
    if (
      left?.type !== right?.type ||
      left?.data !== right?.data ||
      left?.mimeType !== right?.mimeType
    )
      return false;
  }
  const aUploads = a.uploads;
  const bUploads = b.uploads;
  const uploadCount = aUploads?.length ?? 0;
  if (uploadCount !== (bUploads?.length ?? 0)) return false;
  for (let index = 0; index < uploadCount; index++)
    if (aUploads?.[index] !== bUploads?.[index]) return false;
  return true;
}

// Only same-session failed parents with the exact intent prove a local retry lineage.
function replacementRoot(
  entry: LocalOutboxEntry,
  entries: Map<string, LocalOutboxEntry>,
): string | null {
  if (entry.replaces === undefined) return entry.id;
  const seen = new Set([entry.id]);
  let id = entry.replaces;
  if (!id) return null;
  while (true) {
    if (seen.has(id)) return null;
    seen.add(id);
    const parent = entries.get(id);
    if (
      !parent ||
      parent.sessionId !== entry.sessionId ||
      parent.state !== "failed"
    )
      return id;
    if (!sameOutboxIntent(parent, entry)) return null;
    if (parent.replaces === undefined) return id;
    id = parent.replaces;
    if (!id) return null;
  }
}
// Legacy rows predate every sequenced add; timestamp ties already lost their original ordering.
function compareOutbox(a: LocalOutboxEntry, b: LocalOutboxEntry) {
  return (
    (a.enqueueOrder ?? 0) - (b.enqueueOrder ?? 0) ||
    a.createdAt - b.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function readOutboxForSync(db: IDBDatabase) {
  return new Promise<LocalOutboxEntry[]>((resolve, reject) => {
    let entries: LocalOutboxEntry[] = [];
    try {
      const transaction = db.transaction("entries", "readwrite");
      const store = transaction.objectStore("entries");
      const request = store.getAll();
      transaction.oncomplete = () => resolve(entries);
      transaction.onabort =
        transaction.onerror =
        request.onerror =
          () =>
            reject(
              transaction.error ||
                request.error ||
                new Error("Could not read the outbox"),
            );
      request.onsuccess = () => {
        entries = request.result;
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (entry.state !== "sending" || entry.replaces === undefined)
            continue;
          const root = replacementRoot(entry, byId);
          if (root === null) {
            const failed: LocalOutboxEntry = {
              ...entry,
              state: "failed",
              error: "This retry chain is invalid; retry the original message.",
            };
            entries[index] = failed;
            byId.set(entry.id, failed);
            store.put(failed);
          } else if (root !== entry.replaces) {
            const normalized = { ...entry, replaces: root };
            entries[index] = normalized;
            byId.set(entry.id, normalized);
            store.put(normalized);
          }
        }
      };
    } catch (error) {
      reject(error);
    }
  });
}

function acceptedOutboxEntry(
  reply: unknown,
  id: string,
): { replaces?: string } | null {
  if (!isRecord(reply) || !isRecord(reply.data) || !isRecord(reply.data.entry))
    return null;
  const entry = reply.data.entry;
  return reply?.success === true &&
    entry?.id === id &&
    typeof entry.sessionId === "string" &&
    entry.sessionId.length > 0 &&
    typeof entry.mode === "string" &&
    ["prompt", "followUp", "steer"].includes(entry.mode) &&
    typeof entry.state === "string" &&
    ["held", "waiting_host", "delivering", "failed", "delivered"].includes(
      entry.state,
    ) &&
    (entry.images === undefined ||
      (Array.isArray(entry.images) &&
        entry.images.every(
          (image: unknown) =>
            isRecord(image) &&
            image.type === "image" &&
            typeof image.data === "string" &&
            typeof image.mimeType === "string",
        ))) &&
    (entry.uploads === undefined ||
      (Array.isArray(entry.uploads) &&
        entry.uploads.every(
          (upload: unknown) => typeof upload === "string",
        ))) &&
    (entry.error === undefined || typeof entry.error === "string") &&
    (entry.mayHaveBeenSent === undefined ||
      typeof entry.mayHaveBeenSent === "boolean") &&
    (entry.replaces === undefined ||
      (typeof entry.replaces === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(entry.replaces))) &&
    typeof entry.message === "string" &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    entry.createdAt >= 0
    ? { replaces: entry.replaces as string | undefined }
    : null;
}

async function flushOutbox() {
  const open = indexedDB.open("keylime-outbox", 1);
  open.onupgradeneeded = () =>
    open.result.createObjectStore("entries", { keyPath: "id" });
  const db = await done(open);
  try {
    const entries = await readOutboxForSync(db);
    // Oldest first, and a session's later entries wait while an earlier one fails: the server queues by arrival.
    entries.sort(compareOutbox);
    const waiting = new Set<string>();
    for (const initial of entries) {
      const { id, sessionId } = initial;
      if (initial.state !== "sending" || waiting.has(sessionId)) continue;
      // A running worker may have added or accepted an entry since our snapshot: only the shared session head can go.
      const current = await readOutboxForSync(db);
      const head = current
        .filter(
          (entry) => entry.sessionId === sessionId && entry.state === "sending",
        )
        .sort(compareOutbox)[0];
      if (!head || head.id !== id) continue;
      const {
        scope,
        advisor,
        mode,
        message,
        images,
        uploads,
        uploadProofs,
        replaces,
        createdAt,
      } = head;
      // Expired or unscoped rows are never rebound: they are not sent, so they stop blocking that session's later entries.
      const stale =
        Date.now() - createdAt > 7 * 24 * 60 * 60 * 1000
          ? "Not sent within 7 days."
          : typeof scope !== "string" || !scope
            ? "This message has no saved installation or sign-in scope and cannot be sent."
            : null;
      if (stale) {
        await markOutboxFailed(db, id, stale);
        continue;
      }
      let status = 0;
      let error: string | undefined;
      let accepted: { replaces?: string } | null = null;
      let timer: number | NodeJS.Timeout | undefined;
      try {
        // Include the body read: a half-open POST must not keep every later sync entry waiting forever.
        const body = JSON.stringify({
          type: "outbox_add",
          id,
          scope,
          mode,
          message,
          images,
          uploads,
          uploadProofs,
          replaces,
        });
        const controller = new AbortController();
        timer = setTimeout(
          () => controller.abort(),
          40_000 + Math.ceil(body.length / 2),
        );
        const response = await fetch(
          `/api/agent/${encodeURIComponent(sessionId)}${advisor === true ? "?advisor=1" : ""}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: controller.signal,
          },
        );
        const reply: unknown = await response.json().catch((error) => {
          if (controller.signal.aborted) throw error;
        });
        if (isRecord(reply) && typeof reply.error === "string")
          error = reply.error;
        accepted = acceptedOutboxEntry(reply, id);
        status =
          response.status >= 200 && response.status < 300 && !accepted
            ? 0
            : response.status;
      } catch {
        // Offline or timed out: retried below.
      } finally {
        clearTimeout(timer);
      }
      if (status >= 200 && status < 300) {
        const confirmedReplaces =
          accepted && accepted.replaces === replaces
            ? accepted.replaces
            : undefined;
        await deleteOutboxEntry(db, id, confirmedReplaces, sessionId, head);
      } else if (
        status === 0 ||
        status === 401 ||
        status === 408 ||
        status === 429 ||
        status >= 500
      )
        waiting.add(sessionId);
      else await markOutboxFailed(db, id, error || `HTTP ${status}`);
    }
    if (waiting.size > 0) throw new Error("omp-outbox: entries left to send");
  } finally {
    db.close();
  }
}
