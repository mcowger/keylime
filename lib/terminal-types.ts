import type { Static } from "@sinclair/typebox";
import type * as M from "./api-contracts/workspace-models";
import type { TerminalEvent as SchemaTerminalEvent } from "./api-contracts/host-schemas";

/** Terminal process and screen are owned by the host daemon rather than a web connection. */
export type WorkspaceTerminal = Static<typeof M.WorkspaceTerminalSchema>;
/** Serialized terminal screen paired with the output cursor at snapshot time. */
export type TerminalSnapshot = Static<typeof M.TerminalSnapshotSchema>;
export type TerminalEvent = SchemaTerminalEvent;
