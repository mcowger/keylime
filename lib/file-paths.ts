/** The decoded catch-all segments `/api/files/[...path]` receives for a path.
 * The live file-watch channel sends the raw path instead of a URL, and the
 * server rebuilds it from these same segments so both resolve identically. */
export function filePathApiSegments(filePath: string): string[] {
  return filePath.split("/").filter(Boolean);
}

export function encodeFilePathForApi(filePath: string): string {
  return filePathApiSegments(filePath).map(encodeURIComponent).join("/");
}

export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = filePath;
  const normalizedCwd = cwd.replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${parent.replace(/\/$/, "")}/${child}`;
}
export function getFileApiUrl(
  filePath: string,
  type: "list" | "read" | "download" | "meta" | "preview",
  hostId?: string,
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (hostId !== undefined) searchParams.set("hostId", hostId);
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}
