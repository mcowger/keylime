import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { BrowserLink } from "./browser-link";

export type ConnectionStatus =
  "connecting" | "open" | "disconnected" | "unauthorized";

export function useKeylimeConnection(
  origin: string,
  onUnauthorized: () => void,
) {
  const onUnauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [link] = useState(
    () =>
      new BrowserLink(origin, {
        onStatus(next) {
          setStatus(next);
          if (next === "unauthorized") onUnauthorizedRef.current();
        },
      }),
  );

  useEffect(() => {
    link.connect();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") link.reconnect();
      previous = state;
    });
    return () => {
      subscription.remove();
      link.close();
    };
  }, [link]);

  return { link, status };
}
