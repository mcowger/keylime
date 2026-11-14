import { expect, test, spyOn } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelActivityIndicator } from "./ModelActivityIndicator";

test("activity uses unitless numeric readouts with descriptive accessible states", () => {
  const clock = spyOn(Date, "now").mockReturnValue(10_000);
  try {
    for (const [kind, visible, label, icon] of [
      ["idle", null, "Idle", "circle"],
      ["waiting", "2.5", "Waiting for model: 2.5 seconds", "loader-circle"],
      [
        "streaming",
        "86",
        "Streaming: approximately 86 tokens per second",
        "zap",
      ],
      ["tools", "2.5", "Running tools: 2.5 seconds", "wrench"],
    ] as const) {
      const html = renderToStaticMarkup(
        <ModelActivityIndicator
          activity={{ kind, startedAt: 7500, rate: 86, version: 1, epoch: 1 }}
        />,
      );
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`lucide-${icon}`);
      if (visible !== null)
        expect(html).toContain(`aria-hidden="true">${visible}</span>`);
      expect(html).not.toMatch(/>[^<]*(?:tk\/s|seconds|Tools…|Idle)[^<]*</);
    }
  } finally {
    clock.mockRestore();
  }
});
