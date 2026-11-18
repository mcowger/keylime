import type { SystemsHosts } from "../components/SystemsHost";

export const noSystemsSidebar = {
  systemsHosts: {
    byHost: {},
    async run() {
      throw new Error("This sidebar fixture has no Systems");
    },
  } satisfies SystemsHosts,
  onOpenEffort() {},
};
