import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeHostLink } from "@/lib/hosts/hub";
import { linkHost, linkLocalHost } from "@/lib/hosts/link-driver.test-helper";
import { closeUsageDatabase } from "@/lib/usage-db";
import { getUsageReport } from "@/lib/usage-service";
import { GET } from "./route";

test("usage only queries the selected daemon, with omission selecting the local daemon", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "keylime-usage-route-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    closeUsageDatabase();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const local = await linkLocalHost({ hello: { canReportUsage: true } });
  t.after(() => closeHostLink(local.id));
  const linked = await linkHost("Linked report", {
    hello: { canReportUsage: true },
  });
  t.after(() => closeHostLink(linked.id));
  const old = await linkHost("Older daemon");
  t.after(() => closeHostLink(old.id));

  const empty = await getUsageReport();
  const calls: { hostId: string; args: Record<string, unknown> }[] = [];
  for (const [link, scannedAt] of [
    [local, 1],
    [linked, 2],
  ] as const) {
    void link.serve({
      usageReport: (args) => {
        calls.push({ hostId: link.id, args });
        return { ...empty, scanInfo: { ...empty.scanInfo, scannedAt } };
      },
    });
  }

  const read = (params = "") =>
    GET(new Request(`http://keylime.test/api/usage${params}`));
  const localResponse = await read();
  assert.equal(localResponse.status, 200);
  assert.equal((await localResponse.json()).scanInfo.scannedAt, 1);
  const linkedResponse = await read(
    `?hostId=${linked.id}&range=all&granularity=projects&project=workspace&from=100&to=200&refresh=1`,
  );
  assert.equal(linkedResponse.status, 200);
  assert.equal((await linkedResponse.json()).scanInfo.scannedAt, 2);

  const unsupported = await read(`?hostId=${old.id}`);
  assert.equal(unsupported.status, 501);
  const upgrade = await unsupported.json();
  assert.equal(upgrade.code, "host_upgrade_required");
  assert.match(upgrade.error, /Upgrade Older daemon/);

  closeHostLink(linked.id);
  const offline = await read(`?hostId=${linked.id}`);
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).code, "host_offline");
  const unknown = await read("?hostId=no-such-daemon");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "host_not_found");

  assert.deepEqual(calls, [
    {
      hostId: local.id,
      args: { range: "30d", granularity: "daily", forceRefresh: false },
    },
    {
      hostId: linked.id,
      args: {
        range: "all",
        granularity: "projects",
        project: "workspace",
        from: 100,
        to: 200,
        forceRefresh: true,
      },
    },
  ]);
});
