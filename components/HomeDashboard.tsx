"use client";

import {
  Bot,
  FolderPlus,
  Layers,
  MessageSquare,
  MessageCircleQuestion,
} from "lucide-react";
import { sessionKey } from "@/lib/session-identity";
import { getFileName } from "@/lib/file-paths";
import type { SessionInfo } from "@/lib/types";

type HomeDashboardProps = {
  sessions: SessionInfo[];
  runningIds: ReadonlySet<string>;
  awaitingInputIds: ReadonlySet<string>;
  hostNames: Record<string, string>;
  sessionPlace: (session: SessionInfo) => string | undefined;
  onSelectSession: (session: SessionInfo) => void;
  onNewWorkspace: () => void;
  onNewEffort: () => void;
};

function sessionTitle(session: SessionInfo): string {
  const name = session.name?.trim();
  if (name) return name;
  const firstMessage = session.firstMessage.trim();
  return firstMessage && firstMessage !== "(no messages)"
    ? firstMessage.replace(/\s+/g, " ")
    : "New chat";
}

function SessionRow({
  session,
  status,
  hostName,
  place,
  onSelect,
}: {
  session: SessionInfo;
  status: "Awaiting input" | "Running" | "Not running";
  hostName: string;
  place?: string;
  onSelect: () => void;
}) {
  const title = sessionTitle(session);
  const modified = Date.parse(session.modified) || 0;
  return (
    <li>
      <button type="button" className="home-session" onClick={onSelect}>
        <span className="home-session-icon" aria-hidden="true">
          {status === "Awaiting input" ? (
            <MessageCircleQuestion size={17} />
          ) : status === "Running" ? (
            <Bot size={17} />
          ) : (
            <MessageSquare size={17} />
          )}
        </span>
        <span className="home-session-content">
          <span className="home-session-title" title={title}>
            {title}
          </span>
          <span
            className="home-session-context"
            title={`${session.cwd} · ${hostName}`}
          >
            <span className="home-session-path">
              {place || getFileName(session.cwd) || session.cwd}
            </span>
            <span aria-hidden="true"> · </span>
            <span className="home-session-host">{hostName}</span>
          </span>
        </span>
        <span className="home-session-meta">
          <span
            className={`home-session-status${status === "Awaiting input" ? " is-awaiting" : ""}`}
          >
            {status}
          </span>
          {modified > 0 && (
            <time dateTime={session.modified}>
              {new Date(modified).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          )}
        </span>
      </button>
    </li>
  );
}

export function HomeDashboard({
  sessions,
  runningIds,
  awaitingInputIds,
  hostNames,
  sessionPlace,
  onSelectSession,
  onNewWorkspace,
  onNewEffort,
}: HomeDashboardProps) {
  const active: SessionInfo[] = [];
  const recent: SessionInfo[] = [];
  for (const session of sessions) {
    (runningIds.has(sessionKey(session.id, session.hostId))
      ? active
      : recent
    ).push(session);
  }
  const newestFirst = (a: SessionInfo, b: SessionInfo) =>
    (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0);
  active.sort((a, b) => {
    const aAwaiting = awaitingInputIds.has(sessionKey(a.id, a.hostId));
    const bAwaiting = awaitingInputIds.has(sessionKey(b.id, b.hostId));
    return Number(bAwaiting) - Number(aAwaiting) || newestFirst(a, b);
  });
  recent.sort(newestFirst);

  const renderSession = (session: SessionInfo, running: boolean) => {
    const key = sessionKey(session.id, session.hostId);
    const hostId = session.hostId ?? "local";
    return (
      <SessionRow
        key={key}
        session={session}
        status={
          running
            ? awaitingInputIds.has(key)
              ? "Awaiting input"
              : "Running"
            : "Not running"
        }
        hostName={hostNames[hostId] ?? (hostId === "local" ? "Local" : hostId)}
        place={sessionPlace(session)}
        onSelect={() => onSelectSession(session)}
      />
    );
  };

  return (
    <main className="home-dashboard">
      <div className="home-dashboard-inner">
        <header className="home-dashboard-header">
          <h1>Home</h1>
          <div className="home-dashboard-actions">
            <button type="button" onClick={onNewWorkspace}>
              <FolderPlus size={16} aria-hidden="true" />
              New workspace
            </button>
            <button type="button" onClick={onNewEffort}>
              <Layers size={16} aria-hidden="true" />
              New effort
            </button>
          </div>
        </header>
        <section
          className="home-dashboard-section"
          aria-labelledby="home-active-heading"
        >
          <h2 id="home-active-heading">Active agents</h2>
          {active.length ? (
            <ul className="home-session-list">
              {active.map((session) => renderSession(session, true))}
            </ul>
          ) : (
            <p className="home-dashboard-empty">No active agents</p>
          )}
        </section>
        {recent.length > 0 && (
          <section
            className="home-dashboard-section"
            aria-labelledby="home-recent-heading"
          >
            <h2 id="home-recent-heading">Recent chats</h2>
            <ul className="home-session-list">
              {recent
                .slice(0, 5)
                .map((session) => renderSession(session, false))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
