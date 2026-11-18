import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
import type { ProjectLaunchConfig } from "../lib/types";
const { render, cleanup, fireEvent, waitFor } =
  await import("@testing-library/react/pure.js");
const { ProjectLaunchConfigDialog } =
  await import("./RepoLaunchConfigDialog.tsx");
const { translate } = await import("../lib/i18n/index.tsx");
afterEach(cleanup);

test("the launch editor exposes legacy values and saves an explicit correction or clear", async () => {
  const saved: (ProjectLaunchConfig | null)[] = [];
  const props = {
    projectPath: "/workspace",
    initialConfig: {
      profile: "nova insight",
      extraArgs: ["--profile", "work"],
    },
    onClose() {},
    onSave: async (config: ProjectLaunchConfig | null) => {
      saved.push(config);
    },
  };
  const view = render(React.createElement(ProjectLaunchConfigDialog, props));
  const profile = view.getByDisplayValue("nova insight") as HTMLInputElement;
  const args = view.getByRole("textbox", {
    name: translate("projectLaunchConfig.extraArgsLabel"),
  }) as HTMLTextAreaElement;
  assert.equal(args.value, "--profile\nwork");
  const save = view.getByRole("button", {
    name: translate("projectLaunchConfig.save"),
  }) as HTMLButtonElement;
  assert.equal(profile.getAttribute("aria-invalid"), "true");
  assert.equal(save.disabled, true);
  fireEvent.change(profile, { target: { value: "work" } });
  fireEvent.change(args, { target: { value: "--verbose" } });
  fireEvent.click(save);
  await waitFor(() =>
    assert.deepEqual(saved[0], {
      profile: "work",
      advisor: undefined,
      extraArgs: ["--verbose"],
    }),
  );
  await waitFor(() => assert.equal(save.disabled, false));
  fireEvent.change(profile, { target: { value: "" } });
  fireEvent.change(args, { target: { value: "" } });
  await waitFor(() => assert.equal(save.disabled, false));
  fireEvent.click(save);
  await waitFor(() => assert.equal(saved[1], null));
});
