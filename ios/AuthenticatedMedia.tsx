import { useEffect, useState } from "react";
import { Image, Text, useColorScheme, type ImageProps } from "react-native";
import { loadNativeMedia, removeNativeMedia } from "./native-network";

type MediaState =
  | { key: string; status: "loading" }
  | { key: string; status: "error" }
  | { key: string; status: "ready"; id: string; uri: string };

export type AuthenticatedMediaProps = Omit<ImageProps, "source"> & {
  origin: string;
  /** A relative /api/media/<hash> path, with optional hostId and thumb query parameters. */
  path: string;
};

/** Loads protected tool images using the selected server's native cookie jar. */
export function AuthenticatedMedia({
  origin,
  path,
  onError,
  ...imageProps
}: AuthenticatedMediaProps) {
  const key = JSON.stringify([origin, path]);
  const [state, setState] = useState<MediaState>({ key, status: "loading" });
  const dark = useColorScheme() !== "light";

  useEffect(() => {
    const abort = new AbortController();
    let file: string | undefined;
    setState({ key, status: "loading" });
    void loadNativeMedia(origin, path, abort.signal).then(
      (result) => {
        if (abort.signal.aborted) {
          void removeNativeMedia(result.id).catch(() => {});
          return;
        }
        file = result.id;
        setState({ key, status: "ready", ...result });
      },
      () => {
        if (!abort.signal.aborted) setState({ key, status: "error" });
      },
    );
    return () => {
      abort.abort();
      if (file) void removeNativeMedia(file).catch(() => {});
    };
  }, [origin, path, key]);

  if (state.key !== key || state.status === "loading")
    return (
      <Text style={{ color: dark ? "#929299" : "#746D66" }}>
        Loading image…
      </Text>
    );
  if (state.status === "error")
    return (
      <Text
        accessibilityRole="alert"
        style={{ color: dark ? "#929299" : "#746D66" }}
      >
        Image unavailable
      </Text>
    );
  return (
    <Image
      {...imageProps}
      source={{ uri: state.uri }}
      onError={(event) => {
        void removeNativeMedia(state.id).catch(() => {});
        setState({ key, status: "error" });
        onError?.(event);
      }}
    />
  );
}
