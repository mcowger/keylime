# Host independence

Keylime manages independent hosts, not a cluster. One web server can manage several authenticated daemons. Each daemon links to one controller. A web restart must leave the daemon's sessions and terminals running. Multiple browser tabs still share the browser event connection.

The host owns its sessions, archives, repos, workspaces, Systems, and runtime settings. A combined view is for discovery, not routing. Selecting a session on one host never searches another host for the same ID or waits for it to come online.

## Implementation and acceptance

1. **Remove pools.** Delete membership, pool registries and IDs, project coalescing, and pool-specific API and UI behavior. Preserve explicit host selection, enrollment, revocation, and managed deployment. Removing a pool does not move or delete checkouts. Re-register any checkout that needs a host-local repo entry; do not guess a target or convert the pool file automatically.
2. **Put runtime settings on the host.** Host-specific Keylime policies include sent-upload retention, daemon auto-resume, and whether that host offers Keylime agent tools. The controller edits these policies only on the selected host. Reconnect never pushes another host's values. Keep an existing local retention policy; an unset policy does not prune. Keep browser transport and interface preferences at their current scope. Read the selected host's model catalog and default. OMP settings, environment secrets, plugins, and provider logins are managed on the host. Do not mirror them or add linked-host editors for them.
3. **Qualify sessions by `(hostId, sessionId)`.** Use the pair for requests, deep links, CLI, live registry, event routing, drafts, notifications, outbox, and restores. Keep sidebar, metadata search, and archive views combined and labeled by host. Same-ID sessions on two hosts must open independently. Commands, events, and attachments go only to the named host.
   - `/api/sessions/search` scans transcripts only on the web host. Filter scores against that host's registrations, emit host-qualified scores, and label transcript coverage as local-only. If both hosts have the same UUID and only the local transcript matches, only the local row gets the transcript score. Either row can still match on metadata.
   - With B offline, A can browse, launch, deliver queued work, and restore. Restore checks only the target host's strict inventory. Keep the same-host duplicate check, uncertain restore fencing, and exclusive archive publication.
   - Check and insert outbox entries in one transaction. The 256 MiB/1,000-row undelivered limits are per destination host; retain the conversation cap and a separate server disk safeguard. With B offline and at its row cap or byte cap, B's next enqueue returns `outbox_full` and A's is durably accepted. Genuine disk pressure can block new messages but must not evict accepted messages.
4. **Limit agent collaboration to its host.** Agent tools list, start, and message only on the calling host. Only the operator picks another host.
5. **Remove daemon peers.** Keep authenticated links, browser-tab multiplexing, single-controller edit/command fences, live-child adoption after a controller restart, and managed binary deployment. Remove peer link selection, notifier election, and peer frame relays.

## Cutover

This is a breaking API and host-link change. Update the controller and its daemons together, then reload open browser tabs. Keep console access for any daemon whose old protocol cannot reconnect for managed deployment.

Stop old writers and confirm no restore is in progress before switching. There is no requirement to drain, migrate, or replay old pending messages or restore claims. Leave their old files and existing transcripts, archives, checkouts, and local configuration intact. An orphaned filesystem restore claim still requires the existing manual recovery procedure; the cutover does not clear it.
