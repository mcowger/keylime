import { registerRootComponent } from "expo";
import { useCallback, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { ConnectionScreen } from "./ConnectionScreen";
import { HomeScreen } from "./HomeScreen";
import { useHomeInventory } from "./useHomeInventory";
import { useKeylimeConnection } from "./useKeylimeConnection";

function ConnectedHome({
  origin,
  onUnauthorized,
  onChangeServer,
}: {
  origin: string;
  onUnauthorized: () => void;
  onChangeServer: () => void;
}) {
  const { link, status } = useKeylimeConnection(origin, onUnauthorized);
  const { sessions, active, recent, error } = useHomeInventory(
    origin,
    link,
    onUnauthorized,
  );
  const dark = useColorScheme() !== "light";
  const foreground = dark ? "#F4F4F5" : "#221A14";
  return (
    <SafeAreaView
      style={[
        styles.container,
        { backgroundColor: dark ? "#000000" : "#FAF9F6" },
      ]}
    >
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <View
        style={[
          styles.header,
          {
            backgroundColor: dark ? "#0A0A0C" : "#F2F0EA",
            borderColor: dark ? "#29292E" : "#D6CFC1",
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change server"
          onPress={onChangeServer}
          style={styles.headerButton}
        >
          <Text style={[styles.menu, { color: foreground }]}>⋯</Text>
        </Pressable>
      </View>
      {status !== "open" && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, { color: foreground }]}
        >
          {status === "connecting"
            ? "Connecting…"
            : "Connection lost. Reconnecting…"}
        </Text>
      )}
      {sessions ? (
        <HomeScreen active={active} recent={recent} />
      ) : (
        <Text style={[styles.status, { color: foreground }]}>
          {error ? "Couldn't load chats." : "Loading…"}
        </Text>
      )}
    </SafeAreaView>
  );
}

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
    <ConnectedHome
      key={origin}
      origin={origin}
      onUnauthorized={onUnauthorized}
      onChangeServer={() => setChoosing(true)}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: {
    minWidth: 48,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  menu: { fontSize: 20, fontWeight: "700" },
  status: { paddingVertical: 10, paddingHorizontal: 16 },
});

registerRootComponent(App);
