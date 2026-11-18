"use client";

import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  Check,
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Search,
} from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { WorkspaceBranches } from "@/lib/workspace-creation-types";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "./ui/primitives";

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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showPullRequests, setShowPullRequests] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const isMobile = useIsMobile();
  const popupRef = useRef<HTMLDivElement>(null);
  if (error) return <span role="alert">{error}</span>;
  if (!branches) return <span role="status">Loading base branches…</span>;

  const { defaultRef, originAheadRef, otherRefs, pullRequests } = branches;
  const baseRef = selectedWorkspaceBase(branches, selection);
  const count =
    Number(!!defaultRef) +
    Number(!!originAheadRef) +
    otherRefs.length +
    (pullRequests?.length ?? 0);
  if (!count && pullRequests !== null)
    return <span role="status">No base branches available.</span>;

  const selectedPr = pullRequests?.find(
    ({ number }) => pullRef(number) === baseRef,
  );
  const label = selectedPr
    ? `#${selectedPr.number} ${selectedPr.title}`
    : baseRef
      ? branchLabel(baseRef)
      : "Choose a base branch";
  const Icon = selectedPr ? GitPullRequest : GitBranch;
  const query = search.trim().toLowerCase();
  const defaults = [defaultRef, originAheadRef].filter(
    (ref): ref is string =>
      !!ref && branchLabel(ref).toLowerCase().includes(query),
  );
  const matchingPrs = query
    ? pullRequests?.filter(({ number, title, isDraft }) =>
        `#${number} ${title} ${isDraft ? "draft" : "open"}`
          .toLowerCase()
          .includes(query),
      )
    : pullRequests;
  const matchingBranches = query
    ? otherRefs.filter((ref) => branchLabel(ref).toLowerCase().includes(query))
    : otherRefs;

  const row = (ref: string, name: string, meta?: string) => (
    <button
      key={ref}
      type="button"
      className="picker-row"
      data-active={ref === baseRef}
      aria-pressed={ref === baseRef}
      onClick={() => {
        onChange(ref);
        setOpen(false);
      }}
    >
      <span className="picker-check">
        {ref === baseRef && (
          <Check size={11} strokeWidth={2.4} aria-hidden="true" />
        )}
      </span>
      <span className="picker-model-name" title={name}>
        {name}
      </span>
      {meta && <span className="picker-row-meta">{meta}</span>}
    </button>
  );

  const secondaryGroups = [
    {
      title: "Pull requests",
      shown: showPullRequests,
      setShown: setShowPullRequests,
      count: matchingPrs?.length ?? 0,
      renderRows: () =>
        matchingPrs?.map(({ number, title, isDraft }) =>
          row(
            pullRef(number),
            `#${number} ${title}`,
            isDraft ? "Draft" : "Open",
          ),
        ),
    },
    {
      title: "Other branches",
      shown: showBranches,
      setShown: setShowBranches,
      count: matchingBranches.length,
      renderRows: () =>
        matchingBranches.map((ref) =>
          row(
            ref,
            branchLabel(ref),
            ref.startsWith("refs/heads/") ? "Local" : "Remote",
          ),
        ),
    },
  ];

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
          setShowPullRequests(!!selectedPr);
          setShowBranches(otherRefs.includes(baseRef));
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger
        className="workspace-source-trigger ui-focus-ring"
        aria-label={`Base branch: ${label}`}
        title={label}
      >
        <Icon size={14} aria-hidden="true" />
        <span className="picker-model-name">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="workspace-source-positioner"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <Popover.Popup
            ref={popupRef}
            initialFocus={isMobile ? popupRef : undefined}
            className="picker-panel workspace-source-popup"
          >
            <div className="picker-panel-header">
              <GitBranch size={13} aria-hidden="true" />
              <Popover.Title className="picker-panel-title">
                Base branch
              </Popover.Title>
              <span className="picker-panel-count">{count}</span>
            </div>
            <label className="picker-search">
              <Search
                size={13}
                strokeWidth={1.8}
                color="var(--text-dim)"
                aria-hidden="true"
              />
              <input
                type="search"
                autoComplete="off"
                spellCheck={false}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search branches or pull requests…"
                aria-label="Search branches or pull requests"
              />
            </label>
            <div className="picker-model-list">
              {defaults.length > 0 && (
                <div role="group" aria-label="Default branches">
                  <div className="picker-group-label">Default branches</div>
                  {defaults.map((ref) =>
                    row(
                      ref,
                      branchLabel(ref),
                      ref === defaultRef ? "Default" : "Ahead",
                    ),
                  )}
                </div>
              )}
              {secondaryGroups.map(
                ({ title, shown, setShown, count, renderRows }) => {
                  if (!count) return null;
                  if (query)
                    return (
                      <div key={title} role="group" aria-label={title}>
                        {renderRows()}
                      </div>
                    );
                  return (
                    <Collapsible
                      key={title}
                      open={shown}
                      onOpenChange={setShown}
                    >
                      <CollapsibleTrigger className="picker-row picker-other-models">
                        <ChevronDown size={13} aria-hidden="true" />
                        {title}
                        <span className="picker-row-meta">{count}</span>
                      </CollapsibleTrigger>
                      <CollapsiblePanel role="group" aria-label={title}>
                        {shown && renderRows()}
                      </CollapsiblePanel>
                    </Collapsible>
                  );
                },
              )}
              {query &&
                !defaults.length &&
                !matchingPrs?.length &&
                !matchingBranches.length && (
                  <div className="picker-empty" role="status">
                    No matching branches or pull requests.
                  </div>
                )}
              {pullRequests === null && (
                <div className="picker-empty" role="status">
                  Couldn't load GitHub pull requests on this host.
                </div>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
