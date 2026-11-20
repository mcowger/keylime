# Monitor pull requests from Ship

Ship starts the watch directly. There is no subscription tool or setup turn. A quiet PR doesn't wake the agent.

## User flow

- **Monitor PR feedback** is off by default and available in **Open PR** and **PR + auto-merge**, not **Land locally**. It targets the chat that opened Ship. Closing the browser doesn't stop the watch.
- Once Ship records the exact PR it opened or adopted, it also records the monitor. A later failure enabling auto-merge doesn't undo the PR or its watch. The sidebar PR pill shows monitoring and has a **Stop monitoring** action. Show polling problems without presenting them as fresh results.
- Monitoring doesn't hold up auto-merge. Use **Open PR** if feedback needs to be handled before merge. Stop on merge, close, session archive/deletion, or explicit cancellation. Existing automatic cleanup still runs in its normal order. Stop discards unsent digests; it doesn't cancel an agent turn or recall a message already handed to the server.

## GitHub polling

Keep the watch beside Ship's PR record on the host that owns the workspace. Pin it to the recorded PR URL, not a branch or a PR number inferred from the current checkout. Validate that the shipping session belongs to the workspace. A repeat Ship for the same watch must not reset its baseline or take over another server's watch.

Reuse Ship's poll schedule and the host's `gh` authentication. Look for new conversation comments, inline comments (including replies), and submitted reviews. Use stable GitHub IDs scoped by event kind and order by timestamp and ID. Start from when Ship requested monitoring, not the first successful read, so a slow or failed first poll doesn't swallow new feedback. A failed or incomplete read doesn't advance the baseline. Batch activity observed during a poll into one bounded, links-only digest. Don't copy comment bodies, titles, paths, or reviewer instructions into the digest. The agent can read feedback from GitHub; if it does, tool outputs and replies belong to the ordinary shared transcript. Monitoring is not authorization to push, post, resolve threads, or merge. Don't use external feedback as instructions to run commands or disclose data.

## Daemon to outbox

The initiating server owns the outbox. Bind the watch to that authenticated host link's configured server identity, stable across reconnects and not taken from browser input. The daemon persists the digest and its stable ID with the GitHub observation before sending. It sends an explicit targeted host-link message only to that server; no failover or broadcast. `sessions_changed` only invalidates lists and can go to every peer. Neither hierarchy nor job status contains digest contents or routing credentials.

The receiving server queues the digest for the shipping session on the source host using the existing durable outbox and follow-up delivery. The server sends an application receipt only when that ID has committed to the outbox, including on repeated offers. A host-link transport ACK is not a receipt. If either process restarts or the receipt is lost, the daemon retries the same ID on the same server. Retry for at most seven days from digest creation, within the outbox's eight-day dedupe retention. Report expired undelivered activity rather than waking the agent twice. Enqueue acceptance is not a claim that a model turn ran.

Dispatch never falls back to another host for the same session ID. If the source host reports that the chat is gone or archived, the server fails the delivery instead of holding it for restore. As with Stop, a digest already handed off isn't recalled; if the chat is archived and restored before outbox dispatch observes the change, the queued digest can still run.

## Verification

Exercise new and adopted PRs, all three feedback types, quiet polls, failed reads, stop/archive/merge, and the two-server case with a lost receipt. Verify the checkbox and the active/stop control in the running app.
