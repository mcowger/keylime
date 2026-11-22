import { Type, type Static } from "@sinclair/typebox";

export const DaemonWorkspaceJobScopeSchema = Type.Union(
  [Type.Literal("setup"), Type.Literal("effort"), Type.Literal("ship")],
  {
    description:
      "Which daemon-owned job snapshot to refresh: Repo workspace setup, System Effort setup, or Ship.",
  },
);
export type DaemonWorkspaceJobScope = Static<
  typeof DaemonWorkspaceJobScopeSchema
>;

export const WorkspaceJobsChangedSchema = Type.Union(
  [
    Type.Object({
      type: Type.Literal("workspace_jobs_changed"),
      scope: DaemonWorkspaceJobScopeSchema,
    }),
    Type.Object({
      type: Type.Literal("workspace_jobs_changed"),
      scope: Type.Literal("runner"),
      sessionId: Type.String({
        description:
          "Runner session on the subscribed host whose Jobs snapshot changed.",
      }),
    }),
  ],
  {
    title: "WorkspaceJobsChanged",
    description:
      "Invalidates job state on the host named by the subscription. Runner events identify the owning session. Contains no job payload; read the current snapshot on subscription open and after invalidation.",
  },
);
export type WorkspaceJobsChanged = Static<typeof WorkspaceJobsChangedSchema>;
