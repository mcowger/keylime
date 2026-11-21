import { Type, type Static } from "@sinclair/typebox";
import { CREATION_ID_RE } from "../hosts/creation-identity";
import { UPLOAD_ID_RE } from "../upload-limits";

/** Bootstrapped with TypeBox Codegen from SpawnRequest and OpenChannelRequest/Result. */
export const SpawnRequestSchema = Type.Object(
  {
    creationId: Type.Optional(
      Type.String({
        pattern: CREATION_ID_RE.source,
        description:
          "Stable identity of an independent start; retry arguments must remain identical.",
      }),
    ),
    cwd: Type.String(),
    recordedCwd: Type.Union([Type.String(), Type.Null()]),
    sessionFile: Type.String({
      description:
        "Session transcript path on the daemon machine, checked against its session roots.",
    }),
    toolNames: Type.Optional(Type.Array(Type.String())),
    advisor: Type.Boolean(),
    spawnModel: Type.Optional(
      Type.String({
        description:
          "Provider/model identifier bound before resuming a session.",
      }),
    ),
  },
  {
    title: "SpawnRequest",
    description:
      "A launch request. A linked-host start uses the daemon's own provider credentials; a pure join starts nothing.",
  },
);
export type SpawnRequest = Static<typeof SpawnRequestSchema>;

export const OpenChannelRequestSchema = Type.Object(
  {
    sessionId: Type.Union([Type.String(), Type.Null()]),
    launch: SpawnRequestSchema,
    replaceAdvisor: Type.Optional(Type.Boolean()),
    preparing: Type.Optional(
      Type.Boolean({
        description:
          "Protect this channel while a submitted command is being prepared.",
      }),
    ),
    expectedChannel: Type.Optional(
      Type.String({
        description:
          "Rejoin only this channel; prevents adopting an unrelated replacement.",
      }),
    ),
  },
  {
    title: "OpenChannelRequest",
    description:
      "Join an existing daemon-owned session, or start it if no process owns it. Membership, not WebSocket lifetime, controls interest.",
  },
);
export type OpenChannelRequest = Static<typeof OpenChannelRequestSchema>;

export const OpenChannelResultSchema = Type.Object(
  {
    ch: Type.String(),
    joined: Type.Boolean(),
    pending: Type.Union([Type.Array(Type.String()), Type.Null()], {
      description:
        "Still-open blocking runner request lines, or null when the snapshot exceeded the pending byte cap.",
    }),
    streaming: Type.Union([Type.String(), Type.Null()], {
      description: "Whole current streaming frame for reconnect hydration.",
    }),
    cwd: Type.String(),
    fellBack: Type.Boolean(),
    launchAdvisor: Type.Boolean(),
    advisorSpawned: Type.Boolean(),
    autoApproveExtension: Type.Boolean(),
    continuous: Type.Optional(
      Type.Boolean({
        description:
          "The opening link remained a member and has already received the repeated streaming lines.",
      }),
    ),
  },
  {
    title: "OpenChannelResult",
    description:
      "Authoritative channel identity and hydration snapshot returned only after runner startup is ready.",
  },
);
export type OpenChannelResult = Static<typeof OpenChannelResultSchema>;

export const UploadStartArgsSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    attempt: Type.String({
      format: "uuid",
      description:
        "New generation for this start; acknowledgements echo it so stale attempts cannot advance the upload.",
    }),
    name: Type.String({ minLength: 1, maxLength: 4096 }),
    size: Type.Integer({ minimum: 0, maximum: 2 * 1024 * 1024 * 1024 }),
    type: Type.String({ maxLength: 255 }),
  },
  {
    title: "UploadStartArgs",
    description:
      "Generation-bound staged upload declaration; the same upload ID must retain its name, type and size.",
  },
);
export const UploadStartResultSchema = Type.Object(
  { received: Type.Integer({ minimum: 0 }), done: Type.Boolean() },
  {
    title: "UploadStartResult",
    description:
      "The acknowledged resume offset. A completed upload still requires the retained file generation to exist.",
  },
);
export const UploadAttachArgsSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    sessionFile: Type.String(),
    sessionId: Type.String(),
  },
  {
    title: "UploadAttachArgs",
    description:
      "Identify the completed upload and its destination session on the owning daemon.",
  },
);
export const UploadAttachResultSchema = Type.Object(
  { path: Type.String(), url: Type.String() },
  {
    title: "UploadAttachResult",
    description:
      "Attachment path and local:// URL on the owning daemon; the same upload generation is idempotent.",
  },
);

export const StageHostArtifactArgsSchema = Type.Object(
  {
    id: Type.String({
      pattern: UPLOAD_ID_RE.source,
      description: "UUID of the completed upload on the selected daemon.",
    }),
  },
  {
    additionalProperties: false,
    description:
      "Stage a completed upload for manual installation on its host.",
  },
);
export type StageHostArtifactArgs = Static<typeof StageHostArtifactArgsSchema>;

export const StageHostArtifactResultSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Absolute path on the selected host, not on the web server.",
    }),
  },
  {
    description:
      "Confirms the daemon staged the file without installing or running it.",
  },
);
export type StageHostArtifactResult = Static<
  typeof StageHostArtifactResultSchema
>;

const operationId = Type.String({
  pattern: UPLOAD_ID_RE.source,
  description:
    "Operator action ID used to read the outcome across restart. Reusing it cannot start a second install.",
});

export const ActivateHostArtifactArgsSchema = Type.Object(
  {
    artifactId: Type.String({
      pattern: UPLOAD_ID_RE.source,
      description:
        "ID from a successful staging operation on this daemon and server link.",
    }),
    operationId,
    target: Type.Union([Type.Literal("keylime"), Type.Literal("keylime-omp")], {
      description: "The installed standalone executable to replace.",
    }),
    sha256: Type.String({
      pattern: "^[0-9a-f]{64}$",
      description:
        "Expected SHA-256 of the exact binary from a trusted source, in lowercase hex.",
    }),
    runner: Type.Optional(
      Type.Object(
        {
          artifactId: Type.String({ pattern: UPLOAD_ID_RE.source }),
          sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        },
        {
          additionalProperties: false,
          description:
            "Matching staged runner to install with target keylime before one restart.",
        },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      "An explicit standalone host activation request; contains no filesystem path.",
  },
);
export type ActivateHostArtifactArgs = Static<
  typeof ActivateHostArtifactArgsSchema
>;

export const HostArtifactActivationArgsSchema = Type.Object(
  { operationId },
  {
    additionalProperties: false,
    description: "Read an activation previously sent to this daemon.",
  },
);
export type HostArtifactActivationArgs = Static<
  typeof HostArtifactActivationArgsSchema
>;

export const HostArtifactActivationResultSchema = Type.Object(
  {
    state: Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("succeeded"),
        Type.Literal("failed"),
      ],
      {
        description:
          "Pending is not confirmation; succeeded requires the replacement service to start.",
      },
    ),
    backup: Type.Optional(
      Type.String({
        description:
          "Path to the retained backup on the daemon; omitted before a backup exists.",
      }),
    ),
    runnerBackup: Type.Optional(
      Type.String({
        description:
          "Path to the retained runner backup for a paired deployment, omitted if no runner was backed up.",
      }),
    ),
    error: Type.Optional(
      Type.String({ description: "Reason for a known failure." }),
    ),
  },
  {
    description:
      "Daemon-owned activation state, readable through the original link after restarting.",
  },
);
export type HostArtifactActivationResult = Static<
  typeof HostArtifactActivationResultSchema
>;

export const HostInstalledBinaryDigestsSchema = Type.Object(
  {
    keylime: Type.String({
      pattern: "^[0-9a-f]{64}$",
      description:
        "SHA-256 of the installed standalone Keylime daemon, in lowercase hex.",
    }),
    runner: Type.Union(
      [Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.Null()],
      {
        description:
          "SHA-256 of the installed standalone runner, in lowercase hex, or null if the runner is absent.",
      },
    ),
  },
  {
    additionalProperties: false,
    description:
      "Digests of the two managed binaries read on the selected standalone host.",
  },
);
export type HostInstalledBinaryDigests = Static<
  typeof HostInstalledBinaryDigestsSchema
>;

export const HostReleaseListSchema = Type.Object(
  {
    releases: Type.Array(
      Type.Object({
        id: Type.String({ description: "Opaque build ID, not a path." }),
        builtAt: Type.String({
          format: "date-time",
          description: "Build timestamp in UTC.",
        }),
        status: Type.Union(
          [
            Type.Literal("installed"),
            Type.Literal("different"),
            Type.Literal("unverified"),
            Type.Literal("unknown"),
          ],
          {
            description:
              "Installed means both binaries match byte for byte. Different means at least one differs or the runner is missing. Unverified means the daemon cannot report digests; an operator may still deploy. Unknown means a comparison failed and deployment is blocked.",
          },
        ),
      }),
      {
        description:
          "Complete daemon and runner pairs for this host, newest first.",
      },
    ),
  },
  {
    description:
      "Release picker options from the web server's complete builds for the selected daemon.",
  },
);
export type HostReleaseList = Static<typeof HostReleaseListSchema>;

export const DeployHostReleaseArgsSchema = Type.Object(
  {
    releaseId: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "ID selected from the host's release list.",
    }),
    operationId,
  },
  {
    additionalProperties: false,
    description:
      "Deploy the selected server build's matched daemon and runner.",
  },
);
export type DeployHostReleaseArgs = Static<typeof DeployHostReleaseArgsSchema>;

const releaseTransferBytes = Type.Object({
  received: Type.Integer({
    minimum: 0,
    description:
      "Cumulative bytes acknowledged by the target host across both binaries.",
  }),
  total: Type.Integer({
    minimum: 1,
    description: "Combined size in bytes of the two opened binaries.",
  }),
});
export const HostReleaseDeployFrameSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal("transfer"),
        bytes: Type.Optional(releaseTransferBytes),
      },
      {
        description:
          "Transfer is active. Until byte counts are known, bytes is omitted.",
      },
    ),
    Type.Object(
      { type: Type.Literal("installing") },
      {
        description: "Both binaries are staged; activation is being requested.",
      },
    ),
    Type.Object({
      type: Type.Literal("result"),
      result: HostArtifactActivationResultSchema,
    }),
    Type.Object({
      type: Type.Literal("error"),
      status: Type.Integer({
        description:
          "HTTP error status the operation would have returned before streaming began.",
      }),
      code: Type.String(),
      error: Type.String(),
    }),
  ],
  {
    description:
      "Ordered release deployment updates. Result and error are terminal stream frames. A pending result or missing terminal frame requires status lookup by operation ID.",
  },
);
export type HostReleaseDeployFrame = Static<
  typeof HostReleaseDeployFrameSchema
>;
