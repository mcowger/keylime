# iPhone app bootstrap

This Expo and TypeScript app displays only `Hello World`. It does not need a running Keylime server or an Expo account. Expo uses React Native for this prototype; it isn't a decision about the final app framework.

From the repository root, with mise installed:

```sh
mise trust
mise install
cd ios
mise exec -- bun install --frozen-lockfile
```

For a native simulator build, install Xcode with an iOS simulator runtime and put CocoaPods on `PATH`. The `ios` script runs Expo and its `node` subprocesses with Bun. No separate Node installation is needed.

```sh
mkdir -p "$HOME/.expo"
EXPO_NO_TELEMETRY=1 mise exec -- bun run ios --device "iPhone 18 Pro" --configuration Release --no-bundler
```

Use the name of an available iPhone from `xcrun simctl list devices available`. The command builds and installs a standalone simulator app with the JavaScript bundled inside it. It doesn't use Expo Go or a running Metro server. If Expo leaves the simulator on its Home Screen after installing, tap Keylime to launch it directly. Use a Debug build without `--no-bundler` for live reload.

Expo generates the Xcode project and installs Pods under `ios/ios/` (relative to the repository root). That directory is ignored. Change `app.json` rather than editing generated Xcode files.
