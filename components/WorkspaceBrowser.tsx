"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import type { BrowserControlAction, BrowserListResult } from "@/lib/api-contracts/runner-lifecycle";
import { useI18n } from "@/lib/i18n";

type BrowserPage = BrowserListResult["tabs"][number];
type BrowserSessions = Record<string, BrowserPage[]>;

const toolbarButton: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  minHeight: 36, padding: "0 12px", border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)",
  font: "inherit", fontSize: 12, fontWeight: 500, cursor: "pointer",
};
const toolbarField: CSSProperties = {
  minHeight: 36, border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
  background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 12,
};

const browserUrl = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/browser`;

export function useWorkspaceBrowsers(sessionIds: string[], enabled: boolean) {
  const [browsers, setBrowsers] = useState<BrowserSessions>({});
  const idsKey = JSON.stringify(sessionIds);

  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setBrowsers((previous) => Object.fromEntries(ids.filter((id) => previous[id]).map((id) => [id, previous[id]])));
    if (!enabled || ids.length === 0) return;

    const poll = async () => {
      if (document.hidden || stopped) return;
      controller = new AbortController();
      const signal = controller.signal;
      // Limit concurrent discovery requests even when many chats are open.
      for (let start = 0; start < ids.length && !signal.aborted; start += 4) {
        await Promise.all(ids.slice(start, start + 4).map(async (id) => {
          try {
            const response = await fetch(browserUrl(id), { signal, cache: "no-store" });
            if (!response.ok) return;
            const data = await response.json() as BrowserListResult;
            if (!signal.aborted) setBrowsers((previous) => ({ ...previous, [id]: data.tabs }));
          } catch {
            // Keep the last known state on transient disconnects.
          }
        }));
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
  }, [idsKey, enabled]);
  return browsers;
}

type Frame = { url: string; width: number; height: number; capturedAt: number; pageId: string };

function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function isClipboardShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && ["c", "v", "x"].includes(event.key.toLowerCase());
}

async function isDisconnected(response: Response) {
  if (response.status !== 404 && response.status !== 503) return false;
  try {
    const body = await response.json() as { code?: string };
    return body.code === "session_not_running" || body.code === "host_offline";
  } catch {
    return false;
  }
}

export function WorkspaceBrowser({ sessionId, pages, active }: {
  sessionId: string;
  pages: BrowserPage[];
  active: boolean;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(pages[0]?.id ?? "");
  const pageId = pages.some((page) => page.id === selectedId) ? selectedId : pages[0]?.id;
  const page = pages.find((item) => item.id === pageId);
  const [address, setAddress] = useState(page?.url ?? "");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameError, setFrameError] = useState(false);
  const [controlError, setControlError] = useState(false);
  const [controlling, setControlling] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<Frame | null>(null);
  const loadedFrame = useRef<string | null>(null);
  const frameGeneration = useRef(0);
  const touches = useRef(new Map<number, { id: number; x: number; y: number }>());
  const composing = useRef(false);
  const clipboardKeys = useRef(new Set<string>());
  const compositionText = useRef("");
  const dispatch = useRef({ generation: 0, enabled: false, busy: false, queue: [] as Array<{ action: BrowserControlAction; sessionId: string; pageId: string; generation: number }> });

  const release = () => {
    dispatch.current.generation++;
    dispatch.current.enabled = false;
    dispatch.current.queue = [];
    touches.current.clear();
    clipboardKeys.current.clear();
    setControlling(false);
  };

  const send = (action: BrowserControlAction) => {
    const state = dispatch.current;
    if (!state.enabled || !active || !pageId || document.hidden || !navigator.onLine) return;
    state.queue.push({ action, sessionId, pageId, generation: state.generation });
    if (state.busy) return;
    state.busy = true;
    const drain = async () => {
      while (state.enabled && state.queue.length) {
        const next = state.queue.shift()!;
        const navigation = ["navigate", "back", "forward", "reload"].includes(next.action.type);
        if (navigation) { frameGeneration.current++; frameRef.current = null; }
        try {
          const response = await fetch(`${browserUrl(next.sessionId)}/control`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: next.pageId, action: next.action }),
          });
          if (navigation && state.generation === next.generation) { frameGeneration.current++; frameRef.current = null; }
          if (!response.ok) {
            if (await isDisconnected(response) && state.generation === next.generation) {
              setControlError(true);
              release();
            }
            throw new Error("Browser control failed");
          }
          if (state.generation === next.generation) setControlError(false);
        } catch {
          if (navigation && state.generation === next.generation) { frameGeneration.current++; frameRef.current = null; }
          if (state.generation === next.generation) {
            // The failed operation may have executed. Never replay it or later queued input.
            state.queue = [];
            setControlError(true);
          }
        }
      }
      state.busy = false;
    };
    void drain();
  };

  useEffect(() => {
    setAddress(page?.url ?? "");
  }, [pageId, page?.url]);

  useEffect(() => {
    const visibilityChanged = () => { if (document.hidden) release(); };
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
  }, [active, pageId, sessionId]);

  useEffect(() => {
    setFrame(null);
    frameRef.current = null;
    setFrameError(false);
    if (!active || !pageId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let objectUrl: string | undefined;
    const poll = async () => {
      if (document.hidden || stopped) return;
      controller = new AbortController();
      const signal = controller.signal;
      const generation = frameGeneration.current;
      try {
        const response = await fetch(`${browserUrl(sessionId)}/frame?${new URLSearchParams({ tabId: pageId })}`, { signal, cache: "no-store" });
        if (!response.ok) {
          if (await isDisconnected(response) && !signal.aborted) release();
          throw new Error("Frame request failed");
        }
        const width = Number(response.headers.get("X-Browser-Viewport-Width"));
        const height = Number(response.headers.get("X-Browser-Viewport-Height"));
        if (!(width > 0 && height > 0)) throw new Error("Invalid browser viewport");
        const blob = await response.blob();
        if (!signal.aborted && generation === frameGeneration.current) {
          const next = URL.createObjectURL(blob);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          const captured = { url: next, width, height, capturedAt: Date.now(), pageId };
          loadedFrame.current = null;
          frameRef.current = captured;
          setFrame(captured);
          setFrameError(false);
        }
      } catch {
        if (!signal.aborted) {
          frameRef.current = null;
          setFrameError(true);
        }
      }
      if (!signal.aborted && !stopped) timer = setTimeout(poll, 1000);
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      controller?.abort();
      frameRef.current = null;
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      frameRef.current = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, pageId, sessionId]);

  const coordinates = (clientX: number, clientY: number, captured = false) => {
    const current = frameRef.current;
    const rect = imageRef.current?.getBoundingClientRect();
    if (!current || loadedFrame.current !== current.url || current.pageId !== pageId || Date.now() - current.capturedAt > 2500 || !rect?.width || !rect.height) return null;
    if (!captured && (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom)) return null;
    return { x: Math.min(current.width - 1, Math.max(0, (clientX - rect.left) * current.width / rect.width)), y: Math.min(current.height - 1, Math.max(0, (clientY - rect.top) * current.height / rect.height)) };
  };
  const pointer = (event: PointerEvent<HTMLImageElement>, kind: "down" | "move" | "up") => {
    if (!controlling) return;
    const point = coordinates(event.clientX, event.clientY, event.currentTarget.hasPointerCapture(event.pointerId));
    if (!point) return;
    event.preventDefault();
    if (event.pointerType === "touch") {
      if (kind === "down") {
        event.currentTarget.setPointerCapture(event.pointerId);
        touches.current.set(event.pointerId, { id: event.pointerId, ...point });
      } else if (!touches.current.has(event.pointerId)) return;
      else if (kind === "move") touches.current.set(event.pointerId, { id: event.pointerId, ...point });
      else touches.current.delete(event.pointerId);
      send({ type: "touch", event: kind === "down" ? "start" : kind === "up" ? "end" : "move", points: [...touches.current.values()], modifiers: modifiers(event) });
      return;
    }
    if (kind === "down") {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    }
    const button = kind === "move" ? "none" : event.button === 1 ? "middle" : event.button === 2 ? "right" : "left";
    send({ type: "pointer", event: kind, ...point, button, buttons: event.buttons, clickCount: kind === "move" ? 0 : Math.max(1, event.detail), modifiers: modifiers(event) });
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>, kind: "down" | "up") => {
    const shortcutKey = event.code || event.key.toLowerCase();
    if (kind === "down" && isClipboardShortcut(event)) { clipboardKeys.current.add(shortcutKey); return; }
    if (kind === "up" && clipboardKeys.current.delete(shortcutKey)) return;
    if (!controlling || composing.current || event.nativeEvent.isComposing || isClipboardShortcut(event)) return;
    event.preventDefault();
    send({ type: "key", event: kind, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: modifiers(event), repeat: event.repeat });
    if (kind === "down" && event.currentTarget === imageRef.current && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) send({ type: "text", text: event.key });
  };

  if (!active) return null;
  return (
    <section aria-label={t("workspaceBrowser.viewer")} style={{ order: 1, flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 160px", minWidth: 0, color: "var(--text-muted)", fontSize: 12 }}>
            {t("workspaceBrowser.page")}
            <select style={{ ...toolbarField, flex: "1 1 auto", width: 0, minWidth: 0, maxWidth: 360, padding: "0 10px", cursor: "pointer" }} value={pageId ?? ""} onChange={(event) => { release(); setSelectedId(event.target.value); }}>
              {pages.map((item) => <option key={item.id} value={item.id}>{item.title || item.url || t("workspaceBrowser.untitled")}</option>)}
            </select>
          </label>
          <button type="button" disabled={!pageId || !navigator.onLine} onClick={() => { if (controlling) release(); else { dispatch.current.enabled = true; setControlError(false); setControlling(true); } }} aria-pressed={controlling} style={{ ...toolbarButton, background: controlling ? "var(--bg-selected)" : "var(--accent-strong)", borderColor: controlling ? "var(--accent)" : "var(--accent-strong)", color: controlling ? "var(--accent-strong)" : "var(--on-accent)", opacity: !pageId || !navigator.onLine ? 0.5 : 1, cursor: !pageId || !navigator.onLine ? "not-allowed" : "pointer" }}>{t(controlling ? "workspaceBrowser.release" : "workspaceBrowser.takeControl")}</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button type="button" disabled={!controlling} aria-label={t("workspaceBrowser.back")} title={t("workspaceBrowser.back")} onClick={() => send({ type: "back" })} style={{ ...toolbarButton, width: 36, padding: 0, opacity: controlling ? 1 : 0.5, cursor: controlling ? "pointer" : "not-allowed" }}><ArrowLeft size={16} aria-hidden="true" /></button>
            <button type="button" disabled={!controlling} aria-label={t("workspaceBrowser.forward")} title={t("workspaceBrowser.forward")} onClick={() => send({ type: "forward" })} style={{ ...toolbarButton, width: 36, padding: 0, opacity: controlling ? 1 : 0.5, cursor: controlling ? "pointer" : "not-allowed" }}><ArrowRight size={16} aria-hidden="true" /></button>
            <button type="button" disabled={!controlling} aria-label={t("workspaceBrowser.reload")} title={t("workspaceBrowser.reload")} onClick={() => send({ type: "reload" })} style={{ ...toolbarButton, width: 36, padding: 0, opacity: controlling ? 1 : 0.5, cursor: controlling ? "pointer" : "not-allowed" }}><RotateCw size={16} aria-hidden="true" /></button>
          </div>
          <form style={{ display: "flex", flex: "1 1 auto", gap: 6, minWidth: 0 }} onSubmit={(event) => {
          event.preventDefault();
          try {
            const url = new URL(address);
            if (!/^https?:\/\//i.test(address.trim()) || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error("Invalid URL");
            send({ type: "navigate", url: url.href });
            setControlError(false);
          } catch { setControlError(true); }
        }}>
            <input aria-label={t("workspaceBrowser.address")} title={address} value={address} onChange={(event) => setAddress(event.target.value)} readOnly={!controlling} style={{ ...toolbarField, flex: "1 1 auto", width: 0, minWidth: 0, padding: "0 10px", color: controlling ? "var(--text)" : "var(--text-muted)" }} />
            <button disabled={!controlling} type="submit" style={{ ...toolbarButton, opacity: controlling ? 1 : 0.5, cursor: controlling ? "pointer" : "not-allowed" }}>{t("workspaceBrowser.go")}</button>
          </form>
        </div>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.4 }}>{t("workspaceBrowser.sharedWarning")}</p>
        {controlError && <p role="alert" style={{ margin: 0, color: "var(--status-error)", fontSize: 12, lineHeight: 1.4 }}>{t("workspaceBrowser.controlError")}</p>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        {frame ? <img ref={imageRef} src={frame.url} alt={t("workspaceBrowser.image")} tabIndex={controlling ? 0 : -1} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", touchAction: controlling ? "none" : "auto" }} draggable={false}
          onPointerDown={(event) => pointer(event, "down")} onPointerMove={(event) => pointer(event, "move")} onPointerUp={(event) => pointer(event, "up")}
          onPointerCancel={(event) => { if (event.pointerType === "touch" && touches.current.has(event.pointerId)) { touches.current.clear(); if (coordinates(event.clientX, event.clientY, true)) send({ type: "touch", event: "cancel", points: [], modifiers: modifiers(event) }); } }}
          onContextMenu={(event) => { if (controlling) event.preventDefault(); }}
          onWheel={(event: WheelEvent<HTMLImageElement>) => { const point = coordinates(event.clientX, event.clientY); if (!controlling || !point) return; event.preventDefault(); const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (frameRef.current?.height ?? 1) : 1; send({ type: "wheel", ...point, deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: modifiers(event) }); }}
          onKeyDown={(event) => keyboard(event, "down")} onKeyUp={(event) => keyboard(event, "up")}
          onLoad={() => { if (frameRef.current?.url === frame.url) loadedFrame.current = frame.url; }}
          onError={() => { frameRef.current = null; setFrameError(true); }} /> : <p>{t(frameError ? "workspaceBrowser.unavailable" : "workspaceBrowser.waiting")}</p>}
        {frameError && frame && <p role="status" style={{ position: "absolute", bottom: 0 }}>{t("workspaceBrowser.unavailable")}</p>}
      </div>
      {controlling && <textarea aria-label={t("workspaceBrowser.keyboard")} placeholder={t("workspaceBrowser.keyboardPlaceholder")} rows={1} style={{ ...toolbarField, resize: "none", margin: "8px 12px", padding: "8px 10px", boxSizing: "border-box" }}
        onKeyDown={(event) => { if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) keyboard(event, "down"); }}
        onKeyUp={(event) => { if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) keyboard(event, "up"); }}
        onPaste={(event) => event.preventDefault()} onCut={(event) => event.preventDefault()}
        onCompositionStart={() => { composing.current = true; compositionText.current = ""; }}
        onCompositionEnd={(event) => { composing.current = false; compositionText.current = event.data; if (event.data) send({ type: "text", text: event.data }); event.currentTarget.value = ""; setTimeout(() => { compositionText.current = ""; }, 0); }}
        onInput={(event) => { if (composing.current) return; const value = event.currentTarget.value; event.currentTarget.value = ""; if (value && value !== compositionText.current) send({ type: "text", text: value }); compositionText.current = ""; }} />}
    </section>
  );
}
