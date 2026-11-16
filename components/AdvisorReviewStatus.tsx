"use client";

import { useI18n } from "@/lib/i18n";

export function AdvisorReviewStatus({ pending }: { pending: boolean }) {
  const { t } = useI18n();
  if (!pending) return null;
  return (
    <div
      role="status"
      style={{
        border: "1px solid var(--border)",
        borderBottom: "none",
        borderRadius: "var(--radius-card) var(--radius-card) 0 0",
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        padding: "5px 8px 5px 12px",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {t("chatInput.advisorReviewing")}
    </div>
  );
}
