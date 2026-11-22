# iOS development

The Expo app currently shows `Hello World` and doesn't need a Keylime server or an Expo account. Keep app source and dependencies under `ios/`. Expo generates the Xcode project and installs Pods under `ios/ios/`. That directory is ignored; change `app.json`, not the generated Xcode files.

## Keylime API contracts

The native client talks to the Keylime **web server**, like the PWA. The web server routes host operations to the correct daemon. Don't connect directly to daemon hosts or use the host-link or runner-channel contracts.

| Contract | Use | Generated module |
| --- | --- | --- |
| [Web HTTP OpenAPI](../docs/api/web-http.openapi.json) | HTTP requests and responses, including auth and SSE entry points | `generated/web-http.ts` |
| [Browser Link AsyncAPI](../docs/api/browser-link.asyncapi.json) | WebSocket commands, replies, events, and framing at `/api/events/link` | `generated/browser-link.ts` |
| [Terminal Attach AsyncAPI](../docs/api/terminal-attach.asyncapi.json) | Dedicated terminal WebSocket at `/api/terminal/attach`, if using that endpoint | `generated/terminal-attach.ts` |

The checked-in documents come from [`lib/api-contracts/`](../lib/api-contracts/) and server route annotations. Update those sources and run `mise exec -- bun run api` from the repo root when changing a contract. Don't edit the documents or generated iOS types by hand.

From `ios/`, after dependency installation:

```sh
mise exec -- bun run api:types
```

Run this after a fresh checkout before checking or building code that imports generated types, and again when the API documents change. `generated/` is ignored. Use `import type`: HTTP types come from `paths` or `operations`, and WebSocket payloads from `components["schemas"]` in each module. Generation doesn't provide a transport or runtime validation. Read the contract's operation descriptions for auth, message direction, framing, and recovery.

AsyncAPI directions are from the server's perspective: `receive` is client → server, and `send` is server → client. `BrowserUploadBinary` is an `ArrayBuffer` sent as a raw WebSocket frame, not a JSON or base64 string. Follow the schema's framing description when assembling its bytes.

## Bring up the app

Use macOS with Xcode, an installed iOS simulator runtime, CocoaPods on `PATH`, and mise. The `ios` script uses the pinned Bun for Expo and its `node` subprocesses; don't install Node or npm for this app.

From the repository root:

```sh
mise trust && mise install
cd ios
mise exec -- bun install --frozen-lockfile
mkdir -p "$HOME/.expo"
```

Run the remaining commands from `ios/`. Find a simulator name or UDID with `xcrun simctl list devices available` and substitute it for `iPhone 18 Pro` as needed.

```sh
EXPO_NO_TELEMETRY=1 mise exec -- bun run ios --device "iPhone 18 Pro" --configuration Debug
```

Debug starts Metro for live reload. Use `--configuration Release --no-bundler` in place of `--configuration Debug` to build and install a standalone app with embedded JavaScript. No Expo Go or running Metro server is needed for Release.

## Compile without launching

```sh
EXPO_NO_TELEMETRY=1 mise exec -- bun run ios --device generic --configuration Release --no-bundler --output dist
```

This compiles for the generic iOS simulator and writes `dist/Keylime.app` without installing it. It isn't a physical-device or App Store build.

## Test and verify

```sh
mise exec -- bun check -p tsconfig.json
```

There is no automated iOS test suite yet. For smoke testing, build and install the Release app and verify that the simulator actually shows `Hello World`. If Expo leaves the simulator on its Home Screen after installing, tap Keylime or run `xcrun simctl launch <SIMULATOR_UDID> com.mcowger.keylime`.

A cold simulator can take tens of seconds to boot, and app launch and accessibility can take several more seconds. Wait for `xcrun simctl bootstatus <SIMULATOR_UDID> -b` and then for the app's text before calling the smoke check failed. An accessibility timeout immediately after boot can be a readiness issue; allow about 20 more seconds and retry the snapshot if needed.

For MobileBuildMCP, check session defaults first. Use the generated `ios/Keylime.xcworkspace` (relative to this directory), scheme `Keylime`, configuration `Release`, and the chosen simulator with `build_run_sim`. After launch, use `wait_for_ui` with `predicate: "textContains"` and `text: "Hello World"`.

## Load the Keylime PWA in iOS Simulator

This is the Keylime web app, not the Expo app. From the repository root, after the root dependency install, start the seeded web server and leave it running:

```sh
mise exec -- bun run dev
```

In a second terminal at the repository root, choose a simulator UDID from `xcrun simctl list devices available`. Run `boot` only if the selected simulator is shut down. The simulator can reach the Mac's loopback address directly; use the exact URL printed by this dev run.

```sh
SIM='<simulator-UDID>'
URL='http://127.0.0.1:<printed-port>/'
xcrun simctl boot "$SIM"  # skip if already booted
xcrun simctl bootstatus "$SIM" -b
xcrun simctl openurl "$SIM" "$URL"
```

`simctl` can boot and navigate a simulator without showing a Mac window. For manual taps, run `open -a Simulator` if the Simulator GUI is installed. If it isn't, use MobileBuildMCP or AXe to interact with the booted simulator; `simctl` screenshots work headlessly.

Allow several seconds for Safari to open and render. To launch without Safari's address bar, open **Page Menu → Share** in Safari on iOS 27.2. In the share sheet, tap **View More** if needed, then scroll to **Add to Home Screen**. Leave **Open as Web App** on, tap **Add**, and open the **key lime** icon from the Home Screen. The seeded Home page should show recent chats such as **Plan the Atlas project**. The icon keeps the original URL, including the random port; add a new icon after restarting the dev server on a different port.

On the tested iOS 27.2 simulator, Safari showed a Bun development overlay (`Script error.`) while the installed Home Screen app rendered the seeded page without it. Verify and capture the standalone app rather than the Safari tab when testing the PWA.

### Take a screenshot

Bring the page or app you want to capture to the foreground, wait for its content to render, then run:

```sh
mkdir -p screenshots
xcrun simctl io "$SIM" screenshot screenshots/keylime-pwa.png
```

This saves a full-resolution PNG on the Mac. Use the explicit UDID when multiple simulators are booted. `screenshots/` is ignored by Git except for `screenshots/baseline/`.
