# Monitor pull requests from Ship

Ship starts the watch directly. There is no subscription tool or setup turn. A quiet PR doesn't wake the agent.

## User flow

- **Monitor PR feedback** is off by default and available in **Open PR** and **PR + auto-merge**, not **Land locally**. It targets the chat that opened Ship. Closing the browser doesn't stop the watch.
- Once Ship records the exact PR it opened or adopted, it also records the monitor. A later failure enabling auto-merge doesn't undo the PR or its watch. The sidebar PR pill shows monitoring and has a **Stop monitoring** action. Show polling problems without presenting them as fresh results.
- Monitoring doesn't hold up auto-merge. Use **Open PR** if feedback needs to be handled before merge. Stop on merge, close, session archive/deletion, or explicit cancellation. Existing automatic cleanup still runs in its normal order. Stop discards unsent digests; it doesn't cancel an agent turn or recall a message already handed to the server.

## GitHub polling

Keep the watch beside Ship's PR record on the host that owns the workspace. Pin it to the recorded PR URL, not a branch or a PR number inferred from the current checkout. Validate that the shipping session belongs to the workspace. A repeat Ship for the same watch must not reset its baseline or take over another server's watch.

Reuse Ship's poll schedule and the host's `gh` authentication for new conversation comments, inline comments (including replies), and submitted reviews. Order by timestamp and stable GitHub ID scoped by event kind. Start from the Ship request, not the first successful read. An incomplete read doesn't advance the baseline. Each bounded batch carries event kinds and numeric IDs, not comment text, titles, paths, or URLs supplied by GitHub feedback records.

## Daemon to outbox

The initiating server owns the outbox. Bind the watch to that authenticated host link's configured server identity, stable across reconnects and not taken from browser input. The daemon persists the digest and its stable ID with the GitHub observation before sending. It sends an explicit targeted host-link message only to that server; no failover or broadcast. `sessions_changed` only invalidates lists and can go to every peer. Neither hierarchy nor job status contains digest contents or routing credentials.

Only the web Ship POST can issue an opt-in. Before the daemon starts the job, the web server commits a new grant tied to the host credential, workspace and chat. The daemon uses that grant ID for the monitor. When feedback arrives, main asks the source host for the current watch for that grant. The first matching result pins the PR URL inside the same outbox transaction that admits the digest. Later offers must still match that exact PR and active watch. An authenticated link alone can't enqueue a digest. Stop revokes the grant; closing or merging the PR or archiving the chat removes the watch. The daemon is still the source of GitHub observations; the server doesn't independently fetch comments.

The server builds the GitHub links and follow-up text from the pinned PR and validated event IDs. Monitoring doesn't authorize pushing, posting, resolving threads, or merging. GitHub feedback is untrusted; if the agent reads it, that goes through its normal tools and shared transcript.

The server sends a receipt only after the ID commits to its outbox. A transport ACK isn't a receipt, and enqueue acceptance isn't proof of a model turn. If the connection or either process restarts, the daemon retries the same ID on the same server. Retry for at most seven days from digest creation, within the outbox's eight-day dedupe window. Report expired activity rather than waking the agent twice.

Dispatch never falls back to another host for the same session ID. If the source host reports that the chat is gone or archived, the server fails the delivery instead of holding it for restore. As with Stop, a digest already handed off isn't recalled; if the chat is archived and restored before outbox dispatch observes the change, the queued digest can still run.

## Verification

Exercise new and adopted PRs, all three feedback types, failed reads, and stop/archive/merge. The integration test must refuse missing grants and mismatched sessions or PRs on an authenticated link, and accept a correctly scoped offer once even if its receipt is lost. Verify the checkbox and active/stop control in the running app.
