export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  hostId?: string;
}

export function getInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const sessionId = requestedCwd ? null : searchParams.get("session");
  const hostId = searchParams.get("hostId") || undefined;

  return {
    requestedCwd,
    sessionId,
    ...((requestedCwd || sessionId) && hostId ? { hostId } : {}),
  };
}
