"use client";

import { Check, Network, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import { useI18n } from "@/lib/i18n";
import type { TodoPhase } from "@/lib/pi-types";
import { SubagentActivityLine } from "./ComposerPanels";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { TodoList } from "./TodoList";

const pillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  minHeight: 32,
  padding: "0 8px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  font: "inherit",
  fontSize: 12,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

type Panel = "todos" | "agents";

export function ComposerActivityIndicators({
  todoPhases,
  subagents,
  onSelectSubagent,
}: {
  todoPhases: TodoPhase[];
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
}) {
  const { t } = useI18n();
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const [anchor, setAnchor] = useState({ bottom: 76, left: 8 });
  const rootRef = useRef<HTMLSpanElement>(null);
  const todoTriggerRef = useRef<HTMLButtonElement>(null);
  const agentsTriggerRef = useRef<HTMLButtonElement>(null);

  const tasks = todoPhases.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  const activeAgents = subagents.filter(
    (subagent) =>
      subagent.status === "started" && subagent.source !== "history",
  );
  const todoLabel = `${t("chatWindow.todoList")}: ${t("chatWindow.todoProgress", { done, total: tasks.length })}`;
  const agentLabel = `${t("chatWindow.subagentsPanel")}: ${t(
    "chatWindow.subagentSummary",
    {
      running: activeAgents.length,
      total: subagents.length,
    },
  )}`;

  useEffect(() => {
    if (!openPanel) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpenPanel(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenPanel(null);
      (openPanel === "todos"
        ? todoTriggerRef
        : agentsTriggerRef
      ).current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openPanel]);

  const toggle =
    (panel: Panel) => (event: React.MouseEvent<HTMLButtonElement>) => {
      if (openPanel === panel) {
        setOpenPanel(null);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 16);
      setAnchor({
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        left: Math.min(
          Math.max(8, rect.left),
          Math.max(8, window.innerWidth - width - 8),
        ),
      });
      setOpenPanel(panel);
    };

  if (todoPhases.length === 0 && activeAgents.length === 0) return null;

  return (
    <span ref={rootRef} style={{ display: "inline-flex", gap: 6 }}>
      {todoPhases.length > 0 && (
        <button
          ref={todoTriggerRef}
          type="button"
          className="ui-focus-ring"
          style={pillStyle}
          aria-label={todoLabel}
          title={todoLabel}
          aria-expanded={openPanel === "todos"}
          onClick={toggle("todos")}
        >
          <Check size={14} aria-hidden />
          <span>
            {done}/{tasks.length}
          </span>
        </button>
      )}
      {activeAgents.length > 0 && (
        <button
          ref={agentsTriggerRef}
          type="button"
          className="ui-focus-ring"
          style={pillStyle}
          aria-label={agentLabel}
          title={agentLabel}
          aria-expanded={openPanel === "agents"}
          onClick={toggle("agents")}
        >
          <Network size={14} aria-hidden />
          <span>{activeAgents.length}</span>
        </button>
      )}
      {openPanel && (
        <div
          role="dialog"
          aria-label={openPanel === "todos" ? todoLabel : agentLabel}
          className="picker-panel"
          style={{
            position: "fixed",
            left: anchor.left,
            bottom: anchor.bottom,
            width: "min(360px, calc(100vw - 16px))",
            zIndex: 500,
            maxHeight: "min(480px, 60dvh)",
            overflowY: "auto",
          }}
        >
          <div className="picker-panel-header">
            <span className="picker-panel-title">
              {openPanel === "todos" ? todoLabel : agentLabel}
            </span>
            <button
              type="button"
              className="ui-focus-ring"
              aria-label={t("chatWindow.close")}
              onClick={() => setOpenPanel(null)}
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                padding: 4,
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          {openPanel === "todos" ? (
            <TodoList phases={todoPhases} />
          ) : (
            <div className="grid gap-1.5 px-3 py-2.5">
              {activeAgents.map((subagent) => (
                <button
                  key={subagent.id}
                  type="button"
                  className="ui-focus-ring flex min-w-0 items-start gap-2 rounded border border-border bg-bg px-3 py-2 text-left text-xs text-text"
                  onClick={() => {
                    setOpenPanel(null);
                    onSelectSubagent(subagent);
                  }}
                >
                  <span className="mt-1 shrink-0">
                    <SubagentStatusIcon status={subagent.status} live />
                  </span>
                  <span
                    className="min-w-0"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    <span className="font-medium text-accent">
                      {subagent.id}
                    </span>{" "}
                    <span className="text-text-muted">({subagent.agent})</span>
                    {(subagent.task ||
                      subagent.description ||
                      subagent.assignment) && (
                      <span className="mt-1 block">
                        {subagent.task ??
                          subagent.description ??
                          subagent.assignment}
                      </span>
                    )}
                    <SubagentActivityLine subagent={subagent} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
