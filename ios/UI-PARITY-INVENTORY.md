# iPhone UI parity inventory

The installed Keylime PWA is the visual reference. Keep Keylime's layout, colors, and interaction order. Paseo is a reference for native polish, not a redesign. This is a list of gaps to address or recapture, not an implementation plan.

The [PWA baseline](screenshots/baseline/README.md) is a dark-mode iPhone 18 Pro capture set. Native milestone and release captures are local artifacts, not checked in. They show the build and fixture at the time, so current source and physical-iPhone reports take precedence. A screenshot pair below identifies the comparison to make; it doesn't imply that both captures show the same state.

## Fix first

- [ ] **Theme consistency.** The user reports that the theme is not respected. Native surfaces now follow the iPhone's light/dark appearance, including an open context popup, actions menu and Settings. The PWA's separately selected theme is not shared with native. Verify the reported setup on the physical iPhone.
- [ ] **Chat-switch redraw.** Open chats retain their transcript views and scroll positions while inactive subscriptions are released. On the simulator, switching chats preserved the reading position, jump control and separate drafts; a run started while away appeared after returning without pulling the reader to the bottom. The physical-iPhone report still needs retesting.
- [ ] **Scroll following.** The native transcript now keeps saved rows stable during streaming, follows only while at the end, and yields to a reading gesture. In the simulator, a sent message returned to the end, scrolling up held position during output, Jump resumed following, and expanding/collapsing Process details kept its trigger in place. A multiline draft grew without moving the text being read. Check physical-iPhone motion and VoiceOver; native uses coalesced JS scrolling, not Paseo's native end pin.
- [ ] **Keyboard focus and motion.** The latest physical-iPhone recording shows the keyboard starting to rise and then disappearing. In a controlled simulator comparison of the same chat with the software keyboard enabled, changing only `collapsable={false}` kept the keyboard open; without it, the keyboard dismissed. A separate search input still opened the software keyboard in the comparison build. This matches a known React Native Fabric view-flattening issue, but native reparenting was not directly instrumented. Physical-iPhone motion and Write with Siri remain to be checked on device.
- [ ] **Pink focus outline trails the composer.** Motion defect reported on the phone, not something a still can prove. Check the border stays attached during both keyboard appearance and dismissal. Earlier simulator captures in `screenshots/parity/01-keyboard/` do not verify the physical-iPhone Writing Tools variant.
- [ ] **More actions menu.** Photo Library and Attach files now appear as separate actions. On the simulator each opened its system picker directly; a HEIC photo was supplied as JPEG and added to the draft. Check both actions on a physical iPhone.
- [ ] **Model picker.** The phone recording shows roles and model catalog rows without PWA favorites or reasoning controls. The composer chevron is now centered. Match favorites, role/model selection, supported reasoning levels, Plan and Auto prewalk against the same host and catalog, including persistence and startup application. Verify the picker with the keyboard open and closed.
- [ ] **New-chat typing and staged selections.** The simulator now accepts text in a new chat after switching from a focused saved chat, and returning to the saved chat preserves its draft. The first-prompt handoff of staged reasoning, Plan and Auto prewalk still needs verification.
- [x] **Saved-chat header.** One overflow, workspace breadcrumb, session context, and panel toggle. Checked the header on a saved chat. Long titles still need a matched [PWA 52](screenshots/baseline/52-long-conversation.png) capture.
- [x] **Ship placement and disabled states.** The existing dialog opens from the header on a qualifying non-default Git workspace. Ship remained visible but disabled both during a run and when the fixture worktree had nothing to ship.

## Chat polish

- [x] **Plan proposal review.** On the same isolated runner, the installed PWA and native iPhone both showed the pending plan. Native feedback requested revisions; the runner received `Add tests`, produced a new proposal, then accepted native approval and continued into implementation. A reload retained the completed transcript without exposing OMP's internal transition marker. Snapshot/event ordering and uncertain decision recovery have regression coverage.
- [x] **Context statistics.** The compact simulator panel matched the standalone PWA fixture's message counts, token totals, cache hit rate, model capacity, generation speed and agent/subagent costs. Statistics now come from one metadata-only read on the owning daemon; changed file generations are rejected instead of combining snapshots.
- [x] **Composer activity feedback.** Native shows the model's idle, waiting, streaming, and tooling phases without changing the Send/Stop controls. See the captures below for streaming and tooling. Queued and host-offline states still need matched PWA captures.
- [x] **Transcript glyphs.** Replaced text symbols for Copy, Markdown, Read, Edit, Fork, and Process details with line icons. Labels, order, and actions are unchanged.
- [x] **Tool-call timeline.** Native uses compact, category-colored line icons, intent and target previews, status and duration, with expandable command, input and result details. File and agent targets open on the owning host/session. A simulator pass checked the seeded timeline and a real failed Bash call; compare the dark capture with [PWA 04](screenshots/baseline/04-chat-process-expanded.png). The simulator and historical PWA baseline use different iPhone sizes and fixture revisions, so this is not a matched screenshot pair.
  - Relative file targets use the saved chat's cwd, not its workspace root. A simulator fixture with different files at both paths opened the session-local one.
- [x] **Tool activity while running and settling.** Native shows live and failed output in the existing in-place Process details. Tests exercise both end-frame races: a refresh after an end frame before the saved result arrives, and an end frame buffered during a refresh whose cursor already covers it.
  - Rendered transcript tests open live call B and its Process details, merge B into the saved group for call A, and then reconcile B's saved result. Both refresh timings preserve the open disclosures and show the result exactly once.
  - Scope retained results to the active host, session, and history view. Verify retention clears on navigation or a history edit so stale output cannot appear in another chat or branch.
- [ ] **Remaining composer overlays.** Compare [slash suggestions](screenshots/baseline/36-chat-slash-commands.png), attachment chips and the system picker with the same draft and catalog. Keep native clipboard consent.

## Navigation and workspace chrome

- [x] **Sidebar row controls and alignment.** Aligned add and action controls alongside the existing hierarchy rows. See [PWA 02](screenshots/baseline/02-sidebar.png) and the fresh native sidebar capture below.
- [ ] **Home and new-chat header states need a like-for-like pass.** Compare [Home](screenshots/baseline/01-home.png), [new chat](screenshots/baseline/25-new-session.png), and the native milestone captures with the same data. The new-chat PWA capture has a model-error banner and no available models; native was connected to the offline fixture. Don't count that fixture difference as missing UI.
- [ ] **Open sheets and expanded hierarchy are under-captured.** Capture the open [workspace tabs sheet](screenshots/baseline/28-workspace-tabs.png) with the same open and saved chats, the [Project](screenshots/baseline/26-new-session-project-picker.png) and [Workspace](screenshots/baseline/27-new-session-workspace-picker.png) pickers, and the [System expanded with an Effort](screenshots/baseline/43-system-efforts.png). Native has evidence for the tab trigger and Effort route, not these matching open states.

- [x] **Workspace panel and Git action row.** Aligned native toolbar icons and spacing with [Explorer](screenshots/baseline/05-explorer.png) and [Git](screenshots/baseline/06-git.png). Captured changed and clean Git states.
- [x] **Settings density.** Tightened Interface & Behavior spacing against [PWA 11](screenshots/baseline/11-settings-interface.png), preserving supported controls and larger text.
- [ ] **Archive and confirmations.** Pair the same archive selection and the same Edit/Fork target against [PWA 33](screenshots/baseline/33-archived-sessions.png), [53](screenshots/baseline/53-edit-confirmation.png), and [54](screenshots/baseline/54-fork-confirmation.png). The native captures establish that the flows exist, not that the controls and copy match.

## Native simulator evidence

Release captures on the iPhone 18 Pro simulator are under `ios/screenshots/parity/` (local, ignored by Git). Earlier passes used the historical PWA baselines; passes 13, 14 and 17 use the installed standalone PWA and native app against isolated fixtures.

| Pass | Capture directory | Observed |
| --- | --- | --- |
| Keyboard clearance | `01-keyboard/` | Standard software keyboard and saved chat; composer toolbar accessible. Dismissal video and sampled frames recorded. |
| Header and Ship | `02-header/` | Single overflow, workspace tabs, context, and panel controls. Ship opened from the header; it stayed visible and disabled during a real run and after the worktree became clean. |
| Model activity | `03-activity/`, `05-tool-state/running.png` | Streaming rate and Stop, idle after interruption, and tools elapsed during a real Bash call. |
| Transcript glyphs | `04-glyphs/`, `02-header/clean.png` | Copy, Markdown, Read, Edit and Fork kept their existing labels and positions. |
| Tool settlement | `05-tool-state/` | Real isolated runner with `--offline-model --failed-bash`; running and failed output captured. The two refresh timings have focused regression tests, not fault-injected simulator captures. |
| Composer overlays | `06-overlays/` | Slash suggestions above the software keyboard, model picker, and attachment options. Model catalog and attachment states aren't identical to the historical PWA captures. |
| Sidebar, Home and sheets | `07-sidebar/`, `08-home-new/`, `09-sheets/` | Home, new chat, open tab sheet, both location pickers, and a Ready Effort under the expanded System. |
| Workspace panel and Settings | `10-workspace/`, `11-settings/` | Explorer, Git controls in changed and clean fixture states, and Interface & Behavior. |
| Archive and confirmations | `12-confirmations/` | Archive surface and Edit/Fork dialogs opened. Archive selection and confirmation target are not matched with the PWA baseline. |
| Composer parity | `13-composer-pwa/` | Paired saved-chat and more-actions captures; native favorite survives app relaunch. A separate fixture chat's reasoning-enabled model accepted `high` in the running session. Plan and Auto prewalk were checked against the runner's `get_plan_state` and `get_auto_prewalk`. `keyboard-motion.mp4` records simulator opening and dismissal; the physical Write with Siri variant remains unverified. |
| Plan review | `14-plan-review/` | Same pending proposal in the standalone PWA and native app, revision feedback and revised plan, then native approval and a real runner implementation turn. |
| Keyboard and photos | `15-composer-photos/` | Software keyboard stayed open while typing in saved and new chats; switching back preserved the saved draft. Photo Library accepted two selected photos, including a HEIC supplied as JPEG, and both reached the fixture session. Files opened and cancelled without losing focus. Physical-iPhone verification remains open. |
| Focus A/B | `16-focus-ab/` | Same simulator, chat and software-keyboard setting; only the composer's `collapsable` flag changed. With the flag the keyboard remained open for five seconds; without it the composer lost focus. `without-flag-control.png` shows the software keyboard opening in the model search field on the comparison build. |
| Context and actions | `17-context-actions/` | Matched PWA/native session statistics and costs, compact native popup, aligned composer chevron, direct Photos and Files pickers. The selected HEIC was added as JPEG. |
| Long idle context | `18-long-context/` | A cold 1,790-message fixture returned the active-branch statistics in one 647-byte response in 20 ms on loopback, with no transcript body and no runner started. The simulator displayed all 1,790 messages and their totals. |
| Theme and chat switching | `19-theme-navigation/` | Compared the dark chat with the standalone PWA; switched native chat, context, actions and Settings between light and dark. `chat-switch.mp4` shows a return to the same reading position; a real background fixture run reattached while that position remained fixed. |
| Scroll following | `20-paseo-scroll/` | Real offline-runner output followed at the end; a reading drag held position during streaming and Jump resumed following. Disclosure trigger position stayed fixed, and a growing multiline draft didn't move the visible history. |
| Tool-call parity | `21-tool-calls/` | iPhone 18 Pro Max Release: seeded dark timeline, IRC details and agent-target navigation; real offline-runner Bash failure, expanded output and full-input toggle. `pwa-example-native.png` uses an isolated synthetic transcript based on the supplied PWA example, including thinking, hidden reminders, icons and timings; it is not a same-chat PWA/native pair. |

The simulator keyboard motion was sampled in `01-keyboard/open-close.mp4` and `13-composer-pwa/keyboard-motion.mp4`. The composer stayed above the standard software keyboard. This does not establish physical-iPhone motion or the Write with Siri geometry; leave those items open until checked on device.

## Capture before calling these states matched

- Header and composer: Home, new chat, saved idle (default and non-default workspace), waiting on the model, streaming, executing tools, queued follow-up, stopped, and host offline. For Ship include enabled, busy-disabled, and nothing-to-ship-disabled.
- Physical iPhone: keyboard opening and closing in new and saved chats, with and without Write with Siri; short and multiline drafts; model sheet and suggestion selection. Record motion for the outline bug.
- Use the same chat, workspace, theme, width, and model availability in each pair. The original baseline has no live response, streaming tool execution, reconnect, upload, or Ship capture. Use an isolated fixture, not production data.

## Keep out of this pass

Existing [release deferrals](IMPLEMENTATION-PLAN.md#release-decisions) remain in effect. In particular, don't treat deferred Notifications, dictation, Browser, or terminals as missing controls to add to the polish pass. Keep the current Markdown renderer, native system pickers, and accepted read-only file views. No transcript regrouping or composer redesign.

Known differences, not commitments for this pass: native search is flat and has no per-message drill-down ([PWA 31](screenshots/baseline/31-search-results.png)); the file viewer has Source/Preview but lacks the full PWA toolbar, language picker, and syntax highlighting ([PWA 38](screenshots/baseline/38-file-viewer.png), [39](screenshots/baseline/39-file-preview.png)); the Effort preview uses a native modal.
