"use client";

import { useId, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

export function ReasoningEffortSlider({
  levels,
  value,
  labels,
  disabled,
  leading,
  onChange,
}: {
  levels: string[];
  value: string;
  labels?: Record<string, string | null> | null;
  disabled: boolean;
  leading?: ReactNode;
  onChange?: (value: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const manual = levels.filter((level) => level !== "auto");
  const index = manual.indexOf(value);
  return (
    <fieldset className="effort-slider" disabled={disabled} aria-label={t("chatInput.reasoningLabel")}>
      <div className="effort-slider-layout" data-leading={Boolean(leading)}>
        {leading && <div className="effort-leading">{leading}</div>}
        {onChange && (
          <div className="effort-reasoning">
            <div className="effort-heading">{t("chatInput.reasoningLabel")}</div>
            <div className="effort-reasoning-controls">
        {onChange && (
          <button
            type="button"
            className="effort-detent effort-auto"
            aria-pressed={value === "auto"}
            onClick={() => onChange("auto")}
          >
            <span className="effort-notch" aria-hidden="true" />
            <span>Auto</span>
          </button>
        )}
        {onChange && manual.length > 0 && (
          <div
            className="effort-manual"
            data-auto={index < 0}
            style={{ "--effort-count": manual.length } as CSSProperties}
          >
            <div className="effort-track">
              <div className="effort-track-line" aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={Math.max(1, manual.length - 1)}
                step={1}
                value={Math.max(0, index)}
                disabled={disabled || manual.length === 1}
                aria-label={t("chatInput.changeReasoning")}
                aria-valuetext={
                  value === "auto" ? "Auto" : (labels?.[value] ?? value)
                }
                list={id}
                onChange={(event) => {
                  const level = manual[Number(event.target.value)];
                  if (level && !disabled) onChange(level);
                }}
              />
              <datalist id={id}>
                {manual.map((level, at) => (
                  <option
                    key={level}
                    value={at}
                    label={labels?.[level] ?? level}
                  />
                ))}
              </datalist>
            </div>
            <div className="effort-detents">
              {manual.map((level) => (
                <button
                  type="button"
                  className="effort-detent"
                  key={level}
                  aria-pressed={value === level}
                  title={labels?.[level] ?? level}
                  onClick={() => onChange(level)}
                >
                  <span className="effort-notch" aria-hidden="true" />
                  <span className="effort-detent-label">
                    {labels?.[level] ?? level}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
            </div>
          </div>
        )}
      </div>
    </fieldset>
  );
}
