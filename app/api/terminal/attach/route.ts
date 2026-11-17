import { terminalAttachUpgrade, type TerminalAttachData } from "@/lib/terminal-attach";

/**
 * @apiContract getTerminalAttach
 * @apiUsage Attach an authenticated client to an existing session terminal.
 * @apiInputs hostId and sessionId identify the owning host and live session; the first frame is a version 1 hello.
 * @apiInvariants Input belongs only to this socket and is never replayed. Reconnection starts with a fresh snapshot.
 * @apiEffects Input and resize frames are forwarded to the host-owned PTY; detach closes only the attachment.
 * @apiRecovery A disconnected or slow client reconnects and receives a new snapshot.
 */
export function GET(request: Request, { upgrade }: { upgrade: (data: TerminalAttachData) => boolean }) {
  return terminalAttachUpgrade(request, upgrade);
}
