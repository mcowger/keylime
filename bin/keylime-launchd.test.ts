import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_LABEL,
  LABEL,
  buildHostEnv,
  buildPlist,
} from "./keylime-launchd.ts";

const env = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/Users/u/agent" };

test("the host daemon plist runs `keylime host`, restarts with KeepAlive, and is throttled", () => {
  const plist = buildPlist({
    label: HOST_LABEL,
    args: [
      "/usr/local/bin/bun",
      "x",
      "--bun",
      "@mcowger/keylime@latest",
      "host",
    ],
    env,
    logName: "keylime-host",
    throttleInterval: 10,
  });
  assert.equal(HOST_LABEL, "com.kahme247.keylime-host");
  assert.match(
    plist,
    /<key>Label<\/key><string>com\.kahme247\.keylime-host<\/string>/,
  );
  assert.match(
    plist,
    /<string>@mcowger\/keylime@latest<\/string>\n    <string>host<\/string>\n  <\/array>/,
  );
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(
    plist,
    /<key>PI_CODING_AGENT_DIR<\/key><string>\/Users\/u\/agent<\/string>/,
  );
  assert.match(plist, /keylime-host\.log<\/string>/);
});

test("the web plist keeps its arguments and has no throttle", () => {
  const plist = buildPlist({
    label: LABEL,
    args: ["/usr/local/bin/bun", "x", "--bun", "pkg & co"],
    env,
    logName: "keylime",
  });
  assert.match(plist, /<string>pkg &amp; co<\/string>\n  <\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /ThrottleInterval/);
  assert.doesNotMatch(plist, /<string>host<\/string>/);
});

test("the host env carries PATH, the omp binary and the agent dir, but no web settings", () => {
  const all = buildHostEnv({
    svcPath: "/usr/bin",
    ompBin: "/opt/omp/bin/omp",
    agentDir: "/Users/u/agent",
  });
  assert.deepEqual(all, {
    PATH: "/usr/bin",
    KEYLIME_OMP_BIN: "/opt/omp/bin/omp",
    PI_CODING_AGENT_DIR: "/Users/u/agent",
  });
  assert.deepEqual(buildHostEnv({ svcPath: "/usr/bin" }), { PATH: "/usr/bin" });
});
