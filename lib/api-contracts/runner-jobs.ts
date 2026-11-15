import { Type } from "@sinclair/typebox";
import {
  JobActivitySchema,
  JobDetailSchema,
  JobSnapshotSchema,
} from "../jobs-types";
import type { OperationContract } from "./operations";

const JobIdentitySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  incarnation: Type.String({
    minLength: 1,
    description: "Identity token from the job snapshot; detects replacement.",
  }),
  generation: Type.String({
    description: "Runner generation from the job snapshot.",
  }),
  kind: JobActivitySchema.properties.kind,
  cursor: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Output cursor; defaults to zero.",
    }),
  ),
});

/** @apiCommand get_jobs @apiCommand get_job_output @apiCommand cancel_job */
export const jobRunnerOperations = [
  {
    name: "get_jobs",
    description: `Usage: List jobs and services scoped to the current session.
Inputs: No arguments.
Invariants: This is a live snapshot; a service-list failure appears in servicesError.
Effects: Reads runner and daemon state without starting work.
Recovery: Refresh the snapshot after a restart or service-list failure.`,
    args: Type.Object({}),
    result: JobSnapshotSchema,
  },
  {
    name: "get_job_output",
    description: `Usage: Read one job or service's output.
Inputs: Supply its id, kind, incarnation and generation from a current snapshot; cursor defaults to zero.
Invariants: Identity is bound to the runner generation and job incarnation; bash sources honor the cursor, while service logs and non-stream sources return bounded snapshots from zero. Output may be truncated.
Effects: Reads current output without cancelling the job.
Recovery: On stale_generation or job_not_found refresh the list; invalid_args requires correcting the request.`,
    args: JobIdentitySchema,
    result: JobDetailSchema,
  },
  {
    name: "cancel_job",
    description: `Usage: Request cancellation of a scoped job or service.
Inputs: Supply its id, kind, incarnation and generation from a current snapshot.
Invariants: A cancellation request is not proof that work has stopped; stale identities and forbidden targets fail.
Effects: Signals the selected job or service; already produced output is not rolled back.
Recovery: Refresh the snapshot and inspect status after uncertainty; do not reuse an identity from a replaced runner.`,
    args: JobIdentitySchema,
    result: Type.Object({ requested: Type.Boolean() }),
  },
] as const satisfies readonly OperationContract[];
