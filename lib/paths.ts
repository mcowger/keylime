import path from "path";

export function sessionPathKey(filePath: string): string {
  return path.posix.normalize(filePath);
}

export function projectIdentityKey(projectRoot: string): string {
  return normalizeForComparison(projectRoot);
}


export function normalizeForComparison(value: string): string {
  if (!value) return value;
  const normalized = path.posix.normalize(value);
  const rootLength = path.posix.parse(normalized).root.length;
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === "/") end--;
  return normalized.slice(0, end);
}

export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (normalizeForComparison(a) === normalizeForComparison(b)) return true;
  return false;
}
