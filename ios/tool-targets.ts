import type { NativeToolCall } from "./tool-presentation";

export type NativeToolTarget =
  | { kind: "file"; value: string }
  | { kind: "agent"; value: string[] }
  | { kind: "web"; value: string };

/** Resolve row targets without moving paths between hosts or interpreting arbitrary URI schemes. */
export function nativeToolTarget(
  block: NativeToolCall,
  cwd?: string,
): NativeToolTarget | null {
  const path =
    typeof block.input.path === "string" ? block.input.path.trim() : "";
  if (!path) return null;
  const match =
    /^agent:\/\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)((?:\/[^?#]*)?)(?:[?#].*)?$/.exec(
      path,
    );
  if (match && match[1] !== "all") {
    const segments = match[2].split("/").filter(Boolean);
    return {
      kind: "agent",
      value:
        segments.length &&
        segments.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
          ? [[match[1], ...segments].join("."), match[1]]
          : [match[1]],
    };
  }
  const name = block.toolName.toLowerCase();
  const fileTool =
    name === "read" ||
    name.endsWith(".read") ||
    name.endsWith("_read") ||
    name === "file_read" ||
    name === "edit" ||
    name === "write" ||
    name === "ast_edit" ||
    name.endsWith(".edit") ||
    name.endsWith(".write");
  if (!fileTool) return null;
  if (
    /^https?:\/\//i.test(path) &&
    (name === "read" ||
      name.endsWith(".read") ||
      name.endsWith("_read") ||
      name === "file_read")
  ) {
    try {
      const url = new URL(path);
      return { kind: "web", value: url.href };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  const clean = path.replace(/:\d+$/, "");
  if (!clean.startsWith("/") && !cwd) return null;
  return {
    kind: "file",
    value: clean.startsWith("/")
      ? clean
      : `${cwd!.replace(/\/$/, "")}/${clean}`,
  };
}
