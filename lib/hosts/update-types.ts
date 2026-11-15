import type { Static } from "@sinclair/typebox";
import type {
  HostUpdateTargetSchema,
  HostUpdateCompatibilitySchema,
  HostSoftwareUpdateSchema,
  HostUpdateOperationSchema,
  HostUpdateInfoSchema,
} from "../api-contracts/host-update-models";

export type HostUpdateTarget = Static<typeof HostUpdateTargetSchema>;
export type HostUpdateCompatibility = Static<
  typeof HostUpdateCompatibilitySchema
>;
export type HostSoftwareUpdate = Static<typeof HostSoftwareUpdateSchema>;
export type HostUpdateOperation = Static<typeof HostUpdateOperationSchema>;
export type HostUpdateInfo = Static<typeof HostUpdateInfoSchema>;
