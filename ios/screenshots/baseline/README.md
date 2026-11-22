# iPhone PWA baseline

Captured from the installed Home Screen web app on an iPhone 18 Pro simulator, iOS 27.2. PNGs are 1206 × 2622 pixels (402 × 874 points, 3×). The app used the isolated seeded `bun run dev` environment, not production data. Screenshots use the dark appearance.

## Coverage

- `01–10`: Home, sidebar, saved chat and expanded process details, Explorer, Git, Scripts, Notifications, Activity and Jobs.
- `11–23`: Settings categories, including a scrolled Interface & Behavior view and repo workspace setup.
- `24–33`: Systems navigation, new-session selectors, workspace switcher and terminal, search and archive.
- `34–40`: Chat model picker, keyboard and slash suggestions, attachments, file source and preview, and chat actions.
- `41–50`: System and effort creation, effort preview and root, effort navigation, and add-repo picker. The created system and effort existed only in the temporary development environment.
- `51`: Settings search with no results.
- `52–56`: Long saved conversation, Edit and Fork confirmations, and model selection after the runner was built and the isolated server restarted.
- `57–61`: Browser workspace switcher, live fixture view, Take control, an action error, and Release control. The fixture ran on a third isolated seeded server on the same URL.

## Observed behavior

- Mobile navigation uses an overlay sidebar; workspace tabs use a bottom sheet. The workspace side panel replaces the chat view and has a horizontally scrollable tab strip.
- Chat process details expand in place. The composer shows slash suggestions above the keyboard. Edit and Fork each require confirmation; their dialogs describe different history effects.
- Search accepts a query with the keyboard open; the archive opens as a dialog. Markdown files have source and preview views.
- System creation and effort preview use separate forms. Creating the isolated effort returned to the sidebar; opening it showed its root and member repositories.
- Before the runner build, the seeded host reported `omp-missing` and model roles were unavailable. After restarting the isolated server on the same URL, the host reported online and the model picker showed a catalog. The development environment has separate credentials from the operator's installation.
- The Browser tab displayed the live Chromium fixture. Take control changed the button to Release control and exposed a browser text input; releasing it restored Take control. Tapping the fixture's counter in control mode produced “Browser action failed or the address is invalid”; the counter remained at zero. The error remained visible after releasing control. The underlying cause was not investigated.

## Limits

This is a broad baseline, not exhaustive coverage of every state. It does not include an authenticated login, a live model response or streaming/tool execution, remote-host failure and reconnect, uploads, notifications delivered by a push service, voice transcription, shipping, or all settings scroll positions and dialogs. Successful browser input was not established: the captured counter tap failed. No real provider credentials or production sessions were used. Each server restart used a separate temporary seeded home; screenshot paths and IDs are not stable fixtures. Other `ios/screenshots/` paths remain ignored by Git.
