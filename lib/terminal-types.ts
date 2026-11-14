export interface WorkspaceTerminal {
  id: string;
  cwd: string;
  title: string;
  cols: number;
  rows: number;
}

export interface TerminalSnapshot {
  terminal: WorkspaceTerminal;
  snapshot: string;
  cursor: number;
}

export type TerminalEvent =
  | { type: "resize"; cols: number; rows: number; cursor: number }
  | { type: "disconnected" }
  | { type: "output"; data: string; cursor: number }
  | { type: "closed" };
