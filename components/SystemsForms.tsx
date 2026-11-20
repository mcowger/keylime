"use client";

import {
  useId,
  useState,
  type CSSProperties,
  type ComponentProps,
} from "react";
import { browserUUID } from "@/lib/browser-uuid";
import type {
  EffortPlan,
  EffortRecord,
  SystemDefinition,
  SystemRecord,
  SystemsRequest,
} from "@/lib/api-contracts/systems";
import type { SystemsAction } from "./SystemsHost";
import { DirectoryPicker } from "./DirectoryPicker";
import { WorkspaceSourcePicker } from "./WorkspaceSourcePicker";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";

export const systemsStack: CSSProperties = {
  display: "grid",
  gap: 10,
  minWidth: 0,
  overflowWrap: "anywhere",
};
export const systemsRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};
export const systemsMuted: CSSProperties = { color: "var(--text-muted)" };
export const systemsInput: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "6px 8px",
  background: "var(--bg-panel)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
};
export const systemsCard: CSSProperties = {
  ...systemsStack,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
};

export function SystemsButton({ style, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="ui-focus-ring"
      {...props}
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        color: "var(--text)",
        padding: "4px 8px",
        minHeight: 28,
        fontSize: 12,
        overflowWrap: "anywhere",
        cursor: props.disabled ? undefined : "pointer",
        opacity: props.disabled ? 0.6 : 1,
        ...style,
      }}
    />
  );
}

export function SystemsDialog({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="systems-dialog"
        style={{ width: 480, boxSizing: "border-box" }}
      >
        <DialogTitle>{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function SystemsError({ message }: { message?: string }) {
  return message ? (
    <div
      role="alert"
      style={{ color: "var(--status-error)", overflowWrap: "anywhere" }}
    >
      {message}
    </div>
  ) : null;
}

export function useSystemsAction(action: SystemsAction) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (input: SystemsRequest) => {
    setBusy(true);
    setError(undefined);
    try {
      return await action(input);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function SystemEditor({
  host,
  system,
  repos,
  action,
  onClose,
}: {
  host: { id: string; name: string };
  system?: SystemRecord;
  repos: { path: string; name: string }[];
  action: SystemsAction;
  onClose: () => void;
}) {
  const [definition, setDefinition] = useState<SystemDefinition>(() => ({
    name: system?.name ?? "",
    repoPaths: system?.repoPaths ?? [],
    services: system?.services ?? [],
    instructions: system?.instructions ?? "",
  }));
  const [repo, setRepo] = useState("");
  const [browse, setBrowse] = useState(false);
  const { busy, error, run } = useSystemsAction(action);
  const addRepo = (path: string) => {
    setDefinition((previous) =>
      previous.repoPaths.includes(path)
        ? previous
        : { ...previous, repoPaths: [...previous.repoPaths, path] },
    );
    setRepo("");
    setBrowse(false);
  };
  const updateService = (
    id: string,
    patch: Partial<SystemDefinition["services"][number]>,
  ) => {
    setDefinition((previous) => ({
      ...previous,
      services: previous.services.map((service) =>
        service.id === id ? { ...service, ...patch } : service,
      ),
    }));
  };
  return (
    <SystemsDialog
      title={system ? `Edit ${system.name}` : "New System"}
      busy={busy}
      onClose={onClose}
    >
      <form
        style={systemsStack}
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await run({
              action: "saveSystem",
              id: system?.id,
              definition: { ...definition, name: definition.name.trim() },
            })
          )
            onClose();
        }}
      >
        <label>
          System name{" "}
          <input
            style={systemsInput}
            value={definition.name}
            required
            onChange={(event) =>
              setDefinition({ ...definition, name: event.target.value })
            }
          />
        </label>
        <section style={systemsCard} aria-label="Member Repos">
          <strong>Member Repos</strong>
          {definition.repoPaths.map((path) => (
            <div key={path} style={systemsRow}>
              <span style={{ flex: "1 1 12em", minWidth: 0 }}>{path}</span>
              <SystemsButton
                aria-label={`Remove ${path}`}
                onClick={() =>
                  setDefinition({
                    ...definition,
                    repoPaths: definition.repoPaths.filter(
                      (repoPath) => repoPath !== path,
                    ),
                  })
                }
              >
                Remove
              </SystemsButton>
            </div>
          ))}
          <label>
            Registered Repo{" "}
            <select
              style={systemsInput}
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            >
              <option value="">Choose a Repo</option>
              {repos
                .filter(({ path }) => !definition.repoPaths.includes(path))
                .map(({ path, name }) => (
                  <option key={path} value={path}>
                    {name === path ? path : `${name} · ${path}`}
                  </option>
                ))}
            </select>
          </label>
          <div style={systemsRow}>
            <SystemsButton disabled={!repo} onClick={() => addRepo(repo)}>
              Add registered Repo
            </SystemsButton>
            <SystemsButton disabled={busy} onClick={() => setBrowse(true)}>
              Browse host folders
            </SystemsButton>
          </div>
          <span style={systemsMuted}>
            Choose existing Git checkouts on this host.
          </span>
        </section>
        <section style={systemsCard} aria-label="Services">
          <strong>Services</strong>
          <span style={systemsMuted}>
            Each command runs in the foreground in its own terminal at the
            Effort root, as the host daemon user.
          </span>
          {definition.services.map((service, index) => (
            <fieldset key={service.id} style={systemsCard}>
              <legend>Service {index + 1}</legend>
              <label>
                Name{" "}
                <input
                  style={systemsInput}
                  value={service.name}
                  required
                  onChange={(event) =>
                    updateService(service.id, { name: event.target.value })
                  }
                />
              </label>
              <label>
                Command{" "}
                <textarea
                  style={systemsInput}
                  rows={2}
                  value={service.command}
                  required
                  spellCheck={false}
                  onChange={(event) =>
                    updateService(service.id, { command: event.target.value })
                  }
                />
              </label>
              <SystemsButton
                aria-label={`Remove service ${index + 1}`}
                onClick={() =>
                  setDefinition({
                    ...definition,
                    services: definition.services.filter(
                      ({ id }) => id !== service.id,
                    ),
                  })
                }
              >
                Remove service
              </SystemsButton>
            </fieldset>
          ))}
          <SystemsButton
            onClick={() =>
              setDefinition({
                ...definition,
                services: [
                  ...definition.services,
                  { id: browserUUID(), name: "", command: "" },
                ],
              })
            }
          >
            Add service
          </SystemsButton>
        </section>
        <label>
          AGENTS.md instructions{" "}
          <textarea
            style={systemsInput}
            rows={5}
            value={definition.instructions}
            onChange={(event) =>
              setDefinition({ ...definition, instructions: event.target.value })
            }
          />
        </label>
        {system && (
          <span style={systemsMuted}>Changes apply to new Efforts only.</span>
        )}
        <SystemsError message={error} />
        <div style={systemsRow}>
          <SystemsButton
            type="submit"
            disabled={
              busy || !definition.name.trim() || !definition.repoPaths.length
            }
          >
            {busy ? "Saving…" : "Save System"}
          </SystemsButton>
          <SystemsButton disabled={busy} onClick={onClose}>
            Cancel
          </SystemsButton>
        </div>
      </form>
      {browse && (
        <DirectoryPicker
          host={host}
          mode="folder"
          onSelect={addRepo}
          onCancel={() => setBrowse(false)}
        />
      )}
    </SystemsDialog>
  );
}

export function EffortRootEditor({
  host,
  root,
  action,
  onClose,
}: {
  host: { id: string; name: string };
  root: string;
  action: SystemsAction;
  onClose: () => void;
}) {
  const [input, setInput] = useState(root);
  const [browse, setBrowse] = useState(false);
  const { busy, error, run } = useSystemsAction(action);
  return (
    <SystemsDialog title="Effort worktrees root" busy={busy} onClose={onClose}>
      <form
        style={systemsStack}
        onSubmit={async (event) => {
          event.preventDefault();
          if (await run({ action: "setRoot", root: input.trim() })) onClose();
        }}
      >
        <label>
          Root path on this host{" "}
          <input
            style={systemsInput}
            value={input}
            required
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <span style={systemsMuted}>
          This applies to new Efforts only. Existing Efforts stay where they
          are.
        </span>
        <SystemsButton disabled={busy} onClick={() => setBrowse(true)}>
          Browse host folders
        </SystemsButton>
        <SystemsError message={error} />
        <div style={systemsRow}>
          <SystemsButton type="submit" disabled={busy || !input.trim()}>
            {busy ? "Saving…" : "Save root"}
          </SystemsButton>
          <SystemsButton disabled={busy} onClick={onClose}>
            Cancel
          </SystemsButton>
        </div>
      </form>
      {browse && (
        <DirectoryPicker
          host={host}
          mode="folder"
          startPath={input}
          onSelect={(path) => {
            setInput(path);
            setBrowse(false);
          }}
          onCancel={() => setBrowse(false)}
        />
      )}
    </SystemsDialog>
  );
}

export function EffortCreator({
  system,
  action,
  onClose,
  onCreated,
}: {
  system: SystemRecord;
  action: SystemsAction;
  onClose: () => void;
  onCreated: (effort: EffortRecord) => void;
}) {
  const [name, setName] = useState("");
  const [bases, setBases] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<EffortPlan>();
  const [reviewed, setReviewed] = useState(false);
  const { busy, error, run, setError } = useSystemsAction(action);
  const description = useId();
  const request = {
    systemId: system.id,
    name: name.trim(),
    bases: Object.entries(bases)
      .filter(([, ref]) => ref.trim())
      .map(([repoPath, ref]) => ({ repoPath, ref: ref.trim() })),
  };
  const setBase = (path: string, ref: string) => {
    setBases((previous) => ({ ...previous, [path]: ref }));
    setReviewed(false);
  };
  return (
    <SystemsDialog
      title={`New Effort in ${system.name}`}
      busy={busy}
      onClose={onClose}
    >
      <form
        style={systemsStack}
        aria-describedby={description}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || system.archived || !request.name) return;
          if (!reviewed || !plan) {
            const result = await run({ action: "preview", ...request });
            if (result?.preview) {
              setPlan(result.preview);
              setReviewed(true);
            }
            return;
          }
          setReviewed(false);
          const result = await run({
            action: "create",
            ...request,
            confirmation: plan.confirmation,
          });
          if (!result) return;
          const effort = result.efforts.find(
            ({ id }) => id === result.effortId,
          );
          if (effort) onCreated(effort);
          else setError("Couldn't find the new Effort in the host response.");
        }}
      >
        <label>
          Effort name{" "}
          <input
            style={systemsInput}
            required
            disabled={busy}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setReviewed(false);
            }}
          />
        </label>
        <span id={description} style={systemsMuted}>
          Preview the branch and starting commit for each Repo before creating
          worktrees.
        </span>
        {reviewed && plan && (
          <div style={systemsCard}>
            <span>
              Root: <code>{plan.root}</code>
            </span>
            <span>
              Branch: <code>{plan.branch}</code>
            </span>
          </div>
        )}
        <div style={systemsStack}>
          {system.repoPaths.map((repoPath) => {
            const member = plan?.members.find(
              (item) => item.repoPath === repoPath,
            );
            const name = member?.name ?? repoPath;
            return (
              <div key={repoPath} style={systemsCard}>
                <strong title={repoPath}>{name}</strong>
                <div
                  role="group"
                  aria-label={`Base for ${name}`}
                  style={systemsRow}
                >
                  {member?.branches && (
                    <WorkspaceSourcePicker
                      branches={member.branches}
                      selection={bases[repoPath] || undefined}
                      onChange={(ref) => {
                        if (!busy) setBase(repoPath, ref);
                      }}
                    />
                  )}
                  <label style={{ flex: "1 1 9em" }}>
                    Base ref override{" "}
                    <input
                      disabled={busy}
                      style={systemsInput}
                      value={bases[repoPath] ?? ""}
                      placeholder="Detected default"
                      onChange={(event) =>
                        setBase(repoPath, event.target.value)
                      }
                    />
                  </label>
                </div>
                {reviewed && member && (
                  <>
                    <div>
                      Starting at <code>{member.baseRef}</code> (
                      <code>{member.baseCommit}</code>)
                    </div>
                    <div>
                      Checkout: <code>{member.path}</code>
                    </div>
                    {member.skipsCustomCreate && (
                      <div style={{ color: "var(--status-warning)" }}>
                        Skips this Repo's custom create command. Other setup
                        hooks still run.
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <SystemsError message={error} />
        <div style={systemsRow}>
          <SystemsButton
            type="submit"
            disabled={busy || !request.name || system.archived}
          >
            {busy ? "Working…" : reviewed ? "Create Effort" : "Preview Effort"}
          </SystemsButton>
          <SystemsButton disabled={busy} onClick={onClose}>
            Cancel
          </SystemsButton>
        </div>
      </form>
    </SystemsDialog>
  );
}
