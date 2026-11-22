import { mkdir, readFile, writeFile } from "node:fs/promises";
import openapiTS, {
  astToString,
  type OpenAPI3,
  type SchemaObject,
  resolveRef,
  walk,
} from "openapi-typescript";
import ts from "typescript";

const docs = new URL("../../docs/api/", import.meta.url);
const output = new URL("../generated/", import.meta.url);

async function httpSchemas(spec: URL): Promise<OpenAPI3> {
  const document: OpenAPI3 = JSON.parse(await readFile(spec, "utf8"));
  const targets = new Map<string, { name: string; schema: SchemaObject }>();
  // The generator cannot index into inline schema internals in its TS output.
  // Move recursive targets to components before it translates their references.
  walk(document, (node) => {
    const ref = node.$ref;
    if (
      typeof ref !== "string" ||
      !ref.startsWith("#/paths/") ||
      !ref.includes("/schema/")
    )
      return;
    let target = targets.get(ref);
    if (!target) {
      const schema = resolveRef<SchemaObject>(document, ref, { silent: true });
      if (!schema) throw new Error(`Cannot resolve ${ref}`);
      target = { name: `InlineSchema${targets.size + 1}`, schema };
      targets.set(ref, target);
    }
    node.$ref = `#/components/schemas/${target.name}`;
  });
  if (targets.size) {
    const schemas = ((document.components ??= {}).schemas ??= {});
    for (const { name, schema } of targets.values()) {
      if (Object.hasOwn(schemas, name))
        throw new Error(`Duplicate schema ${name}`);
      schemas[name] = { ...schema };
      const inline = schema as Record<string, unknown>;
      for (const key of Object.keys(inline)) delete inline[key];
      inline.$ref = `#/components/schemas/${name}`;
    }
  }
  return document;
}

async function socketSchemas(spec: URL): Promise<OpenAPI3> {
  const document: {
    info: OpenAPI3["info"];
    components: Required<Pick<NonNullable<OpenAPI3["components"]>, "schemas">>;
  } = JSON.parse(await readFile(spec, "utf8"));
  // AsyncAPI message payloads reference these schemas. Keep their reference paths intact.
  return {
    openapi: "3.1.0",
    info: document.info,
    paths: {},
    components: { schemas: document.components.schemas },
  };
}

const inputs = [
  ["web-http", "web-http.openapi.json"],
  ["browser-link", "browser-link.asyncapi.json"],
  ["terminal-attach", "terminal-attach.asyncapi.json"],
] as const;

await mkdir(output, { recursive: true });
for (const [name, source] of inputs) {
  const spec = new URL(source, docs);
  const socket = source.endsWith(".asyncapi.json");
  const input = socket ? await socketSchemas(spec) : await httpSchemas(spec);
  // A propertyless object in an allOf must not forbid the other branches' keys.
  const types = await openapiTS(input, {
    emptyObjectsUnknown: true,
    transform(schema) {
      if (socket && schema.type === "string" && schema.format === "binary")
        return ts.factory.createTypeReferenceNode("ArrayBuffer");
    },
  });
  await writeFile(new URL(`${name}.ts`, output), astToString(types));
  console.log(`generated/${name}.ts ← ${source}`);
}
