# iPhone UI parity inventory

The installed Keylime PWA is the visual reference. Keep Keylime's layout, colors, and interaction order. Paseo is a reference for native polish, not a redesign. This is a list of gaps to address or recapture, not an implementation plan.

The [PWA baseline](screenshots/baseline/README.md) is a dark-mode iPhone 18 Pro capture set. Native milestone and release captures are local artifacts, not checked in. They show the build and fixture at the time, so current source and physical-iPhone reports take precedence. A screenshot pair below identifies the comparison to make; it doesn't imply that both captures show the same state.

## Fix first

- [ ] **Composer hidden by the keyboard.** On the reported physical iPhone, the keyboard with Write with Siri visible covers the toolbar and part of the composer. [PWA 35](screenshots/baseline/35-chat-keyboard.png) keeps the whole card above the keyboard. The earlier native `milestone-2/native/keyboard.png` has a focused field but no visible software keyboard; it doesn't cover the failure.
- [ ] **Pink focus outline trails the composer.** Motion defect reported on the phone, not something a still can prove. Keep the focus treatment and check that the border stays attached to the card during keyboard appearance and dismissal.
  - Simulator evidence: `screenshots/parity/01-keyboard/native-after.png` and `transition.mp4`. The saved chat's Send button ended at y=540 pt with the iOS keyboard's Q row at y=597 pt. This does not verify the physical-iPhone Writing Tools variant.
- [x] **Saved-chat header.** One overflow, workspace breadcrumb, session context, and panel toggle. Checked the header on a saved chat. Long titles still need a matched [PWA 52](screenshots/baseline/52-long-conversation.png) capture.
- [x] **Ship placement and disabled states.** The existing dialog opens from the header on a qualifying non-default Git workspace. Ship remained visible but disabled both during a run and when the fixture worktree had nothing to ship.

## Chat polish

- [x] **Composer activity feedback.** Native shows the model's idle, waiting, streaming, and tooling phases without changing the Send/Stop controls. See the captures below for streaming and tooling. Queued and host-offline states still need matched PWA captures.
- [x] **Transcript glyphs.** Replaced text symbols for Copy, Markdown, Read, Edit, Fork, and Process details with line icons. Labels, order, and actions are unchanged.
- [x] **Tool activity while running and settling.** Native shows live and failed output in the existing in-place Process details. Tests exercise both end-frame races: a refresh after an end frame before the saved result arrives, and an end frame buffered during a refresh whose cursor already covers it.
  - Rendered transcript tests open live call B and its Process details, merge B into the saved group for call A, and then reconcile B's saved result. Both refresh timings preserve the open disclosures and show the result exactly once.
  - Scope retained results to the active host, session, and history view. Verify retention clears on navigation or a history edit so stale output cannot appear in another chat or branch.
- [ ] **Composer overlays need matched keyboard captures.** [Slash suggestions](screenshots/baseline/36-chat-slash-commands.png), [attachments](screenshots/baseline/37-chat-attachments.png), and the [online model picker](screenshots/baseline/55-online-model-picker.png) have native counterparts, but native photo picker/paste captures aren't the same state as a PWA composer attachment menu. Compare card and sheet placement, chip styling, and enabled controls with the same draft and catalog. Keep the system picker and clipboard consent.

## Navigation and workspace chrome

- [x] **Sidebar row controls and alignment.** Aligned add and action controls alongside the existing hierarchy rows. See [PWA 02](screenshots/baseline/02-sidebar.png) and the fresh native sidebar capture below.
- [ ] **Home and new-chat header states need a like-for-like pass.** Compare [Home](screenshots/baseline/01-home.png), [new chat](screenshots/baseline/25-new-session.png), and the native milestone captures with the same data. The new-chat PWA capture has a model-error banner and no available models; native was connected to the offline fixture. Don't count that fixture difference as missing UI.
- [ ] **Open sheets and expanded hierarchy are under-captured.** Capture the open [workspace tabs sheet](screenshots/baseline/28-workspace-tabs.png) with the same open and saved chats, the [Project](screenshots/baseline/26-new-session-project-picker.png) and [Workspace](screenshots/baseline/27-new-session-workspace-picker.png) pickers, and the [System expanded with an Effort](screenshots/baseline/43-system-efforts.png). Native has evidence for the tab trigger and Effort route, not these matching open states.

- [x] **Workspace panel and Git action row.** Aligned native toolbar icons and spacing with [Explorer](screenshots/baseline/05-explorer.png) and [Git](screenshots/baseline/06-git.png). Captured changed and clean Git states.
- [x] **Settings density.** Tightened Interface & Behavior spacing against [PWA 11](screenshots/baseline/11-settings-interface.png), preserving supported controls and larger text.
- [ ] **Archive and confirmations.** Pair the same archive selection and the same Edit/Fork target against [PWA 33](screenshots/baseline/33-archived-sessions.png), [53](screenshots/baseline/53-edit-confirmation.png), and [54](screenshots/baseline/54-fork-confirmation.png). The native captures establish that the flows exist, not that the controls and copy match.

## Native simulator evidence

Release captures on the iPhone 18 Pro simulator are under `ios/screenshots/parity/` (local, ignored by Git). The comparisons use the existing standalone PWA baselines unless noted; no new matched PWA session was captured.

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

The keyboard motion was sampled on the simulator, including open and close (`01-keyboard/open-close.mp4`). No disconnected outline is visible in those samples. Write with Siri and the transition on a physical iPhone remain unverified.

## Capture before calling these states matched

- Header and composer: Home, new chat, saved idle (default and non-default workspace), waiting on the model, streaming, executing tools, queued follow-up, stopped, and host offline. For Ship include enabled, busy-disabled, and nothing-to-ship-disabled.
- Physical iPhone: keyboard opening and closing in new and saved chats, with and without Write with Siri; short and multiline drafts; model sheet and suggestion selection. Record motion for the outline bug.
- Use the same chat, workspace, theme, width, and model availability in each pair. The original baseline has no live response, streaming tool execution, reconnect, upload, or Ship capture. Use an isolated fixture, not production data.

## Keep out of this pass

Existing [release deferrals](IMPLEMENTATION-PLAN.md#release-decisions) remain in effect. In particular, don't treat deferred Notifications, dictation, Browser, or terminals as missing controls to add to the polish pass. Keep the current Markdown renderer, native system pickers, and accepted read-only file views. No transcript regrouping or composer redesign.

Known differences, not commitments for this pass: native search is flat and has no per-message drill-down ([PWA 31](screenshots/baseline/31-search-results.png)); the file viewer has Source/Preview but lacks the full PWA toolbar, language picker, and syntax highlighting ([PWA 38](screenshots/baseline/38-file-viewer.png), [39](screenshots/baseline/39-file-preview.png)); the Effort preview uses a native modal.
