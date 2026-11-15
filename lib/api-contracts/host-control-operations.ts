import { Type } from "@sinclair/typebox";
import type { OperationContract } from "./operations";
import {
  OpenChannelRequestSchema,
  OpenChannelResultSchema,
  UploadStartArgsSchema,
  UploadStartResultSchema,
  UploadAttachArgsSchema,
  UploadAttachResultSchema,
} from "./host-control-models";
import {
  HostUpdateCompatibilitySchema,
  HostUpdateInfoSchema,
  HostUpdateOperationSchema,
} from "./host-update-models";
import { ConfigStateSchema } from "./host-schemas";

const empty = Type.Object({});
/** The twelve lifecycle/software/upload operations in addition to session and workspace operations. */
export const hostControlOperations: readonly OperationContract[] = [
  {
    name: "open",
    description:
      "Usage: Join or start a runner.\nInputs: Provide session identity, launch settings and optional preparation or expected channel.\nInvariants: Shared processes are joined, not replaced; trusted membership and startup fences apply. Cold startup can wait channelReadyMs plus opTimeoutMs.\nEffects: Establishes membership; preparation protects a pending command across disconnects.\nRecovery: Rejoin the expected channel after uncertainty rather than assuming a new process was started.",
    args: OpenChannelRequestSchema,
    result: OpenChannelResultSchema,
  },
  {
    name: "close",
    description:
      "Usage: Leave a runner channel.\nInputs: Supply the channel identity.\nInvariants: Closing this server's membership does not kill a peer's process.\nEffects: The daemon manages abandonment and idle cleanup.\nRecovery: Reconcile membership after a lost response before assuming the process stopped.",
    args: Type.Object({ ch: Type.String() }),
    result: empty,
  },
  {
    name: "editLease",
    description:
      "Usage: Acquire or release a history-edit lease.\nInputs: Supply channel and desired on/off state.\nInvariants: Conflicting peers are refused before editing; ownership follows membership.\nEffects: Changes the daemon's editing fence.\nRecovery: Re-establish membership and lease before editing after disconnect.",
    args: Type.Object({ ch: Type.String(), on: Type.Boolean() }),
    result: empty,
  },
  {
    name: "sessionFileExists",
    description:
      "Usage: Check whether a session transcript exists.\nInputs: Supply its daemon-local path.\nInvariants: Paths outside session roots are refused.\nEffects: Reads the filesystem; no process is started.\nRecovery: Correct the path or restore access before retrying a failed check.",
    args: Type.Object({ path: Type.String() }),
    result: Type.Boolean(),
  },
  {
    name: "invalidateSessionLists",
    description:
      "Usage: Invalidate session and workspace inventories.\nInputs: An optional path scopes the notification.\nInvariants: Void success omits res.result in JSON.\nEffects: Invalidates cached inventories and notifies linked servers.\nRecovery: Refresh inventory after reconnect if notification delivery was uncertain.",
    args: Type.Object({ path: Type.Optional(Type.String()) }),
    result: Type.Undefined({
      description: "No result property is sent on successful completion.",
    }),
  },
  {
    name: "checkUpdates",
    description:
      "Usage: Inspect daemon software update status.\nInputs: Supply supported protocol compatibility and optionally force a check.\nInvariants: This checks the daemon, not the web server.\nEffects: Reads software status; does not install an update.\nRecovery: Retry a failed status check after connectivity is restored.",
    args: Type.Object({
      compatibility: HostUpdateCompatibilitySchema,
      force: Type.Optional(Type.Boolean()),
    }),
    result: HostUpdateInfoSchema,
  },
  {
    name: "updateSoftware",
    description:
      "Usage: Start a daemon software update.\nInputs: Supply ompweb target, version and supported protocol range.\nInvariants: Compatibility and quiescence are checked; omp updates with ompweb and is not a separate target. Acceptance is not completion.\nEffects: Starts an update with durable operation status.\nRecovery: Read operation status after reconnect before submitting another update.",
    args: Type.Object({
      target: Type.Literal("ompweb"),
      version: Type.String(),
      compatibility: HostUpdateCompatibilitySchema,
    }),
    result: Type.Object({
      accepted: Type.Literal(true),
      operation: HostUpdateOperationSchema,
    }),
  },
  {
    name: "uploadStart",
    description:
      "Usage: Create or resume a staged upload.\nInputs: Supply upload ID, attempt generation, name, MIME type and byte size; binary pieces follow separately.\nInvariants: Reusing an ID with different metadata conflicts; acknowledgements are attempt-bound. Completed attachment receipts require the retained target to exist, not merely a stored receipt.\nEffects: Creates or resumes daemon-local staged data; inactive staged files are swept after 24 hours.\nRecovery: Resume with matching metadata and use the acknowledged offset, not stale attempt acknowledgements.",
    args: UploadStartArgsSchema,
    result: UploadStartResultSchema,
  },
  {
    name: "uploadAbort",
    description:
      "Usage: Cancel a staged upload.\nInputs: Supply its UUID.\nInvariants: Upload controls are ordered per upload; an earlier attach cannot undo cancellation.\nEffects: Aborts staged data owned by this link; void success omits res.result.\nRecovery: Reconcile upload state after a lost response before proceeding.",
    args: Type.Object({ id: Type.String({ format: "uuid" }) }),
    result: Type.Undefined(),
  },
  {
    name: "uploadAttach",
    description:
      "Usage: Attach a completed staged upload to a session.\nInputs: Supply upload ID and daemon-local session identity and file.\nInvariants: The retained generation must exist; existing names are not overwritten. Repeating for the same destination is idempotent only while its receipt target exists, but a different consumed destination is 404.\nEffects: Installs the file under local/uploads, choosing another name on collision; cross-device copies may take ten minutes.\nRecovery: Retry the same destination after an uncertain response, not a different destination.",
    args: UploadAttachArgsSchema,
    result: UploadAttachResultSchema,
  },
  {
    name: "setUploadRetention",
    description:
      "Usage: Set upload retention policy.\nInputs: Supply positive days or null for never.\nInvariants: A sweep checks the latest policy before deletion.\nEffects: Persists policy and schedules retention without waiting for a sweep.\nRecovery: Read policy after uncertain delivery before changing it again.",
    args: Type.Object({
      days: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    }),
    result: Type.Null(),
  },
  {
    name: "clusterConfig",
    description:
      "Usage: Apply master configuration or restore the host's own configuration.\nInputs: Apply takes a lowercase SHA-256 version; restore takes no version.\nInvariants: Applies are serialized and must succeed before a new cluster session starts; foreign ownership and a departed credentials link are refused, and only the owner may restore.\nEffects: Changes daemon configuration and returns state and ownership.\nRecovery: Inspect returned or current state after an uncertain result before retrying.",
    args: Type.Union([
      Type.Object({
        action: Type.Literal("apply"),
        version: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      }),
      Type.Object({ action: Type.Literal("restore") }),
    ]),
    result: Type.Object({ state: ConfigStateSchema, owned: Type.Boolean() }),
  },
];
