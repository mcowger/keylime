import { Type } from "@sinclair/typebox";
import type { OperationContract } from "./operations";
import {
  OpenChannelRequestSchema,
  OpenChannelResultSchema,
  UploadStartArgsSchema,
  UploadStartResultSchema,
  UploadAttachArgsSchema,
  UploadAttachResultSchema,
  StageHostArtifactArgsSchema,
  StageHostArtifactResultSchema,
  ActivateHostArtifactArgsSchema,
  HostArtifactActivationArgsSchema,
  HostArtifactActivationResultSchema,
} from "./host-control-models";
import { BrowserListResultSchema, BrowserCaptureResultSchema, BrowserControlArgsSchema, BrowserControlResultSchema } from "./runner-lifecycle";
import { BrowserVideoStartArgsSchema, BrowserVideoStreamArgsSchema, BrowserVideoStartResultSchema, BrowserVideoNextResultSchema, BrowserVideoStopResultSchema } from "./runner-lifecycle";

const empty = Type.Object({});
export const BrowserListSchema = Type.Object(BrowserListResultSchema.properties, { description: "Browser tabs currently owned by the requested live session on the host." });
export const BrowserFrameSchema = Type.Object(BrowserCaptureResultSchema.properties, { description: "A bounded JPEG frame captured from a browser tab owned by the requested live session." });
/** Lifecycle and upload operations in addition to session and workspace operations. */
export const hostControlOperations: readonly OperationContract[] = [
  {
    name: "ptySessions",
    description: "Usage: List live session terminals on this host.\nInputs: No arguments.\nInvariants: Includes idle PTYs, not just active turns.\nEffects: None.\nRecovery: Retry after the host reconnects.",
    args: empty,
    result: Type.Array(Type.String()),
  },
  {
    name: "browserList",
    description: "Usage: Discover browser tabs belonging to an already-live session.\nInputs: Supply its exact session ID.\nInvariants: Never starts or attaches a runner or browser.\nEffects: Queries the session's runner.\nRecovery: Rediscover after reconnect or session changes.",
    args: Type.Object({ sessionId: Type.String() }),
    result: BrowserListSchema,
  },
  {
    name: "browserCapture",
    description: "Usage: Capture one session-owned browser tab.\nInputs: Supply the exact session ID and tab ID from discovery.\nInvariants: No caller-supplied CDP endpoint or browser input is accepted; capture is bounded.\nEffects: Captures a single JPEG without changing browser lifecycle.\nRecovery: Rediscover after tab or session changes.",
    args: Type.Object({ sessionId: Type.String(), tabId: Type.String({ minLength: 1, maxLength: 1024 }) }),
    result: BrowserFrameSchema,
  },
  ...([ 
    ["browserVideoStart", BrowserVideoStartArgsSchema, BrowserVideoStartResultSchema],
    ["browserVideoNext", BrowserVideoStreamArgsSchema, BrowserVideoNextResultSchema],
    ["browserVideoStop", BrowserVideoStreamArgsSchema, BrowserVideoStopResultSchema],
  ] as const).map(([name, input, result]) => ({
    name,
    description: "Usage: Manage a session-owned encoded browser video stream.\nInputs: Supply the session and exact target and stream identifiers.\nInvariants: Video is bounded and ephemeral; ownership is checked by the runner.\nEffects: Starts, consumes, or stops the stream.\nRecovery: Restart after disconnect or decoder failure.",
    args: Type.Object({ sessionId: Type.String(), input }),
    result,
  })),
  {
    name: "browserControl",
    description: "Usage: Control a session-owned browser tab with a bounded ordered batch.\nInputs: Supply the session ID, target ID and 1–64 actions from the browser control contract.\nInvariants: Whole-batch validation precedes dispatch; the runner rechecks ownership before each action; no runner or browser is started and no CDP endpoint is exposed.\nEffects: Applies actions sequentially through one CDP session; failure stops the batch and may leave an applied prefix.\nRecovery: Delivery of a prefix may be uncertain; never automatically retry the batch or remaining actions.",
    args: Type.Object({ sessionId: Type.String(), control: BrowserControlArgsSchema }),
    result: BrowserControlResultSchema,
  },
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
    name: "stageHostArtifact",
    description:
      "Usage: Stage a binary, runner or other artifact for manual installation.\nInputs: Supply the ID of a completed upload on this link.\nInvariants: The upload must be nonempty and unused by a session or workspace. The daemon picks the destination; it never overwrites an artifact or an installed binary.\nEffects: Moves the file into private host staging without execute permission and returns its host-local path. It does not install, start or restart anything.\nRecovery: If confirmation is lost, inspect keylime/host-artifacts/<upload id> under the daemon's agent directory before uploading again.",
    args: StageHostArtifactArgsSchema,
    result: StageHostArtifactResultSchema,
  },
  {
    name: "activateHostArtifact",
    description:
      "Usage: Install a selected staged binary and restart the standalone daemon.\nInputs: Supply its staged upload ID, an operation ID, the target executable and its expected SHA-256.\nInvariants: Valid only on a supported standalone install and the server link that staged the artifact. Replaying an admitted operation ID cannot trigger a second activation. Busy hosts refuse activation.\nEffects: Hands installation to a worker that verifies the bytes and preflights the replacement with the other installed binary before draining. On success, it saves a backup, replaces the binary atomically and restarts the unit. Acceptance is not completion.\nRecovery: Read hostArtifactActivationStatus with the same operation ID after reconnect. Never blindly retry or automatically roll back a restart.",
    args: ActivateHostArtifactArgsSchema,
    result: HostArtifactActivationResultSchema,
  },
  {
    name: "hostArtifactActivationStatus",
    description:
      "Usage: Read the outcome of a standalone host activation.\nInputs: Supply the original operation ID.\nInvariants: State belongs to the daemon and the server relationship that requested the activation. A missing receipt does not prove that the operation ran or failed.\nEffects: Reads durable state without installing, restarting or retrying.\nRecovery: Poll after the link returns. If the outcome stays unknown, inspect the service and backup on the host before retrying.",
    args: HostArtifactActivationArgsSchema,
    result: HostArtifactActivationResultSchema,
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
];
