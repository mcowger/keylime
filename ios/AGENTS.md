# iOS development

The Expo app is a standalone `Hello World` prototype. It doesn't need a Keylime server or an Expo account. Keep app source and dependencies under `ios/`. Expo generates the Xcode project and installs Pods under `ios/ios/` from the repository root. That directory is ignored; change `app.json`, not the generated Xcode files.

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
