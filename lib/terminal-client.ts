import type { TerminalSnapshot, WorkspaceTerminal } from "./terminal-types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.error?.message ??
        body?.error ??
        `Terminal request failed (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

const terminalUrl = (id: string, hostId: string) =>
  `/api/terminals/${encodeURIComponent(id)}?hostId=${encodeURIComponent(hostId)}`;

export function listTerminals(hostId: string, cwd: string) {
  return request<{ terminals: WorkspaceTerminal[] }>(
    `/api/terminals?${new URLSearchParams({ hostId, cwd })}`,
  );
}
export function createTerminal(hostId: string, cwd: string) {
  return request<{ terminal: WorkspaceTerminal }>("/api/terminals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostId, cwd, cols: 80, rows: 24 }),
  });
}
export function terminalSnapshot(id: string, hostId: string) {
  return request<TerminalSnapshot>(terminalUrl(id, hostId));
}
export function terminalCommand(
  id: string,
  hostId: string,
  command:
    | { action: "input"; data: string }
    | { action: "resize"; cols: number; rows: number },
) {
  return request<unknown>(terminalUrl(id, hostId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostId, ...command }),
  });
}
export function closeTerminal(id: string, hostId: string) {
  return request<unknown>(terminalUrl(id, hostId), { method: "DELETE" });
}
