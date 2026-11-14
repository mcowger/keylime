"use client";

import type { ExitedRpcSession } from "@/lib/types";
import en from "./locales/en.json";
export type Locale = "en";

const dictionary: Record<string, string> = en;

/** English UI copy lookup with optional template variables. */
export function translate(
  key: string,
  vars?: Record<string, string | number>,
): string {
  const template = dictionary[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** User-facing explanation for a retained unexpected process exit. */
export function formatExitedSessionNotice(exit: ExitedRpcSession): string {
  const status = exit.signal
    ? translate("sessionSidebar.exitSignal", { signal: exit.signal })
    : translate("sessionSidebar.exitCode", {
        code: exit.code ?? translate("sessionSidebar.exitUnknown"),
      });
  return translate("sessionSidebar.agentExited", {
    reason: exit.detail ? `${status}: ${exit.detail}` : status,
  });
}

/** Resolve English singular/plural copy with {count} available to the template. */
export function translatePlural(
  key: string,
  count: number,
  vars?: Record<string, string | number>,
): string {
  return translate(`${key}.${count === 1 ? "one" : "other"}`, {
    count,
    ...vars,
  });
}

/** Shared English copy helpers; no locale detection, storage, or subscriptions. */
export function useI18n() {
  return { locale: "en" as const, t: translate, tn: translatePlural };
}
