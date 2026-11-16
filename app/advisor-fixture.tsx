import "./globals.css";
import { createRoot } from "react-dom/client";
import { ChatInput } from "@/components/ChatInput";

const onSend = async () => ({ status: "accepted" as const });

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 20, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 32 }}>
    <section style={{ minWidth: 0 }}>
      <h2>Advisor review</h2>
      <ChatInput onSend={onSend} onAbort={() => {}} isStreaming={false} advisorReviewPending />
    </section>
    <section style={{ minWidth: 0 }}>
      <h2>Advisor review with queued follow-up</h2>
      <ChatInput onSend={onSend} onAbort={() => {}} isStreaming advisorReviewPending queuedMessages={{ followUp: ["Continue after the current run"], steering: [] }} />
    </section>
  </main>,
);
