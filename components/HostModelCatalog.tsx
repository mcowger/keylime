"use client";

import { useEffect, useState } from "react";
import type { HostModels } from "@/lib/api-contracts/configuration-models";
import { useI18n } from "@/lib/i18n";

type CatalogState =
  | { status: "loading" | "offline" | "upgrade" | "error" }
  | { status: "ready"; data: HostModels };

const statusKeys = {
  loading: "hostModelCatalog.loading",
  offline: "hostModelCatalog.offline",
  upgrade: "hostModelCatalog.upgrade",
  error: "hostModelCatalog.error",
} as const;

// The Settings parent keys this view by hostId to reset it on host switches.
export function HostModelCatalog({ hostId }: { hostId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<CatalogState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function load() {
      try {
        const params = new URLSearchParams({ hostId });
        const response = await fetch(`/api/models?${params}`, {
          cache: "no-store",
          signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          if (signal.aborted) return;
          if (
            response.status === 501 ||
            body?.code === "host_upgrade_required"
          ) {
            setState({ status: "upgrade" });
          } else if (
            body?.hostOffline === true ||
            body?.code === "host_offline"
          ) {
            setState({ status: "offline" });
          } else {
            setState({ status: "error" });
          }
          return;
        }
        const data: HostModels = await response.json();
        if (signal.aborted) return;
        setState(
          data.modelError ? { status: "error" } : { status: "ready", data },
        );
      } catch {
        if (!signal.aborted) setState({ status: "error" });
      }
    }
    void load();
    return () => controller.abort();
  }, [hostId]);

  return (
    <section
      className="settings-card"
      style={{
        flexDirection: "column",
        alignItems: "stretch",
        gap: 8,
        overflowWrap: "anywhere",
      }}
    >
      <h3 style={{ margin: 0, fontSize: "var(--text-md)" }}>
        {t("hostModelCatalog.title")}
      </h3>
      {state.status !== "ready" ? (
        <p role="status" style={{ color: "var(--text-muted)" }}>
          {t(statusKeys[state.status])}
        </p>
      ) : (
        <>
          <p>
            <strong>{t("hostModelCatalog.defaultModel")}</strong>{" "}
            {state.data.defaultModel ? (
              <code>
                {state.data.defaultModel.provider}/
                {state.data.defaultModel.modelId}
              </code>
            ) : (
              t("hostModelCatalog.noDefault")
            )}
          </p>
          {state.data.modelList.length ? (
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {state.data.modelList.map(({ provider, id, name }) => (
                <li key={JSON.stringify([provider, id])}>
                  {name}{" "}
                  <code style={{ color: "var(--text-muted)" }}>
                    {provider}/{id}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: "var(--text-muted)" }}>
              {t("hostModelCatalog.empty")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
