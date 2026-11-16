"use client";

import { useEffect, useState } from "react";
import type { BrowserListResult } from "@/lib/api-contracts/runner-lifecycle";

type BrowserPage = BrowserListResult["tabs"][number];
type BrowserSessions = Record<string, BrowserPage[]>;

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

export function WorkspaceBrowser({ sessionId, pages, active }: {
  sessionId: string;
  pages: BrowserPage[];
  active: boolean;
}) {
  const [selectedId, setSelectedId] = useState(pages[0]?.id ?? "");
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const pageId = pages.some((page) => page.id === selectedId) ? selectedId : pages[0]?.id;

  useEffect(() => {
    setFrame(null);
    setError(false);
    if (!active || !pageId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let objectUrl: string | undefined;
    const poll = async () => {
      if (document.hidden || stopped) return;
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const response = await fetch(`${browserUrl(sessionId)}/frame?${new URLSearchParams({ tabId: pageId })}`, { signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Frame request failed (${response.status})`);
        const blob = await response.blob();
        if (signal.aborted) return;
        const next = URL.createObjectURL(blob);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = next;
        setFrame(next);
        setError(false);
      } catch {
        if (!signal.aborted) setError(true);
      }
      if (!signal.aborted && !stopped) timer = setTimeout(poll, 1000);
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, pageId, sessionId]);

  if (!active) return null;
  return (
    <section aria-label="Browser viewer" style={{ order: 1, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <label style={{ padding: 8 }}>
        Page{" "}
        <select value={pageId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
          {pages.map((page) => <option key={page.id} value={page.id}>{page.title || page.url || "Untitled page"}</option>)}
        </select>
      </label>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {frame ? <img src={frame} alt="Live browser page (view only)" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} draggable={false} /> : <p>{error ? "Browser view unavailable. Retrying…" : "Waiting for browser frame…"}</p>}
        {error && frame && <p role="status">Browser view disconnected. Retrying…</p>}
      </div>
    </section>
  );
}
