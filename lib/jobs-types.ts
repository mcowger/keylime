export interface JobActivity {
  id: string;
  incarnation: string;
  kind: "bash" | "task" | "eval" | "service";
  status: string;
  label: string;
  command?: string;
  ownerId?: string;
  agentId?: string;
  startTime: number;
  endTime?: number;
  canCancel: boolean;
}

export interface JobSnapshot {
  generation: string;
  jobs: JobActivity[];
  services: JobActivity[];
  servicesError?: string;
  available: boolean;
}

export interface JobDetail {
  id: string;
  incarnation: string;
  kind: JobActivity["kind"];
  generation: string;
  command?: string;
  cwd?: string;
  pids: number[];
  exitCode?: number;
  output: string;
  cursor: number;
  start: number;
  open: boolean;
  truncated: boolean;
}
