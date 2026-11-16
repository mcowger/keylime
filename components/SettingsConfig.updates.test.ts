import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { SettingsConfig } from "./SettingsConfig";

const noop = () => {};

/** Render the real System panel and record its HTTP boundary. */
async function renderSystemTab(
  t: TestContext,
  {
    appUpdate = null,
    onRequestAppUpdate = noop,
  }: {
    appUpdate?: ComponentProps<typeof SettingsConfig>["appUpdate"];
    onRequestAppUpdate?: () => void;
  },
) {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL) => {
      requests.push(String(url));
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(
      createElement(SettingsConfig, {
        activeTab: "system",
        toolCallsDefaultCollapsed: false,
        onToolCallsDefaultCollapsedChange: noop,
        hideToolActivity: false,
        onHideToolActivityChange: noop,
        neverFoldActivity: false,
        onNeverFoldActivityChange: noop,
        showToolCallsUnfolded: false,
        onShowToolCallsUnfoldedChange: noop,
        expandThinkingByDefault: "off",
        onExpandThinkingByDefaultChange: noop,
        onHideThinkingBlockChange: noop,
        providerUsageVisible: false,
        onProviderUsageVisibleChange: noop,
        scopeNativeSelectAll: false,
        onScopeNativeSelectAllChange: noop,
        openUrlAutomatically: false,
        onOpenUrlAutomaticallyChange: noop,
        cwd: null,
        remoteHost: false,
        cluster: false,
        sessionId: null,
        onModelsSaved: noop,
        onPluginsReloaded: noop,
        appUpdate,
        onRefreshAppUpdate: async () => appUpdate,
        onRequestAppUpdate,
        onSelectTab: noop,
        onClose: noop,
      }),
    );
  });
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  return { container, requests };
}

const buttonLabels = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((button) =>
    (button.textContent ?? "").trim(),
  );

test("System keeps web-server updates but never checks or updates the host runtime", async (t) => {
  let requested = false;
  const { container, requests } = await renderSystemTab(t, {
    appUpdate: {
      currentVersion: "0.6.0",
      availableVersion: "0.7.0",
      updateAvailable: true,
      selfUpdateSupported: true,
    },
    onRequestAppUpdate: () => {
      requested = true;
    },
  });
  assert.ok(container.querySelector("h2")?.textContent === "System");
  const updateButton = [...container.querySelectorAll("button")].find(
    (button) => (button.textContent ?? "").trim() === "Update and restart",
  );
  assert.ok(updateButton);
  act(() => updateButton.click());
  assert.equal(requested, true);
  assert.ok(!buttonLabels(container).includes("Restart OMP sessions"));
  assert.ok(!container.textContent?.includes("OMP runtime"));
  assert.ok(
    container.textContent?.includes("Resume running sessions after a restart"),
  );
  assert.ok(!requests.includes("/api/omp-update"), requests.join(", "));
});

test("a binary install's ompweb update links the release page instead of showing a command", async (t) => {
  const releases = "https://github.com/ompweb-dev/ompweb/releases/latest";
  const appUpdate = {
    currentVersion: "0.6.0",
    availableVersion: "0.7.0",
    updateAvailable: true,
    selfUpdateSupported: false,
  };
  const { container: binary } = await renderSystemTab(t, {
    appUpdate: {
      ...appUpdate,
      installMethod: "binary",
      updateCommand: releases,
    },
  });
  const link = binary.querySelector<HTMLAnchorElement>(`a[href="${releases}"]`);
  assert.ok(link, "no link to the release page");
  assert.equal(link.target, "_blank");
  assert.match(link.rel, /\bnoopener\b/);
  assert.ok(
    ![...binary.querySelectorAll("code")].some(
      (code) => code.textContent === releases,
    ),
    "the release page is shown as a command",
  );

  const { container: bun } = await renderSystemTab(t, {
    appUpdate: {
      ...appUpdate,
      installMethod: "bun",
      updateCommand: "bun add -g @kahme247/ompweb",
    },
  });
  assert.ok(
    [...bun.querySelectorAll("code")].some(
      (code) => code.textContent === "bun add -g @kahme247/ompweb",
    ),
    "the Bun command is gone",
  );
});

test("a host's omp row shows the omp its ompweb shipped and offers no update of its own", async (t) => {
  const { HostUpdates } = await import("./HostUpdates");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        ompweb: {
          currentVersion: "0.6.0",
          availableVersion: "0.7.0",
          updateAvailable: true,
          canUpdate: true,
          blockedReason: null,
          updateCommand: "bun add -g @kahme247/ompweb",
          installMethod: "bun",
          protocolVersion: 10,
        },
        omp: { currentVersion: "18.20.0-int.202611130355.gd2c2eff" },
        operation: null,
      }),
    { preconnect: originalFetch.preconnect },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(
      createElement(HostUpdates, {
        host: {
          id: "box",
          label: "Box",
          status: "online",
          ompVersion: "omp/18.20.0-int.202611130355.gd2c2eff",
          ompwebVersion: "0.6.0",
          platform: null,
          lastSeenAt: null,
          allowAgentStart: false,
          shareCredentials: false,
          hostVersion: null,
          serverVersion: 10,
          workspaceOps: [],
        },
      }),
    );
  });
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  assert.ok(
    container.textContent?.includes("18.20.0-int.202611130355.gd2c2eff"),
    container.textContent ?? "",
  );
  assert.ok(
    container.textContent?.includes("Updated with key lime"),
    container.textContent ?? "",
  );
  assert.deepEqual(
    buttonLabels(container).filter((label) => label === "Update"),
    ["Update"],
    "only ompweb has an update button",
  );
});
