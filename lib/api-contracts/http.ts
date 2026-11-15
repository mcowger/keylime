import { hostHttpOperations } from "./host-http";
import { sessionHttpOperations } from "./http-sessions";
import { workspaceHttpOperations } from "./http-workspaces";
import { configurationHttpOperations } from "./http-configuration";
import { systemHttpOperations } from "./http-system";

/** Exhaustive source registry; generation compares it with every exported method in server/routes.ts. */
export const httpOperations = [
  ...hostHttpOperations,
  ...sessionHttpOperations,
  ...workspaceHttpOperations,
  ...configurationHttpOperations,
  ...systemHttpOperations,
];
