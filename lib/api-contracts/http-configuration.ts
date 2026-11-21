import type { HttpOperation } from "./operations";
import {
  jsonBody,
  jsonResponse,
  pathParameter,
  queryParameter,
  webErrors,
  webSecurity,
} from "./http-helpers";
import { Type, type TSchema } from "@sinclair/typebox";
import {
  SkillSearchResultSchema as SkillSearchResult,
  SkillInstallScopeSchema as SkillInstallScope,
  SkillUpdateResultSchema as SkillUpdateResult,
  SkillInfoSchema as SkillInfo,
  PluginScopeSchema as PluginScope,
  PluginsResponseSchema as PluginsResponse,
  ProviderUsageSnapshotSchema as ProviderUsageSnapshot,
  ModelDefinitionSchema as ModelDefinition,
  ProviderConfigSchema as ProviderConfig,
  ModelsFileConfigSchema as ModelsFileConfig,
  ModelCatalogEntrySchema as ModelCatalogEntry,
  ModelCatalogRecommendationSchema as ModelCatalogRecommendation,
  AgentInfoSchema as AgentInfo,
  AgentDiagnosticSchema as AgentDiagnostic,
  NativeSettingsSchema as NativeSettings,
  BrowserSettingsSchema as BrowserSettings,
  HostSettingsSchema as HostSettings,
  HostSettingsPatchSchema as HostSettingsPatch,
  HostModelsSchema as HostModels,
  ChatRolesSchema as ChatRoles,
  McpLiveServerSchema as liveServer,
} from "./configuration-models";

const S = Type.String();
const B = Type.Boolean();
const N = Type.Number();
const opt = Type.Optional;
const nullableString = Type.Union([S, Type.Null()]);
const strings = Type.Array(S);
const success = Type.Object({ success: Type.Literal(true) });
const error = (description: string) =>
  jsonResponse(Type.Object({ error: S, code: opt(S) }), description);
const codeError = (codes: string[], description: string) =>
  jsonResponse(
    Type.Object({
      error: S,
      code: Type.Union(codes.map((code) => Type.Literal(code))),
    }),
    description,
  );
const body = (schema: TSchema) => jsonBody(schema);
const query = (
  name: string,
  schema: TSchema = S,
  required = false,
  description?: string,
) => queryParameter(name, schema, required, description);
const providerPath = [pathParameter("provider")];
const scope = Type.Union([Type.Literal("user"), Type.Literal("project")]);
const agentScope = Type.Union([
  Type.Literal("all"),
  Type.Literal("user"),
  Type.Literal("project"),
  Type.Literal("bundled"),
]);
const diagnostic = Type.Object({
  type: Type.Union([
    Type.Literal("error"),
    Type.Literal("warning"),
    Type.Literal("info"),
  ]),
  message: S,
  path: opt(S),
});
const skillsResponse = Type.Object({
  skills: Type.Array(SkillInfo),
  diagnostics: Type.Array(diagnostic),
});
const skillRequest = Type.Object({
  cwd: opt(
    Type.String({
      description:
        "Allowed project workspace path; omit for user-level operations.",
    }),
  ),
  package: S,
  scope: SkillInstallScope,
});
const nativeSettingsResponse = Type.Object({
  path: S,
  settings: NativeSettings,
});
const agentPayload = Type.Object({
  description: S,
  model: opt(Type.Union([S, strings])),
  tools: opt(Type.Union([S, strings])),
  thinkingLevel: opt(S),
  spawns: opt(Type.Union([S, strings])),
  body: opt(S),
  prewalk: opt(Type.Union([B, S])),
  advisor: opt(Type.Union([B, S])),
  output: opt(
    Type.Unknown({ description: "Extensible agent output configuration." }),
  ),
  blocking: opt(B),
  enabled: opt(B),
  existingFrontmatter: opt(
    Type.Record(
      S,
      Type.Unknown({ description: "Extensible agent frontmatter value." }),
    ),
  ),
});
const agentWrite = Type.Object({
  cwd: opt(
    Type.String({
      description:
        "Allowed workspace path, required for project scope and ignored for user scope.",
    }),
  ),
  scope,
  name: Type.String({
    description: "Agent file name within the selected writable scope.",
  }),
  previousName: opt(
    Type.String({
      description: "Existing name to rename, when changing an agent's name.",
    }),
  ),
  agent: agentPayload,
});
const agentWriteResponse = Type.Object({
  success: Type.Literal(true),
  path: S,
  agent: Type.Union([AgentInfo, Type.Null()]),
});
const agentUnpack = Type.Object({
  success: Type.Literal(true),
  targetDir: S,
  total: N,
  written: N,
  skipped: N,
});
const mcpServer = Type.Object(
  {
    type: opt(S),
    command: opt(
      Type.String({
        description:
          "Executable for stdio transport; mutually exclusive with url.",
      }),
    ),
    args: opt(strings),
    url: opt(
      Type.String({
        description: "HTTP or SSE endpoint; mutually exclusive with command.",
      }),
    ),
    enabled: opt(B),
    env: opt(
      Type.Record(S, S, {
        description: "Child environment; omitted from project read responses.",
      }),
    ),
    headers: opt(
      Type.Record(S, S, {
        description:
          "HTTP headers, potentially containing credentials; omitted from project read responses.",
      }),
    ),
  },
  {
    additionalProperties: Type.Unknown({
      description: "Additional provider-specific MCP configuration.",
    }),
    description:
      "MCP configuration. Project GET redacts env and headers; user GET exposes only status, never raw configuration.",
  },
);
const mcpResponse = Type.Object({
  root: nullableString,
  path: nullableString,
  exists: B,
  servers: Type.Array(
    Type.Object({
      name: S,
      config: Type.Omit(mcpServer, ["env", "headers"], {
        description: "Project MCP configuration with env and headers redacted.",
      }),
    }),
  ),
  user: opt(
    Type.Object({
      path: S,
      disabledServers: strings,
      error: opt(S),
      servers: Type.Array(
        Type.Object({
          name: S,
          status: Type.Union([
            Type.Literal("disabled"),
            Type.Literal("configured"),
          ]),
          type: S,
          enabled: B,
          valid: B,
        }),
      ),
    }),
  ),
  inventory: Type.Array(liveServer),
  liveServers: opt(Type.Array(liveServer)),
  liveError: opt(S),
});
const mcpWrite = Type.Object({
  cwd: Type.String({
    description:
      "Allowed local workspace whose project MCP configuration is edited.",
  }),
  name: Type.String({
    description: "Server name within the project MCP configuration.",
  }),
  previousName: opt(
    Type.String({ description: "Existing name to rename, if applicable." }),
  ),
  server: mcpServer,
});
const pathResult = Type.Object({ success: Type.Literal(true), path: S });
const loginEvent = Type.Union(
  [
    Type.Object({
      type: Type.Literal("auth"),
      url: S,
      instructions: nullableString,
      token: Type.String({
        description:
          "Process-local pending-login token, bound to this provider and valid only while the stream remains active.",
      }),
    }),
    Type.Object({
      type: Type.Literal("prompt_request"),
      message: S,
      placeholder: nullableString,
      token: Type.String({
        description:
          "Pending-login token to submit with the authorization response.",
      }),
    }),
    Type.Object({ type: Type.Literal("progress"), message: S }),
    Type.Object({ type: Type.Literal("success") }),
    Type.Object({ type: Type.Literal("error"), message: S }),
    Type.Object({ type: Type.Literal("cancelled") }),
  ],
  {
    description:
      "JSON data frames; comment heartbeats may appear between events.",
  },
);
const apiKeyStatus = Type.Object(
  { provider: S, displayName: S, configured: B, models: N },
  { description: "Status only; actual API keys are never returned." },
);
const testResult = Type.Union([
  Type.Object({ ok: Type.Literal(true), latencyMs: N, responseText: S }),
  Type.Object({
    ok: Type.Literal(false),
    error: S,
    code: opt(S),
    latencyMs: opt(N),
  }),
]);
const op = (
  route: string,
  method: HttpOperation["method"],
  operationId: string,
  summary: string,
  schema: TSchema,
  extra: Partial<HttpOperation> = {},
): HttpOperation => ({
  path: route.replace(/\[([^\]]+)\]/g, "{$1}"),
  route,
  method,
  operationId,
  summary,
  security: webSecurity,
  ...extra,
  responses: Object.fromEntries(
    Object.entries({
      ...webErrors,
      200: jsonResponse(schema),
      ...extra.responses,
    }).filter(([, value]) => value !== undefined),
  ),
});
export const configurationHttpOperations: readonly HttpOperation[] = [
  op(
    "/api/auth/api-key/[provider]",
    "get",
    "getAuthApiKeyProvider",
    "Get provider key status",
    apiKeyStatus,
    {
      parameters: providerPath,
      description:
        "Reports configured state and model count; never returns the key.",
    },
  ),
  op(
    "/api/auth/api-key/[provider]",
    "post",
    "postAuthApiKeyProvider",
    "Store provider API key",
    apiKeyStatus,
    {
      parameters: providerPath,
      description: "Unsupported: omp owns its encrypted credential store.",
      responses: {
        200: undefined,
        501: codeError(
          ["api_key_store_unsupported"],
          "API key storage is unsupported.",
        ),
      },
    },
  ),
  op(
    "/api/auth/api-key/[provider]",
    "delete",
    "deleteAuthApiKeyProvider",
    "Remove provider API key",
    apiKeyStatus,
    {
      parameters: providerPath,
      description: "Unsupported: use omp in a terminal.",
      responses: {
        200: undefined,
        501: codeError(
          ["api_key_remove_unsupported"],
          "API key removal is unsupported.",
        ),
      },
    },
  ),
  op(
    "/api/auth/providers",
    "get",
    "getAuthProviders",
    "List login providers",
    Type.Object({
      providers: Type.Array(
        Type.Object({
          id: S,
          name: S,
          usesCallbackServer: Type.Literal(false),
          loggedIn: B,
        }),
      ),
    }),
    {
      responses: {
        500: jsonResponse(
          Type.Object({ providers: Type.Array(Type.Never()), error: S }),
          "Provider discovery failed.",
        ),
      },
    },
  ),
  op(
    "/api/auth/all-providers",
    "get",
    "getAuthAllProviders",
    "List configured providers",
    Type.Object({
      providers: Type.Array(
        Type.Object({ id: S, displayName: S, configured: B, modelCount: N }),
      ),
    }),
    {
      description:
        "Lists configured non-OAuth, non-custom providers; unconfigured providers cannot be discovered.",
      responses: {
        500: jsonResponse(
          Type.Object({ providers: Type.Array(Type.Never()), error: S }),
          "Provider discovery failed.",
        ),
      },
    },
  ),
  op(
    "/api/auth/accounts/[provider]",
    "get",
    "getAuthAccountsProvider",
    "List stored credential accounts",
    Type.Object({
      supported: Type.Literal(true),
      accounts: Type.Array(
        Type.Object({
          credentialId: N,
          label: S,
          detail: S,
          type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
        }),
      ),
    }),
    {
      parameters: providerPath,
      description: "Labels do not contain raw credentials.",
    },
  ),
  op(
    "/api/auth/accounts/[provider]",
    "delete",
    "deleteAuthAccountsProvider",
    "Remove a stored credential",
    Type.Object({ ok: Type.Literal(true) }),
    {
      parameters: [
        ...providerPath,
        query("credentialId", S, true, "Non-negative integer credential ID."),
      ],
    },
  ),
  op(
    "/api/auth/login/[provider]",
    "get",
    "getAuthLoginProvider",
    "Start interactive provider login",
    loginEvent,
    {
      parameters: providerPath,
      responses: {
        200: {
          description: "Server-sent JSON login events and comment heartbeats.",
          content: { "text/event-stream": { schema: loginEvent } },
        },
      },
    },
  ),
  op(
    "/api/auth/login/[provider]",
    "post",
    "postAuthLoginProvider",
    "Submit login authorization code",
    Type.Object({ ok: Type.Literal(true), provider: S }),
    {
      parameters: providerPath,
      requestBody: body(Type.Object({ token: S, code: S })),
      responses: {
        400: codeError(
          ["login_token_code_required", "login_token_mismatch"],
          "Missing input or provider mismatch.",
        ),
        404: codeError(["login_no_pending"], "Login token is not pending."),
      },
    },
  ),
  op("/api/chat-roles", "get", "getChatRoles", "Resolve workspace chat roles", ChatRoles, {
    parameters: [
      queryParameter("hostId", S, false, "Selected daemon; defaults to local."),
      queryParameter("cwd", S, true, "Absolute workspace directory on the selected daemon."),
      queryParameter("sessionId", S, false, "Existing session; a live runner supplies current thinking state."),
      queryParameter("thinkingLevel", S, false, "Current composer selector for a new or inactive session; ignored for a live runner."),
      queryParameter("currentProvider", S, false, "Current model provider for a new or inactive session; supply with currentModelId. Ignored for a live runner."),
      queryParameter("currentModelId", S, false, "Current model ID for a new or inactive session; supply with currentProvider. Ignored for a live runner."),
    ],
    responses: { 400: error("Invalid workspace directory."), 404: error("Unknown daemon."), 501: error("Daemon does not support chat role discovery."), 503: error("Daemon unavailable.") },
  }),
  op("/api/models", "get", "getModels", "List available models", HostModels, {
    parameters: [
      queryParameter("hostId", S, false, "Selected daemon; defaults to local."),
    ],
    responses: {
      404: error("Unknown daemon."),
      501: codeError(
        ["host_upgrade_required"],
        "Model catalog requires a v14 daemon.",
      ),
      503: error("Daemon unavailable."),
    },
  }),
  op(
    "/api/models",
    "post",
    "refreshModels",
    "Refresh available models",
    HostModels,
    {
      parameters: [
        queryParameter(
          "hostId",
          S,
          false,
          "Selected daemon; defaults to local.",
        ),
      ],
      responses: {
        404: error("Unknown daemon."),
        501: codeError(
          ["host_upgrade_required"],
          "Model catalog requires a v14 daemon.",
        ),
        503: error("Daemon unavailable or model refresh failed."),
      },
    },
  ),
  op(
    "/api/models-config",
    "get",
    "getModelsConfig",
    "Read custom model configuration",
    Type.Union([
      ModelsFileConfig,
      Type.Object({
        providers: Type.Object({}),
        parseError: S,
        path: S,
        code: Type.Literal("models_config_unparseable"),
      }),
    ]),
    {
      description:
        "Configuration may contain credentials; avoid sharing response content.",
    },
  ),
  op(
    "/api/models-config",
    "put",
    "putModelsConfig",
    "Save custom model configuration",
    success,
    {
      parameters: [
        query(
          "overwrite",
          S,
          false,
          "Set to true to replace an unparseable file.",
        ),
      ],
      requestBody: body(ModelsFileConfig),
      responses: {
        409: codeError(
          ["models_config_unparseable"],
          "Existing configuration is unparseable; overwrite was not requested.",
        ),
      },
    },
  ),
  op(
    "/api/models-config/test",
    "post",
    "postModelsConfigTest",
    "Test custom model resolution",
    testResult,
    {
      requestBody: body(
        Type.Object({
          providerName: S,
          provider: ProviderConfig,
          model: ModelDefinition,
        }),
      ),
      description:
        "Runs isolated registry discovery only; no completion or credential contact.",
      responses: {
        400: jsonResponse(
          testResult,
          "Required provider, providerName, model or model ID is missing.",
        ),
        500: jsonResponse(testResult, "Isolated discovery failed."),
      },
    },
  ),
  op(
    "/api/models-config/catalog",
    "get",
    "getModelsConfigCatalog",
    "Search the models.dev catalog",
    Type.Object({
      models: Type.Array(ModelCatalogEntry),
      recommendation: ModelCatalogRecommendation,
      source: S,
    }),
    {
      parameters: [
        query("q"),
        query("provider"),
        query("baseUrl"),
        query("limit"),
      ],
      responses: {
        502: error("Catalog unavailable and no cached data exists."),
      },
    },
  ),
  op(
    "/api/model-roles",
    "get",
    "getModelRoles",
    "Read model roles",
    Type.Object({ path: S, roles: Type.Record(S, S) }),
  ),
  op(
    "/api/model-roles",
    "put",
    "putModelRoles",
    "Save model roles",
    Type.Object({ success: Type.Literal(true), roles: Type.Record(S, S) }),
    { requestBody: body(Type.Object({ roles: Type.Record(S, S) })) },
  ),
  op(
    "/api/providers/enable",
    "post",
    "postProvidersEnable",
    "Enable a provider",
    success,
    { requestBody: body(Type.Object({ provider: S })) },
  ),
  op(
    "/api/provider-usage",
    "get",
    "getProviderUsage",
    "Read provider usage",
    ProviderUsageSnapshot,
    {
      parameters: [query("provider"), query("model"), query("refresh")],
      responses: {
        400: codeError(
          ["invalid_usage_query"],
          "Invalid provider or model identifier.",
        ),
        502: codeError(
          ["provider_usage_unavailable"],
          "Provider usage unavailable.",
        ),
      },
    },
  ),
  op(
    "/api/agents",
    "get",
    "getAgents",
    "List agents",
    Type.Object({
      agents: Type.Array(AgentInfo),
      diagnostics: Type.Array(AgentDiagnostic),
      userPath: S,
      projectPath: nullableString,
      bundledPath: opt(S),
    }),
    { parameters: [query("cwd"), query("scope", agentScope)] },
  ),
  op(
    "/api/agents",
    "post",
    "postAgents",
    "Create or unpack agents",
    Type.Union([agentWriteResponse, agentUnpack]),
    {
      requestBody: body(
        Type.Union([
          agentWrite,
          Type.Object({ action: Type.Literal("unpack"), cwd: opt(S), scope }),
        ]),
      ),
      responses: { 413: error("Agent request is too large.") },
    },
  ),
  op("/api/agents", "put", "putAgents", "Update an agent", agentWriteResponse, {
    requestBody: body(agentWrite),
    responses: { 413: error("Agent request is too large.") },
  }),
  op("/api/agents", "delete", "deleteAgents", "Delete an agent", pathResult, {
    requestBody: body(Type.Object({ cwd: opt(S), scope, name: S })),
    responses: { 413: error("Agent request is too large.") },
  }),
  op(
    "/api/mcp",
    "get",
    "getMcp",
    "List MCP configuration and status",
    mcpResponse,
    {
      parameters: [
        query("cwd"),
        query("sessionId"),
        query("live"),
        query("advisor"),
        query("attach"),
      ],
      description:
        "Attach-only reads omit local configuration and never spawn a session. Project server env and headers are redacted; user servers expose only status and type. Live errors are sanitized.",
    },
  ),
  op("/api/mcp", "post", "postMcp", "Save an MCP server", pathResult, {
    requestBody: body(mcpWrite),
    responses: { 413: error("MCP request is too large.") },
  }),
  op(
    "/api/mcp",
    "put",
    "putMcp",
    "Validate an MCP server",
    Type.Object({ success: Type.Literal(true), message: S }),
    {
      requestBody: body(Type.Object({ name: S, server: mcpServer })),
      responses: { 413: error("MCP request is too large.") },
    },
  ),
  op("/api/mcp", "delete", "deleteMcp", "Delete an MCP server", pathResult, {
    requestBody: body(Type.Object({ cwd: S, name: S })),
    responses: { 413: error("MCP request is too large.") },
  }),
  op("/api/mcp", "patch", "patchMcp", "Change live MCP server state", success, {
    requestBody: body(
      Type.Object({
        sessionId: S,
        action: Type.Union([
          Type.Literal("enable"),
          Type.Literal("disable"),
          Type.Literal("reload"),
        ]),
        name: opt(S),
      }),
    ),
    responses: { 409: error("The session is busy.") },
  }),
  op("/api/plugins", "get", "getPlugins", "List plugins", PluginsResponse, {
    parameters: [query("cwd")],
  }),
  op("/api/plugins", "post", "postPlugins", "Manage plugins", PluginsResponse, {
    requestBody: body(
      Type.Object({
        action: Type.Union([
          Type.Literal("install"),
          Type.Literal("remove"),
          Type.Literal("update"),
          Type.Literal("disable"),
          Type.Literal("enable"),
        ]),
        source: opt(S),
        scope: opt(PluginScope),
        cwd: opt(S),
      }),
    ),
    responses: {
      400: codeError(
        [
          "cwd_required",
          "action_required",
          "source_required",
          "plugin_unsupported_action",
        ],
        "Invalid plugin action or missing argument.",
      ),
      403: codeError(["access_denied"], "Workspace is not allowed."),
    },
  }),
  op("/api/skills", "get", "getSkills", "List skills", skillsResponse, {
    parameters: [query("cwd")],
  }),
  op(
    "/api/skills",
    "patch",
    "patchSkills",
    "Toggle skill model invocation",
    Type.Object({ success: Type.Literal(true), disableModelInvocation: B }),
    {
      requestBody: body(
        Type.Object({ filePath: S, disableModelInvocation: B, cwd: opt(S) }),
      ),
      responses: {
        400: codeError(
          ["file_path_required", "not_a_skill_file"],
          "Invalid skill path.",
        ),
        403: codeError(
          ["access_denied"],
          "Skill path is outside writable roots.",
        ),
        404: codeError(["file_not_found"], "Skill file not found."),
      },
    },
  ),
  op(
    "/api/skills/search",
    "post",
    "postSkillsSearch",
    "Search skills",
    Type.Object({ results: Type.Array(SkillSearchResult) }),
    {
      requestBody: body(Type.Object({ query: S, limit: opt(N) })),
      responses: {
        400: codeError(["query_required"], "A search query is required."),
      },
    },
  ),
  op(
    "/api/skills/install",
    "post",
    "postSkillsInstall",
    "Install a skill package",
    Type.Object({ success: Type.Literal(true), output: S }),
    {
      requestBody: body(
        Type.Object({ package: S, scope: opt(SkillInstallScope), cwd: opt(S) }),
      ),
      responses: {
        400: codeError(
          [
            "package_required",
            "package_invalid",
            "cwd_required_for_project_install",
          ],
          "Invalid installation request.",
        ),
        403: codeError(["access_denied"], "Workspace is not allowed."),
        500: error("Installation failed; code may be skill_install_failed."),
      },
    },
  ),
  op(
    "/api/skills/check",
    "post",
    "postSkillsCheck",
    "Check skill updates",
    Type.Object({ updates: Type.Array(SkillUpdateResult) }),
    {
      requestBody: body(
        Type.Object({
          cwd: opt(S),
          package: opt(S),
          scope: opt(SkillInstallScope),
        }),
      ),
      responses: {
        400: codeError(
          ["package_scope_together", "cwd_required"],
          "Package and scope must be supplied together; project scope requires cwd.",
        ),
        403: codeError(["access_denied"], "Workspace is not allowed."),
        404: codeError(["skill_not_installed"], "Skill is not installed."),
      },
    },
  ),
  op(
    "/api/skills/update",
    "post",
    "postSkillsUpdate",
    "Update a skill package",
    Type.Object({
      success: Type.Literal(true),
      skill: opt(SkillInfo),
      output: S,
    }),
    {
      requestBody: body(skillRequest),
      responses: {
        400: codeError(
          ["cwd_package_scope_required", "skill_update_unsupported"],
          "Required input is missing or this installation cannot be updated.",
        ),
        403: codeError(["access_denied"], "Workspace is not allowed."),
        404: codeError(["skill_not_installed"], "Skill is not installed."),
      },
    },
  ),
  op(
    "/api/omp-settings",
    "get",
    "getOmpSettings",
    "Read native settings",
    nativeSettingsResponse,
    {
      description:
        "Only supported persisted values are returned; omitted fields retain omp defaults.",
    },
  ),
  op(
    "/api/omp-settings",
    "put",
    "putOmpSettings",
    "Save native settings",
    Type.Object({ success: Type.Literal(true), settings: NativeSettings }),
    {
      requestBody: body(Type.Object({ settings: NativeSettings })),
      description:
        "Writes the supported settings allowlist, preserving unrelated configuration.",
    },
  ),
  op(
    "/api/web-settings",
    "get",
    "getWebSettings",
    "Read daemon policy or browser settings",
    Type.Union([HostSettings, BrowserSettings]),
    {
      parameters: [
        queryParameter(
          "hostId",
          S,
          false,
          "Select the daemon; omit for local. Not valid with browser scope.",
        ),
        queryParameter(
          "scope",
          Type.Literal("browser"),
          false,
          "Select web-server browser settings instead of daemon policy.",
        ),
      ],
      responses: {
        400: error("Invalid scope."),
        404: error("Unknown daemon."),
        501: codeError(
          ["host_upgrade_required"],
          "Host policy requires a v14 daemon.",
        ),
        503: error("Daemon unavailable."),
      },
    },
  ),
  op(
    "/api/web-settings",
    "put",
    "putWebSettings",
    "Update daemon policy or browser settings",
    Type.Union([HostSettings, BrowserSettings]),
    {
      parameters: [
        queryParameter(
          "hostId",
          S,
          false,
          "Select the daemon; omit for local. Not valid with browser scope.",
        ),
        queryParameter(
          "scope",
          Type.Literal("browser"),
          false,
          "Select web-server browser settings instead of daemon policy.",
        ),
      ],
      requestBody: body(Type.Union([HostSettingsPatch, BrowserSettings])),
      responses: {
        400: error("Invalid scope or settings patch."),
        404: error("Unknown daemon."),
        501: codeError(
          ["host_upgrade_required"],
          "Host policy requires a v14 daemon.",
        ),
        503: error("Daemon unavailable."),
      },
    },
  ),
];
