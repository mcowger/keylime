import { TypeScriptToTypeBox } from "@sinclair/typebox-codegen";
import ts from "typescript";

/** One-time conversion helper. Its output becomes maintained source, never a regenerated mirror of legacy types. */
export function bootstrapSchema(
  source: string,
  names: readonly string[],
): string {
  const file = ts.createSourceFile(
    "contract.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = file.statements.filter(
    (node): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      names.includes(node.name.text),
  );
  const found = new Set(declarations.map((node) => node.name.text));
  for (const name of names) {
    if (!found.has(name))
      throw new Error(`Type declaration not found: ${name}`);
  }
  // Codegen preserves JSDoc schema metadata. Imported dependencies still need explicit conversion/review.
  return TypeScriptToTypeBox.Generate(
    declarations.map((node) => node.getFullText(file)).join("\n"),
    { useExportEverything: true },
  );
}

if (import.meta.main) {
  const [file, ...names] = process.argv.slice(2);
  if (!file || names.length === 0) {
    throw new Error(
      "Usage: bun scripts/bootstrap-api-schema.ts <file.ts> <Type> [Type ...]",
    );
  }
  process.stdout.write(bootstrapSchema(await Bun.file(file).text(), names));
}
