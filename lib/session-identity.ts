/** Process-wide key for a session, including temporary creation IDs and aliases. */
export function sessionKey(sessionId: string, hostId = "local"): string {
  return `${hostId}:${sessionId}`;
}

/** A request path with the owning host; omitting the host selects local only. */
export function sessionUrl(path: string, hostId = "local"): string {
  return hostId === "local"
    ? path
    : `${path}${path.includes("?") ? "&" : "?"}hostId=${encodeURIComponent(hostId)}`;
}
