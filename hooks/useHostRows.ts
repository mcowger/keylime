"use client";

import { useEffect, useState } from "react";
import { openEventStream } from "@/lib/event-stream";
import type { HostRow } from "@/lib/hosts/hub";

/** Authenticated snapshot followed by live host updates. */
export function useHostRows(): {
  hosts: HostRow[] | null;
  failed: boolean;
} {
  const [hosts, setHosts] = useState<HostRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const snapshot = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/hosts", { signal: snapshot.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { hosts?: HostRow[] };
        if (!Array.isArray(data.hosts))
          throw new Error("Invalid host snapshot");
        if (!snapshot.signal.aborted) setHosts(data.hosts);
      } catch {
        if (!snapshot.signal.aborted) setFailed(true);
      }
    })();
    const stream = openEventStream({ kind: "hosts" });
    stream.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { hosts?: HostRow[] };
        if (Array.isArray(data.hosts)) {
          snapshot.abort();
          setHosts(data.hosts);
          setFailed(false);
        }
      } catch {
        // A malformed frame is skipped; the next change sends a full list.
      }
    };
    stream.onerror = () => setFailed(true);
    return () => {
      snapshot.abort();
      stream.close();
    };
  }, []);

  return { hosts, failed };
}
