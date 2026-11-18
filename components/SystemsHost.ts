"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SystemsRequest,
  SystemsResult,
} from "@/lib/api-contracts/systems";
import { isLinkUp, type HostStatus } from "@/lib/hosts/host";
import { formatApiError } from "@/lib/i18n/api-error";
import { LOCAL_HOST_ID } from "@/lib/project-ordering";

export type SystemsHost = { data?: SystemsResult; error?: string };
export type SystemsHosts = {
  byHost: Record<string, SystemsHost>;
  run: (host: string, input: SystemsRequest) => Promise<SystemsResult>;
};
export type SystemsAction = (input: SystemsRequest) => Promise<SystemsResult>;

export async function systemsRequest(
  host: string,
  input?: SystemsRequest,
  signal?: AbortSignal,
) {
  const response = await (input
    ? fetch("/api/systems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, input }),
      })
    : fetch(`/api/systems?${new URLSearchParams({ host })}`, { signal }));
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      formatApiError({ error: `HTTP ${response.status}`, ...body }),
    );
  return body as SystemsResult;
}

export function useSystemsHosts(
  hosts: readonly { id: string; status: HostStatus }[] | null,
): SystemsHosts {
  const [byHost, setByHost] = useState<Record<string, SystemsHost>>({});
  const mutations = useRef(new Set<string>());
  const revisions = useRef(new Map<string, number>());
  const snapshots = useRef(new Map<string, string>());
  const wake = useRef<(host: string) => void>(() => {});
  const connected = JSON.stringify(
    hosts
      ?.filter((host) => isLinkUp(host.status))
      .map((host) => host.id)
      .sort() ?? [LOCAL_HOST_ID],
  );

  const publish = useCallback(
    (host: string, { root, systems, efforts }: SystemsResult) => {
      const data = { root, systems, efforts };
      const snapshot = JSON.stringify(data);
      const changed = snapshots.current.get(host) !== snapshot;
      snapshots.current.set(host, snapshot);
      setByHost((previous) =>
        !changed && !previous[host]?.error
          ? previous
          : { ...previous, [host]: { data } },
      );
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const poll = async (host: string) => {
      timers.delete(host);
      let delay = 10_000;
      if (mutations.current.has(host)) delay = 1_500;
      else {
        const revision = revisions.current.get(host);
        try {
          const result = await systemsRequest(
            host,
            undefined,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (revision === revisions.current.get(host)) publish(host, result);
          if (
            result.efforts.some(
              (effort) =>
                effort.status === "creating" ||
                effort.status === "cleaning" ||
                effort.services.some((service) => service.status === "running"),
            )
          )
            delay = 1_500;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (revision === revisions.current.get(host)) {
            const message =
              error instanceof Error ? error.message : String(error);
            setByHost((previous) =>
              previous[host]?.error === message
                ? previous
                : {
                    ...previous,
                    [host]: { ...previous[host], error: message },
                  },
            );
          }
        }
      }
      if (!controller.signal.aborted)
        timers.set(
          host,
          setTimeout(() => void poll(host), delay),
        );
    };
    wake.current = (host) => {
      const timer = timers.get(host);
      if (timer) {
        clearTimeout(timer);
        void poll(host);
      }
    };
    for (const host of JSON.parse(connected) as string[]) void poll(host);
    return () => {
      wake.current = () => {};
      controller.abort();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [connected, publish]);

  const run = useCallback(
    async (host: string, input: SystemsRequest) => {
      if (mutations.current.has(host))
        throw new Error("Wait for the current Systems request to finish.");
      mutations.current.add(host);
      revisions.current.set(host, (revisions.current.get(host) ?? 0) + 1);
      try {
        const result = await systemsRequest(host, input);
        publish(host, result);
        return result;
      } finally {
        mutations.current.delete(host);
        wake.current(host);
      }
    },
    [publish],
  );

  return { byHost, run };
}
