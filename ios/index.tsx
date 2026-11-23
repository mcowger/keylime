import { registerRootComponent } from "expo";
import { File, Paths } from "expo-file-system";
import { useCallback, useState } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { normalizeOrigin } from "./keylime-http";
import { ConnectionScreen } from "./ConnectionScreen";
import { NavigationShell } from "./NavigationShell";

const keylimeOriginFile = () => new File(Paths.document, "keylime-origin.txt");

function loadOrigin() {
  try {
    const file = keylimeOriginFile();
    if (file.exists) return normalizeOrigin(file.textSync());
  } catch {
    // An invalid or unreadable setting cannot identify a server.
  }
}
function App() {
  const [origin, setOrigin] = useState(loadOrigin);
  const [expired, setExpired] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const onUnauthorized = useCallback(() => setExpired(true), []);
  const onConnected = useCallback((value: string) => {
    try {
      keylimeOriginFile().writeSync(value);
    } catch {
      /* keep the current session in memory */
    }
    setOrigin(value);
    setExpired(false);
    setChoosing(false);
  }, []);

  if (!origin || expired || choosing) {
    return (
      <ConnectionScreen
        onConnected={onConnected}
        expiredOrigin={expired && !choosing ? origin : undefined}
        onCancel={origin && !expired ? () => setChoosing(false) : undefined}
      />
    );
  }
  return (
    <NavigationShell
      key={origin}
      origin={origin}
      onUnauthorized={onUnauthorized}
      onChangeServer={() => setChoosing(true)}
    />
  );
}

function Root() {
  return (
    <KeyboardProvider preload={false}>
      <App />
    </KeyboardProvider>
  );
}

registerRootComponent(Root);
