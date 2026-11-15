import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { followDeployment } from "./deploy-follow";
import { saveDeployState } from "./deploy-state";

async function scenario(phase: "complete" | "failed" | "crash") {
  const base = mkdtempSync(path.join(tmpdir(), "keylime-follow-"));
  const log = path.join(base, "deploy.log");
  const id = "test-deployment";
  saveDeployState(base, {
    id,
    pid: process.pid,
    phase: "building",
    updatedAt: "now",
  });
  const fd = openSync(log, "w");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { writeFileSync, renameSync } = require("node:fs");
    console.log("first line");
    await new Response(Bun.stdin.stream()).text();
    if (${JSON.stringify(phase)} !== "crash") {
      writeFileSync(${JSON.stringify(path.join(base, "next.json"))}, JSON.stringify({id:${JSON.stringify(id)}, phase:${JSON.stringify(phase)}, pid:process.pid, updatedAt:"now"}));
      renameSync(${JSON.stringify(path.join(base, "next.json"))}, ${JSON.stringify(path.join(base, "deployment.json"))});
    }
    console.log("final line ☘");
    process.exit(${phase === "complete" ? 0 : 1});
  `,
    ],
    { stdin: "pipe", stdout: fd, stderr: fd },
  );
  closeSync(fd);
  let output = "";
  let released = false;
  try {
    const result = followDeployment(base, id, log, child, (bytes) => {
      output += Buffer.from(bytes).toString("utf8");
      if (!released && output.includes("first line\n")) {
        released = true;
        child.stdin.end();
      }
    });
    if (phase === "crash") {
      await expect(result).rejects.toThrow("without a terminal status");
    } else {
      expect((await result).phase).toBe(phase);
    }
    expect(output).toBe("first line\nfinal line ☘\n");
  } finally {
    await child.exited;
    rmSync(base, { recursive: true, force: true });
  }
}

test("follows output through successful completion", () =>
  scenario("complete"));
test("follows output through a reported failure", () => scenario("failed"));
test("reports a crashed worker after draining its log", () =>
  scenario("crash"));
