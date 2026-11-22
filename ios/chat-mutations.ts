import type { BrowserReply } from "./browser-link";
import type { ChatIdentity } from "./ChatActions";
import type { operations } from "./generated/web-http";
import { requestJson } from "./keylime-http";

type EditResult = {
  sessionId: string;
  cancelled: boolean;
  leafId: string | null;
};
type ForkResult = { cancelled?: boolean; newSessionId?: string; text?: string };

export function editReply(reply: BrowserReply): EditResult {
  const value: unknown =
    "success" in reply.data && reply.data.success ? reply.data.data : null;
  if (
    value === null ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    !("cancelled" in value) ||
    typeof value.cancelled !== "boolean" ||
    !("leafId" in value) ||
    (value.leafId !== null && typeof value.leafId !== "string")
  ) {
    throw new Error("The edit result could not be confirmed.");
  }
  return {
    sessionId: value.sessionId,
    cancelled: value.cancelled,
    leafId: value.leafId,
  };
}

export function forkReply(reply: BrowserReply): ForkResult {
  const value: unknown =
    "success" in reply.data && reply.data.success ? reply.data.data : null;
  if (!value || typeof value !== "object")
    throw new Error("The fork result could not be confirmed.");
  if ("cancelled" in value && value.cancelled === true)
    return { cancelled: true };
  if (
    !("newSessionId" in value) ||
    typeof value.newSessionId !== "string" ||
    !value.newSessionId
  )
    throw new Error("The fork did not return a session ID.");
  return {
    newSessionId: value.newSessionId,
    ...("text" in value && typeof value.text === "string"
      ? { text: value.text }
      : {}),
  };
}

export async function renameChat(session: ChatIdentity, name: string) {
  const body: operations["renameSession"]["requestBody"]["content"]["application/json"] =
    { name };
  await requestJson(
    session.origin,
    `/api/sessions/${encodeURIComponent(session.sessionId)}?hostId=${encodeURIComponent(session.hostId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function archiveChat(session: ChatIdentity) {
  await requestJson(
    session.origin,
    `/api/sessions/${encodeURIComponent(session.sessionId)}/archive?hostId=${encodeURIComponent(session.hostId)}`,
    { method: "POST" },
  );
}
