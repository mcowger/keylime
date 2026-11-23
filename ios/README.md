# Keylime for iPhone

This Expo and TypeScript app connects to the Keylime web server using the same Browser Link protocol as the PWA. Start with an isolated server for development.

See [iOS development instructions](AGENTS.md) for setup, compilation, and simulator testing.

The iPhone icon at `assets/icon.png` comes from `../public/icon.png`, scaled to 1024 pixels and flattened onto black for iOS.

In a chat, **More actions** offers Photo Library and Attach files directly. Photos use a compatible image representation when available; image formats that cannot be sent inline are attached as files.

Context statistics are read from the session's owning host without starting a runner. Update an older host daemon if the panel reports that statistics are unsupported.

For a real runner plan-review fixture, add `--offline-model --plan-review` to the `ios/tools/native-fixture.ts` command. Enter Plan mode and send a prompt; the fixture proposes a plan, revises it after feedback, and continues after approval.

See the [native iOS implementation plan](IMPLEMENTATION-PLAN.md) for milestones and PWA screenshot comparisons.

See the [iPhone UI parity inventory](UI-PARITY-INVENTORY.md) for visual and interaction gaps against the PWA.
