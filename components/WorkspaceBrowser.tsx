"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import {
  BROWSER_CONTROL_BATCH_MAX,
  BrowserVideoStartResultSchema,
  BrowserVideoNextResultSchema,
  type BrowserControlAction,
  type BrowserListResult,
} from "@/lib/api-contracts/runner-lifecycle";
import { Value } from "@sinclair/typebox/value";
import { useI18n } from "@/lib/i18n";
import { sessionKey, sessionUrl } from "@/lib/session-identity";

type BrowserPage = BrowserListResult["tabs"][number];
type BrowserSessions = Record<string, BrowserPage[]>;

const toolbarButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  minHeight: 36,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-subtle)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};
const toolbarField: CSSProperties = {
  minHeight: 36,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12,
};

const browserUrl = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/browser`;

export function useWorkspaceBrowsers(
  sessionIds: string[],
  enabled: boolean,
  hostId = "local",
) {
  const [browsers, setBrowsers] = useState<BrowserSessions>({});
  const idsKey = JSON.stringify(sessionIds);

  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setBrowsers((previous) =>
      Object.fromEntries(
        ids
          .map((id) => sessionKey(id, hostId))
          .filter((key) => previous[key])
          .map((key) => [key, previous[key]]),
      ),
    );
    if (!enabled || ids.length === 0) return;

    const poll = async () => {
      if (document.hidden || stopped) return;
      controller = new AbortController();
      const signal = controller.signal;
      // Limit concurrent discovery requests even when many chats are open.
      for (let start = 0; start < ids.length && !signal.aborted; start += 4) {
        await Promise.all(
          ids.slice(start, start + 4).map(async (id) => {
            try {
              const response = await fetch(sessionUrl(browserUrl(id), hostId), {
                signal,
                cache: "no-store",
              });
              if (!response.ok) return;
              const data = (await response.json()) as BrowserListResult;
              if (!signal.aborted)
                setBrowsers((previous) => ({
                  ...previous,
                  [sessionKey(id, hostId)]: data.tabs,
                }));
            } catch {
              // Keep the last known state on transient disconnects.
            }
          }),
        );
      }
      if (!signal.aborted && !stopped) timer = setTimeout(poll, 5000);
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      controller?.abort();
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [idsKey, enabled, hostId]);
  return browsers;
}

type Frame = {
  width: number;
  height: number;
  ageAtReceipt: number;
  receivedAt: number;
  pageId: string;
};

type QueuedControl = {
  action: BrowserControlAction;
  serialized: string;
  sessionId: string;
  hostId: string;
  pageId: string;
  generation: number;
  enqueuedAt: number;
  pointerSource?: string;
};

const CONTROL_BATCH_CHAR_BUDGET = 128 * 1024;
const CONTROL_ACTION_CHAR_LIMIT = 400 * 1024;
const CONTROL_BODY_BYTE_LIMIT = 1024 * 1024;
const NAVIGATION_TYPES: readonly string[] = [
  "navigate",
  "back",
  "forward",
  "reload",
];

function canReplaceMotion(
  previous: QueuedControl,
  action: BrowserControlAction,
  pointerSource?: string,
) {
  const old = previous.action;
  if (
    old.type === "pointer" &&
    action.type === "pointer" &&
    old.event === "move" &&
    action.event === "move"
  ) {
    return (
      pointerSource !== undefined &&
      previous.pointerSource === pointerSource &&
      old.buttons === action.buttons &&
      old.button === action.button &&
      old.modifiers === action.modifiers
    );
  }
  if (
    old.type === "touch" &&
    action.type === "touch" &&
    old.event === "move" &&
    action.event === "move"
  ) {
    return (
      old.modifiers === action.modifiers &&
      old.points.length === action.points.length &&
      old.points.every((point) =>
        action.points.some((next) => next.id === point.id),
      )
    );
  }
  return false;
}

function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function isClipboardShortcut(event: KeyboardEvent) {
  return (
    (event.ctrlKey || event.metaKey) &&
    ["c", "v", "x"].includes(event.key.toLowerCase())
  );
}

async function isDisconnected(response: Response) {
  if (response.status !== 404 && response.status !== 503) return false;
  try {
    const body = (await response.json()) as { code?: string };
    return body.code === "session_not_running" || body.code === "host_offline";
  } catch {
    return false;
  }
}

export function WorkspaceBrowser({
  sessionId,
  hostId = "local",
  pages,
  active,
}: {
  sessionId: string;
  hostId?: string;
  pages: BrowserPage[];
  active: boolean;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(pages[0]?.id ?? "");
  const pageId = pages.some((page) => page.id === selectedId)
    ? selectedId
    : pages[0]?.id;
  const page = pages.find((item) => item.id === pageId);
  const [address, setAddress] = useState(page?.url ?? "");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [videoVersion, setVideoVersion] = useState(0);
  const [snapshotFallback, setSnapshotFallback] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [controlError, setControlError] = useState(false);
  const [controlling, setControlling] = useState(false);
  const imageRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<Frame | null>(null);
  const frameGeneration = useRef(0);
  const navigating = useRef(false);
  const touches = useRef(
    new Map<number, { id: number; x: number; y: number }>(),
  );
  const composing = useRef(false);
  const clipboardKeys = useRef(new Set<string>());
  const compositionText = useRef("");
  const dispatch = useRef({
    generation: 0,
    enabled: false,
    busy: false,
    errorVersion: 0,
    queue: [] as QueuedControl[],
    stats: {
      accepted: 0,
      sentActions: 0,
      sentBatches: 0,
      coalesced: 0,
      discarded: 0,
      failures: 0,
      maxQueueDepth: 0,
      totalQueueWaitMs: 0,
      maxQueueWaitMs: 0,
      totalRoundtripMs: 0,
      maxRoundtripMs: 0,
    },
    lastReport: 0,
  });

  const release = () => {
    dispatch.current.generation++;
    navigating.current = false;
    dispatch.current.enabled = false;
    dispatch.current.stats.discarded += dispatch.current.queue.length;
    dispatch.current.queue = [];
    touches.current.clear();
    clipboardKeys.current.clear();
    setControlling(false);
  };

  const send = (action: BrowserControlAction, pointerSource?: string) => {
    const state = dispatch.current;
    if (
      !state.enabled ||
      !active ||
      !pageId ||
      document.hidden ||
      !navigator.onLine
    )
      return;
    const serialized = JSON.stringify(action);
    const prefix = `{"id":${JSON.stringify(pageId)},"actions":[`;
    if (
      serialized.length >= CONTROL_ACTION_CHAR_LIMIT ||
      (prefix.length + serialized.length + 2 > CONTROL_BATCH_CHAR_BUDGET &&
        new TextEncoder().encode(`${prefix}${serialized}]}`).length >=
          CONTROL_BODY_BYTE_LIMIT)
    ) {
      state.stats.discarded += state.queue.length + 1;
      state.errorVersion++;
      state.queue = [];
      setControlError(true);
      return;
    }
    const last = state.queue[state.queue.length - 1];
    state.stats.accepted++;
    if (
      last &&
      last.generation === state.generation &&
      last.sessionId === sessionId &&
      last.hostId === hostId &&
      last.pageId === pageId &&
      canReplaceMotion(last, action, pointerSource)
    ) {
      last.action = action;
      last.serialized = serialized;
      state.stats.coalesced++;
    } else {
      state.queue.push({
        action,
        serialized,
        sessionId,
        hostId,
        pageId,
        generation: state.generation,
        enqueuedAt: performance.now(),
        pointerSource,
      });
      state.stats.maxQueueDepth = Math.max(
        state.stats.maxQueueDepth,
        state.queue.length,
      );
    }
    if (state.busy) return;
    state.busy = true;
    const drain = async () => {
      while (state.enabled && state.queue.length) {
        const next = state.queue.shift()!;
        const navigation = NAVIGATION_TYPES.includes(next.action.type);
        const batch = [next];
        const prefix = `{"id":${JSON.stringify(next.pageId)},"actions":[`;
        let size = prefix.length + next.serialized.length + 2;
        while (
          !navigation &&
          batch.length < BROWSER_CONTROL_BATCH_MAX &&
          state.queue.length
        ) {
          const candidate = state.queue[0];
          if (
            candidate.generation !== next.generation ||
            candidate.sessionId !== next.sessionId ||
            candidate.hostId !== next.hostId ||
            candidate.pageId !== next.pageId ||
            NAVIGATION_TYPES.includes(candidate.action.type) ||
            size + 1 + candidate.serialized.length > CONTROL_BATCH_CHAR_BUDGET
          )
            break;
          batch.push(state.queue.shift()!);
          size += 1 + candidate.serialized.length;
        }
        const startedAt = performance.now();
        const errorVersion = state.errorVersion;
        state.stats.sentActions += batch.length;
        state.stats.sentBatches++;
        for (const item of batch) {
          const queueWait = startedAt - item.enqueuedAt;
          state.stats.totalQueueWaitMs += queueWait;
          state.stats.maxQueueWaitMs = Math.max(
            state.stats.maxQueueWaitMs,
            queueWait,
          );
        }
        if (navigation) {
          navigating.current = true;
          frameGeneration.current++;
          frameRef.current = null;
          setVideoVersion((version) => version + 1);
        }
        try {
          const response = await fetch(
            sessionUrl(`${browserUrl(next.sessionId)}/control`, next.hostId),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: `${prefix}${batch.map((item) => item.serialized).join(",")}]}`,
            },
          );
          if (navigation && state.generation === next.generation) {
            navigating.current = false;
            frameGeneration.current++;
            frameRef.current = null;
            setVideoVersion((version) => version + 1);
          }
          if (!response.ok) {
            if (
              (await isDisconnected(response)) &&
              state.generation === next.generation
            ) {
              setControlError(true);
              release();
            }
            throw new Error("Browser control failed");
          }
          if (
            state.generation === next.generation &&
            state.errorVersion === errorVersion
          )
            setControlError(false);
        } catch {
          state.stats.failures++;
          if (navigation && state.generation === next.generation) {
            navigating.current = false;
            frameGeneration.current++;
            frameRef.current = null;
            setVideoVersion((version) => version + 1);
          }
          if (state.generation === next.generation) {
            state.stats.discarded += state.queue.length;
            // The failed operation may have executed. Never replay it or later queued input.
            state.queue = [];
            setControlError(true);
          }
        } finally {
          const roundtrip = performance.now() - startedAt;
          state.stats.totalRoundtripMs += roundtrip;
          state.stats.maxRoundtripMs = Math.max(
            state.stats.maxRoundtripMs,
            roundtrip,
          );
          const now = Date.now();
          if (!state.lastReport || now - state.lastReport >= 30_000) {
            state.lastReport = now;
            // Counts and timings only: never include actions, coordinates, IDs, URLs, or errors.
            console.info("[browser-input viewer]", {
              ...state.stats,
              queued: state.queue.length,
            });
          }
        }
      }
      state.busy = false;
    };
    queueMicrotask(() => void drain());
  };

  useEffect(() => {
    setAddress(page?.url ?? "");
  }, [pageId, page?.url]);

  useEffect(() => {
    const visibilityChanged = () => {
      if (document.hidden) release();
    };
    const disconnected = () => release();
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("offline", disconnected);
    window.addEventListener("pagehide", disconnected);
    return () => {
      release();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("offline", disconnected);
      window.removeEventListener("pagehide", disconnected);
    };
  }, [active, pageId, sessionId, hostId]);

  useEffect(() => {
    setFrame(null);
    frameRef.current = null;
    setFrameError(false);
    setSnapshotFallback(false);
    if (!active || !pageId) return;
    let stopped = false;
    let generation = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let streamId: string | undefined;
    let decoder: VideoDecoder | undefined;
    const endpoint = sessionUrl(`${browserUrl(sessionId)}/video`, hostId);
    // Aggregate only counts and fixed stage names; never log tab IDs, URLs, packets, or errors.
    const stats = {
      starts: 0,
      polls: 0,
      empty: 0,
      packets: 0,
      decoded: 0,
      rendered: 0,
      failures: 0,
      snapshots: 0,
      snapshotFailures: 0,
      status: "starting",
      httpStatus: 0,
    };
    let lastReport = 0;
    const report = () => {
      const now = Date.now();
      if (lastReport && now - lastReport < 30_000) return;
      lastReport = now;
      console.info("[browser-video viewer]", { ...stats });
    };
    report();
    let lastFailureReport = 0;
    const reportFailure = () => {
      const now = Date.now();
      if (lastFailureReport && now - lastFailureReport < 30_000) return;
      lastFailureReport = now;
      console.warn("[browser-video viewer failure]", { ...stats });
    };
    const stopStream = () => {
      generation++;
      clearTimeout(timer);
      controller?.abort();
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined;
      frameRef.current = null;
      setFrame(null);
      if (streamId) {
        const id = streamId;
        streamId = undefined;
        void fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "stop",
            input: { id: pageId, streamId: id },
          }),
          keepalive: true,
        }).catch(() => {});
      }
    };
    const startSnapshots = () => {
      if (stopped || document.hidden || !navigator.onLine) return;
      setSnapshotFallback(true);
      const current = ++generation;
      controller = new AbortController();
      const signal = controller.signal;
      const poll = async () => {
        const requestedAt = performance.now();
        const frameVersion = frameGeneration.current;
        try {
          const response = await fetch(
            sessionUrl(
              `${browserUrl(sessionId)}/frame?${new URLSearchParams({ tabId: pageId })}`,
              hostId,
            ),
            { signal, cache: "no-store" },
          );
          if (!response.ok) {
            if ((await isDisconnected(response)) && !signal.aborted) release();
            throw new Error("Snapshot request failed");
          }
          const width = Number(
            response.headers.get("X-Browser-Viewport-Width"),
          );
          const height = Number(
            response.headers.get("X-Browser-Viewport-Height"),
          );
          if (
            !Number.isFinite(width) ||
            !Number.isFinite(height) ||
            width <= 0 ||
            height <= 0
          )
            throw new Error("Invalid snapshot viewport");
          const bitmap = await createImageBitmap(await response.blob());
          try {
            const canvas = imageRef.current;
            if (
              signal.aborted ||
              current !== generation ||
              frameVersion !== frameGeneration.current ||
              navigating.current ||
              !canvas
            )
              return;
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext("2d");
            context?.drawImage(bitmap, 0, 0);
            if (context) stats.snapshots++;
            stats.status = context ? "snapshot-rendered" : "canvas-unavailable";
            report();
            const receivedAt = performance.now();
            const captured = {
              width,
              height,
              ageAtReceipt: receivedAt - requestedAt,
              receivedAt,
              pageId,
            };
            frameRef.current = captured;
            setFrame(captured);
            setFrameError(false);
          } finally {
            bitmap.close();
          }
        } catch {
          if (!signal.aborted && current === generation) {
            stats.snapshotFailures++;
            stats.status = "snapshot-failed";
            reportFailure();
          }
          if (!signal.aborted && current === generation) {
            frameRef.current = null;
            setFrameError(true);
          }
        }
        if (!signal.aborted && current === generation)
          timer = setTimeout(() => void poll(), 1000);
      };
      void poll();
    };
    const start = async () => {
      if (stopped || document.hidden || !navigator.onLine) return;
      const current = ++generation;
      stats.starts++;
      let stage = "decoder-unavailable";
      controller = new AbortController();
      const signal = controller.signal;
      const request = async (body: unknown) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
          cache: "no-store",
        });
        if (!response.ok) {
          stats.httpStatus = response.status;
          if ((await isDisconnected(response)) && !signal.aborted) release();
          throw new Error("Video request failed");
        }
        return response.json() as Promise<unknown>;
      };
      let videoReady = false;
      try {
        if (typeof VideoDecoder === "undefined")
          throw new Error("Video decoding unavailable");
        stage = "start-request";
        const opened = await request({ op: "start", input: { id: pageId } });
        stage = "start-result";
        if (!Value.Check(BrowserVideoStartResultSchema, opened))
          throw new Error("Invalid video stream");
        if (current !== generation) return;
        streamId = opened.streamId;
        let failed = false;
        const metadata = new Map<
          number,
          {
            width: number;
            height: number;
            ageAtReceipt: number;
            receivedAt: number;
            generation: number;
          }
        >();
        decoder = new VideoDecoder({
          output: (videoFrame) => {
            stats.decoded++;
            try {
              const canvas = imageRef.current;
              if (current !== generation || !canvas) return;
              const source = metadata.get(videoFrame.timestamp);
              metadata.delete(videoFrame.timestamp);
              if (
                !source ||
                source.generation !== frameGeneration.current ||
                navigating.current
              )
                return;
              canvas.width = videoFrame.displayWidth;
              canvas.height = videoFrame.displayHeight;
              const context = canvas.getContext("2d");
              context?.drawImage(videoFrame, 0, 0);
              if (context) stats.rendered++;
              stats.status = context ? "rendered" : "canvas-unavailable";
              report();
              const captured = {
                width: source.width,
                height: source.height,
                ageAtReceipt: source.ageAtReceipt,
                receivedAt: source.receivedAt,
                pageId,
              };
              frameRef.current = captured;
              setFrame(captured);
              setFrameError(false);
            } finally {
              videoFrame.close();
            }
          },
          error: () => {
            failed = true;
            stats.status = "decoder-error";
          },
        });
        stage = "codec-support";
        const support = await VideoDecoder.isConfigSupported({
          codec: opened.codec,
          optimizeForLatency: true,
        });
        if (!support.supported || current !== generation)
          throw new Error("Video codec unavailable");
        decoder.configure({ codec: opened.codec, optimizeForLatency: true });
        videoReady = true;
        stats.status = "stream-ready";
        report();
        setSnapshotFallback(false);
        while (!signal.aborted && current === generation) {
          const requestedAt = performance.now();
          stage = "next-request";
          const next = await request({
            op: "next",
            input: { id: pageId, streamId: opened.streamId },
          });
          const receivedAt = performance.now();
          stage = "next-result";
          if (
            !Value.Check(BrowserVideoNextResultSchema, next) ||
            next.packets.reduce((n, packet) => n + packet.data.length, 0) >
              512 * 1024
          )
            throw new Error("Invalid video packets");
          stats.polls++;
          stats.packets += next.packets.length;
          if (!next.packets.length) stats.empty++;
          stats.status = next.packets.length ? "packets-received" : "empty";
          report();
          stage = "decoder";
          if (
            failed ||
            decoder.state === "closed" ||
            decoder.decodeQueueSize > 8 ||
            metadata.size > 32
          )
            throw new Error("Video decoder failed");
          for (const packet of next.packets) {
            stage = "packet-decode";
            if (packet.capturedAt > next.serverTime)
              throw new Error("Invalid video timestamp");
            metadata.set(packet.timestamp, {
              width: packet.width,
              height: packet.height,
              ageAtReceipt:
                next.serverTime - packet.capturedAt + receivedAt - requestedAt,
              receivedAt,
              generation: frameGeneration.current,
            });
            const binary = atob(packet.data);
            const data = Uint8Array.from(binary, (char) => char.charCodeAt(0));
            decoder.decode(
              new EncodedVideoChunk({
                type: packet.type,
                timestamp: packet.timestamp,
                duration: packet.duration,
                data,
              }),
            );
          }
          if (!next.packets.length) {
            const { promise, resolve } = Promise.withResolvers<void>();
            timer = setTimeout(resolve, 50);
            await promise;
          }
        }
      } catch {
        if (!signal.aborted && current === generation) {
          stats.failures++;
          stats.status = stage;
          report();
          reportFailure();
          stopStream();
          if (!videoReady) startSnapshots();
          else {
            setFrameError(true);
            if (!stopped && !document.hidden)
              timer = setTimeout(() => void start(), 1000);
          }
        }
      }
    };
    const visibilityChanged = () => {
      stopStream();
      if (!document.hidden) void start();
    };
    const offline = () => stopStream();
    const online = () => {
      if (!document.hidden) void start();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    window.addEventListener("pagehide", offline);
    void start();
    return () => {
      stopped = true;
      stopStream();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", offline);
    };
  }, [active, pageId, sessionId, hostId, videoVersion]);

  const coordinates = (clientX: number, clientY: number, captured = false) => {
    const current = frameRef.current;
    const rect = imageRef.current?.getBoundingClientRect();
    if (
      !current ||
      navigating.current ||
      current.pageId !== pageId ||
      current.ageAtReceipt + performance.now() - current.receivedAt > 2500 ||
      !rect?.width ||
      !rect.height
    )
      return null;
    if (
      !captured &&
      (clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom)
    )
      return null;
    return {
      x: Math.min(
        current.width - 1,
        Math.max(0, ((clientX - rect.left) * current.width) / rect.width),
      ),
      y: Math.min(
        current.height - 1,
        Math.max(0, ((clientY - rect.top) * current.height) / rect.height),
      ),
    };
  };
  const pointer = (
    event: PointerEvent<HTMLCanvasElement>,
    kind: "down" | "move" | "up",
  ) => {
    if (!controlling) return;
    const point = coordinates(
      event.clientX,
      event.clientY,
      event.currentTarget.hasPointerCapture(event.pointerId),
    );
    if (!point) {
      setControlError(true);
      return;
    }
    event.preventDefault();
    if (event.pointerType === "touch") {
      if (kind === "down") {
        event.currentTarget.setPointerCapture(event.pointerId);
        touches.current.set(event.pointerId, { id: event.pointerId, ...point });
      } else if (!touches.current.has(event.pointerId)) return;
      else if (kind === "move")
        touches.current.set(event.pointerId, { id: event.pointerId, ...point });
      else touches.current.delete(event.pointerId);
      send({
        type: "touch",
        event: kind === "down" ? "start" : kind === "up" ? "end" : "move",
        points: [...touches.current.values()],
        modifiers: modifiers(event),
      });
      return;
    }
    if (kind === "down") {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    }
    const button =
      kind === "move"
        ? "none"
        : event.button === 1
          ? "middle"
          : event.button === 2
            ? "right"
            : "left";
    send(
      {
        type: "pointer",
        event: kind,
        ...point,
        button,
        buttons: event.buttons,
        clickCount: kind === "move" ? 0 : Math.max(1, event.detail),
        modifiers: modifiers(event),
      },
      `${event.pointerType}:${event.pointerId}`,
    );
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>, kind: "down" | "up") => {
    const shortcutKey = event.code || event.key.toLowerCase();
    if (kind === "down" && isClipboardShortcut(event)) {
      clipboardKeys.current.add(shortcutKey);
      return;
    }
    if (kind === "up" && clipboardKeys.current.delete(shortcutKey)) return;
    if (
      !controlling ||
      composing.current ||
      event.nativeEvent.isComposing ||
      isClipboardShortcut(event)
    )
      return;
    event.preventDefault();
    send({
      type: "key",
      event: kind,
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: modifiers(event),
      repeat: event.repeat,
    });
    if (
      kind === "down" &&
      event.currentTarget === imageRef.current &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    )
      send({ type: "text", text: event.key });
  };

  if (!active) return null;
  return (
    <section
      aria-label={t("workspaceBrowser.viewer")}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "10px 12px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            minWidth: 0,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: "1 1 160px",
              minWidth: 0,
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            {t("workspaceBrowser.page")}
            <select
              style={{
                ...toolbarField,
                flex: "1 1 auto",
                width: 0,
                minWidth: 0,
                maxWidth: 360,
                padding: "0 10px",
                cursor: "pointer",
              }}
              value={pageId ?? ""}
              onChange={(event) => {
                release();
                setSelectedId(event.target.value);
              }}
            >
              {pages.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || item.url || t("workspaceBrowser.untitled")}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!pageId || !navigator.onLine}
            onClick={() => {
              if (controlling) release();
              else {
                dispatch.current.enabled = true;
                setControlError(false);
                setControlling(true);
              }
            }}
            aria-pressed={controlling}
            style={{
              ...toolbarButton,
              background: controlling
                ? "var(--bg-selected)"
                : "var(--accent-strong)",
              borderColor: controlling
                ? "var(--accent)"
                : "var(--accent-strong)",
              color: controlling ? "var(--accent-strong)" : "var(--on-accent)",
              opacity: !pageId || !navigator.onLine ? 0.5 : 1,
              cursor: !pageId || !navigator.onLine ? "not-allowed" : "pointer",
            }}
          >
            {t(
              controlling
                ? "workspaceBrowser.release"
                : "workspaceBrowser.takeControl",
            )}
          </button>
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
        >
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button
              type="button"
              disabled={!controlling}
              aria-label={t("workspaceBrowser.back")}
              title={t("workspaceBrowser.back")}
              onClick={() => send({ type: "back" })}
              style={{
                ...toolbarButton,
                width: 36,
                padding: 0,
                opacity: controlling ? 1 : 0.5,
                cursor: controlling ? "pointer" : "not-allowed",
              }}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={!controlling}
              aria-label={t("workspaceBrowser.forward")}
              title={t("workspaceBrowser.forward")}
              onClick={() => send({ type: "forward" })}
              style={{
                ...toolbarButton,
                width: 36,
                padding: 0,
                opacity: controlling ? 1 : 0.5,
                cursor: controlling ? "pointer" : "not-allowed",
              }}
            >
              <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={!controlling}
              aria-label={t("workspaceBrowser.reload")}
              title={t("workspaceBrowser.reload")}
              onClick={() => send({ type: "reload" })}
              style={{
                ...toolbarButton,
                width: 36,
                padding: 0,
                opacity: controlling ? 1 : 0.5,
                cursor: controlling ? "pointer" : "not-allowed",
              }}
            >
              <RotateCw size={16} aria-hidden="true" />
            </button>
          </div>
          <form
            style={{ display: "flex", flex: "1 1 auto", gap: 6, minWidth: 0 }}
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const url = new URL(address);
                if (
                  !/^https?:\/\//i.test(address.trim()) ||
                  (url.protocol !== "http:" && url.protocol !== "https:")
                )
                  throw new Error("Invalid URL");
                setControlError(false);
                send({ type: "navigate", url: url.href });
              } catch {
                setControlError(true);
              }
            }}
          >
            <input
              aria-label={t("workspaceBrowser.address")}
              title={address}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              readOnly={!controlling}
              style={{
                ...toolbarField,
                flex: "1 1 auto",
                width: 0,
                minWidth: 0,
                padding: "0 10px",
                color: controlling ? "var(--text)" : "var(--text-muted)",
              }}
            />
            <button
              disabled={!controlling}
              type="submit"
              style={{
                ...toolbarButton,
                opacity: controlling ? 1 : 0.5,
                cursor: controlling ? "pointer" : "not-allowed",
              }}
            >
              {t("workspaceBrowser.go")}
            </button>
          </form>
        </div>
        <p
          style={{
            margin: 0,
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          {t("workspaceBrowser.sharedWarning")}
        </p>
        {snapshotFallback && (
          <p
            role="status"
            style={{
              margin: 0,
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {t("workspaceBrowser.snapshotFallback")}
          </p>
        )}
        {controlError && (
          <p
            role="alert"
            style={{
              margin: 0,
              color: "var(--status-error)",
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {t("workspaceBrowser.controlError")}
          </p>
        )}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <canvas
          ref={imageRef}
          aria-label={t("workspaceBrowser.image")}
          tabIndex={controlling ? 0 : -1}
          style={{
            display: frame ? "block" : "none",
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            touchAction: controlling ? "none" : "auto",
          }}
          onPointerDown={(event) => pointer(event, "down")}
          onPointerMove={(event) => pointer(event, "move")}
          onPointerUp={(event) => pointer(event, "up")}
          onPointerCancel={(event) => {
            if (
              event.pointerType === "touch" &&
              touches.current.has(event.pointerId)
            ) {
              touches.current.clear();
              if (coordinates(event.clientX, event.clientY, true))
                send({
                  type: "touch",
                  event: "cancel",
                  points: [],
                  modifiers: modifiers(event),
                });
            }
          }}
          onContextMenu={(event) => {
            if (controlling) event.preventDefault();
          }}
          onWheel={(event: WheelEvent<HTMLCanvasElement>) => {
            const point = coordinates(event.clientX, event.clientY);
            if (!controlling || !point) return;
            event.preventDefault();
            const scale =
              event.deltaMode === 1
                ? 16
                : event.deltaMode === 2
                  ? (frameRef.current?.height ?? 1)
                  : 1;
            send({
              type: "wheel",
              ...point,
              deltaX: event.deltaX * scale,
              deltaY: event.deltaY * scale,
              modifiers: modifiers(event),
            });
          }}
          onKeyDown={(event) => keyboard(event, "down")}
          onKeyUp={(event) => keyboard(event, "up")}
        />
        {!frame && (
          <p>
            {t(
              frameError
                ? "workspaceBrowser.unavailable"
                : "workspaceBrowser.waiting",
            )}
          </p>
        )}
        {frameError && frame && (
          <p role="status" style={{ position: "absolute", bottom: 0 }}>
            {t("workspaceBrowser.unavailable")}
          </p>
        )}
      </div>
      {controlling && (
        <textarea
          aria-label={t("workspaceBrowser.keyboard")}
          placeholder={t("workspaceBrowser.keyboardPlaceholder")}
          rows={1}
          style={{
            ...toolbarField,
            resize: "none",
            margin: "8px 12px",
            padding: "8px 10px",
            boxSizing: "border-box",
          }}
          onKeyDown={(event) => {
            if (
              event.key.length !== 1 ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey
            )
              keyboard(event, "down");
          }}
          onKeyUp={(event) => {
            if (
              event.key.length !== 1 ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey
            )
              keyboard(event, "up");
          }}
          onPaste={(event) => event.preventDefault()}
          onCut={(event) => event.preventDefault()}
          onCompositionStart={() => {
            composing.current = true;
            compositionText.current = "";
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            compositionText.current = event.data;
            if (event.data) send({ type: "text", text: event.data });
            event.currentTarget.value = "";
            setTimeout(() => {
              compositionText.current = "";
            }, 0);
          }}
          onInput={(event) => {
            if (composing.current) return;
            const value = event.currentTarget.value;
            event.currentTarget.value = "";
            if (value && value !== compositionText.current)
              send({ type: "text", text: value });
            compositionText.current = "";
          }}
        />
      )}
    </section>
  );
}
