import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename } from "path";
import {
  getSkillToggleRoots,
  loadSkillsWithInstallInfo,
  loadUserSkillsWithInstallInfo,
  parseSkillFrontmatter,
  readDisableModelInvocation,
  setDisableModelInvocation,
} from "@/lib/skills-service";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
} from "@/lib/file-access";

// GET /api/skills?cwd=<path>
// Lists what omp resolves (`omp skill list --json`), falling back to a scan
// of omp's skill roots on binaries that predate the command. Each skill
// carries `togglable`, the same check PATCH applies. Without a cwd: the user
// level only.
/**
 * @apiContract getSkills
 * @apiUsage List skills with install information and toggle eligibility.
 * @apiInputs Optional cwd must be allowed.
 * @apiInvariants Without cwd only user-level skills are listed; discovery uses omp or a filesystem fallback.
 * @apiEffects Reads skill files and may run omp listing.
 * @apiRecovery Correct access or discovery errors and repeat the read.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) {
    try {
      return Response.json(await loadUserSkillsWithInstallInfo());
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json(
        { error: "Access denied", code: "access_denied" },
        { status: 403 },
      );
    }
    return Response.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
/**
 * @apiContract patchSkills
 * @apiUsage Toggle disable-model-invocation in a skill's frontmatter.
 * @apiInputs Provide filePath ending in SKILL.md and disableModelInvocation; cwd may add allowed project roots.
 * @apiInvariants The resolved path must be in an allowed writable skill root; plugin and registry skills are read-only.
 * @apiEffects Writes the resolved file only when content changes and returns the resulting setting.
 * @apiRecovery Re-read the skill after an uncertain response before retrying.
 */
export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      filePath: string;
      disableModelInvocation: boolean;
      cwd?: string;
    };
    const { filePath, disableModelInvocation, cwd } = body;
    if (!filePath)
      return Response.json(
        { error: "filePath required", code: "file_path_required" },
        { status: 400 },
      );
    if (basename(filePath) !== "SKILL.md") {
      return Response.json(
        { error: "not a SKILL.md file", code: "not_a_skill_file" },
        { status: 400 },
      );
    }
    if (!existsSync(filePath))
      return Response.json(
        { error: "file not found", code: "file_not_found" },
        { status: 404 },
      );
    // Every user-owned root the scanner reads must be writable here, or skills
    // in the compat dirs (~/.agents/skills — where the app's own global
    // installs land, ~/.claude/skills, ~/.codex/skills, managed-skills) could
    // be listed but never toggled. Session cwds cover the project-scope roots;
    // an optional cwd (already an allowed root) adds the project walk-up roots.
    // Plugin/registry skills stay read-only (see getSkillToggleRoots).
    const allowedRoots = await getSkillToggleRoots(cwd);
    // Resolve symlinks once up front and authorize the resolved path: the
    // read/write below then operate on the same resolved path, so a symlink
    // swapped between the authorization check and the write cannot redirect
    // it outside the checked roots.
    const resolvedFilePath = realpathSync(filePath);
    if (!isExistingFilePathAllowed(resolvedFilePath, allowedRoots)) {
      return Response.json(
        { error: "Access denied", code: "access_denied" },
        { status: 403 },
      );
    }

    const content = readFileSync(resolvedFilePath, "utf8");
    const updated = setDisableModelInvocation(content, disableModelInvocation);
    if (updated !== content) writeFileSync(resolvedFilePath, updated, "utf8");

    // Report what the file now says rather than what was asked for.
    const { frontmatter } = parseSkillFrontmatter(updated);
    return Response.json({
      success: true,
      disableModelInvocation: readDisableModelInvocation(frontmatter),
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
