"use client";

import { useId } from "react";
import { GitBranch, GitPullRequest } from "lucide-react";
import type { WorkspaceBranches } from "@/lib/workspace-creation-types";
import { ThemedSelect, type ThemedSelectOption } from "./ui/primitives";

const branchLabel = (ref: string) =>
  ref.replace(/^refs\/(heads|remotes)\//, "");
const pullRef = (number: number) => `refs/pull/${number}/head`;

export function selectedWorkspaceBase(
  branches?: WorkspaceBranches,
  selection?: string,
) {
  if (!branches) return "";
  if (selection === undefined) return branches.defaultRef;
  return selection === branches.defaultRef ||
    selection === branches.originAheadRef ||
    branches.otherRefs.includes(selection) ||
    branches.pullRequests?.some(({ number }) => pullRef(number) === selection)
    ? selection
    : "";
}

function SourceSelect({
  label,
  value,
  options,
  pullRequests = false,
  onChange,
}: {
  label: string;
  value: string;
  options: ThemedSelectOption[];
  pullRequests?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const Icon = pullRequests ? GitPullRequest : GitBranch;
  return (
    <div className="new-session-workspace-field">
      <label htmlFor={id} className="new-session-workspace-label">
        {label}
      </label>
      <div className="new-session-workspace-control">
        <span className="new-session-workspace-icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.8} />
        </span>
        <ThemedSelect
          id={id}
          className="workspace-select-trigger"
          value={value}
          options={options}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

export function WorkspaceSourcePicker({
  branches,
  error,
  selection,
  onChange,
}: {
  branches?: WorkspaceBranches;
  error?: string;
  selection?: string;
  onChange: (value: string) => void;
}) {
  if (error) return <span role="alert">{error}</span>;
  if (!branches) return <span role="status">Loading base branches…</span>;
  const { defaultRef, originAheadRef, otherRefs, pullRequests } = branches;
  const baseRef = selectedWorkspaceBase(branches, selection);
  const source =
    pullRequests?.length &&
    (selection === "pullRequests" || baseRef.startsWith("refs/pull/"))
      ? "pullRequests"
      : otherRefs.length &&
          (selection === "branches" || otherRefs.includes(baseRef))
        ? "branches"
        : baseRef;
  const options: ThemedSelectOption[] = [];
  if (!source)
    options.push({ value: "", label: "Choose a base branch", disabled: true });
  if (defaultRef)
    options.push({
      value: defaultRef,
      label: `${branchLabel(defaultRef)} (default)`,
    });
  if (originAheadRef)
    options.push({
      value: originAheadRef,
      label: `${branchLabel(originAheadRef)} (ahead)`,
    });
  if (pullRequests?.length)
    options.push({ value: "pullRequests", label: "Pull requests" });
  if (otherRefs.length)
    options.push({ value: "branches", label: "Other branches" });
  return (
    <>
      {options.length > 1 || source ? (
        <SourceSelect
          label="Base branch"
          value={source}
          options={options}
          onChange={onChange}
        />
      ) : (
        <span role="status">No base branches available.</span>
      )}
      {source === "pullRequests" && pullRequests && (
        <SourceSelect
          label="Pull request"
          value={baseRef}
          pullRequests
          onChange={onChange}
          options={[
            { value: "", label: "Choose a pull request", disabled: true },
            ...pullRequests.map(({ number, title, isDraft }) => ({
              value: pullRef(number),
              label: `#${number} ${title}${isDraft ? " (draft)" : ""}`,
            })),
          ]}
        />
      )}
      {source === "branches" && (
        <SourceSelect
          label="Other branch"
          value={baseRef}
          onChange={onChange}
          options={[
            { value: "", label: "Choose a branch", disabled: true },
            ...otherRefs.map((ref) => ({
              value: ref,
              label: branchLabel(ref),
            })),
          ]}
        />
      )}
      {pullRequests === null && (
        <span role="status">
          Couldn't load GitHub pull requests on this host.
        </span>
      )}
    </>
  );
}
