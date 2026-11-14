import type { ProjectLaunchConfig, SessionInfo } from "./types";

export interface HierarchyWorkspace {
  id: string;
  projectId: string;
  path: string;
  name: string;
  isDefault: boolean;
  branch?: string;
  sessionIds: string[];
  unavailable?: boolean;
  setup?: {
    status: "running" | "failed" | "complete" | "interrupted";
    jobId: string;
    stage?: string;
    error?: string;
  };
}
export interface HierarchyProject {
  id: string;
  path: string;
  name: string;
  kind: "git" | "directory";
  addedAt: string;
  launchConfig?: ProjectLaunchConfig;
  alias?: string;
  sortOrder?: number;
  pinOrder?: number;
  workspaces: HierarchyWorkspace[];
}
export interface HierarchySnapshot {
  selectedProjectId?: string;
  projects: HierarchyProject[];
  workspaceCandidates?: {
    path: string;
    name: string;
    branch?: string;
    isDefault: boolean;
  }[];
  sessionCandidates?: SessionInfo[];
}
export interface HierarchyRequest {
  action:
    | "list"
    | "registerProject"
    | "unregisterProject"
    | "updateProject"
    | "discoverWorkspaces"
    | "importWorkspaces"
    | "unregisterWorkspace"
    | "discoverSessions"
    | "importSessions"
    | "unregisterSession"
    | "registerSession"
    | "moveSession";
  projectId?: string;
  workspaceId?: string;
  path?: string;
  paths?: string[];
  sessionId?: string;
  sessionIds?: string[];
  cwd?: string;
  from?: string;
  to?: string;
  alias?: string | null;
  sortOrder?: number | null;
  pinOrder?: number | null;
  launchConfig?: ProjectLaunchConfig | null;
}
