import { Type, type Static } from "@sinclair/typebox";

export const JobActivitySchema = Type.Object({
  id: Type.String(),
  incarnation: Type.String(),
  kind: Type.Union([
    Type.Literal("bash"),
    Type.Literal("task"),
    Type.Literal("eval"),
    Type.Literal("service"),
  ]),
  status: Type.String(),
  label: Type.String(),
  command: Type.Optional(Type.String()),
  ownerId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  startTime: Type.Number(),
  endTime: Type.Optional(Type.Number()),
  canCancel: Type.Boolean(),
});
export type JobActivity = Static<typeof JobActivitySchema>;

export const JobSnapshotSchema = Type.Object({
  generation: Type.String({
    description:
      "Runner generation; identities become stale when the runner is replaced.",
  }),
  jobs: Type.Array(JobActivitySchema),
  services: Type.Array(JobActivitySchema),
  servicesError: Type.Optional(Type.String()),
  available: Type.Boolean(),
});
export type JobSnapshot = Static<typeof JobSnapshotSchema>;

export const JobDetailSchema = Type.Object({
  id: Type.String(),
  incarnation: Type.String(),
  kind: JobActivitySchema.properties.kind,
  generation: Type.String(),
  command: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  pids: Type.Array(Type.Number()),
  exitCode: Type.Optional(Type.Number()),
  output: Type.String(),
  cursor: Type.Number(),
  start: Type.Number(),
  open: Type.Boolean(),
  truncated: Type.Boolean(),
});
export type JobDetail = Static<typeof JobDetailSchema>;
