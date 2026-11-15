import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { isPortAvailable } from "../bin/port-availability";

test("reports a port occupied by another server", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen({ host: "127.0.0.1", port: 0 }, resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;

  try {
    assert.equal(await isPortAvailable(port, "127.0.0.1"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(await isPortAvailable(port, "127.0.0.1"), true);
});
