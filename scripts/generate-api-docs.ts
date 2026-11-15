import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Parser } from "@asyncapi/parser";
import { Kind, type TSchema } from "@sinclair/typebox";
import ts from "typescript";
import Ajv from "ajv";
import type { SocketContract } from "../lib/api-contracts/types";
import { hostLinkContract } from "../lib/api-contracts/host-link";
import { completeBrowserLinkContract } from "../lib/api-contracts/browser-complete";
import { runnerLinkContract } from "../lib/api-contracts/runner-link";
import { hostHttpOperations } from "../lib/api-contracts/host-http";
import { httpOperations } from "../lib/api-contracts/http";
import { hostOperations } from "../lib/api-contracts/host-operations";
import {
  runnerOperations,
  agentOperations,
} from "../lib/api-contracts/runner-messages";
import { browserAgentCommandNames } from "../lib/api-contracts/browser-agent-operations";
import { HOST_OP_NAMES, SESSION_OP_PARAMS } from "../lib/hosts/link-protocol";
import { WORKSPACE_OP_PARAMS } from "../lib/workspace-types";
import {
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_TRUSTED_HEADER,
} from "../lib/web-auth";
import { portableDocument } from "./api-schema";
import {
  assertOperationSemantics,
  handlerSemantics,
  renderSemantics,
  type ContractSemantics,
} from "./api-semantics";
import * as domain from "../lib/api-contracts/domain";
import * as workspace from "../lib/api-contracts/workspace-models";
import * as configuration from "../lib/api-contracts/configuration-models";
import * as host from "../lib/api-contracts/host-schemas";
import * as hostControl from "../lib/api-contracts/host-control-models";
import * as hostUpdates from "../lib/api-contracts/host-update-models";
import * as session from "../lib/api-contracts/host-session-operations";
import * as runner from "../lib/api-contracts/runner-messages";
import * as runnerEvents from "../lib/api-contracts/runner-events";
import * as runnerNativeEvents from "../lib/api-contracts/runner-native-events";
import * as runnerTools from "../lib/api-contracts/runner-tools";
import * as runnerJobs from "../lib/api-contracts/runner-jobs";
import * as browser from "../lib/api-contracts/browser-link";
import * as notifications from "../lib/api-contracts/notification-models";
import * as system from "../lib/api-contracts/http-system";

const root = path.resolve(import.meta.dir, "..");
const outputDirectory = path.join(root, "docs/api");
const generated =
  "Generated from canonical TypeBox schemas, source descriptions and handler annotations. Do not edit; run bun run api:generate.";
const dialect = "http://json-schema.org/draft-07/schema#";
type JsonObject = Record<string, unknown>;

/** Stable output is the contract artifact's drift-check representation. */
export function serializeDocument(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en")),
            )
          : item,
      2,
    ) + "\n"
  );
}

/** Directions describe the serving application, never silently inverted for connecting clients. */
export function socketDocument(contract: SocketContract): JsonObject {
  const schemas: JsonObject = {},
    messages: JsonObject = {},
    operations: JsonObject = {};
  function addMessage(schema: TSchema, correlation?: "id" | "rid"): string {
    const name = schema.title;
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
      throw new Error(
        `${contract.id}: a message schema needs a stable alphanumeric title`,
      );
    if (
      schemas[name] &&
      serializeDocument(schemas[name]) !== serializeDocument(schema)
    )
      throw new Error(
        `${contract.id}: conflicting message schema title ${name}`,
      );
    schemas[name] = schema;
    messages[name] = {
      name,
      title: name,
      description: schema.description,
      contentType:
        schema.format === "binary"
          ? "application/octet-stream"
          : "application/json",
      payload: { $ref: `#/components/schemas/${name}` },
      ...(correlation
        ? { correlationId: { location: `$message.payload#/${correlation}` } }
        : {}),
    };
    return name;
  }
  for (const action of ["send", "receive"] as const) {
    const names = contract[action].map((schema) => addMessage(schema));
    if (new Set(names).size !== names.length)
      throw new Error(`${contract.id}: duplicate ${action} message`);
    operations[action] = {
      action,
      channel: { $ref: "#/channels/link" },
      summary: `${action === "send" ? "Application sends" : "Application receives"} ${contract.title} messages`,
      messages: names.map((name) => ({
        $ref: `#/channels/link/messages/${name}`,
      })),
    };
  }
  for (const exchange of contract.exchanges ?? []) {
    const request = addMessage(exchange.request, exchange.correlation);
    const response = addMessage(exchange.response, exchange.correlation);
    const key = `operation_${exchange.name}`;
    if (operations[key]) throw new Error(`Duplicate exchange ${exchange.name}`);
    operations[key] = {
      action: exchange.action,
      channel: { $ref: "#/channels/link" },
      summary: exchange.name,
      description: exchange.description,
      messages: [{ $ref: `#/channels/link/messages/${request}` }],
      reply: {
        channel: { $ref: "#/channels/link" },
        messages: [{ $ref: `#/channels/link/messages/${response}` }],
      },
    };
  }
  const local = contract.security === "localProcess";
  const securitySchemes = local
    ? {}
    : contract.security === "hostBearer"
      ? {
          hostBearer: {
            type: "http",
            scheme: "bearer",
            description:
              "Host registration token in the HTTP upgrade; never in a channel message.",
          },
        }
      : {
          webSession: {
            type: "httpApiKey",
            in: "cookie",
            name: OMP_WEB_SESSION_COOKIE,
            description:
              "Optional configured web authentication. Open deployments require no cookie; trusted proxies can authenticate the upgrade. Origin checks still apply.",
          },
        };
  return portableDocument({
    asyncapi: "3.0.0",
    id: `urn:keylime:${contract.id}`,
    info: {
      title: contract.title,
      version: String(contract.version),
      description: `${generated}\n\n${contract.description}`,
    },
    defaultContentType: "application/json",
    servers: {
      server: {
        host: local ? "localhost" : "{hostname}",
        protocol: contract.protocol ?? "wss",
        ...(!local
          ? {
              variables: {
                hostname: {
                  default: "localhost:30177",
                  description:
                    "Web-server authority; ws is available only for an explicitly allowed plaintext deployment.",
                },
              },
              security: [
                { $ref: `#/components/securitySchemes/${contract.security}` },
              ],
            }
          : {}),
      },
    },
    channels: {
      link: {
        address: contract.path,
        ...(!local
          ? { bindings: { ws: { method: "GET", bindingVersion: "0.1.0" } } }
          : {}),
        messages: Object.fromEntries(
          Object.keys(messages).map((name) => [
            name,
            { $ref: `#/components/messages/${name}` },
          ]),
        ),
      },
    },
    operations,
    components: { schemas, messages, securitySchemes },
  });
}

function sourceFile(filename: string, content: string): ts.SourceFile {
  return ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
}

/** Verify exhaustive registered route/method bindings without evaluating server modules. */
async function checkHttpCoverage(): Promise<Map<string, ContractSemantics>> {
  const source = sourceFile(
    "routes.ts",
    await Bun.file(path.join(root, "server/routes.ts")).text(),
  );
  const routes = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "ROUTE_MODULES" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties)
        if (
          property.name &&
          (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))
        )
          routes.add(property.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const ids = new Set<string>(),
    bindings = new Set<string>();
  const semantics = new Map<string, ContractSemantics>();
  for (const op of httpOperations) {
    if (ids.has(op.operationId))
      throw new Error(`Duplicate operationId ${op.operationId}`);
    if (!routes.has(op.route.replace(/^\/api\//, "")))
      throw new Error(`Unregistered HTTP contract ${op.route}`);
    ids.add(op.operationId);
  }
  for (const route of routes) {
    const filename = path.join(root, "app/api", route, "route.ts");
    for (const statement of sourceFile(
      filename,
      await Bun.file(filename).text(),
    ).statements) {
      let method: string | undefined;
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        method = statement.name?.text;
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        method =
          statement.declarationList.declarations.length === 1 &&
          ts.isIdentifier(statement.declarationList.declarations[0].name)
            ? statement.declarationList.declarations[0].name.text
            : undefined;
      if (!method || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) continue;
      const tags = ts
        .getJSDocTags(statement)
        .filter((tag) => tag.tagName.text === "apiContract");
      if (!tags.length)
        throw new Error(`Missing @apiContract on /api/${route}:${method}`);
      const sections = handlerSemantics(statement, `/api/${route}:${method}`);
      for (const tag of tags) {
        const text = typeof tag.comment === "string" ? tag.comment.trim() : "";
        for (const id of text.split(/\s+/).filter(Boolean)) {
          const op = httpOperations.find(
            (operation) => operation.operationId === id,
          );
          if (
            !op ||
            op.route !== `/api/${route}` ||
            op.method.toUpperCase() !== method
          )
            throw new Error(`Invalid @apiContract ${id} on ${route}:${method}`);
          if (bindings.has(id)) throw new Error(`Duplicate @apiContract ${id}`);
          bindings.add(id);
          semantics.set(id, sections);
        }
      }
    }
  }
  for (const op of httpOperations)
    if (!bindings.has(op.operationId))
      throw new Error(`No handler annotation for ${op.operationId}`);
  return semantics;
}

function compareInventory(
  label: string,
  expected: readonly string[],
  actual: readonly string[],
): void {
  if (new Set(actual).size !== actual.length)
    throw new Error(`${label}: duplicate contract names`);
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length || extra.length)
    throw new Error(
      `${label}: missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`,
    );
}

/** Source-level registry coverage supplements generated-artifact freshness. */
async function checkMessageCoverage(): Promise<void> {
  for (const [family, operations] of [
    ["Host", hostOperations],
    ["Runner", runnerOperations],
    ["Browser", agentOperations],
  ] as const) {
    for (const operation of operations)
      assertOperationSemantics(
        `${family} operation ${operation.name}`,
        operation.description,
      );
  }
  compareInventory(
    "Host operations",
    HOST_OP_NAMES,
    hostOperations.map((operation) => operation.name),
  );
  for (const [name, params] of Object.entries({
    ...SESSION_OP_PARAMS,
    ...WORKSPACE_OP_PARAMS,
  })) {
    const operation = hostOperations.find((item) => item.name === name)!;
    function hasProperties(schema: TSchema): Set<string> {
      const names = new Set(Object.keys(schema.properties ?? {}));
      for (const choice of schema.anyOf ?? schema.allOf ?? [])
        for (const key of hasProperties(choice)) names.add(key);
      return names;
    }
    compareInventory(
      `${name} argument names`,
      [...params],
      [...hasProperties(operation.args)],
    );
  }
  const declared: string[] = [];
  const emitted = new Set<string>();
  for await (const filename of new Bun.Glob("runner/src/**/*.ts").scan(root)) {
    const source = sourceFile(
      filename,
      await Bun.file(path.join(root, filename)).text(),
    );
    function visit(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /Commands$/.test(node.name.text) &&
        node.name.text !== "commands" &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties)
          if (
            property.name &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name))
          )
            declared.push(property.name.text);
      }
      if (
        ts.isObjectLiteralExpression(node) &&
        ts.isCallExpression(node.parent) &&
        /(?:^send$|\.(?:send|#send|#output)$)/.test(
          node.parent.expression.getText(source),
        )
      ) {
        for (const property of node.properties)
          if (
            ts.isPropertyAssignment(property) &&
            ["t", "type"].includes(property.name.getText(source)) &&
            ts.isStringLiteral(property.initializer)
          )
            emitted.add(property.initializer.text);
      }
      for (const tag of ts.getJSDocTags(node))
        if (
          tag.tagName.text === "apiEvent" &&
          typeof tag.comment === "string"
        ) {
          const name = tag.comment.trim().split(/\s+/)[0];
          if (name) emitted.add(name);
        }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  compareInventory(
    "Runner commands",
    [...new Set(declared)],
    runnerOperations.map((operation) => operation.name),
  );
  const documented = new Set<string>();
  function discriminators(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object")
      for (const field of ["t", "type"]) {
        const schema = (properties as Record<string, unknown>)[field];
        if (
          schema &&
          typeof schema === "object" &&
          "const" in schema &&
          typeof schema.const === "string"
        )
          documented.add(schema.const);
      }
    for (const item of Object.values(record)) discriminators(item);
  }
  discriminators(runnerLinkContract.send);
  discriminators(runnerLinkContract.receive);
  for (const exchange of runnerLinkContract.exchanges ?? []) {
    discriminators(exchange.request);
    discriminators(exchange.response);
  }
  const missingEvents = [...emitted].filter((name) => !documented.has(name));
  if (missingEvents.length)
    throw new Error(
      `Missing runner event/frame schemas: ${missingEvents.join(", ")}`,
    );
  const wrapperSource = sourceFile(
    "rpc-manager.ts",
    await Bun.file(path.join(root, "lib/rpc-manager.ts")).text(),
  );
  const accepted = new Set<string>();
  function visitWrapper(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "PASSTHROUGH_COMMANDS" &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      const list = node.initializer.arguments?.[0];
      if (list && ts.isArrayLiteralExpression(list))
        for (const item of list.elements)
          if (ts.isStringLiteral(item)) accepted.add(item.text);
    }
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(wrapperSource) === "dispatchCommand"
    ) {
      function cases(child: ts.Node): void {
        if (ts.isCaseClause(child) && ts.isStringLiteral(child.expression))
          accepted.add(child.expression.text);
        ts.forEachChild(child, cases);
      }
      cases(node);
    }
    ts.forEachChild(node, visitWrapper);
  }
  visitWrapper(wrapperSource);
  // These deliberately throw unsupported; they are not accepted browser commands.
  for (const name of ["navigate_tree", "clear_queue", "get_tools", "set_tools"])
    accepted.delete(name);
  if (accepted.size)
    compareInventory(
      "Browser command dispatch",
      [...accepted],
      browserAgentCommandNames,
    );
  for (const name of browserAgentCommandNames)
    if (!agentOperations.some((operation) => operation.name === name))
      throw new Error(`Missing browser command ${name}`);
}

export function httpDocument(
  semantics: ReadonlyMap<string, ContractSemantics>,
  operations = httpOperations,
  hostOnly = false,
): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const {
    path: address,
    method,
    route: _route,
    ...operation
  } of operations) {
    const item = (paths[address] ??= {});
    if (item[method])
      throw new Error(`Duplicate HTTP operation ${method} ${address}`);
    const sections = semantics.get(operation.operationId);
    if (!sections)
      throw new Error(
        `Missing source usage contract for ${operation.operationId}`,
      );
    item[method] = {
      ...operation,
      description: `${renderSemantics(sections)}${operation.description ? `\n\n### Additional protocol details\n\n${operation.description}` : ""}`,
      "x-client-semantics": sections,
    };
  }
  return portableDocument({
    openapi: "3.1.0",
    jsonSchemaDialect: dialect,
    info: {
      title: hostOnly ? "Keylime host HTTP API" : "Keylime web HTTP API",
      version: "1.0.0",
      description: `${generated}\n\n${hostOnly ? "Daemon-to-web HTTP endpoints." : "All registered web HTTP endpoints for browser and native clients."} Authentication is optional when not configured; origin, ownership and secret-exclusion policies still apply. HEAD follows GET, OPTIONS reports allowed methods, and missing methods return 405. Streaming media descriptions identify SSE/NDJSON item schemas. WebSocket framing and command exchanges are generated separately as AsyncAPI documents.`,
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        hostBearer: { type: "http", scheme: "bearer" },
        webSession: {
          type: "apiKey",
          in: "cookie",
          name: OMP_WEB_SESSION_COOKIE,
        },
        trustedProxy: {
          type: "apiKey",
          in: "header",
          name: OMP_WEB_TRUSTED_HEADER,
          description:
            "Only a configured trusted proxy should set this header.",
        },
      },
    },
  });
}

function schemaDocument(): JsonObject {
  const definitions: JsonObject = {};
  for (const [prefix, module] of Object.entries({
    domain,
    workspace,
    configuration,
    host,
    hostControl,
    hostUpdates,
    session,
    runner,
    runnerEvents,
    runnerNativeEvents,
    runnerTools,
    runnerJobs,
    browser,
    notifications,
    system,
  })) {
    for (const [name, value] of Object.entries(module)) {
      if (value && typeof value === "object" && Kind in value)
        definitions[`${prefix}_${name.replace(/Schema$/, "")}`] = value;
    }
  }
  for (const [prefix, operations] of [
    ["host", hostOperations],
    ["runner", runnerOperations],
    ["agent", agentOperations],
  ] as const) {
    for (const operation of operations) {
      definitions[`${prefix}_${operation.name}_args`] = operation.args;
      definitions[`${prefix}_${operation.name}_result`] = operation.result;
    }
  }
  return portableDocument({
    $schema: dialect,
    title: "Keylime API schemas",
    description: generated,
    definitions,
  });
}

async function validateDocuments(
  documents: Record<string, JsonObject>,
): Promise<void> {
  for (const [name, document] of Object.entries(documents)) {
    if (name.endsWith(".schema.json")) {
      new Ajv({ strict: false, validateFormats: false }).compile(document);
      continue;
    }
    if (name.endsWith(".openapi.json"))
      await SwaggerParser.validate(JSON.parse(serializeDocument(document)), {
        resolve: { external: false },
      });
    else {
      const result = await new Parser().parse(serializeDocument(document));
      const errors = result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 0,
      );
      if (!result.document || errors.length)
        throw new Error(`${name}: ${JSON.stringify(errors, null, 2)}`);
    }
  }
}

/** Use the pinned runtime's formatter for both emission and comparison, so api:check and format:check agree. */
async function formatArtifact(
  name: string,
  document: JsonObject,
): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      "fmt",
      "--stdin-filepath",
      path.join(outputDirectory, name),
    ],
    {
      cwd: root,
      stdin: new Blob([serializeDocument(document)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, content, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Formatting ${name} failed: ${error}`);
  return content;
}

/** Evaluate schema metadata only; source operations and TypeBox builders remain the authoring source. */
async function checkSchemaSemantics(): Promise<void> {
  const missing: string[] = [];
  for await (const filename of new Bun.Glob("lib/api-contracts/*.ts").scan(
    root,
  )) {
    // Filesystem-selected documentation registry: new schema modules must not bypass the gate through a stale static allow-list.
    const module: Record<string, unknown> = await import(
      pathToFileURL(path.join(root, filename)).href
    );
    for (const [name, value] of Object.entries(module)) {
      if (
        !name.endsWith("Schema") ||
        !value ||
        typeof value !== "object" ||
        !(Kind in value)
      )
        continue;
      if (
        !("description" in value) ||
        typeof value.description !== "string" ||
        !value.description.trim()
      )
        missing.push(`${filename}:${name}`);
    }
  }
  if (missing.length)
    throw new Error(
      `Canonical schemas need intended-use descriptions:\n${missing.join("\n")}`,
    );
}

export async function generateApiDocs(check: boolean): Promise<void> {
  const semantics = await checkHttpCoverage();
  await checkMessageCoverage();
  await checkSchemaSemantics();
  const documents = {
    "host-http.openapi.json": httpDocument(semantics, hostHttpOperations, true),
    "web-http.openapi.json": httpDocument(semantics),
    "host-link.asyncapi.json": socketDocument(hostLinkContract),
    "browser-link.asyncapi.json": socketDocument(completeBrowserLinkContract),
    "runner-channel.asyncapi.json": socketDocument(runnerLinkContract),
    "contracts.schema.json": schemaDocument(),
  };
  await validateDocuments(documents);
  if (!check) await mkdir(outputDirectory, { recursive: true });
  for (const [name, document] of Object.entries(documents)) {
    const filename = path.join(outputDirectory, name);
    const content = await formatArtifact(name, document);
    if (check) {
      if (
        !(await Bun.file(filename).exists()) ||
        (await Bun.file(filename).text()) !== content
      )
        throw new Error(`${name} is stale; run bun run api:generate`);
    } else await Bun.write(filename, content);
    console.log(`${check ? "Checked" : "Generated"} docs/api/${name}`);
  }
  console.log(
    `Covered ${httpOperations.length} HTTP operations, ${hostOperations.length} host operations, ${runnerOperations.length} runner commands and ${agentOperations.length} web commands.`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error("Usage: bun scripts/generate-api-docs.ts [--check]");
  await generateApiDocs(args.includes("--check"));
}
