"use client";

import { useEffect, useState } from "react";
import { Circle, LoaderCircle, Wrench, Zap } from "lucide-react";
import type { ModelActivity } from "@/lib/model-activity";
import { useI18n } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

export function ModelActivityIndicator({
  activity,
}: {
  activity?: ModelActivity;
}) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const [now, setNow] = useState(Date.now());
  const kind = activity?.kind ?? "idle";
  const timed = kind === "waiting" || kind === "tools";
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [timed, activity?.startedAt]);
  const number = timed
    ? (Math.max(0, now - (activity?.startedAt ?? now)) / 1000).toFixed(1)
    : kind === "streaming"
      ? String(Math.round(activity?.rate ?? 0))
      : null;
  const Icon =
    kind === "waiting"
      ? LoaderCircle
      : kind === "streaming"
        ? Zap
        : kind === "tools"
          ? Wrench
          : Circle;
  const label = timed
    ? t(
        kind === "tools"
          ? "modelActivity.toolsElapsed"
          : "modelActivity.waitingElapsed",
        { seconds: number ?? "0.0" },
      )
    : kind === "streaming"
      ? t("modelActivity.streamingRate", { rate: number ?? "0" })
      : t("modelActivity.idle");
  return (
    <span
      aria-label={label}
      title={
        kind === "streaming"
          ? `${label}. ${t("modelActivity.estimateTooltip")}`
          : label
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 5,
        width: 80,
        flex: "0 0 80px",
        overflow: "hidden",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        fontSize: 11,
        marginRight: 4,
        color: kind === "tools" ? "var(--accent)" : "var(--text-muted)",
      }}
    >
      {number !== null && <span aria-hidden="true">{number}</span>}
      <Icon
        size={13}
        aria-hidden="true"
        style={{ flexShrink: 0 }}
        className={
          kind === "waiting" && !reducedMotion ? "animate-spin" : undefined
        }
      />
    </span>
  );
}
