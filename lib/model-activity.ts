export type ModelActivity = {
  kind: "idle" | "waiting" | "streaming" | "tools";
  startedAt: number;
  rate: number;
  version: number;
  epoch: number;
};

export const IDLE_MODEL_ACTIVITY: ModelActivity = {
  kind: "idle",
  startedAt: 0,
  rate: 0,
  version: 0,
  epoch: 0,
};

export function readModelActivity(value: unknown): ModelActivity | null {
  if (!value || typeof value !== "object") return null;
  const activity = value as Record<string, unknown>;
  if (
    !["idle", "waiting", "streaming", "tools"].includes(
      String(activity.kind),
    ) ||
    typeof activity.startedAt !== "number" ||
    !Number.isFinite(activity.startedAt) ||
    typeof activity.rate !== "number" ||
    !Number.isFinite(activity.rate) ||
    typeof activity.version !== "number" ||
    !Number.isFinite(activity.version) ||
    typeof activity.epoch !== "number" ||
    !Number.isFinite(activity.epoch)
  )
    return null;
  return activity as ModelActivity;
}
