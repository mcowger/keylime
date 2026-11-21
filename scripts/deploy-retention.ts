import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

const RETAIN_RELEASES = 3;
const GENERATED_RELEASE = /^[0-9a-f]{12}-(\d{13})$/;

export function pruneDeployReleases(base: string, previous: string[]): void {
  const protectedPaths = [...previous];
  for (const name of ["current", "frontend-current"]) {
    const pointer = path.join(base, name);
    if (lstatSync(pointer, { throwIfNoEntry: false }))
      protectedPaths.push(realpathSync(pointer));
  }

  for (const name of ["releases", "frontend-releases"]) {
    const rootPath = path.join(base, name);
    const rootStat = lstatSync(rootPath, { throwIfNoEntry: false });
    if (!rootStat) continue;
    if (!rootStat.isDirectory())
      throw new Error(`Not a release directory: ${rootPath}`);
    const root = realpathSync(rootPath);
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && GENERATED_RELEASE.test(entry.name),
      )
      .sort((a, b) => {
        const timestamp = Number(b.name.slice(13)) - Number(a.name.slice(13));
        return timestamp || b.name.localeCompare(a.name);
      });
    for (const entry of entries.slice(RETAIN_RELEASES)) {
      const release = path.join(root, entry.name);
      if (
        protectedPaths.some((target) => {
          const relative = path.relative(release, target);
          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          );
        })
      )
        continue;
      rmSync(release, { recursive: true });
      console.log(`Removed old release: ${release}`);
    }
  }
}
