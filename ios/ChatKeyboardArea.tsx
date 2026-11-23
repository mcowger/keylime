import type { ReactNode } from "react";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

/** Keep the transcript and composer together as the native keyboard moves. */
export function ChatKeyboardArea({ children }: { children: ReactNode }) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      automaticOffset
    >
      {children}
    </KeyboardAvoidingView>
  );
}
