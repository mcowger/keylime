# Native Keylime for iPhone

Build the existing mobile Keylime experience as an iPhone app, starting from the Expo/TypeScript project in this directory. The installed Keylime PWA is the reference for layout, labels, control placement, navigation and interaction. Use native views and iOS system controls where needed, not a WebView shell or a parallel design. Expo is the implementation starting point, not a reason to change the interface.

## Parity is an acceptance criterion

Use the [checked-in PWA screenshots](screenshots/baseline/README.md), not desktop Keylime or Safari with its browser chrome. The baseline is an iPhone 18 Pro at 402 × 874 points, iOS 27.2, dark appearance. Match the same seeded repo, workspace, chat, model availability, open panels, scroll position and keyboard state. Match the PWA's hierarchy, typography, spacing, colors and icons using its design tokens as the reference. For example: the sidebar is an overlay with host-grouped Systems and Repos, the chat header opens the Workspace tabs bottom sheet, and the workspace side panel replaces the chat on mobile. None becomes a new tab bar.

For **each milestone**:

1. Use the references below before building. If a needed state isn't captured, reproduce it in the standalone PWA using an isolated server and capture it first. Login, live model replies, uploads and remote-host recovery aren't covered by the existing captures. The seeded saved chat is a visual fixture, not proof that Send works.
2. Capture the matching native screen on the same simulator. Keep pairs under `ios/screenshots/` using the baseline filenames and attach them side by side to the milestone review. Use [the simulator capture workflow](AGENTS.md#take-a-screenshot). Keep checked-in baselines intact; don't replace a PWA image with a native capture.
3. Exercise the actual path on the simulator: open, interact, dismiss and return. Review visual differences alongside behavior (including keyboard and scroll position). Also check light appearance, larger text and VoiceOver on affected screens; the dark screenshots don't establish those behaviors.
4. Fix unexplained differences before closing the milestone. If matching the PWA isn't viable, record the reference, concrete constraint, proposed closest alternative, effect on the flow and screenshot evidence here. Review the alternative before shipping it. Don't add new navigation or substitute an iOS convention just because it's easier to implement.

## Live connection

Use the PWA's [Browser Link WebSocket protocol](../docs/api/browser-link.asyncapi.json) at `/api/events/link` on the Keylime web server. Maintain one authenticated, multiplexed socket per active server connection. Use the existing protocol for subscriptions and agent commands, including sequencing, acknowledgements, heartbeat, resume and resubscription when resume fails. The native app owns the socket lifecycle instead of using a SharedWorker; it doesn't introduce a new wire protocol, SSE fallback, or polling loop.

Use HTTP for login, session creation, initial or paged reads, and catch-up when a persisted-session change event arrives or the link reports a gap it can't replay. Reconnect on foreground or network recovery. Live chat and workspace events come from the socket, not from periodic HTTP snapshots. The deferred **Browser tab** is the remote browser viewer and control feature, not Browser Link.

## Milestones

### 0. Prove the connection and comparison loop

Keep the existing build and screenshot workflow. Generate types from the [web HTTP contract](../docs/api/web-http.openapi.json) via `api:types`. Use the configured Keylime web server origin only; never call a host daemon directly or treat a host path as an iPhone path. Verify Expo cookie handling with `POST /api/web-auth/session` and an authenticated follow-up read. Support password-disabled servers without a login prompt; distinguish invalid credentials, expired auth, an unreachable server and an offline host. Keep the password out of persistent storage and logs, keep session credentials scoped to their origin, and do not bypass TLS validation. Use isolated simulator fixtures for HTTP development. Capture the PWA sign-in and re-entry states before building their native equivalents. The native app needs a server URL because it doesn't start at a browser origin; see the deviation below.

**Exit:** Release app launches, authenticates and opens the Browser Link on both open and password-protected isolated servers. Verify hello/welcome, a live subscription, reconnect with resume and a fresh subscription after resume is refused. Expiry and switching origins don't leak credentials or leave the old socket active. Paired screenshots cover sign-in and the first shared page.

**Milestone 0 progress.** Release ran on iPhone 18 Pro. Verified open-server entry, protected sign-in, incorrect-password feedback and authenticated Home via the actual native bridge. The same origin-scoped, in-memory cookie jar serves HTTP and the socket; the bridge refuses redirects instead of letting React Native forward a password. The Browser Link client also passed a real-controller smoke with a Bun socket adapter: initial hosts subscription, successful resume without resubscription, then a refused resume with a fresh hosts subscription. The latter two cases were not forced on the simulator. Review captures are under `ios/screenshots/milestone-0/{pwa,native}/`. The native server selector actions sit outside the password card; the navigation controls and Home actions follow in milestones 1–4.

### 1. Mobile shell and read-only navigation

Build Home (active agents, recent chats and workspace entry points), sidebar overlay, Settings entry and the workspace header/switcher. Read host status, registered hierarchy and saved chats via `/api/hosts`, `/api/hierarchy`, `/api/systems` and `/api/sessions`. Preserve host → Repo → workspace and host → System → Effort navigation. Workspace rows don't become trees of chats; use **Workspace tabs** for open and saved chats. Closing a tab doesn't stop or delete its session. Keep selection keyed by server and owning host as well as workspace/session; keep the previous location when dismissing the sidebar or a sheet.

Use the link's `hosts` and `running` channels for live status and badges. Refresh the affected inventory when an event invalidates it, not on a timer.

**Compare:** [Home](screenshots/baseline/01-home.png), [sidebar](screenshots/baseline/02-sidebar.png), [Systems](screenshots/baseline/24-systems-expanded.png), [Workspace tabs](screenshots/baseline/28-workspace-tabs.png), [Effort root](screenshots/baseline/48-effort-root.png).

**Exit:** Open the same saved chat from Home and from a workspace, switch and close tabs, navigate to an Effort, and return using the same controls as the PWA. Host unavailable and genuinely empty are distinct states.

**Milestone 1 progress.** Release simulator walkthrough opened the same seeded chat from Home and Saved chats, closed its tab without removing the saved chat, and switched workspaces without losing the original open tab. Native captures are under `ios/screenshots/milestone-1/native/` against references 01, 02, 03, 24 and 28. The initial capture identified a drawer safe-area mismatch and an empty local host name; the shell now insets the drawer and uses “This machine” when no custom name is set. The remaining creation and search affordances are wired in later milestones. The seeded run had no Effort, so the Effort route and return still need the System/Effort walkthrough.

### 2. Live chat and composer

Start with saved transcripts: user and assistant rows, Markdown, folded Process details and in-place expansion, followed by the keyboard-safe composer. Page long history using `tail`/`before` and `historyRevision`; refresh the active view if the revision changes. Keep the scroll anchor when loading older entries; follow a reply only while the reader is at the bottom. Then add New Session with the same Project and Workspace selectors, model/role selection, Send and Stop in their PWA locations. Exercise both a working catalog and the captured unavailable-model state. Preserve drafts across navigation and failures.

For a fresh chat, follow the PWA's two-step path:

1. `POST /api/agent/new` with `type: "ensure_session"` and the selected host and workspace. Don't send the prompt, uploads or a caller-chosen session ID. The create route doesn't accept uploads, discards `sessionId`, and rejects caller-chosen creation identifiers. If the response is lost, session creation is unconfirmed but no prompt was sent. Keep the draft and check for the created session before offering another create attempt.
2. Adopt the returned session ID, open the session subscription and send the first `prompt` to that ID via Browser Link. When attachments land in milestone 4, pass staged upload IDs and their proofs on the prompt, not on create. If the command result is lost, follow the link's replay and dedupe rules. If delivery remains uncertain, reconcile the known session's state and transcript; don't issue a fresh prompt or create another chat.

Keep subsequent sends on the web outbox path via Browser Link. A stored receipt isn't delivery to the agent; reconcile an uncertain outcome by client message ID before issuing any new command for it. Apply live message deltas, tool updates, queue/outbox updates and run lifecycle events as they arrive. Resume the socket after a gap when the server can replay it. If the link requires resync, use `/api/sessions/{id}/state` and `/api/sessions/{id}/context?sync=1` for catch-up, applying append/replace and cursor semantics before continuing with live events. Don't apply stale answers to a different chat, duplicate a streamed reply when its persisted entry arrives, or fall back to polling.

Even on a healthy socket, `message_end` can arrive before the transcript is written. Follow the PWA and listen for persisted-session change notifications on the `running` channel. When a notification includes the open chat's host-qualified session ID, request `/api/sessions/{id}/context?sync=1` with the current durable history cursor. Coalesce overlapping invalidations and merge the returned append or replace page without duplicating the live message. The notification triggers the read, not a timer.

**Compare:** [saved chat](screenshots/baseline/03-chat.png), [expanded Process details](screenshots/baseline/04-chat-process-expanded.png), [new session](screenshots/baseline/25-new-session.png), [project](screenshots/baseline/26-new-session-project-picker.png) and [workspace](screenshots/baseline/27-new-session-workspace-picker.png) selectors, [keyboard](screenshots/baseline/35-chat-keyboard.png), [long chat](screenshots/baseline/52-long-conversation.png), [online model picker](screenshots/baseline/55-online-model-picker.png).

**Exit:** On an isolated runner-enabled server, open and scroll a real saved chat, send real prompts in a new chat and an existing one, watch replies and tool activity update over the socket, and stop an active run. Drop the create response and the prompt result separately; verify draft preservation when no prompt was sent and no duplicate send or chat when delivery is uncertain. Exercise network loss during a reply, resume, forced resync and background/foreground. Verify that blocking tool requests are restored and can be answered after reconnect. Confirm that an active chat generates no periodic HTTP state reads.

Exercise a reply whose `message_end` arrives before persistence. With the socket still healthy, verify that the persisted-session notification triggers a catch-up read and advances the durable cursor without duplicating the reply.

**Milestone 2 progress.** The Release app opened a seeded long chat and loaded older entries, selected Project/Workspace and the live model catalog, and streamed first and existing-session replies through Browser Link against the real local daemon and compiled runner. Stop cancelled the model stream, and foregrounding the app returned to the same chat during a reply. The offline fixture runs only the model HTTP endpoint locally (`native-fixture.ts --offline-model`); it does not replace Keylime. Native captures are under `ios/screenshots/milestone-2/native/`. Fault-injected create/prompt acknowledgement loss, the exact persistence race, and blocking-dialog replay were not covered by this simulator walkthrough.

The Stop regression check retained both the new user prompt and interrupted assistant reply immediately, then reopened the saved chat after app restart without duplicate rows (`stopped-echo.png`).

### 3. Settings and workspace tools

Match the full-page Settings header, search, horizontal categories and setting cards. Start with Interface & Behavior controls that already have native behavior (appearance and transcript controls), host status, and model settings the chat consumes. Keep device-local display preferences separate from host policies and provider configuration. Bind settings to the same source and scope as the PWA; show an unavailable control only if that state exists in the reference. Don't ship inert switches. Provider or host secrets must not be exposed through the app.

Reuse the mobile workspace panel and horizontally scrollable tabs for Explorer and Git. Start with tree/file reads, Markdown source and preview, and Git status/diff. Respect owning host, workspace root, session-local file ownership and the server's authorization results. Add the existing Repo registration and workspace creation/import flows with their real server jobs and errors; use the PWA's confirmation steps for destructive actions before enabling them. Don't confuse unregistering with deleting a worktree. No direct Git or filesystem access on the phone.

**Compare:** [Settings](screenshots/baseline/11-settings-interface.png), [Hosts](screenshots/baseline/20-settings-hosts.png), [Repo workspace setup](screenshots/baseline/21b-repo-workspace-setup.png), [empty Settings search](screenshots/baseline/51-settings-search-empty.png), [Explorer](screenshots/baseline/05-explorer.png), [Git](screenshots/baseline/06-git.png), [file source](screenshots/baseline/38-file-viewer.png) and [preview](screenshots/baseline/39-file-preview.png), [Add repo](screenshots/baseline/50-add-repo.png).

**Exit:** A changed preference persists and visibly affects its intended screen. Workspace selection changes the underlying files and Git status, registering a Repo and creating a workspace refresh the hierarchy, and host errors aren't reported as empty results or successful writes.

**Milestone 3 progress.** The Release simulator build has the live workspace panel, Explorer, Git, Markdown Source/Preview and Settings. Native captures are under `ios/screenshots/milestone-3/native/`. Workspace setup status currently requires an explicit refresh or app foreground: the existing job API has no completion event, and the PWA polls it. This client does not poll. The file viewer keeps the Source/Preview switch but does not yet match the PWA's syntax highlighting, language picker or full toolbar. The device-local Settings file stores preferences and the selected server URL, not credentials.

The simulator showed `Never fold tool activity` replacing a Process details group with its `read ideas.md` row. The switch stayed on after app relaunch. Atlas Explorer opened `README.md` in Source and Preview; Git correctly reported a working tree matching HEAD. The current panel does not expose the PWA's Git mutation buttons or Explorer upload/download controls.

The isolated simulator run also registered the seeded `atlas-service` Repo, created `native-proof` from `main`, and opened the new workspace once setup reported completion. No production workspace was used.

### 4. Complete the everyday flows

Add sidebar search and archive browsing/restore, chat actions and Edit/Fork, attachments using the existing upload contracts, and System/Effort creation. Keep Edit (rewind in place, subject to native ownership) separate from Fork (new chat); use the PWA's distinct confirmation dialogs and preserve drafts through identity changes. Mirror the Effort preview/confirmation and open the Effort root with the correct members. Add Activity and Jobs using the PWA's existing commands and live event paths; no placeholder tabs.

**Compare:** [sidebar search](screenshots/baseline/31-search-results.png), [archive](screenshots/baseline/33-archived-sessions.png), [slash suggestions](screenshots/baseline/36-chat-slash-commands.png), [attachments](screenshots/baseline/37-chat-attachments.png), [chat actions](screenshots/baseline/40-chat-actions.png), [Create System](screenshots/baseline/41-create-system.png), [Effort preview](screenshots/baseline/46-effort-preview.png), [Edit](screenshots/baseline/53-edit-confirmation.png) and [Fork](screenshots/baseline/54-fork-confirmation.png).

**Exit:** Run a paired walkthrough from launch through Repo/workspace selection, chat, file inspection, Settings and return. Also verify archive/restore, Edit/Fork and Effort creation against the same disposable data on local and linked hosts. Build and launch Release without Metro; check on a physical iPhone before release.

**Milestone 4 progress.** Release built and launched without Metro. The simulator selected chat search results, forked a disposable conversation, and confirmed Edit: the later turn disappeared and the selected prompt returned to the composer. It previewed and created an Atlas Effort; Explorer showed the expected member checkout, `AGENTS.md` and `repomap.md`. Native captures are under `ios/screenshots/milestone-4/native/`. An independent runner fixture also verified the Edit leaf, Fork reply, archive-key restore, completed setup and upload completion proof.

The simulator resent the edited prompt, received its new reply, then archived the disposable fork and restored it from Archived Sessions. Restore selected that host-qualified conversation and showed its saved transcript and original open tab.

After returning Home and relaunching, the simulator reopened the Effort from its System, showed it Ready, and listed the same member and root files.

The final search transport returned a transcript-only hit for `fixture` in **Long conversation for paging**. It consumes NDJSON as it arrives; Stop, changing query and closing the sidebar cancel the native request. The simulator search was on the real seeded endpoint, not a deliberately delayed stream.

Baseline 31 keeps search results nested in the filtered sidebar hierarchy. The native capture shows a flat match list in the same drawer. Both open the same saved chat, but the grouping and per-message hit drill-down do not yet match.

Compared with baseline 46, the native Effort preview keeps the same name, root, branch, base ref and checkout information, but uses a dimmed native modal and stacks the branch chooser above the override field. The simulator verified the Effort details chip, member checkout navigation, and return to the root, matching the flow in baseline 48.

The iOS document picker opened and was cancelled in the simulator. Photos → Copy Photo → Attachments → Paste image required a second tap on the system Paste control, which grants clipboard access. The simulator showed the image chip, sent it with a prompt, and received the offline model's reply. The image was saved; the fixture does not test vision. A staged file upload and its completion proof were verified separately over HTTP.

The Jobs tab uses explicit Refresh for status the server does not publish as events. Markdown handles common transcript formatting but not every PWA diagram, math, or link treatment. Slash suggestions omit commands that depend on PWA-only client handlers. These are visible parity gaps, not new interaction conventions.

A separate controller and enrolled standalone daemon verified host-qualified workspace and session reads, archive/restore and System/Effort preview and setup through the web API. The simulator walkthrough used the controller's local host. Native linked-host and physical-iPhone acceptance remain open; no physical iPhone was connected.

## Explicit deferrals and planned differences

| PWA behavior | Why not in the initial iPhone client | Native behavior for now |
| --- | --- | --- |
| The browser already knows the server origin. | A standalone app has no page origin. | Ask for the server URL before the familiar login or Home flow. Limit the new UI to connection setup; use the same Keylime sign-in flow once the origin is known. |
| Workspace Browser tab live stream and remote control ([Browser captures](screenshots/baseline/58-browser-view.png)). | Explicitly deferred. | Omit Browser viewer and control. Browser Link remains required for live chat and other app events. |
| xterm, terminal tabs, New terminal and terminal attach ([terminal](screenshots/baseline/29-terminal.png)). | Explicitly deferred, including a native terminal substitute. | Omit terminal actions and tabs. Keep the Workspace tabs sheet for chats and keep Explorer/Git in their existing locations. Don't hide terminal-backed operations behind a new UI. |
| Browser keyboard, file picker and safe-area handling. | iOS owns these system surfaces. | Use the system keyboard, document/photo picker and safe-area insets. Keep the surrounding Keylime composer, attachment chips, labels and interaction order. Verify with keyboard and sheet open. |

Push delivery, dictation, shipping and advanced settings aren't gates for the core milestones. Keep their existing PWA references for later coverage; don't present nonfunctional controls as parity. Add new entries above only when there's evidence that the reference flow can't be reproduced, including the rejected approach and the closest viable behavior.
