import { useEffect, useState } from "react";
import type { ShipPreview } from "@/lib/workspace-ship-types";

export function useShipAvailability(host?: string, projectPath?: string, path?: string, active = true) {
  const key = host && projectPath && path ? JSON.stringify([host, projectPath, path]) : null;
  const [state, setState] = useState<{ key: string; empty: boolean } | null>(null);

  useEffect(() => {
    if (!key || !active || !host || !projectPath || !path) return;
    let stopped = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (controller) return;
      const request = new AbortController();
      controller = request;
      try {
        const query = new URLSearchParams({ host, projectPath, path });
        const response = await fetch(`/api/ship?${query}`, { signal: request.signal });
        if (!response.ok) throw new Error("Ship preview failed");
        const preview: ShipPreview = await response.json();
        if (!stopped) setState({ key, empty: !preview.dirty && preview.ahead === 0 && preview.issues.length === 0 && preview.pr?.state !== "open" });
      } catch {
        if (!stopped) setState(null);
      } finally {
        if (controller === request) controller = null;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [key, active, host, projectPath, path]);

  return state?.key === key && state.empty;
}
