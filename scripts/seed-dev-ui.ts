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

const skillDir = path.join(process.env.HOME!, ".agents", "skills", "atlas-review");
mkdirSync(skillDir, { recursive: true });
writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: atlas-review\ndescription: Review Atlas changes\n---\n\nReview the workspace changes.\n");

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
writeFileSync(
  path.join(repo, "browser-fixture.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas browser fixture</title>
<style>body{margin:0;font:18px system-ui;color:#213331;background:#f3f8f3}header,main{padding:36px max(32px,8vw)}header{min-height:760px;background:#174f48;color:white}h1{font-size:54px}h2{font-size:38px}section{max-width:900px}.cards{display:flex;gap:20px;flex-wrap:wrap}.card{background:white;border:1px solid #cfddd4;border-radius:12px;padding:24px;flex:1;min-width:200px}strong{color:#087f66}</style></head>
<body><header><p>ATLAS / DEVELOPMENT PREVIEW</p><h1>Workspace overview</h1><p>This introduction sits above the browser fixture's initial scroll position.</p></header>
<div aria-label="Video motion fixture" style="position:fixed;right:20px;top:20px;width:120px;height:16px;overflow:hidden;background:#d8e9df;border-radius:8px"><div style="width:24px;height:16px;background:#087f66;animation:fixture-motion 1s linear infinite alternate"></div></div><style>@keyframes fixture-motion{from{transform:translateX(0)}to{transform:translateX(96px)}}</style>
<main><section id="details"><p>ATLAS / LIVE BROWSER</p><h2>Scrolled project dashboard</h2><p>This section is below the fold. The live browser viewer should show this heading, not the overview above.</p><div class="cards"><div class="card"><strong>12 projects</strong><p>Active workspace projects</p></div><div class="card"><strong>98% indexed</strong><p>Search coverage</p></div><div class="card"><strong>All systems ready</strong><p>Latest deployment</p></div></div><h3>Interactive controls</h3><p><label>Project note <input id="note" placeholder="Type a note" style="font:inherit;padding:10px;max-width:90%"></label></p><p><button id="counter" style="font:inherit;padding:10px">Clicks: 0</button></p><p><a href="https://example.com">Example site</a></p></section></main>
<script>addEventListener('load', () => document.getElementById('details').scrollIntoView()); let count = 0; document.getElementById('counter').addEventListener('click', event => { event.currentTarget.textContent = 'Clicks: ' + ++count; });</script></body></html>`,
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
    advisor: "Consider **edge cases** before changing `search`.",
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
    ...("advisor" in session && session.advisor
      ? [{
          type: "message",
          id: "00000004",
          parentId: "00000003",
          timestamp,
          message: { role: "custom", customType: "advisor", display: true, content: session.advisor, details: { notes: [{ note: session.advisor, severity: "concern" }] }, timestamp: 1767225602000 },
        }]
      : []),
    ...("advisor" in session && session.advisor
      ? [{
          type: "message",
          id: "00000005",
          parentId: "00000004",
          timestamp,
          message: { role: "custom", customType: "lsp-late-diagnostic", display: true, content: `<system-notice>\nLate LSP diagnostics arrived after the edit returned:\n${repo}/src/index.ts — 1 error(s), 1 warning(s)\n${repo}/src/index.ts:12:8 [error] [ts] Type 'string' is not assignable to type 'number'.\n  The expected type comes from the return value.\n${repo}/src/index.ts:15:3 [warning] [eslint] Unused variable 'result'.\n</system-notice>`, timestamp: 1767225603000 },
        }]
      : []),
    ...("advisor" in session && session.advisor
      ? [
          { type: "message", id: "00000006", parentId: "00000005", timestamp, message: { role: "custom", customType: "async-result", display: true, content: `<system-notice>\nBackground job bg_1 completed.\n${repo}/src/index.ts\nA long result with preserved line breaks and a path that wraps on narrow screens.\n  Indented output remains intact.\n</system-notice>`, details: { jobs: [{ jobId: "bg_1", type: "task", status: "completed", label: "Search review", durationMs: 194633 }] }, timestamp: 1767225604000 } },
          { type: "message", id: "00000007", parentId: "00000006", timestamp, message: { role: "custom", customType: "developer", display: true, content: '<system-reminder reason="rule_violation" rule="example">\nReview **error handling** before continuing.\n</system-reminder>', details: { rule: "example" }, timestamp: 1767225605000 } },
          { type: "message", id: "00000008", parentId: "00000007", timestamp, message: { role: "custom", customType: "job-result", display: true, content: "Search review finished.", details: { jobs: [{ jobId: "bg_2", type: "task", status: "failed", label: "Index check", durationMs: 211815 }] }, timestamp: 1767225606000 } },
          { type: "message", id: "00000009", parentId: "00000008", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "hub-seed", name: "hub", arguments: { op: "send", to: "SearchReview", message: "# Search review\n\nPlease check **error handling** and the `src/index.ts` path.\n\n- Check empty queries.\n- Report any failures." } }], timestamp: 1767225607000 } },
          { type: "message", id: "0000000a", parentId: "00000009", timestamp, message: { role: "toolResult", toolCallId: "hub-seed", toolName: "hub", content: [{ type: "text", text: "Delivered to SearchReview" }], details: { op: "send", receipts: [{ to: "SearchReview", outcome: "injected" }] }, timestamp: 1767225608000 } },
          { type: "message", id: "0000000b", parentId: "0000000a", timestamp, message: { role: "custom", customType: "irc:incoming", display: true, content: "<irc>\nIncoming IRC message from agent `SearchReview`:\n# Search review findings\n\n**Error handling** needs a closer look in `src/index.ts`.\n\n- Empty queries return no results.\n- Failed lookups should show an error.\n\nSee [the project readme](README.md) for context.", timestamp: 1767225609000 } },
        ]
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
