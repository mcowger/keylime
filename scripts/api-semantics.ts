import ts from "typescript";

export const semanticSections = [
  "Usage",
  "Inputs",
  "Invariants",
  "Effects",
  "Recovery",
] as const;
export type ContractSemantics = Record<
  (typeof semanticSections)[number],
  string
>;

/** Sections describe client obligations and lifecycle; no runtime request validation is installed. */
export function renderSemantics(sections: ContractSemantics): string {
  return semanticSections
    .map((name) => `### ${name}\n\n${sections[name]}`)
    .join("\n\n");
}

/** Extract only the exported handler's own JSDoc, never a neighboring handler's comments. */
export function handlerSemantics(
  statement: ts.Statement,
  context: string,
): ContractSemantics {
  const tags = ts.getJSDocTags(statement);
  const sections = {} as ContractSemantics;
  for (const name of semanticSections) {
    const matches = tags.filter((tag) => tag.tagName.text === `api${name}`);
    if (matches.length !== 1)
      throw new Error(
        `${context}: expected one @api${name} section, found ${matches.length}`,
      );
    const text = ts.getTextOfJSDocComment(matches[0].comment)?.trim();
    if (!text)
      throw new Error(
        `${context}: @api${name} must explain the operation, not just declare a heading`,
      );
    sections[name] = text;
  }
  return sections;
}

/** A shape-complete operation is still incomplete when its client obligations are unspecified. */
export function assertOperationSemantics(
  context: string,
  description: string,
): void {
  const headings = [
    ...description.matchAll(
      /^(?:#{1,6}\s*)?(Usage|Inputs|Invariants|Effects|Recovery):?\s*$/gm,
    ),
  ];
  // Inline "Usage: prose" is also supported; sections can continue on later lines.
  const inline = [
    ...description.matchAll(
      /^(?:#{1,6}\s*)?(Usage|Inputs|Invariants|Effects|Recovery):[^\S\n]*(\S.*)$/gm,
    ),
  ];
  const starts = [...headings, ...inline].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  for (const section of semanticSections) {
    const matches = starts.filter((heading) => heading[1] === section);
    if (matches.length !== 1)
      throw new Error(
        `${context}: expected one ${section}: semantic section, found ${matches.length}`,
      );
    const heading = matches[0];
    const start = (heading.index ?? 0) + heading[0].length;
    const next = starts.find(
      (candidate) => (candidate.index ?? 0) > (heading.index ?? 0),
    );
    const content =
      `${heading[2] ?? ""}\n${description.slice(start, next?.index)}`.trim();
    if (!content)
      throw new Error(
        `${context}: ${section} must explain usage, not just declare a heading`,
      );
  }
}
