import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Every isolated test worker needs its own installation and socket. Keep the
// root short so sockets created inside other test fixtures also fit on macOS.
const root = mkdtempSync("/tmp/klt-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
for (const key of Object.keys(process.env)) {
  if (key === "KEYLIME_TEST_BROWSER") continue;
  if (/^(KEYLIME_|OMP_|PI_|XDG_)/.test(key)) delete process.env[key];
}
process.env.HOME = join(root, "home");
process.env.TMPDIR = join(root, "tmp");
process.env.XDG_RUNTIME_DIR = root;
process.env.KEYLIME_HOST_SOCKET = join(root, "host.sock");
mkdirSync(process.env.HOME);
mkdirSync(process.env.TMPDIR);
