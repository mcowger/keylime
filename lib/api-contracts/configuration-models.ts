import { Type, type Static } from "@sinclair/typebox";

type CompactionMethod = Static<typeof CompactionMethodSchema>;
const CompactionMethodSchema = Type.Union([
  Type.Literal("remote"),
  Type.Literal("snapcompact"),
  Type.Literal("handoff"),
  Type.Literal("soft"),
  Type.Literal("shake"),
]);

export type SkillSearchResult = Static<typeof SkillSearchResultSchema>;
export const SkillSearchResultSchema = Type.Object(
  {
    package: Type.String({
      description: "Catalog package identifier, generally source@skill.",
    }),
    installs: Type.String({
      description:
        "Human-readable approximate install count; empty when unavailable.",
    }),
    url: Type.String({
      description: "Catalog page URL, or an empty string when unavailable.",
    }),
  },
  {
    description:
      "A remote skills search hit; install count is display text rather than an exact numeric count.",
  },
);

export type SkillInstallScope = Static<typeof SkillInstallScopeSchema>;
export const SkillInstallScopeSchema = Type.Union(
  [Type.Literal("global"), Type.Literal("project")],
  {
    description:
      "Installation target: user-wide global directory or a specific project directory.",
  },
);

export type SkillInstallInfo = Static<typeof SkillInstallInfoSchema>;
export const SkillInstallInfoSchema = Type.Object(
  {
    package: Type.String(),
    scope: SkillInstallScopeSchema,
    source: Type.String(),
    sourceType: Type.Optional(Type.String()),
    skillsShUrl: Type.Optional(Type.String()),
    skillPath: Type.Optional(
      Type.String({ description: "Local installed skill path, when known." }),
    ),
    ref: Type.Optional(
      Type.String({
        description: "Source revision or reference used by this installation.",
      }),
    ),
    versionHash: Type.Optional(
      Type.String({
        description:
          "Recorded installed source revision used for update checks.",
      }),
    ),
    canCheckForUpdates: Type.Boolean(),
  },
  {
    description:
      "Provenance and update capability of an installed skill; optional source details are omitted when unavailable.",
  },
);

export type SkillUpdateState = Static<typeof SkillUpdateStateSchema>;
export const SkillUpdateStateSchema = Type.Union(
  [
    Type.Literal("up-to-date"),
    Type.Literal("update-available"),
    Type.Literal("unsupported"),
    Type.Literal("error"),
  ],
  {
    description:
      "Outcome of comparing an installed skill with its upstream source.",
  },
);

export type SkillUpdateResult = Static<typeof SkillUpdateResultSchema>;
export const SkillUpdateResultSchema = Type.Object(
  {
    package: Type.String(),
    scope: SkillInstallScopeSchema,
    state: SkillUpdateStateSchema,
    currentVersion: Type.Optional(Type.String()),
    latestVersion: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  },
  {
    description:
      "Update check result for one package and installation scope; versions are omitted when unknown.",
  },
);

/** Skill discovery describes server-local paths; only user-owned roots can be toggled. */
export type SkillInfo = Static<typeof SkillInfoSchema>;
export const SkillInfoSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    filePath: Type.String({
      description:
        "Local SKILL.md path; PATCH is allowed only for writable roots.",
    }),
    baseDir: Type.String({
      description: "Local directory containing the discovered skill.",
    }),
    disableModelInvocation: Type.Boolean({
      description:
        "Whether skill frontmatter prevents automatic model invocation.",
    }),
    sourceInfo: Type.Object({
      source: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
    }),
    install: Type.Optional(SkillInstallInfoSchema),
    togglable: Type.Optional(
      Type.Boolean({
        description: "False for skills outside user-owned writable roots.",
      }),
    ),
  },
  {
    description:
      "Discovered local skill and its writable-toggle eligibility; install metadata is absent for unmanaged skills.",
  },
);

export type PluginScope = Static<typeof PluginScopeSchema>;
export const PluginScopeSchema = Type.Union(
  [Type.Literal("global"), Type.Literal("project")],
  {
    description:
      "Plugin installation target: global user configuration or project configuration.",
  },
);

export type PluginResourceKind = Static<typeof PluginResourceKindSchema>;
export const PluginResourceKindSchema = Type.Union(
  [
    Type.Literal("extension"),
    Type.Literal("skill"),
    Type.Literal("prompt"),
    Type.Literal("theme"),
  ],
  { description: "Kind of resource contributed by a plugin package." },
);

export type PluginResourceCounts = Static<typeof PluginResourceCountsSchema>;
export const PluginResourceCountsSchema = Type.Object(
  {
    extensions: Type.Number(),
    skills: Type.Number(),
    prompts: Type.Number(),
    themes: Type.Number(),
  },
  { description: "Counts of discovered plugin resources by kind." },
);

export type PluginDiagnostic = Static<typeof PluginDiagnosticSchema>;
export const PluginDiagnosticSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
    message: Type.String(),
    source: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
  },
  {
    description:
      "A warning or error encountered while listing plugin packages, optionally tied to a source or local path.",
  },
);

export type PluginResourceInfo = Static<typeof PluginResourceInfoSchema>;
export const PluginResourceInfoSchema = Type.Object(
  {
    kind: PluginResourceKindSchema,
    name: Type.String(),
    path: Type.String(),
    relativePath: Type.String(),
  },
  {
    description:
      "A discovered plugin resource with local absolute and package-relative paths.",
  },
);

export type PluginPackageInfo = Static<typeof PluginPackageInfoSchema>;
export const PluginPackageInfoSchema = Type.Object(
  {
    source: Type.String(),
    scope: PluginScopeSchema,
    filtered: Type.Boolean(),
    disabled: Type.Boolean(),
    installedPath: Type.Optional(Type.String()),
    packageName: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    configuredVersion: Type.Optional(Type.String()),
    counts: PluginResourceCountsSchema,
    resources: Type.Array(PluginResourceInfoSchema),
    status: Type.Union([
      Type.Literal("loaded"),
      Type.Literal("installed"),
      Type.Literal("missing"),
      Type.Literal("disabled"),
    ]),
  },
  {
    description:
      "Local plugin package inventory including source, scope, enabled state and discovered resources.",
  },
);

export type PluginsResponse = Static<typeof PluginsResponseSchema>;
export const PluginsResponseSchema = Type.Object(
  {
    packages: Type.Array(PluginPackageInfoSchema),
    totals: PluginResourceCountsSchema,
    diagnostics: Type.Array(PluginDiagnosticSchema),
  },
  {
    description:
      "Plugin inventory snapshot with aggregate resource counts and diagnostics.",
  },
);

export type ProviderUsageWindowId = Static<typeof ProviderUsageWindowIdSchema>;
export const ProviderUsageWindowIdSchema = Type.Union(
  [Type.Literal("5h"), Type.Literal("7d"), Type.Literal("monthly")],
  {
    description:
      "Provider quota reporting window identifier: five hours, seven days or monthly.",
  },
);

export type ProviderUsageWindow = Static<typeof ProviderUsageWindowSchema>;
export const ProviderUsageWindowSchema = Type.Object(
  {
    percent: Type.Number({
      description: "Percentage of the quota window used.",
    }),
    resetMinutes: Type.Optional(
      Type.Number({
        description:
          "Minutes until the quota window resets, when supplied by the provider.",
      }),
    ),
    resetHours: Type.Optional(
      Type.Number({
        description:
          "Hours until the quota window resets, when supplied by the provider.",
      }),
    ),
  },
  {
    description:
      "Quota utilization percentage and optional remaining reset time in minutes or hours.",
  },
);

export type ProviderUsageReport = Static<typeof ProviderUsageReportSchema>;
export const ProviderUsageReportSchema = Type.Object(
  {
    provider: Type.String(),
    accountLabel: Type.Optional(Type.String()),
    accountIndex: Type.Optional(Type.Number()),
    plan: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    tier: Type.Optional(Type.String()),
    bucket: Type.Optional(
      Type.String({
        description:
          "Human-readable quota bucket for providers with backend-specific counters.",
      }),
    ),
    noLimits: Type.Optional(Type.Boolean()),
    fiveHour: Type.Optional(ProviderUsageWindowSchema),
    sevenDay: Type.Optional(ProviderUsageWindowSchema),
    monthly: Type.Optional(ProviderUsageWindowSchema),
  },
  {
    description:
      "Provider-reported quota windows for an account or model; unavailable dimensions are omitted.",
  },
);

/** An omp usage snapshot may omit generation time and individual quota windows. */
export type ProviderUsageSnapshot = Static<typeof ProviderUsageSnapshotSchema>;
export const ProviderUsageSnapshotSchema = Type.Object(
  {
    generatedAt: Type.Union([Type.Number(), Type.Null()], {
      description:
        "Generation timestamp reported by omp, or null when unavailable.",
    }),
    reports: Type.Array(ProviderUsageReportSchema),
  },
  {
    description:
      "Cached provider usage snapshot; generatedAt is null when no snapshot has been generated.",
  },
);

export type ProviderUsageContext = Static<typeof ProviderUsageContextSchema>;
export const ProviderUsageContextSchema = Type.Object(
  {
    provider: Type.String(),
    modelId: Type.String(),
  },
  { description: "Provider and model identity used to select usage context." },
);

export type ModelsData = Static<typeof ModelsDataSchema>;
export const ModelsDataSchema = Type.Object(
  {
    models: Type.Record(Type.String(), Type.String()),
    modelList: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        provider: Type.String(),
        thinkingLevels: Type.Optional(Type.Array(Type.String())),
        contextWindow: Type.Optional(Type.Number()),
        maxTokens: Type.Optional(Type.Number()),
        supportsFastMode: Type.Optional(Type.Boolean()),
        supportsSlowMode: Type.Optional(Type.Boolean()),
      }),
    ),
    defaultModel: Type.Union([
      Type.Object({
        provider: Type.String(),
        modelId: Type.String(),
      }),
      Type.Null(),
    ]),
    thinkingLevels: Type.Record(Type.String(), Type.Array(Type.String())),
    connectedProviders: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          disabled: Type.Boolean(),
        }),
      ),
    ),
    modelError: Type.Optional(Type.String()),
  },
  {
    description:
      "Shared model-cache projection from omp, including resolved default and optional runtime error. The HTTP route adds anthropicSlowMode.",
  },
);

export type ModelThinkingConfig = Static<typeof ModelThinkingConfigSchema>;
export const ModelThinkingConfigSchema = Type.Intersect(
  [
    Type.Record(
      Type.String(),
      Type.Unknown({
        description: "Additional provider-specific thinking settings.",
      }),
    ),
    Type.Object({
      mode: Type.Optional(Type.String()),
      efforts: Type.Optional(Type.Array(Type.String())),
      defaultLevel: Type.Optional(Type.String()),
      effortMap: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
  ],
  {
    description:
      "Provider-specific thinking configuration; unrecognized YAML keys are preserved.",
  },
);

/** Custom YAML model settings preserve provider-specific keys not understood by the editor. */
export type ModelDefinition = Static<typeof ModelDefinitionSchema>;
export const ModelDefinitionSchema = Type.Intersect(
  [
    Type.Record(
      Type.String(),
      Type.Unknown({
        description: "Additional model configuration preserved from YAML.",
      }),
    ),
    Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      api: Type.Optional(Type.String()),
      baseUrl: Type.Optional(Type.String()),
      reasoning: Type.Optional(Type.Boolean()),
      thinking: Type.Optional(ModelThinkingConfigSchema),
      input: Type.Optional(Type.Array(Type.String())),
      contextWindow: Type.Optional(
        Type.Number({ description: "Model context window in tokens." }),
      ),
      maxTokens: Type.Optional(
        Type.Number({ description: "Maximum output tokens." }),
      ),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      cost: Type.Optional(
        Type.Object({
          input: Type.Optional(
            Type.Number({ description: "Input cost per million tokens." }),
          ),
          output: Type.Optional(
            Type.Number({ description: "Output cost per million tokens." }),
          ),
          cacheRead: Type.Optional(
            Type.Number({ description: "Cache-read cost per million tokens." }),
          ),
          cacheWrite: Type.Optional(
            Type.Number({
              description: "Cache-write cost per million tokens.",
            }),
          ),
        }),
      ),
      compat: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Unknown({
            description: "Provider-specific compatibility setting.",
          }),
        ),
      ),
    }),
  ],
  {
    description:
      "A custom model definition in models.yml; unspecified settings inherit provider or runtime defaults and extra YAML keys are preserved.",
  },
);

/** Provider configuration can contain credentials; treat values as sensitive when editing. */
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
export const ProviderConfigSchema = Type.Intersect(
  [
    Type.Record(
      Type.String(),
      Type.Unknown({
        description: "Additional provider configuration preserved from YAML.",
      }),
    ),
    Type.Object({
      baseUrl: Type.Optional(Type.String()),
      apiKey: Type.Optional(
        Type.String({
          description:
            "Credential; avoid exposing or including this value in examples.",
        }),
      ),
      api: Type.Optional(Type.String()),
      auth: Type.Optional(
        Type.Union([
          Type.Literal("apiKey"),
          Type.Literal("none"),
          Type.Literal("oauth"),
        ]),
      ),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      compat: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Unknown({
            description: "Provider-specific compatibility setting.",
          }),
        ),
      ),
      models: Type.Optional(Type.Array(ModelDefinitionSchema)),
      modelOverrides: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Unknown({ description: "Provider-specific model override." }),
        ),
      ),
    }),
  ],
  {
    description:
      "Custom provider configuration in models.yml, including optional credentials and model definitions; extra YAML keys are preserved.",
  },
);

/** User-wide models.yml data, independent of a selected project workspace. */
export type ModelsFileConfig = Static<typeof ModelsFileConfigSchema>;
export const ModelsFileConfigSchema = Type.Intersect(
  [
    Type.Record(
      Type.String(),
      Type.Unknown({
        description: "Additional configuration preserved from YAML.",
      }),
    ),
    Type.Object({
      providers: Type.Optional(
        Type.Record(Type.String(), ProviderConfigSchema),
      ),
    }),
  ],
  {
    description:
      "User models.yml configuration; provider IDs key the optional providers map and unrelated YAML keys are preserved.",
  },
);

export type ModelCatalogCost = Static<typeof ModelCatalogCostSchema>;
export const ModelCatalogCostSchema = Type.Object(
  {
    input: Type.Optional(
      Type.Number({ description: "Input cost per million tokens." }),
    ),
    output: Type.Optional(
      Type.Number({ description: "Output cost per million tokens." }),
    ),
    cacheRead: Type.Optional(
      Type.Number({ description: "Cache-read cost per million tokens." }),
    ),
    cacheWrite: Type.Optional(
      Type.Number({ description: "Cache-write cost per million tokens." }),
    ),
  },
  {
    description:
      "Optional model pricing components from the catalog; missing components are not zero prices.",
  },
);

export type CompleteModelCatalogCost = Static<
  typeof CompleteModelCatalogCostSchema
>;
export const CompleteModelCatalogCostSchema = Type.Required(
  ModelCatalogCostSchema,
  {
    description:
      "Catalog price with all input, output, cache-read and cache-write components present.",
  },
);

export type ModelCatalogEntry = Static<typeof ModelCatalogEntrySchema>;
export const ModelCatalogEntrySchema = Type.Object(
  {
    key: Type.String(),
    providerId: Type.String(),
    providerName: Type.String(),
    providerBaseUrl: Type.Optional(Type.String()),
    id: Type.String(),
    name: Type.String(),
    reasoning: Type.Optional(Type.Boolean()),
    input: Type.Optional(Type.Array(Type.String())),
    contextWindow: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Number()),
    cost: ModelCatalogCostSchema,
  },
  {
    description:
      "A models.dev catalog model and provider metadata; optional capabilities and prices may be absent.",
  },
);

export type ModelCatalogPreset = Static<typeof ModelCatalogPresetSchema>;
export const ModelCatalogPresetSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    reasoning: Type.Optional(Type.Boolean()),
    input: Type.Optional(Type.Array(Type.String())),
    contextWindow: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Number()),
    cost: Type.Optional(CompleteModelCatalogCostSchema),
  },
  {
    description:
      "Suggested model configuration derived from catalog metadata; omitted fields have no recommendation.",
  },
);

export type ModelCatalogMatchMethod = Static<
  typeof ModelCatalogMatchMethodSchema
>;
export const ModelCatalogMatchMethodSchema = Type.Union(
  [
    Type.Literal("provider"),
    Type.Literal("base-url"),
    Type.Literal("consensus"),
    Type.Literal("none"),
  ],
  {
    description:
      "How a catalog recommendation selected metadata: provider, base URL, consensus or no match.",
  },
);

export type ModelCatalogPriceRecommendation = Static<
  typeof ModelCatalogPriceRecommendationSchema
>;
export const ModelCatalogPriceRecommendationSchema = Type.Union(
  [
    Type.Object({
      status: Type.Literal("reliable"),
      method: Type.Exclude(ModelCatalogMatchMethodSchema, Type.Literal("none")),
      cost: CompleteModelCatalogCostSchema,
      providerId: Type.Optional(Type.String()),
      providerName: Type.Optional(Type.String()),
      support: Type.Number(),
      total: Type.Number(),
    }),
    Type.Object({
      status: Type.Literal("unreliable"),
      reason: Type.Union([
        Type.Literal("no-exact-match"),
        Type.Literal("no-valid-price"),
        Type.Literal("insufficient-support"),
        Type.Literal("conflict"),
      ]),
      support: Type.Number(),
      total: Type.Number(),
    }),
  ],
  {
    description:
      "Price recommendation with complete cost when reliable, or an explicit reason and support counts when unreliable.",
  },
);

export type ModelCatalogRecommendation = Static<
  typeof ModelCatalogRecommendationSchema
>;
export const ModelCatalogRecommendationSchema = Type.Object(
  {
    exactMatches: Type.Number(),
    metadataMethod: ModelCatalogMatchMethodSchema,
    matchedProviderId: Type.Optional(Type.String()),
    matchedProviderName: Type.Optional(Type.String()),
    preset: ModelCatalogPresetSchema,
    price: ModelCatalogPriceRecommendationSchema,
  },
  {
    description:
      "Catalog recommendation combining exact-match count, metadata provenance, preset and price confidence.",
  },
);

export type AgentSource = Static<typeof AgentSourceSchema>;
export const AgentSourceSchema = Type.Union(
  [Type.Literal("bundled"), Type.Literal("user"), Type.Literal("project")],
  { description: "Origin of an agent definition: bundled, user or project." },
);

export type AgentInfo = Static<typeof AgentInfoSchema>;
export const AgentInfoSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    model: Type.Optional(Type.Array(Type.String())),
    tools: Type.Optional(Type.Array(Type.String())),
    spawns: Type.Optional(
      Type.Union([Type.Array(Type.String()), Type.Literal("*")]),
    ),
    thinkingLevel: Type.Optional(Type.String()),
    output: Type.Optional(
      Type.Unknown({ description: "Extensible agent output configuration." }),
    ),
    blocking: Type.Optional(Type.Boolean()),
    prewalk: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
    advisor: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
    source: AgentSourceSchema,
    scope: Type.Union([
      Type.Literal("user"),
      Type.Literal("project"),
      Type.Literal("bundled"),
    ]),
    filePath: Type.String(),
    valid: Type.Boolean(),
    enabled: Type.Boolean(),
    body: Type.Optional(Type.String()),
    rawFrontmatter: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Unknown({ description: "Extensible agent frontmatter value." }),
      ),
    ),
  },
  {
    description:
      "Discovered agent definition and local source path; body and raw frontmatter are included when available.",
  },
);

export type AgentDiagnostic = Static<typeof AgentDiagnosticSchema>;
export const AgentDiagnosticSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("error"),
      Type.Literal("warning"),
      Type.Literal("info"),
    ]),
    message: Type.String(),
    path: Type.Optional(Type.String()),
  },
  {
    description:
      "Agent discovery diagnostic with severity and optional local file path.",
  },
);

/** The native settings editor operates on user configuration, not browser preferences. */
export type NativeSettings = Static<typeof NativeSettingsSchema>;
export const NativeSettingsSchema = Type.Object(
  {
    defaultThinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    providers: Type.Optional(
      Type.Object({
        autoThinkingSource: Type.Optional(
          Type.Union([Type.Literal("classifier"), Type.Literal("vendor")]),
        ),
      }),
    ),
    hideThinkingBlock: Type.Optional(Type.Boolean()),
    externalThinking: Type.Optional(Type.Boolean()),
    textVerbosity: Type.Optional(
      Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ]),
    ),
    personality: Type.Optional(
      Type.Union([
        Type.Literal("default"),
        Type.Literal("friendly"),
        Type.Literal("pragmatic"),
        Type.Literal("none"),
      ]),
    ),
    advisor: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        subagents: Type.Optional(Type.Boolean()),
        syncBacklog: Type.Optional(
          Type.Union([
            Type.Literal("off"),
            Type.Literal("1"),
            Type.Literal("3"),
            Type.Literal("5"),
          ]),
        ),
        immuneTurns: Type.Optional(Type.Number()),
      }),
    ),
    tools: Type.Optional(
      Type.Object({
        approvalMode: Type.Optional(
          Type.Union([
            Type.Literal("always-ask"),
            Type.Literal("write"),
            Type.Literal("yolo"),
          ]),
        ),
        approval: Type.Optional(
          Type.Object({
            bash: Type.Optional(
              Type.Union([
                Type.Literal("allow"),
                Type.Literal("prompt"),
                Type.Literal("deny"),
              ]),
            ),
            extension: Type.Optional(
              Type.Union([Type.Literal("allow"), Type.Literal("prompt")]),
            ),
          }),
        ),
      }),
    ),
    enabledModels: Type.Optional(Type.Array(Type.String())),
    disabledProviders: Type.Optional(Type.Array(Type.String())),
    modelProviderOrder: Type.Optional(Type.Array(Type.String())),
    registryHasScopedEntries: Type.Optional(Type.Boolean()),
    retry: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        maxRetries: Type.Optional(Type.Number()),
        modelFallback: Type.Optional(Type.Boolean()),
        fallbackRevertPolicy: Type.Optional(
          Type.Union([Type.Literal("cooldown-expiry"), Type.Literal("never")]),
        ),
        fallbackChains: Type.Optional(
          Type.Record(Type.String(), Type.Array(Type.String())),
        ),
      }),
    ),
    compaction: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        midTurnEnabled: Type.Optional(Type.Boolean()),
        methodOrder: Type.Optional(Type.Array(CompactionMethodSchema)),
        autoContinue: Type.Optional(Type.Boolean()),
        keepRecentTokens: Type.Optional(Type.Number()),
      }),
    ),
    memory: Type.Optional(
      Type.Object({
        backend: Type.Optional(
          Type.Union([
            Type.Literal("off"),
            Type.Literal("local"),
            Type.Literal("mnemopi"),
            Type.Literal("hindsight"),
          ]),
        ),
      }),
    ),
    autolearn: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        autoContinue: Type.Optional(Type.Boolean()),
        minToolCalls: Type.Optional(Type.Number()),
      }),
    ),
    mnemopi: Type.Optional(
      Type.Object({
        scoping: Type.Optional(
          Type.Union([
            Type.Literal("global"),
            Type.Literal("per-project"),
            Type.Literal("per-project-tagged"),
          ]),
        ),
        autoRecall: Type.Optional(Type.Boolean()),
        autoRetain: Type.Optional(Type.Boolean()),
        noEmbeddings: Type.Optional(Type.Boolean()),
      }),
    ),
    mcp: Type.Optional(
      Type.Object({
        enableProjectConfig: Type.Optional(Type.Boolean()),
        renderMarkdownResults: Type.Optional(Type.Boolean()),
        notifications: Type.Optional(Type.Boolean()),
        notificationDebounceMs: Type.Optional(
          Type.Number({
            description: "MCP notification debounce interval in milliseconds.",
          }),
        ),
      }),
    ),
  },
  {
    description:
      "Editable native user settings; optional fields represent omitted configuration rather than explicit null values.",
  },
);

/** Server-wide settings are shared across browsers and do not include browser-local preferences. */
export const WebServerSettingsSchema = Type.Object(
  {
    autoResumeSessions: Type.Boolean({
      description: "Resume sessions interrupted by server shutdown.",
    }),
    agentToolsEnabled: Type.Boolean({
      description: "Enable server-side cross-session agent tools.",
    }),
    agentEnv: Type.Record(Type.String(), Type.String(), {
      description:
        "Validated environment variables for child agents; reserved names are rejected or filtered.",
    }),
    browserTransport: Type.Union([Type.Literal("sse"), Type.Literal("ws")], {
      description:
        "Server-selected browser event transport, shared across connected clients.",
    }),
    uploadRetentionDays: Type.Union([Type.Number(), Type.Null()], {
      description:
        "Days to retain sent uploads; null retains them indefinitely.",
    }),
  },
  {
    description:
      "Persisted web-server settings shared by clients, separate from browser-local preferences.",
  },
);
export type WebServerSettings = Static<typeof WebServerSettingsSchema>;

export const McpLiveStatusSchema = Type.Union(
  [
    Type.Literal("connected"),
    Type.Literal("connecting"),
    Type.Literal("not_connected"),
    Type.Literal("inactive"),
    Type.Literal("disabled"),
    Type.Literal("configured"),
  ],
  {
    description:
      "Observed or configured MCP server state; configured does not imply a live connection.",
  },
);
export type McpLiveStatus = Static<typeof McpLiveStatusSchema>;
export const McpLiveServerSchema = Type.Object(
  {
    name: Type.String(),
    source: Type.String(),
    status: McpLiveStatusSchema,
    type: Type.Optional(Type.String()),
    sourcePath: Type.Optional(Type.String()),
  },
  {
    description:
      "MCP inventory entry combining server identity, source and live or configured state; sourcePath is optional.",
  },
);
export type McpLiveServer = Static<typeof McpLiveServerSchema>;
