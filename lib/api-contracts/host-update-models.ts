import { Type } from "@sinclair/typebox";

const nullableString = (description: string) =>
  Type.Union([Type.String(), Type.Null()], { description });
export const HostUpdateTargetSchema = Type.Literal("ompweb", {
  description: "The daemon software target supported for new updates.",
});
export const HostUpdateCompatibilitySchema = Type.Object(
  {
    min: Type.Number({
      description: "Oldest supported daemon link protocol version.",
    }),
    max: Type.Number({
      description: "Newest supported daemon link protocol version.",
    }),
  },
  { description: "The web server's supported daemon protocol range." },
);
export const HostSoftwareUpdateSchema = Type.Object(
  {
    currentVersion: nullableString(
      "Installed version, or null when unavailable.",
    ),
    availableVersion: nullableString(
      "Available release version, or null when unknown.",
    ),
    updateAvailable: Type.Boolean({
      description: "Whether a newer release is available.",
    }),
    canUpdate: Type.Boolean({
      description:
        "Whether the daemon can safely install the available release.",
    }),
    blockedReason: Type.Union([Type.String(), Type.Null()], {
      description: "Human-readable reason installation is blocked, or null.",
    }),
    updateCommand: Type.String({
      description: "Manual update command or release URL.",
    }),
  },
  {
    description:
      "Update availability and installation eligibility for host software.",
  },
);
export const HostUpdateOperationSchema = Type.Object(
  {
    id: Type.String({
      description: "Identifier of the daemon update operation.",
    }),
    target: Type.Union(
      [
        HostUpdateTargetSchema,
        Type.Literal("omp", { description: "A legacy omp update." }),
      ],
      {
        description:
          "Software targeted by this operation; omp is retained for legacy status.",
      },
    ),
    version: Type.String({
      description: "Release version requested for installation.",
    }),
    state: Type.Union(
      [
        Type.Literal("running"),
        Type.Literal("succeeded"),
        Type.Literal("failed"),
      ],
      { description: "Current operation state." },
    ),
    error: Type.Optional(
      Type.String({
        description: "Failure detail when reported by the daemon.",
      }),
    ),
  },
  { description: "Status of a daemon software update operation." },
);
export const HostUpdateInfoSchema = Type.Object(
  {
    ompweb: Type.Intersect(
      [
        HostSoftwareUpdateSchema,
        Type.Object({
          installMethod: Type.Union(
            [Type.Literal("bun"), Type.Literal("binary")],
            {
              description: "How the host daemon is installed.",
            },
          ),
          protocolVersion: Type.Union([Type.Number(), Type.Null()], {
            description:
              "Candidate release link protocol version, or null when unverified.",
          }),
        }),
      ],
      {
        description:
          "Daemon update status and candidate compatibility details.",
      },
    ),
    omp: Type.Object(
      {
        currentVersion: nullableString(
          "Installed omp version, or null when unavailable.",
        ),
      },
      { description: "Installed omp version; omp is not a new update target." },
    ),
    operation: Type.Union([HostUpdateOperationSchema, Type.Null()], {
      description:
        "Most recent daemon update operation, or null when none is reported.",
    }),
  },
  {
    description: "Software update status reported by the selected host daemon.",
  },
);
