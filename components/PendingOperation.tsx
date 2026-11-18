import { Loader2 } from "lucide-react";

export function PendingOperation({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}) {
  return (
    <span
      role="status"
      title={compact ? label : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
