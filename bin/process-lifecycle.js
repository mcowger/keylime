"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");

const forwardedSignals = ["SIGINT", "SIGTERM"];
// SIGHUP arrives when a CLI-run launcher loses its terminal (window closed,
// session ended). The child must die gracefully, not verbatim: a verbatim
// SIGHUP terminates Node without running exit handlers, orphaning the detached
// omp children it spawned. Translate it to a graceful SIGTERM tree kill.
const translatedSignals = { SIGHUP: "SIGTERM" };
const shutdownTimeoutMs = 5_000;
// Time to wait for a terminated process tree to actually exit (used as the
// default for terminateChildProcess and by the update worker's stop gate).
const STOP_TIMEOUT_MS = 5_000;

function getSignalExitCode(signal) {
  const signalNumber = signal ? os.constants.signals[signal] : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function killChildTree(child, force, gracefulSignal = "SIGTERM") {
  const signal = force ? "SIGKILL" : gracefulSignal;
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }

  try { child.kill(signal); } catch {}
}

function childHasExited(child) {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
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

async function terminateChildProcess(child, timeoutMs = STOP_TIMEOUT_MS) {
  if (childHasExited(child)) return true;
  const exited = waitForChildExit(child, timeoutMs);
  killChildTree(child, true);
  return exited;
}

function wireChildProcessLifecycle(child, parentProcess = process, timeoutMs = shutdownTimeoutMs, handleChildExit) {
  const signalHandlers = new Map();
  let shutdownTimer;
  const forceKill = () => killChildTree(child, true);
  const killChildOnSignal = (childSignal) => {
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

  child.once("exit", (code, signal) => {
    if (shutdownTimer) clearTimeout(shutdownTimer);

    for (const [forwardedSignal, handler] of signalHandlers) {
      parentProcess.removeListener(forwardedSignal, handler);
    }
    if (handleChildExit?.({ code, signal }) === true) return;

    parentProcess.exit(code ?? getSignalExitCode(signal));
  });
}

module.exports = { terminateChildProcess, wireChildProcessLifecycle };
