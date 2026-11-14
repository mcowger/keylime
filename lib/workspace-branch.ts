/** Normalize a new branch name without changing valid namespaces or letter case. */
export function sanitizeWorkspaceBranch(value: string): string {
  const branch = value
    .replace(/[\u0000-\u0020\u007f~^:?*[\]\\]+/gu, "-")
    .replace(/@\{/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-./]+/, "")
    .split("/")
    .map((part) => part.replace(/^\.+/g, "").replace(/\.lock$/, "-lock"))
    .filter(Boolean)
    .join("/")
    .replace(/\.+$/, "")
    .replace(/\.lock$/, "-lock");
  return branch === "@" || branch === "HEAD" ? "" : branch;
}
