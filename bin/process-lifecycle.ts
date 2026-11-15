"use strict";

import os from "node:os";
import type { EventEmitter } from "node:events";

type Child = EventEmitter & {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
};
type Parent = EventEmitter & { exit(code: number): unknown };

const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
// SIGHUP arrives when a CLI-run launcher loses its terminal (window closed,
// session ended). The child must die gracefully, not verbatim: a verbatim
// SIGHUP terminates Node without running exit handlers, orphaning the detached
// omp children it spawned. Translate it to a graceful SIGTERM tree kill.
const translatedSignals: Record<string, NodeJS.Signals> = { SIGHUP: "SIGTERM" };
const shutdownTimeoutMs = 5_000;
// Time to wait for a terminated process tree to actually exit (used as the
// default for terminateChildProcess and by the update worker's stop gate).
const STOP_TIMEOUT_MS = 5_000;

function getSignalExitCode(signal: NodeJS.Signals | null): number {
  const signalNumber = signal ? os.constants.signals[signal] : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function killChildTree(
  child: Child,
  force: boolean,
  gracefulSignal: NodeJS.Signals = "SIGTERM",
): void {
  const signal = force ? "SIGKILL" : gracefulSignal;
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }

  try {
    child.kill(signal);
  } catch {}
}

function childHasExited(child: Child): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForChildExit(child: Child, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

export async function terminateChildProcess(
  child: Child,
  timeoutMs = STOP_TIMEOUT_MS,
): Promise<boolean> {
  if (childHasExited(child)) return true;
  const exited = waitForChildExit(child, timeoutMs);
  killChildTree(child, true);
  return exited;
}

export function wireChildProcessLifecycle(
  child: Child,
  parentProcess: Parent = process,
  timeoutMs = shutdownTimeoutMs,
  handleChildExit?: (exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => boolean | void,
): void {
  const signalHandlers = new Map<string, () => void>();
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const forceKill = () => killChildTree(child, true);
  const killChildOnSignal = (childSignal: NodeJS.Signals) => {
    if (shutdownTimer) {
      forceKill();
      return;
    }
    shutdownTimer = setTimeout(forceKill, timeoutMs);
    shutdownTimer.unref?.();
    killChildTree(child, false, childSignal);
  };
  for (const signal of forwardedSignals) {
    const handler = () => killChildOnSignal(signal);
    signalHandlers.set(signal, handler);
    parentProcess.on(signal, handler);
  }
  for (const [signal, childSignal] of Object.entries(translatedSignals)) {
    const handler = () => killChildOnSignal(childSignal);
    signalHandlers.set(signal, handler);
    parentProcess.on(signal, handler);
  }

  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (shutdownTimer) clearTimeout(shutdownTimer);

    for (const [forwardedSignal, handler] of signalHandlers) {
      parentProcess.removeListener(forwardedSignal, handler);
    }
    if (handleChildExit?.({ code, signal }) === true) return;

    parentProcess.exit(code ?? getSignalExitCode(signal));
  });
}
