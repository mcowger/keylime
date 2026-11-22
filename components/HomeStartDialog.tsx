"use client";

import { useState } from "react";
import type { SystemRecord } from "@/lib/api-contracts/systems";
import type { ManagedProject } from "@/lib/types";
import { LOCAL_HOST_ID, hostProjectKey } from "@/lib/project-ordering";
import {
  EffortCreator,
  SystemsButton,
  SystemsDialog,
  systemsStack,
} from "./SystemsForms";
import type { SystemsHosts } from "./SystemsHost";

export function HomeStartDialog({
  kind,
  projects,
  systemsHosts,
  hostNames,
  availableHosts,
  onClose,
  onNewWorkspace,
  onEffortCreated,
  onAddRepo,
}: {
  kind: "workspace" | "effort";
  projects: ManagedProject[];
  systemsHosts: SystemsHosts;
  hostNames: Record<string, string>;
  availableHosts: ReadonlySet<string>;
  onClose: () => void;
  onNewWorkspace: (project: ManagedProject) => void;
  onEffortCreated: (host: string, effortId: string) => void;
  onAddRepo: () => void;
}) {
  const [selected, setSelected] = useState<{
    host: string;
    system: SystemRecord;
  } | null>(null);
  const repos = projects.filter(
    (project) => project.projectKind === "git" && project.isDefaultWorkspace,
  );
  const systems = Object.entries(systemsHosts.byHost).flatMap(
    ([host, state]) =>
      state.error
        ? []
        : (state.data?.systems ?? [])
            .filter((system) => !system.archived)
            .map((system) => ({ host, system })),
  );

  if (selected) {
    const current = systemsHosts.byHost[selected.host]?.data?.systems.find(
      (system) => system.id === selected.system.id,
    );
    if (current)
      return (
        <EffortCreator
          system={current}
          action={(input) => systemsHosts.run(selected.host, input)}
          onClose={onClose}
          onCreated={(effort) => onEffortCreated(selected.host, effort.id)}
        />
      );
  }

  return (
    <SystemsDialog
      title={kind === "workspace" ? "New workspace" : "New effort"}
      onClose={onClose}
    >
      <div style={systemsStack}>
        {kind === "workspace" ? (
          repos.length ? (
            repos.map((project) => {
              const host = project.hostId ?? LOCAL_HOST_ID;
              return (
                <SystemsButton
                  key={hostProjectKey(
                    host,
                    project.projectPath ?? project.path,
                  )}
                  disabled={!availableHosts.has(host)}
                  onClick={() => onNewWorkspace(project)}
                  style={{ textAlign: "left", minHeight: 44 }}
                >
                  {project.projectName ?? project.name} ·{" "}
                  {hostNames[host] ?? host}
                </SystemsButton>
              );
            })
          ) : (
            <span>No repos available.</span>
          )
        ) : systems.length ? (
          systems.map(({ host, system }) => (
            <SystemsButton
              key={`${host}:${system.id}`}
              disabled={!availableHosts.has(host)}
              onClick={() => setSelected({ host, system })}
              style={{ textAlign: "left", minHeight: 44 }}
            >
              {system.name} · {hostNames[host] ?? host}
            </SystemsButton>
          ))
        ) : (
          <span>No systems available.</span>
        )}
        {kind === "workspace" && (
          <SystemsButton onClick={onAddRepo}>Add repo</SystemsButton>
        )}
      </div>
    </SystemsDialog>
  );
}
