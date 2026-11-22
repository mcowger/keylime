import type { operations } from "./generated/web-http";

type CreateResponses = operations["createAgentSession"]["responses"];
type CreatedChat = CreateResponses[200]["content"]["application/json"];
type OfflineChat = CreateResponses[503]["content"]["application/json"];

export async function readChatCreation(response: Response) {
  if (response.status !== 200 && response.status !== 503) return;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!payload || typeof payload !== "object") return;
  const body = payload as Partial<CreatedChat & OfflineChat>;
  if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return;
  if (response.status === 200 && body.success === true)
    return { sessionId: body.sessionId, kind: "ready" as const };
  if (
    response.status === 503 &&
    body.hostOffline === true &&
    body.code === "host_offline"
  )
    return {
      sessionId: body.sessionId,
      kind: "initialization-interrupted" as const,
    };
}
