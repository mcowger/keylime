import SwaggerParser from "@apidevtools/swagger-parser";
import { Parser } from "@asyncapi/parser";
import Ajv from "ajv";

const [name] = process.argv.slice(2);
if (!name) throw new Error("Missing API document name");
const content = await Bun.stdin.text();

if (name.endsWith(".schema.json")) {
  new Ajv({ strict: false, validateFormats: false }).compile(
    JSON.parse(content),
  );
} else if (name.endsWith(".openapi.json")) {
  await SwaggerParser.validate(JSON.parse(content), {
    resolve: { external: false },
  });
} else if (name.endsWith(".asyncapi.json")) {
  const diagnostics = await new Parser().validate(content);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 0);
  if (errors.length)
    throw new Error(`${name}: ${JSON.stringify(errors, null, 2)}`);
} else {
  throw new Error(`Unknown API document type: ${name}`);
}
