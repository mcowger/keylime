import { Type, type Static } from "@sinclair/typebox";
import { CREATION_ID_RE } from "../hosts/creation-identity";

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
    shareCredentials: Type.Optional(
      Type.Literal(true, {
        description: "Use the opening server's provider credentials.",
      }),
    ),
    credentialsServer: Type.Optional(
      Type.String({
        description:
          "Daemon-local recorded credential owner; wire-provided values are ignored and replaced with the opening link's identity.",
      }),
    ),
    configVersion: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{64}$",
        description:
          "Required master configuration content version. Not persisted in resume manifests.",
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
      "A launch request; trusted link context overrides credential-sharing and cluster-configuration authority.",
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
