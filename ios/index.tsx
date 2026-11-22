import { registerRootComponent } from "expo";
import { useCallback, useState } from "react";
import { ConnectionScreen } from "./ConnectionScreen";
import { NavigationShell } from "./NavigationShell";

function App() {
  const [origin, setOrigin] = useState<string>();
  const [expired, setExpired] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const onUnauthorized = useCallback(() => setExpired(true), []);
  const onConnected = useCallback((value: string) => {
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

registerRootComponent(App);
