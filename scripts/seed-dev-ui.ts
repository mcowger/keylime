import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hierarchyOperation } from "../lib/hosts/project-hierarchy";
import { getSessionDirNameForCwd, getSessionsDir } from "../lib/omp/paths";
import { saveWebServerSettings } from "../lib/web-settings";

// Invoked only by the dev launcher, before the host starts and caches its hierarchy.
const root = process.env.KEYLIME_UI_FIXTURE_ROOT;
if (
  !root ||
  process.env.HOME !== path.join(root, "home") ||
  process.env.PI_CODING_AGENT_DIR !== path.join(root, "home", ".omp", "agent")
)
  throw new Error("UI fixtures require the isolated dev launcher");

const projectsDir = path.join(root, "projects");
mkdirSync(projectsDir, { recursive: true });
const projects = realpathSync(projectsDir);
const repo = path.join(projects, "atlas");
const worktree = path.join(projects, "atlas-feature");
const notes = path.join(projects, "field-notes");
mkdirSync(repo);
mkdirSync(notes);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.name", "UI Fixture");
git("config", "user.email", "fixture@example.invalid");
writeFileSync(
  path.join(repo, "README.md"),
  "# Atlas\n\nA sample project for UI testing.\n",
);
mkdirSync(path.join(repo, "src"));
writeFileSync(
  path.join(repo, "src", "index.ts"),
  'export const greeting = "Hello from Atlas";\n',
);
git("add", ".");
git("commit", "-m", "Initial fixture");
git("worktree", "add", "-b", "feature/search", worktree);
writeFileSync(
  path.join(worktree, "notes.md"),
  "# Search\n\nUntracked work in progress.\n",
);
writeFileSync(
  path.join(notes, "ideas.md"),
  "# Field notes\n\nA non-Git workspace.\n",
);

const sessions = [
  {
    cwd: repo,
    id: "11111111-1111-4111-8111-111111111111",
    title: "Plan the Atlas project",
    tasks: [
      { content: "Plan the project", status: "completed" },
      { content: "Review the plan", status: "completed" },
    ],
  },
  {
    cwd: worktree,
    id: "22222222-2222-4222-8222-222222222222",
    title: "Improve search",
    tasks: [
      { content: "Inspect search", status: "completed" },
      { content: "Improve search results", status: "in_progress" },
    ],
  },
  {
    cwd: notes,
    id: "33333333-3333-4333-8333-333333333333",
    title: "Organize field notes",
  },
];
for (const session of sessions) {
  const dir = path.join(getSessionsDir(), getSessionDirNameForCwd(session.cwd));
  mkdirSync(dir, { recursive: true });
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries = [
    {
      type: "session",
      version: 3,
      id: session.id,
      cwd: session.cwd,
      timestamp,
    },
    {
      type: "message",
      id: "00000001",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: session.title,
        timestamp: 1767225600000,
      },
    },
    {
      type: "message",
      id: "00000002",
      parentId: "00000001",
      timestamp,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "This is a sample conversation for UI testing.",
          },
        ],
        timestamp: 1767225601000,
      },
    },
    ...("tasks" in session && session.tasks
      ? [{
          type: "custom",
          id: "00000003",
          parentId: "00000002",
          timestamp,
          customType: "user_todo_edit",
          data: { phases: [{ name: "Tasks", tasks: session.tasks }] },
        }]
      : []),
  ];
  writeFileSync(
    path.join(dir, `2026-01-01_${session.id}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}
async function hierarchy(input: Parameters<typeof hierarchyOperation>[0]) {
  const result = await hierarchyOperation(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const atlas = await hierarchy({ action: "registerProject", path: repo });
const project = atlas.projects.find((item) => item.name === "atlas");
if (!project) throw new Error("Atlas registration failed");
await hierarchy({
  action: "importWorkspaces",
  projectId: project.id,
  paths: [worktree],
});
const all = await hierarchy({ action: "registerProject", path: notes });
for (const session of sessions) {
  const workspace = all.projects
    .flatMap((item) => item.workspaces)
    .find((item) => item.path === session.cwd);
  if (!workspace) throw new Error(`Missing workspace: ${session.cwd}`);
  await hierarchy({
    action: "importSessions",
    workspaceId: workspace.id,
    sessionIds: [session.id],
  });
}
saveWebServerSettings({ uploadRetentionDays: 14, agentToolsEnabled: true });
console.log(
  "[dev] UI fixtures seeded: atlas, atlas-feature, field-notes (3 saved conversations)",
);
