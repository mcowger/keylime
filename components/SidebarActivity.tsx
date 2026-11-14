"use client";

import { Bot, Circle, CircleDotDashed, ListChecks } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TodoPhase } from "@/lib/pi-types";
import type { SubagentInfo } from "@/lib/subagent-types";

export function SidebarActivity({
  todoPhases,
  subagents,
  onSelectSubagent,
}: {
  todoPhases: TodoPhase[];
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
}) {
  const { t } = useI18n();
  const tasks = todoPhases.flatMap((phase) =>
    phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
  );
  const running = subagents.filter(
    (agent) => agent.source !== "history" && agent.status === "started",
  );
  if (!tasks.length && !running.length) return null;

  return (
    <section
      aria-label={t("tabBar.activity")}
      style={{ borderTop: "1px solid var(--border)", padding: "8px 10px", fontSize: 12 }}
    >
      {running.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontWeight: 600, marginBottom: 4 }}>
            <Bot size={14} aria-hidden="true" /> {t("chatWindow.subagentsPanel")}
          </div>
          {running.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectSubagent(agent)}
              title={agent.task ?? agent.description ?? agent.id}
              style={{ display: "flex", gap: 6, alignItems: "center", width: "100%", padding: "3px 0", border: 0, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12 }}
            >
              <span style={{ color: "var(--accent)", flexShrink: 0 }}>●</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.id}: {agent.task ?? agent.description ?? agent.agent}</span>
            </button>
          ))}
        </div>
      )}
      {tasks.length > 0 && (
        <div style={{ marginTop: running.length ? 8 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontWeight: 600, marginBottom: 4 }}>
            <ListChecks size={14} aria-hidden="true" /> {t("chatWindow.todoList")}
          </div>
          {tasks.map((task, index) => (
            <div key={`${task.id ?? task.content}:${index}`} title={task.content} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", color: "var(--text)" }}>
              {task.status === "in_progress" ? <CircleDotDashed size={13} color="var(--accent)" aria-hidden="true" /> : <Circle size={13} color="var(--text-dim)" aria-hidden="true" />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.content}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
