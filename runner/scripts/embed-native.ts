import { promises as fs } from "node:fs";
import path from "node:path";

const runnerDir = path.resolve(import.meta.dir, "..");

async function readVersion(manifestPath: string): Promise<string> {
  const manifest: unknown = await Bun.file(manifestPath).json();
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error(`${manifestPath} has no version`);
  }
  return String(manifest.version);
}

/** Embed the target's prebuilt pi-natives addons for extraction by its runtime loader. */
export async function embeddedAddonFiles(target: { platform: string; arch: string }): Promise<Record<string, string | Uint8Array>> {
  const nativesDir = await fs.realpath(path.join(path.dirname(path.dirname(Bun.resolveSync("@oh-my-pi/pi-natives", runnerDir))), "native"));
  const platformTag = `${target.platform}-${target.arch}`;
  const leafPackage = `@oh-my-pi/pi-natives-${platformTag}`;
  let leafManifest: string;
  try {
    leafManifest = Bun.resolveSync(`${leafPackage}/package.json`, nativesDir);
  } catch (error) {
    throw new Error(`${leafPackage} is not installed; run \`bun install --os=${target.platform} --cpu=${target.arch}\``, { cause: error });
  }
  const version = await readVersion(path.join(nativesDir, "..", "package.json"));
  const leafVersion = await readVersion(leafManifest);
  if (leafVersion !== version) throw new Error(`${leafPackage}@${leafVersion} does not match pi-natives@${version}`);
  const leafDir = path.dirname(leafManifest);
  const candidates = target.arch === "x64"
    ? [
        { variant: "modern", filename: `pi_natives.${platformTag}-modern.node` },
        { variant: "baseline", filename: `pi_natives.${platformTag}-baseline.node` },
      ]
    : [{ variant: "default", filename: `pi_natives.${platformTag}.node` }];
  const present = new Set(await fs.readdir(leafDir));
  const available = await Promise.all(candidates.filter((candidate) => present.has(candidate.filename)).map(async (candidate) => ({
    ...candidate,
    bytes: await Bun.file(path.join(leafDir, candidate.filename)).bytes(),
  })));
  if (available.length === 0) throw new Error(`${leafPackage} has no pi_natives addon in ${leafDir}`);
  // These large addons dominate build time at zstd's highest levels.
  const frames = await Promise.all(
    available.map(({ bytes }) => Bun.zstdCompress(bytes, { level: 6 })),
  );
  const imports = available.map(({ filename }, index) =>
    `import zstdPath${index} from ${JSON.stringify(`./${filename}.zst`)} with { type: "file" };`,
  );
  const files = available.map(({ variant, filename, bytes }, index) =>
    `{ variant: ${JSON.stringify(variant)}, filename: ${JSON.stringify(filename)}, size: ${bytes.length}, zstdPath: zstdPath${index} }`,
  );
  const overrides: Record<string, string | Uint8Array> = {
    [path.join(nativesDir, "embedded-addon.js")]: `${imports.join("\n")}
export const embeddedAddon = {
\tplatformTag: ${JSON.stringify(platformTag)},
\tversion: ${JSON.stringify(version)},
\tfiles: [${files.join(", ")}],
};
`,
  };
  available.forEach(({ filename }, index) => {
    overrides[path.join(nativesDir, `${filename}.zst`)] = frames[index];
  });
  return overrides;
}
