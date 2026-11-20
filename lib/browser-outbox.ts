import type { LocalOutboxEntry } from "./event-stream";
import { sessionKey } from "./session-identity";

// A fresh database excludes pending entries that have no trustworthy owning host.
export const BROWSER_OUTBOX_DB = "keylime-outbox-host-scoped";
export const BROWSER_OUTBOX_KEY_PATH = ["hostId", "sessionId", "id"];

export function groupBrowserOutbox(entries: LocalOutboxEntry[]) {
  const groups = new Map<string, Map<string, LocalOutboxEntry>>();
  for (const entry of entries) {
    const key = sessionKey(entry.sessionId, entry.hostId);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = new Map()));
    group.set(entry.id, entry);
  }
  return groups;
}
