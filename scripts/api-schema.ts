/** Compose embedded TypeBox JSON Schema resources into one portable document.
 * TypeScript-only undefined becomes omission in objects and null in tuples, exactly as JSON.stringify serializes it.
 * Recursive/local references are rebased to their actual document location rather than treated as remote URLs.
 */
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const pointerPart = (value: string) =>
  value.replace(/~/g, "~0").replace(/\//g, "~1");
const isUndefined = (value: unknown): boolean =>
  object(value) && value.type === "undefined";
const allowsUndefined = (value: unknown): boolean =>
  isUndefined(value) ||
  (object(value) &&
    [value.anyOf, value.oneOf].some(
      (choices) => Array.isArray(choices) && choices.some(allowsUndefined),
    ));

export function portableDocument(document: unknown): Record<string, unknown> {
  function visit(
    value: unknown,
    pointer: string,
    ids: ReadonlyMap<string, string>,
    localRoot: string,
    tuple = false,
  ): unknown {
    if (isUndefined(value)) return tuple ? { type: "null" } : false;
    if (Array.isArray(value))
      return value.map((item, index) =>
        visit(item, `${pointer}/${index}`, ids, localRoot, tuple),
      );
    if (!object(value)) return value;
    let scope = ids;
    if (typeof value.$id === "string") {
      scope = new Map(ids).set(value.$id, pointer);
    }
    const resource =
      object(value.$defs) || object(value.definitions) ? pointer : localRoot;
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "$id") continue;
      if (key === "$ref" && typeof item === "string") {
        if (scope.has(item)) out[key] = scope.get(item);
        else if (
          item.startsWith("#/$defs/") ||
          item.startsWith("#/definitions/")
        )
          out[key] = `${resource}${item.slice(1)}`;
        else if (item.startsWith("#/")) out[key] = item;
        else
          throw new Error(`Unresolved schema resource ${item} at ${pointer}`);
        continue;
      }
      if ((key === "anyOf" || key === "oneOf") && Array.isArray(item)) {
        const variants = tuple
          ? item
          : item.filter((entry) => !isUndefined(entry));
        if (!variants.length) return false;
        out[key] = variants.map((entry, index) =>
          visit(entry, `${pointer}/${key}/${index}`, scope, resource, tuple),
        );
        continue;
      }
      if (key === "properties" && object(item)) {
        out[key] = Object.fromEntries(
          Object.entries(item)
            .filter(([, schema]) => !isUndefined(schema))
            .map(([name, schema]) => [
              name,
              visit(
                schema,
                `${pointer}/properties/${pointerPart(name)}`,
                scope,
                resource,
              ),
            ]),
        );
        continue;
      }
      if (
        key === "required" &&
        Array.isArray(item) &&
        object(value.properties)
      ) {
        const properties = value.properties;
        const required = item.filter(
          (name) =>
            typeof name === "string" && !allowsUndefined(properties[name]),
        );
        if (required.length) out[key] = required;
        continue;
      }
      out[key] = visit(
        item,
        `${pointer}/${pointerPart(key)}`,
        scope,
        resource,
        key === "items" && Array.isArray(item),
      );
    }
    return out;
  }
  return visit(document, "#", new Map(), "#") as Record<string, unknown>;
}
