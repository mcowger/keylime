"use client";

import { useSyncExternalStore } from "react";

const KEY = "omp-chat-width";
const EVENT = "omp-chat-width-change";

function readWidth(): number {
  try {
    const value = localStorage.getItem(KEY);
    if (value === null) return 0;
    const width = Number(value);
    return Number.isInteger(width) && width >= 30 && width <= 100 ? width : 0;
  } catch {
    return 0;
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

export function setChatWidth(width: number): void {
  if (!Number.isInteger(width) || (width !== 0 && (width < 30 || width > 100)))
    return;
  try {
    if (width === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(width));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useChatWidth(): number {
  return useSyncExternalStore(subscribe, readWidth, () => 0);
}
