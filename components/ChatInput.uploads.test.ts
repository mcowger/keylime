import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ChatInputHandle } from "./ChatInput";
import type { LinkSocketData } from "../lib/hosts/hub";
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");

const { ChatInput } = await import("./ChatInput.tsx");
const { MAX_TOTAL_ATTACHED_IMAGE_BYTES } =
  await import("@/lib/image-attachments");
const { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_MESSAGE, UPLOAD_ID_RE } =
  await import("@/lib/upload-limits");
const { getDraft, clearDraft } = await import("@/lib/draft-store");
const { openEventStream } = await import("@/lib/event-stream");
type ComposerProps = React.ComponentProps<typeof ChatInput>;
type SendArgs = Parameters<ComposerProps["onSend"]>;
type UploadRequest = {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
};
type UploadOpen = { id: string; name: string; size: number; host: string };

// Composer uploads (docs/specs/2026-11-02-file-uploads-design.md U2). No shared worker in jsdom, so uploads take the
// HTTP routes, answered here: POST opens at 0, each PUT is acked through its end once `gate` resolves, or fails with
// `failNextPut` when set.
const previousFetch = globalThis.fetch;
const requests: UploadRequest[] = [];
let gate = Promise.resolve();
let failNextPut: Error | { status: number; code: string } | null = null;
let realUploadRoutes:
  ((url: RequestInfo | URL, init: RequestInit) => Promise<Response>) | null =
  null;
let completionProof: string | undefined;
globalThis.fetch = Object.assign(
  async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    requests.push({
      url: String(url),
      method,
      body: init.body,
      signal: init.signal,
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (realUploadRoutes && String(url).startsWith("/api/uploads"))
      return realUploadRoutes(url, init);
    if (url === "/api/uploads" && method === "POST")
      return json({ received: 0 });
    if (String(url).startsWith("/api/uploads/") && method === "PUT") {
      await gate;
      if (failNextPut) {
        const failure = failNextPut;
        failNextPut = null;
        if (failure instanceof Error) throw failure;
        const { status, code } = failure;
        return json({ error: code, code }, status);
      }
      const offset = Number(
        new URL(String(url), "https://omp.test/").searchParams.get("offset"),
      );
      return json({
        received: offset + (init.body as Blob).size,
        done: true,
        ...(completionProof ? { proof: completionProof } : {}),
      });
    }
    return json({});
  },
  { preconnect: previousFetch.preconnect },
);

// Same stand-in as ChatInput.queue-attachments.test.ts: jsdom's FileReader brand-checks against its own realm's Blob.
const previousFileReader = globalThis.FileReader;
globalThis.FileReader = class {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
} as unknown as typeof FileReader;

// jsdom has no object URLs and the composer reads matchMedia at mount.
URL.createObjectURL = () => "blob:omp-test/preview";
URL.revokeObjectURL = () => {};
const domWindow = window;
const previousMatchMedia = window.matchMedia;
window.matchMedia = (media) => ({
  media,
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent() {
    return true;
  },
});

after(() => {
  globalThis.fetch = previousFetch;
  globalThis.FileReader = previousFileReader;
  if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia;
  else Reflect.deleteProperty(domWindow, "matchMedia");
});
afterEach(() => {
  cleanup();
  requests.length = 0;
  gate = Promise.resolve();
  failNextPut = null;
  completionProof = undefined;
});

const SEND = /^(Send|chatInput\.send)$/;
const UPLOADING = /1 uploading|chatInput\.uploadsPending/;
const AS_FILE_NOTICE = /too large to send inline|chatInput\.imagesAsFile/;
const SWITCH_TO_INLINE = /Switch to Inline|chatInput\.imageSwitchToInline/;
const SWITCH_TO_FILE = /Switch to As file|chatInput\.imageSwitchToFile/;
const WAITING = /Waiting for 1 upload|chatInput\.uploadsWaiting/;
const FAILED_BLOCK = /1 upload\(s\) failed|chatInput\.uploadsFailedBlock/;
const UPLOAD_FAILED = /Upload failed|chatInput\.uploadFailed/;
const RETRY = /^(Retry upload|chatInput\.uploadRetry)$/;
const RECONNECTING = /Reconnecting…|chatInput\.uploadReconnecting/;
const REMOVE_FILE = /^(Remove file|chatInput\.removeFile)$/;
const TOO_LARGE =
  /skipped: files up to 2 GB|chatInput\.attachmentUploadTooLarge/;
const UPLOAD_LIMIT = /at most 20 files|chatInput\.attachmentUploadLimit/;
// 1x1 transparent PNG: fits the inline budget.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function renderComposer(
  draftKey: string,
  sent: SendArgs[],
  props: Partial<ComposerProps> = {},
) {
  const ref = React.createRef<ChatInputHandle>();
  render(
    React.createElement(ChatInput, {
      ref,
      draftKey,
      onSend: async (...args) => {
        sent.push(args);
        return { status: "accepted" };
      },
      onAbort() {},
      isStreaming: false,
      ...props,
    }),
  );
  return ref;
}

/** Small, but with NUL bytes: never inlined as text, so it goes As file. */
function binaryFile(name: string) {
  return new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])], name, {
    type: "application/zip",
  });
}

/** Holds every PUT until the returned release runs. */
function holdUploads() {
  const { promise, resolve: release } = Promise.withResolvers<void>();
  gate = promise;
  return () =>
    act(async () => {
      release();
    });
}

/** The upload opened for `name` (its POST body), once it was. */
function opened(name: string) {
  return waitFor(() => {
    const request = requests.find(
      (each) =>
        each.method === "POST" &&
        (JSON.parse(each.body as string) as UploadOpen).name === name,
    );
    assert.ok(request, `${name} was opened`);
    return JSON.parse(request.body as string) as UploadOpen;
  });
}

/** The PUT carrying `id`'s bytes, once it was sent. */
function putOf(id: string) {
  return waitFor(() => {
    const request = requests.find(
      (each) =>
        each.method === "PUT" && each.url.startsWith(`/api/uploads/${id}?`),
    );
    assert.ok(request, "its bytes were sent");
    return request;
  });
}

const deleted = (id: string) =>
  requests.some(
    (each) =>
      each.method === "DELETE" && each.url === `/api/uploads/${id}?host=local`,
  );
const chipOf = (name: string) => screen.getByText(name).parentElement!;
const pressEnter = () =>
  act(async () => {
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  });

/** Reuse the uploads server suite's loopback daemon fixture so ID-bound PUTs reach real staged files. */
async function uploadOwner(t: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), "omp-composer-owner-"));
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    ompBin: process.env.OMP_WEB_OMP_BIN,
  };
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
  process.env.OMP_WEB_OMP_BIN = join(scratch, "no-omp");
  const linkRoute = await import("../app/api/hosts/link/route.ts");
  const uploadsRoute = await import("../app/api/uploads/route.ts");
  const uploadRoute = await import("../app/api/uploads/[id]/route.ts");
  const hub = await import("../lib/hosts/hub.ts");
  const { closeOutboxStore } = await import("../lib/message-outbox.ts");
  const { closeNotificationStore } =
    await import("../lib/notification-store.ts");
  const { createHost } = await import("../lib/hosts/registry.ts");
  const { runHostDaemon } = await import("../lib/hosts/daemon.ts");
  const server = Bun.serve<LinkSocketData>({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/api/hosts/link": {
        GET: (req: Request) =>
          linkRoute.GET(req, {
            upgrade: (data) => server.upgrade(req, { data }),
          }),
      },
    },
    websocket: hub.hostLinkSocket,
    fetch: () => new Response("not found", { status: 404 }),
  });
  const { host, token } = createHost("Composer upload owner");
  const daemon = runHostDaemon({
    url: `http://127.0.0.1:${server.port}`,
    token,
    allowHttp: false,
  });
  const uploadRequests: Promise<Response>[] = [];
  t.after(async () => {
    cleanup();
    await Promise.all(uploadRequests);
    realUploadRoutes = null;
    await daemon.stop();
    await server.stop(true);
    hub.flushLinkSamples();
    closeNotificationStore();
    closeOutboxStore();
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", previous.agentDir],
      ["OMP_WEB_OMP_BIN", previous.ompBin],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  await waitFor(
    () =>
      assert.ok(
        ["online", "omp-missing"].includes(hub.getHost(host.id)!.status()),
      ),
    { timeout: 5000 },
  );
  realUploadRoutes = (url, init) => {
    const req = new Request(new URL(String(url), "http://composer.test"), init);
    const context = {
      params: Promise.resolve({
        id: new URL(req.url).pathname.split("/").at(-1)!,
      }),
    };
    const response =
      String(url) === "/api/uploads"
        ? uploadsRoute.POST(req)
        : init.method === "DELETE"
          ? uploadRoute.DELETE(req, context)
          : uploadRoute.PUT(req, context);
    uploadRequests.push(response);
    return response;
  };
  return {
    hostId: host.id,
    staged: (id: string) =>
      readFileSync(join(scratch, "agent", "omp-web", "uploads", `${id}.part`)),
  };
}

test("a .zip becomes a file chip, uploads on attach, and its id goes with the prompt", async () => {
  const sent: SendArgs[] = [];
  const ref = renderComposer("uploads-zip", sent);
  const zip = new File(
    [new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])],
    "data.zip",
    { type: "application/zip" },
  );
  await act(async () => {
    ref.current!.addFiles([zip]);
  });
  await waitFor(() =>
    assert.ok(screen.getByText("data.zip"), "a file chip, not a refusal"),
  );
  const send = await waitFor(() => {
    const button = screen.getByRole("button", {
      name: SEND,
    }) as HTMLButtonElement;
    assert.equal(button.disabled, false, "Send waits for the upload");
    return button;
  });
  await act(async () => {
    send.click();
  });

  const opened = requests.find((request) => request.method === "POST");
  assert.ok(opened);
  const { id, name, size, host } = JSON.parse(
    opened.body as string,
  ) as UploadOpen;
  assert.match(id, UPLOAD_ID_RE);
  assert.deepEqual([name, size, host], ["data.zip", zip.size, "local"]);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0],
    ["", undefined, [id]],
    "no images, the upload's id",
  );
});

test("a pooled file waits for its owner before any upload begins, then persists bytes only on that owner", async (t) => {
  const worker = await uploadOwner(t);
  const file = binaryFile("pool-owned.zip");
  const { promise: owner, resolve: resolveOwner } =
    Promise.withResolvers<string>();
  const ref = renderComposer("new:pool:workers:app", [], {
    resolveUploadHost: () => owner,
  });
  await act(async () => {
    ref.current!.addFiles([file]);
  });
  assert.ok(
    screen.getByText("pool-owned.zip"),
    "the pending file remains visible",
  );
  assert.equal(
    requests.filter((request) => request.url.startsWith("/api/uploads")).length,
    0,
    "not even upload begin may default to the Mac",
  );
  await act(async () => {
    resolveOwner(worker.hostId);
  });
  const upload = await opened("pool-owned.zip");
  await putOf(upload.id);
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  assert.equal(upload.host, worker.hostId);
  assert.deepEqual(
    worker.staged(upload.id),
    Buffer.from(await file.arrayBuffer()),
  );
});

test("failed pool owner resolution leaves a retryable file and never uploads locally", async () => {
  const { promise: owner, reject: resolveOwner } =
    Promise.withResolvers<string>();
  const ref = renderComposer("new:pool:workers:unavailable", [], {
    resolveUploadHost: () => owner,
  });
  await act(async () => {
    ref.current!.addFiles([binaryFile("unplaced.zip")]);
  });
  await act(async () => {
    resolveOwner(new Error("No eligible pool worker"));
  });
  await waitFor(() =>
    assert.ok(
      within(chipOf("unplaced.zip")).getByRole("button", { name: RETRY }),
    ),
  );
  assert.equal(
    requests.filter((request) => request.url.startsWith("/api/uploads")).length,
    0,
  );
  assert.equal(
    (screen.getByRole("button", { name: SEND }) as HTMLButtonElement).disabled,
    true,
  );
});

test("removing a file while its pool owner resolves cannot start a late upload", async () => {
  const { promise: owner, resolve: resolveOwner } =
    Promise.withResolvers<string>();
  const ref = renderComposer("new:pool:workers:cancelled", [], {
    resolveUploadHost: () => owner,
  });
  await act(async () => {
    ref.current!.addFiles([binaryFile("cancelled-owner.zip")]);
  });
  await act(async () => {
    within(chipOf("cancelled-owner.zip"))
      .getByRole("button", { name: REMOVE_FILE })
      .click();
  });
  await act(async () => {
    resolveOwner("h2");
  });
  assert.equal(screen.queryByText("cancelled-owner.zip"), null);
  assert.equal(
    requests.filter((request) => request.url.startsWith("/api/uploads")).length,
    0,
  );
});

test("a session with a known owner persists file uploads on that host", async (t) => {
  const worker = await uploadOwner(t);
  const file = binaryFile("known-owner.zip");
  const ref = renderComposer("known-pool-session", [], {
    uploadHostId: worker.hostId,
  });
  await act(async () => {
    ref.current!.addFiles([file]);
  });
  const upload = await opened("known-owner.zip");
  await putOf(upload.id);
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  assert.equal(upload.host, worker.hostId);
  assert.deepEqual(
    worker.staged(upload.id),
    Buffer.from(await file.arrayBuffer()),
  );
});

test("an image over the inline budget goes As file with a notice, and Send waits for its upload", async () => {
  const { promise, resolve: release } = Promise.withResolvers<void>();
  gate = promise;
  const sent: SendArgs[] = [];
  const ref = renderComposer("uploads-image", sent);
  const image = new File(
    [new Uint8Array(MAX_TOTAL_ATTACHED_IMAGE_BYTES + 1)],
    "big.png",
    { type: "image/png" },
  );
  await act(async () => {
    ref.current!.addFiles([image]);
  });

  assert.match(screen.getByRole("status").textContent!, AS_FILE_NOTICE);
  const toggle = screen.getByRole("button", {
    name: SWITCH_TO_INLINE,
  }) as HTMLButtonElement;
  assert.equal(toggle.disabled, true, "too large to switch back to Inline");
  const opened = await waitFor(() => {
    const request = requests.find((each) => each.method === "POST");
    assert.ok(request);
    return JSON.parse(request.body as string) as UploadOpen;
  });
  assert.deepEqual([opened.name, opened.size], ["big.png", image.size]);
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: UPLOADING }) as HTMLButtonElement)
        .disabled,
      true,
    ),
  );

  await act(async () => {
    release();
  });
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  await act(async () => {
    screen.getByRole("button", { name: SEND }).click();
  });
  assert.deepEqual(sent[0][2], [opened.id]);
});

test("Enter refuses to send while an upload is in flight, and while one failed", async () => {
  const release = holdUploads();
  const sent: SendArgs[] = [];
  const ref = renderComposer("uploads-enter", sent);
  await act(async () => {
    ref.current!.addFiles([binaryFile("data.zip")]);
  });
  await putOf((await opened("data.zip")).id);

  await pressEnter();
  assert.match(screen.getByRole("alert").textContent!, WAITING);
  assert.equal(sent.length, 0, "no send while it uploads");

  // A full disk: waiting cannot fix it, so the chip fails instead of resuming by itself.
  failNextPut = { status: 507, code: "upload_write_failed" };
  await release();
  await waitFor(() =>
    assert.match(chipOf("data.zip").textContent!, UPLOAD_FAILED),
  );
  await pressEnter();
  assert.match(screen.getByRole("alert").textContent!, FAILED_BLOCK);
  assert.equal(sent.length, 0, "no send while one failed");
});

for (const status of ["uploading", "error"]) {
  test(`a bang draft with a ${status} upload stays a prompt after remount`, async (t) => {
    const key = `uploads-bang-${status}`;
    t.after(() => clearDraft(key));
    const release = holdUploads();
    try {
      const ref = renderComposer(key, []);
      await act(async () => {
        ref.current!.addFiles([binaryFile("pending.zip")]);
      });
      await putOf((await opened("pending.zip")).id);
      await act(async () => {
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "!!explain this upload" },
        });
      });
      if (status === "error") {
        failNextPut = { status: 507, code: "upload_write_failed" };
        await release();
        await waitFor(() =>
          assert.match(chipOf("pending.zip").textContent!, UPLOAD_FAILED),
        );
      }
      cleanup();
      renderComposer(key, []);
      assert.equal(
        (screen.getByRole("textbox") as HTMLInputElement).value,
        "!!explain this upload",
      );
      assert.equal(
        document.querySelector(".chat-input-shell")!.hasAttribute("data-shell"),
        false,
        "losing an unfinished upload must not enable shell dispatch",
      );
      assert.equal(
        screen.queryByText("pending.zip"),
        null,
        "unfinished upload payloads are intentionally not restored",
      );
    } finally {
      await release();
    }
  });
}

test("a queued steer or follow-up during a run waits for uploads too", async () => {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
    return true;
  };
  holdUploads();
  const ref = renderComposer("uploads-queue", [], {
    isStreaming: true,
    onSteer: record("onSteer"),
    onFollowUp: record("onFollowUp"),
  });
  await act(async () => {
    ref.current!.addFiles([binaryFile("data.zip")]);
  });
  await putOf((await opened("data.zip")).id);

  await pressEnter();
  assert.match(screen.getByRole("alert").textContent!, WAITING);
  assert.deepEqual(calls, [], "nothing queued while it uploads");
});

test("removing a chip aborts its upload in flight, or discards a finished one", async () => {
  const ref = renderComposer("uploads-remove", []);
  await act(async () => {
    ref.current!.addFiles([binaryFile("done.zip")]);
  });
  const done = await opened("done.zip");
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );

  const release = holdUploads();
  await act(async () => {
    ref.current!.addFiles([binaryFile("busy.zip")]);
  });
  const busy = await opened("busy.zip");
  const put = await putOf(busy.id);
  await act(async () => {
    within(chipOf("busy.zip"))
      .getByRole("button", { name: REMOVE_FILE })
      .click();
  });
  assert.equal(put.signal!.aborted, true, "its bytes stop");
  assert.ok(deleted(busy.id), "the host drops what it staged");
  assert.equal(screen.queryByText("busy.zip"), null);

  await act(async () => {
    within(chipOf("done.zip"))
      .getByRole("button", { name: REMOVE_FILE })
      .click();
  });
  assert.ok(deleted(done.id), "a finished upload is discarded on its host");
  assert.equal(screen.queryByText("done.zip"), null);
  await release();
});

test("Retry on a failed chip resumes the same upload, then the chip finishes", async () => {
  failNextPut = { status: 507, code: "upload_write_failed" };
  const sent: SendArgs[] = [];
  const ref = renderComposer("uploads-retry", sent);
  await act(async () => {
    ref.current!.addFiles([binaryFile("data.zip")]);
  });
  const { id } = await opened("data.zip");
  const retry = await waitFor(() =>
    within(chipOf("data.zip")).getByRole("button", { name: RETRY }),
  );

  requests.length = 0;
  const release = holdUploads();
  await act(async () => {
    retry.click();
  });
  assert.equal((await opened("data.zip")).id, id, "resumed under the same id");
  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: UPLOADING })),
  );
  await release();
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  assert.equal(
    within(chipOf("data.zip")).queryByRole("button", { name: RETRY }),
    null,
  );
  await act(async () => {
    screen.getByRole("button", { name: SEND }).click();
  });
  assert.deepEqual(sent[0][2], [id]);
});

test("a reconnecting chip identifies a network failure instead of a generic upload failure", async () => {
  failNextPut = new TypeError("Failed to fetch");
  const ref = renderComposer("uploads-network-error", []);
  await act(async () => {
    ref.current!.addFiles([binaryFile("network.zip")]);
  });
  await waitFor(() =>
    assert.match(chipOf("network.zip").textContent!, RECONNECTING),
  );
  assert.match(chipOf("network.zip").title, /network error/i);
  assert.equal(
    within(chipOf("network.zip")).queryByRole("button", { name: RETRY }),
    null,
  );
  await act(async () => {
    within(chipOf("network.zip"))
      .getByRole("button", { name: REMOVE_FILE })
      .click();
  });
});

test("an image switches Inline -> As file -> Inline, and switching back aborts its upload", async () => {
  const release = holdUploads();
  const ref = renderComposer("uploads-switch", []);
  await act(async () => {
    ref.current!.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
    ]);
  });
  const toFile = await waitFor(() =>
    screen.getByRole("button", { name: SWITCH_TO_FILE }),
  );

  await act(async () => {
    toFile.click();
  });
  const { id } = await opened("dot.png");
  const put = await putOf(id);
  const toInline = screen.getByRole("button", {
    name: SWITCH_TO_INLINE,
  }) as HTMLButtonElement;
  assert.equal(toInline.disabled, false, "small enough to go back Inline");

  await act(async () => {
    toInline.click();
  });
  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: SWITCH_TO_FILE })),
  );
  assert.equal(put.signal!.aborted, true, "its bytes stop");
  assert.ok(deleted(id), "the host drops what it staged");
  assert.equal(
    (screen.getByRole("button", { name: SEND }) as HTMLButtonElement).disabled,
    false,
    "nothing left to wait for",
  );
  await release();
});

test("an image sent As file shows that it is reconnecting, without hovering", async () => {
  const { ImageChip } = await import("./ChatInput-uploads.tsx");
  const upload = {
    id: "u",
    name: "dot.png",
    size: 8,
    hostId: "local",
    file: null,
    received: 4,
    status: "uploading" as const,
    error: "This machine is offline",
    previewUrl: null,
  };
  const props = {
    previewUrl: null,
    canSwitch: true,
    onSwitch() {},
    onRemove() {},
  };
  const { rerender } = render(
    React.createElement(ImageChip, { ...props, upload }),
  );
  assert.ok(screen.getByRole("img", { name: RECONNECTING }));
  rerender(
    React.createElement(ImageChip, {
      ...props,
      upload: { ...upload, error: null },
    }),
  );
  assert.equal(
    screen.queryByRole("img", { name: RECONNECTING }),
    null,
    "gone once the host answers",
  );
});

test(`only ${MAX_UPLOADS_PER_MESSAGE} files attach to one message`, async () => {
  const ref = renderComposer("uploads-count", []);
  const files = Array.from(
    { length: MAX_UPLOADS_PER_MESSAGE + 1 },
    (_, index) => binaryFile(`f${index}.zip`),
  );
  await act(async () => {
    ref.current!.addFiles(files);
  });
  await waitFor(() =>
    assert.match(screen.getByRole("alert").textContent!, UPLOAD_LIMIT),
  );
  assert.equal(
    screen.getAllByRole("button", { name: REMOVE_FILE }).length,
    MAX_UPLOADS_PER_MESSAGE,
  );
  assert.equal(
    requests.filter((each) => each.method === "POST").length,
    MAX_UPLOADS_PER_MESSAGE,
  );
});

test("a PDF goes As file even when its bytes decode as text; a JSON file stays inline", async () => {
  const ref = renderComposer("uploads-pdf", []);
  const pdf = new File(["%PDF-1.4 plain ascii body"], "doc.pdf", {
    type: "application/pdf",
  });
  const json = new File(['{"a":1}'], "data.json", { type: "application/json" });
  await act(async () => {
    ref.current!.addFiles([pdf, json]);
  });
  await opened("doc.pdf");
  await waitFor(() =>
    assert.ok(screen.getByText("data.json"), "the JSON chip"),
  );
  assert.deepEqual(
    requests
      .filter((each) => each.method === "POST")
      .map((each) => (JSON.parse(each.body as string) as UploadOpen).name),
    ["doc.pdf"],
  );
});

test("a PDF filename with no MIME type goes As file instead of inline text", async () => {
  const ref = renderComposer("uploads-pdf-empty-mime", []);
  const pdf = new File(["%PDF-1.4 plain ascii body"], "report.PDF");
  const json = new File(['{"a":1}'], "data.json", { type: "application/json" });
  await act(async () => {
    ref.current!.addFiles([pdf, json]);
  });
  await opened(pdf.name);
  await waitFor(() =>
    assert.ok(screen.getByText("data.json"), "the JSON chip"),
  );
  assert.deepEqual(
    requests
      .filter((each) => each.method === "POST")
      .map((each) => (JSON.parse(each.body as string) as UploadOpen).name),
    [pdf.name],
  );
});

test("a file over 2 GiB is refused, its sibling attaches", async () => {
  const ref = renderComposer("uploads-size", []);
  const huge = binaryFile("disk.iso");
  Object.defineProperty(huge, "size", { value: MAX_UPLOAD_BYTES + 1 });
  await act(async () => {
    ref.current!.addFiles([huge, binaryFile("ok.zip")]);
  });
  await opened("ok.zip");
  assert.match(screen.getByRole("alert").textContent!, TOO_LARGE);
  assert.equal(screen.queryByText("disk.iso"), null);
  assert.deepEqual(
    requests
      .filter((each) => each.method === "POST")
      .map((each) => (JSON.parse(each.body as string) as UploadOpen).name),
    ["ok.zip"],
  );
});

test("a draft keeps finished uploads only, and restores them as done chips", async () => {
  const key = "uploads-draft";
  const ref = renderComposer(key, []);
  await act(async () => {
    ref.current!.addFiles([binaryFile("done.zip")]);
  });
  const done = await opened("done.zip");
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  holdUploads();
  await act(async () => {
    ref.current!.addFiles([binaryFile("busy.zip")]);
  });
  await putOf((await opened("busy.zip")).id);
  assert.deepEqual(
    getDraft(key)?.uploads,
    [{ id: done.id, name: "done.zip", size: done.size, hostId: "local" }],
    "the one in flight is not kept",
  );

  cleanup();
  const sent: SendArgs[] = [];
  renderComposer(key, sent);
  assert.equal(screen.queryByText("busy.zip"), null);
  assert.equal(
    within(chipOf("done.zip")).queryByRole("button", { name: RETRY }),
    null,
    "done: nothing to retry",
  );
  assert.equal(screen.queryByRole("progressbar"), null);
  await act(async () => {
    screen.getByRole("button", { name: SEND }).click();
  });
  assert.deepEqual(sent[0][2], [done.id]);
});

test("upload continuity: completed proof survives a refused send and composer remount", async () => {
  const key = "uploads-proof-recovery";
  completionProof = "completed-upload-proof";
  const ref = renderComposer(key, [], {
    onSend: async () => ({ status: "rejected" }),
  });
  await act(async () => {
    ref.current!.addFiles([binaryFile("authorized.zip")]);
  });
  const upload = await opened("authorized.zip");
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  const expected = {
    id: upload.id,
    name: upload.name,
    size: upload.size,
    hostId: "local",
    proof: "completed-upload-proof",
  };
  assert.deepEqual(
    getDraft(key)?.uploads,
    [expected],
    "completion authority is persisted before Send becomes available",
  );
  await act(async () => {
    screen.getByRole("button", { name: SEND }).click();
  });
  await waitFor(() =>
    assert.deepEqual(
      getDraft(key)?.uploads,
      [expected],
      "refusal recovers the same authorized attachment",
    ),
  );
  cleanup();
  renderComposer(key, []);
  assert.ok(screen.getByText("authorized.zip"));
  assert.deepEqual(
    getDraft(key)?.uploads,
    [expected],
    "hydration must not strip authority while rewriting the draft",
  );
});

/** The tab's one shared-worker transport (a module singleton), faked once and switched to `ws` by each test. */
type WorkerMessage = { op: string; id: string; name: string };
type FakePort = {
  posted: WorkerMessage[];
  postMessage(message: WorkerMessage): void;
  onmessage: (event: { data: unknown }) => void;
  start(): void;
};
let fakePort: FakePort;
function wsPort() {
  if (!fakePort) {
    globalThis.SharedWorker = class {
      port: FakePort;
      constructor() {
        fakePort = this.port = {
          posted: [],
          postMessage(message) {
            this.posted.push(message);
          },
          onmessage: null as unknown as FakePort["onmessage"],
          start() {},
        };
      }
    } as unknown as typeof SharedWorker;
    openEventStream({ kind: "running" });
    Reflect.deleteProperty(globalThis, "SharedWorker");
  }
  fakePort.onmessage({ data: { transport: "ws" } });
  return fakePort;
}

test("a stall the worker reports shows Reconnecting… and resumes by itself under the same id", async () => {
  // The browser-link path: the fake shared worker answers the upload with the worker's stall error.
  const port = wsPort();
  try {
    const ref = renderComposer("uploads-stall", []);
    await act(async () => {
      ref.current!.addFiles([binaryFile("data.zip")]);
    });
    const upload = await waitFor(() => {
      const message = port.posted.find((each) => each.op === "upload");
      assert.ok(message);
      return message;
    });
    await act(async () => {
      port.onmessage({
        data: {
          up: upload.id,
          error: {
            status: 504,
            code: "upload_stalled",
            message: "The upload stalled",
          },
        },
      });
    });
    await waitFor(() =>
      assert.match(chipOf("data.zip").textContent!, RECONNECTING),
    );
    assert.equal(
      within(chipOf("data.zip")).queryByRole("button", { name: RETRY }),
      null,
      "no Retry while it waits",
    );
    const again = await waitFor(
      () => {
        const starts = port.posted.filter(
          (each) => each.op === "upload" && each.id === upload.id,
        );
        assert.equal(starts.length, 2, "started again after the back-off");
        return starts[1];
      },
      { timeout: 3_000 },
    );
    await act(async () => {
      port.onmessage({ data: { up: again.id, received: 8, done: true } });
    });
    await waitFor(() =>
      assert.equal(
        (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
    assert.doesNotMatch(chipOf("data.zip").textContent!, RECONNECTING);
  } finally {
    port.onmessage({ data: { transport: "sse" } });
  }
});

test("Retry after the page left the back/forward cache starts a new upload id: the old one's cancel can never delete it", async () => {
  const port = wsPort();
  try {
    const ref = renderComposer("uploads-bfcache-retry", []);
    await act(async () => {
      ref.current!.addFiles([binaryFile("cached.zip")]);
    });
    const first = await waitFor(() => {
      const message = port.posted.find(
        (each) => each.op === "upload" && each.name === "cached.zip",
      );
      assert.ok(message);
      return message;
    });
    // pagehide: the worker cancelled it on the host (410, not resumable).
    await act(async () => {
      port.onmessage({
        data: {
          up: first.id,
          error: {
            status: 410,
            code: "upload_failed",
            message: "The upload failed. Retry it.",
          },
        },
      });
    });
    const retry = await waitFor(() =>
      within(chipOf("cached.zip")).getByRole("button", { name: RETRY }),
    );
    await act(async () => {
      retry.click();
    });
    const second = await waitFor(() => {
      const starts = port.posted.filter(
        (each) => each.op === "upload" && each.name === "cached.zip",
      );
      assert.equal(starts.length, 2);
      return starts[1];
    });
    assert.notEqual(
      second.id,
      first.id,
      "a new id: the cancel still pending for the old one cannot reach it",
    );
    await act(async () => {
      port.onmessage({ data: { up: second.id, received: 8, done: true } });
    });
    await waitFor(() =>
      assert.equal(
        (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
  } finally {
    port.onmessage({ data: { transport: "sse" } });
  }
});

test("upload continuity: an old completion cannot give a replacement upload its proof", async () => {
  const port = wsPort();
  const key = "uploads-proof-new-id";
  try {
    const ref = renderComposer(key, []);
    await act(async () => {
      ref.current!.addFiles([binaryFile("replacement.zip")]);
    });
    const first = await waitFor(() => {
      const message = port.posted.find(
        (each) => each.op === "upload" && each.name === "replacement.zip",
      );
      assert.ok(message);
      return message;
    });
    await act(async () => {
      port.onmessage({
        data: {
          up: first.id,
          error: { status: 410, code: "upload_failed", message: "Retry it." },
        },
      });
    });
    const retry = await waitFor(() =>
      within(chipOf("replacement.zip")).getByRole("button", { name: RETRY }),
    );
    await act(async () => {
      retry.click();
    });
    const second = await waitFor(() => {
      const starts = port.posted.filter(
        (each) => each.op === "upload" && each.name === "replacement.zip",
      );
      assert.equal(starts.length, 2);
      return starts[1];
    });
    assert.notEqual(second.id, first.id);
    await act(async () => {
      port.onmessage({
        data: {
          up: first.id,
          received: 8,
          done: true,
          proof: "old-upload-proof",
        },
      });
      port.onmessage({ data: { up: second.id, received: 8, done: true } });
    });
    await waitFor(() =>
      assert.equal(
        (screen.getByRole("button", { name: SEND }) as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
    assert.deepEqual(getDraft(key)?.uploads, [
      { id: second.id, name: "replacement.zip", size: 8, hostId: "local" },
    ]);
  } finally {
    port.onmessage({ data: { transport: "sse" } });
  }
});
