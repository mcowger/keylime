import { createRoot } from "react-dom/client";
import { ShipPlanProgress } from "@/components/ShipDialog";

createRoot(document.getElementById("root")!).render(
  <main style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 12, background: "var(--overlay-backdrop)", boxSizing: "border-box" }}>
    <section role="dialog" aria-label="Ship workspace" style={{ boxSizing: "border-box", width: 640, maxWidth: "100%", minWidth: 0, padding: 22, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)" }}>
      <h2 className="display-heading" style={{ fontSize: 20, margin: "0 0 12px" }}>Ship workspace</h2>
      <ShipPlanProgress elapsed={12} messages={["Inspecting changed files", "Reading the staged diff", "Preparing commit message"]} />
    </section>
  </main>,
);
