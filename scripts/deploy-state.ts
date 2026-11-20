import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type DeployState = {
  id: string;
  pid: number;
  phase: string;
  updatedAt: string;
  candidate?: string;
  previous?: string;
  error?: string;
  [key: string]: unknown;
};
export function saveDeployState(base: string, state: DeployState): void {
  const target = path.join(base, "deployment.json");
  const temporary = `${target}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  const dir = openSync(base, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function readDeployState(base: string): DeployState | null {
  try {
    return JSON.parse(readFileSync(path.join(base, "deployment.json"), "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}
