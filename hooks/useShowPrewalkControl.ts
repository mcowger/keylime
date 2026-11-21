"use client";

import { useSyncExternalStore } from "react";

const KEY = "keylime:show-prewalk-control";
const EVENT = "keylime:show-prewalk-control-change";

function readPreference(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setShowPrewalkControl(show: boolean): void {
  try {
    localStorage.setItem(KEY, String(show));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useShowPrewalkControl(): boolean {
  return useSyncExternalStore(subscribe, readPreference, () => true);
}
