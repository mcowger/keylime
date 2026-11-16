"use client";

import { useI18n } from "@/lib/i18n";

export function AdvisorReviewStatus({ pending }: { pending: boolean }) {
  const { t } = useI18n();
  if (!pending) return null;
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        marginBottom: 4,
        padding: "5px 10px",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--bg)",
        color: "var(--text-muted)",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {t("chatInput.advisorReviewing")}
    </div>
  );
}
