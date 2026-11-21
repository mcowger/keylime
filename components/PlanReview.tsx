"use client";

import type { Static } from "@sinclair/typebox";
import type { PlanStateSchema } from "@/lib/api-contracts/runner-native-events";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { MarkdownBody } from "./MarkdownBody";
import { SystemsButton, systemsInput } from "./SystemsForms";

interface Props {
  proposal: NonNullable<Static<typeof PlanStateSchema>["proposal"]>;
  pending: boolean;
  onRespond: (id: string, approved: boolean, feedback?: string) => Promise<boolean>;
}

export function PlanReview({ proposal, pending, onRespond }: Props) {
  const { t } = useI18n();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <section
      aria-label={t("planReview.label")}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
        padding: 12,
        marginBottom: 8,
      }}
    >
      <strong>{proposal.title || t("planReview.label")}</strong>
      <div style={{ maxHeight: "min(40dvh, 360px)", overflowY: "auto", margin: "8px 0" }}>
        <MarkdownBody>{proposal.content}</MarkdownBody>
      </div>
      {revising && (
        <textarea
          aria-label={t("planReview.feedbackLabel")}
          placeholder={t("planReview.feedbackPlaceholder")}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={3}
          style={{ ...systemsInput, marginBottom: 8 }}
        />
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <SystemsButton disabled={pending} onClick={() => void onRespond(proposal.id, true)}>
          {t("planReview.approve")}
        </SystemsButton>
        {revising ? (
          <>
            <SystemsButton disabled={pending || !feedback.trim()} onClick={() => void onRespond(proposal.id, false, feedback.trim())}>
              {t("planReview.sendRevisions")}
            </SystemsButton>
            <SystemsButton disabled={pending} onClick={() => setRevising(false)}>
              {t("chatInput.cancel")}
            </SystemsButton>
          </>
        ) : (
          <SystemsButton disabled={pending} onClick={() => setRevising(true)}>
            {t("planReview.requestRevisions")}
          </SystemsButton>
        )}
      </div>
    </section>
  );
}
