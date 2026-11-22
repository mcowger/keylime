import { requireNativeModule } from "expo";

interface SocketEvent {
  id: string;
  type: "open" | "message" | "error" | "close";
  data?: string;
  code?: number;
  reason?: string;
}

interface SearchEvent {
  id: string;
  type: "response" | "data" | "done" | "error";
  status?: number;
  data?: string;
}

const network = requireNativeModule<{
  request(
    origin: string,
    path: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  startSearch(id: string, origin: string, path: string): Promise<void>;
  newUploadId(): string;
  copyText(text: string): Promise<void>;
  readText(text: string): Promise<void>;
  pickAttachments(): Promise<NativePickedFile[]>;
  pasteAttachmentImage(): Promise<NativePickedFile | null>;
  readAttachmentBase64(file: string): Promise<string>;
  removeAttachmentFile(file: string): Promise<void>;
  requestFileChunk(
    id: string,
    origin: string,
    path: string,
    file: string,
    offset: number,
    length: number,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  requestMedia(
    id: string,
    origin: string,
    path: string,
  ): Promise<{ id: string; uri: string }>;
  removeMedia(id: string): Promise<void>;
  cancelRequest(id: string): Promise<void>;
  connectSocket(id: string, url: string): void | Promise<void>;
  sendSocket(id: string, text: string): void | Promise<void>;
  closeSocket(id: string, code: number, reason: string): Promise<void>;
  addListener(
    event: "socketEvent",
    listener: (event: SocketEvent) => void,
  ): { remove(): void };
  addListener(
    event: "searchEvent",
    listener: (event: SearchEvent) => void,
  ): { remove(): void };
}>("KeylimeNetwork");

export interface NativePickedFile {
  file: string;
  name: string;
  size: number;
  mimeType: string;
}

export const newUploadId = () => network.newUploadId();
export const copyText = (text: string) => network.copyText(text);
export const readText = (text: string) => network.readText(text);
export const pickNativeAttachments = () => network.pickAttachments();
export const pasteNativeAttachment = () => network.pasteAttachmentImage();
export const readNativeAttachment = (file: string) =>
  network.readAttachmentBase64(file);
export const removeNativeAttachment = (file: string) =>
  network.removeAttachmentFile(file);

export const removeNativeMedia = (id: string) => network.removeMedia(id);

export async function loadNativeMedia(
  origin: string,
  path: string,
  signal: AbortSignal,
): Promise<{ id: string; uri: string }> {
  if (signal.aborted) throw new Error("Request cancelled");
  const id = network.newUploadId();
  const cancel = () => {
    void network.cancelRequest(id);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const pending = network.requestMedia(id, origin, path);
    if (signal.aborted) cancel();
    const result = await pending;
    if (signal.aborted) {
      await network.removeMedia(id);
      throw new Error("Request cancelled");
    }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function nativeFileChunk(
  origin: string,
  path: string,
  file: string,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) throw new Error("Request cancelled");
  const id = network.newUploadId();
  const cancel = () => {
    void network.cancelRequest(id);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const pending = network.requestFileChunk(
      id,
      origin,
      path,
      file,
      offset,
      length,
    );
    if (signal.aborted) cancel();
    const result = await pending;
    if (signal.aborted) throw new Error("Request cancelled");
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function nativeRequest(
  origin: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const body = init?.body;
  if (body != null && typeof body !== "string")
    throw new TypeError("Expected a text request body");
  if (init?.signal?.aborted) throw new Error("Request cancelled");
  const result = await network.request(
    origin,
    path,
    init?.method ?? "GET",
    headers,
    body ?? null,
  );
  if (init?.signal?.aborted) throw new Error("Request cancelled");
  return new Response(
    [204, 205, 304].includes(result.status) ? null : result.body,
    { status: result.status, headers: result.headers },
  );
}

export function nativeSearchStream(
  origin: string,
  path: string,
  signal: AbortSignal,
  onResponse: (status: number) => void,
  onData: (data: string) => void,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Request cancelled"));
  const id = network.newUploadId();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      subscription.remove();
      signal.removeEventListener("abort", cancel);
      if (error !== undefined) {
        void network.cancelRequest(id).catch(() => {});
        reject(error);
      } else resolve();
    };
    const cancel = () => finish(new Error("Request cancelled"));
    const subscription = network.addListener("searchEvent", (event) => {
      if (event.id !== id || finished) return;
      try {
        if (event.type === "response" && typeof event.status === "number")
          onResponse(event.status);
        else if (event.type === "data" && typeof event.data === "string")
          onData(event.data);
        else if (event.type === "done") finish();
        else if (event.type === "error") finish(new Error("Request failed"));
      } catch (error) {
        finish(error);
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    void network.startSearch(id, origin, path).catch(finish);
    if (signal.aborted) cancel();
  });
}

export interface NativeWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

let nextSocketId = 0;

export function openNativeWebSocket(url: string): NativeWebSocket {
  const id = String(++nextSocketId);
  let state = 0;
  let bufferedAmount = 0;
  const socket: NativeWebSocket = {
    get readyState() {
      return state;
    },
    get bufferedAmount() {
      return bufferedAmount;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (state !== 1) throw new Error("WebSocket is not open");
      bufferedAmount += data.length;
      void Promise.resolve()
        .then(() => network.sendSocket(id, data))
        .catch(fail)
        .finally(() => {
          bufferedAmount -= data.length;
        });
    },
    close(code = 1000, reason = "") {
      if (state >= 2) return;
      state = 2;
      void network.closeSocket(id, code, reason).catch(() => {});
      finish(code, reason);
    },
  };
  const subscription = network.addListener("socketEvent", (event) => {
    if (event.id !== id || state === 3) return;
    switch (event.type) {
      case "open":
        if (state !== 0) return;
        state = 1;
        socket.onopen?.();
        break;
      case "message":
        if (state === 1 && typeof event.data === "string")
          socket.onmessage?.({ data: event.data });
        break;
      case "error":
        socket.onerror?.();
        break;
      case "close":
        finish(event.code ?? 1006, event.reason ?? "");
        break;
    }
  });

  function finish(code: number, reason: string) {
    if (state === 3) return;
    state = 3;
    subscription.remove();
    socket.onclose?.({ code, reason });
  }

  function fail() {
    if (state >= 2) return;
    socket.onerror?.();
    if (state >= 2) return;
    void network.closeSocket(id, 1000, "").catch(() => {});
    finish(1006, "");
  }

  void Promise.resolve()
    .then(() => {
      if (state === 0) return network.connectSocket(id, url);
    })
    .catch(fail);
  return socket;
}
