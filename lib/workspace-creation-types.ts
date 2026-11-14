export type WorkspaceBranchMode = "local" | "remote" | "new";
export interface WorkspacePipeline {
  pre: string[];
  create: string[];
  post: string[];
}
export interface WorkspaceCreationSettings {
  defaults: WorkspacePipeline;
  override: WorkspacePipeline | null;
}
export interface WorkspaceSettingsRequest {
  projectPath?: string;
  defaults?: WorkspacePipeline;
  override?: WorkspacePipeline | null;
}
export interface WorkspaceCreateRequest {
  projectPath: string;
  branch: string;
  mode: WorkspaceBranchMode;
  baseRef: string;
  name: string;
}
export interface WorkspaceCreationJob {
  id: string;
  input: WorkspaceCreateRequest;
  pipeline: WorkspacePipeline;
  status: "running" | "complete" | "failed" | "interrupted";
  stage: "pre" | "create" | "post";
  logs: string;
  error?: string;
  workspacePath?: string;
  workspaceId?: string;
}
export interface WorkspaceBranches {
  local: string[];
  remote: string[];
  defaultRef: string;
}
export interface WorkspaceDeleteRequest {
  projectPath: string;
  path: string;
  stopProcesses: boolean;
  discardChanges: boolean;
  keepBranch?: boolean;
  cancel?: boolean;
}
export interface WorkspaceDeleteResult {
  status: "deleted" | "processes" | "dirty" | "branch" | "cancelled";
  processes?: Array<{ id: string; cwd: string }>;
  branch?: string;
}
