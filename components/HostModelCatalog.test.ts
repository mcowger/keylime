import "../tests/setup-dom.ts";
import { cleanup, render, within } from "@testing-library/react/pure.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import type { HostModels } from "@/lib/api-contracts/configuration-models";
import { translate } from "@/lib/i18n";
import { HostModelCatalog } from "./HostModelCatalog";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const emptyCatalog: HostModels = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  anthropicSlowMode: false,
};
const hostId = "linked & remote";

function mockResponse(response: Response) {
  const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, options?: RequestInit) => {
      calls.push([url, options]);
      return response;
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
}

test("reads and displays only the selected host's default and catalog", async () => {
  const calls = mockResponse(
    Response.json({
      ...emptyCatalog,
      defaultModel: { provider: "remote-provider", modelId: "default-only" },
      modelList: [
        { provider: "remote-provider", id: "model-a", name: "Remote A" },
      ],
    } satisfies HostModels),
  );
  const view = render(createElement(HostModelCatalog, { hostId }));
  await view.findByText("remote-provider/default-only");
  assert.ok(
    within(view.getByRole("list")).getByText("remote-provider/model-a"),
  );
  assert.equal(view.queryByRole("button"), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "/api/models?hostId=linked+%26+remote");
  assert.equal(calls[0]?.[1]?.method ?? "GET", "GET");
});

test("shows an empty catalog without inferring a default", async () => {
  mockResponse(Response.json(emptyCatalog));
  const view = render(createElement(HostModelCatalog, { hostId }));
  await view.findByText(translate("hostModelCatalog.empty"));
  assert.ok(view.getByText(translate("hostModelCatalog.noDefault")));
});

for (const { status, body, message } of [
  { status: 501, body: { code: "host_upgrade_required" }, message: "upgrade" },
  { status: 503, body: { hostOffline: true }, message: "offline" },
  { status: 500, body: { error: "Internal failure" }, message: "error" },
  {
    status: 200,
    body: { ...emptyCatalog, modelError: "Model load failed" },
    message: "error",
  },
]) {
  test(`shows ${message} for a host catalog response with status ${status}`, async () => {
    const calls = mockResponse(Response.json(body, { status }));
    const view = render(createElement(HostModelCatalog, { hostId }));
    await view.findByText(translate(`hostModelCatalog.${message}`));
    assert.equal(view.queryByRole("list"), null);
    assert.equal(view.queryByText(translate("hostModelCatalog.empty")), null);
    assert.equal(calls.length, 1);
  });
}
