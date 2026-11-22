import { requireNativeModule } from "expo";

interface SocketEvent {
  id: string;
  type: "open" | "message" | "error" | "close";
  data?: string;
  code?: number;
  reason?: string;
}

const network = requireNativeModule<{
  request(
    origin: string,
    path: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  connectSocket(id: string, url: string): void | Promise<void>;
  sendSocket(id: string, text: string): void | Promise<void>;
  closeSocket(id: string, code: number, reason: string): Promise<void>;
  addListener(
    event: "socketEvent",
    listener: (event: SocketEvent) => void,
  ): { remove(): void };
}>("KeylimeNetwork");

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
