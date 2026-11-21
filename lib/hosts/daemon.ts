import { createConnection, type Socket } from "node:net";
import {
  TerminalAttachClientSchema,
  TerminalAttachServerSchema,
} from "../api-contracts/terminal-attach";
import { lstatSync, realpathSync, mkdirSync, watch } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { SpawnResult } from "./host";
import { SessionPtyManager } from "./session-pty";
import { Value } from "@sinclair/typebox/value";
import { SystemsRequestSchema } from "../api-contracts/systems";
import type { HostInstalledBinaryDigests } from "../api-contracts/host-control-models";
import {
  BrowserListSchema,
  BrowserFrameSchema,
} from "../api-contracts/host-control-operations";
import {
  BrowserControlArgsSchema,
  BrowserControlResultSchema,
} from "../api-contracts/runner-lifecycle";
import {
  BrowserVideoStartArgsSchema,
  BrowserVideoStreamArgsSchema,
  BrowserVideoStartResultSchema,
  BrowserVideoNextResultSchema,
  BrowserVideoStopResultSchema,
} from "../api-contracts/runner-lifecycle";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getOmpVersion } from "../omp/omp-cli";
import { getAgentDir, getSessionsDir } from "../omp/paths";
import { ProjectPathError } from "../project-registry";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import {
  loadHostSettings,
  parseHostSettingsPatch,
  saveHostSettings,
} from "../web-settings";
import { getHostModels } from "../models-cache";
import { runIsolatedUtilityCommand } from "../omp/rpc-utility";
import { getAgentEnvOverrides } from "../omp/agent-env";
import { ChatRolesSchema } from "../api-contracts/configuration-models";
import { UsageQuerySchema } from "../api-contracts/usage-models";
import type { HostControlCommand, HostControlStatus } from "./host-control";
import { readHostLogin, type HostLink } from "./host-login";
import { DaemonLink, dialable, nextRedialDelay } from "./daemon-link";
import { ChannelTable } from "./daemon-channels";
import { TerminalManager } from "./terminals";
import { checkPlanningAdmission, planningOperation } from "./planning";
import {
  readHierarchy,
  registerCreatedSession,
  moveRegisteredSession,
} from "./project-hierarchy";
import {
  setWorkspaceDeletionAdapter,
  workspaceCreationBusy,
  stopWorkspaceCreation,
  type WorkspaceDeletionAdapter,
} from "./workspace-creation";
import {
  isEffortCleaningPath,
  stopSystems,
  systemsBusy,
  systemsOperation,
} from "./systems";
import { HostResumeTracker, type HostResumeEntry } from "./host-resume";
import { ManagedArtifactActivation } from "./managed-artifact-activation";
import { digestBinary, openBinary } from "./binary-digest";
import { STANDALONE_HOST_INSTALL } from "./standalone-service";
import {
  CREATION_ID_RE,
  encodeLine,
  HostOpError,
  isHostOp,
  LINK_LIMITS,
  LINK_PROTOCOL_VERSION,
  SESSION_OP_PARAMS,
  type DownMessage,
  type OpenChannelRequest,
  type ShipPrDigest,
  type UnknownMessage,
} from "./link-protocol";
import {
  localHost,
  prepareInteractiveLaunch,
  resolveSpawnCwdResult,
} from "./local-host";
import {
  hostSocketPath,
  listenHostSocket,
  type HostSocket,
} from "./omp-socket";
import { sessionOps } from "./session-ops";
import packageJson from "../../package.json";
import { UploadRetention } from "./upload-retention";
import { StagedUploads, UPLOAD_SWEEP_INTERVAL_MS } from "./uploads";
import { isWorkspaceOp, WORKSPACE_OP_PARAMS } from "../workspace-types";
import { createWorkspaceService, type WorkspaceService } from "./workspace-ops";
import {
  acceptShipDigestReceipt,
  removeShipMonitorsForSession,
  shipWorkBusy,
  startShipWatcher,
  stopShipWatcher,
} from "./workspace-ship";
import {
  grantWorkspaceRoot,
  invalidateWorkspaceRoots,
} from "./workspace-roots";
export { nextRedialDelay };
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const log = (message: string) => console.error("[keylime host] " + message);
/** realpath of the longest existing prefix; null when a component is a dangling symlink. */
function canonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
    } catch {
      // Does not exist: resolve the parent instead.
    }
    const parent = dirname(path);
    if (parent === path) return path;
    const canonicalParent = canonicalPath(parent);
    return canonicalParent === null
      ? null
      : join(canonicalParent, basename(path));
  }
}

/** A path main names must resolve, symlinks and `..` included, inside this host's sessions directory. */
function sessionsPath(value: unknown): string {
  const root = canonicalPath(getSessionsDir());
  const target =
    typeof value === "string" && isAbsolute(value)
      ? canonicalPath(resolve(value))
      : null;
  if (!root || !target || !target.startsWith(root + sep)) {
    throw new HostOpError(
      403,
      "path_outside_sessions",
      "The path is outside this host's sessions directory",
    );
  }
  return target;
}

export interface HostDaemon {
  stop(): Promise<void>;
  done: Promise<number>;
  /** Settles once startup work (upload sweep, session recovery, omp version read) is done; until then drain reports busy. */
  started: Promise<void>;
  control(command: HostControlCommand): HostControlStatus;
}
/** `hostSocket`: where omps started from a TUI attach (`hostSocketPath()`); unset, none can. */
type DaemonOptions = {
  allowHttp: boolean;
  url?: string;
  token?: string;
  hostSocket?: string;
  standaloneControl?: boolean;
};
export function runHostDaemon(options: DaemonOptions): HostDaemon {
  const explicit = options.url !== undefined && options.token !== undefined;
  const initial = explicit
    ? { url: options.url!.replace(/\/+$/, ""), token: options.token! }
    : readHostLogin();
  if (initial && !dialable(initial.url, options.allowHttp))
    throw new Error(
      "keylime host needs an https:// server URL (http:// only for loopback, or with --allow-http)",
    );
  let controller: DaemonLink | undefined;
  const shipOwners = new Map<string, DaemonLink>();
  const shipOwnerByLink = new WeakMap<DaemonLink, string>();
  const services = new Map<string, WorkspaceService>();
  const uploadOwners = new Map<string, { link: DaemonLink; attempt: string }>();
  const uploadAttempts = new Map<string, DaemonLink>();
  const stops = new Set<Promise<void>>();
  const { promise: done, resolve: finish } = Promise.withResolvers<number>();
  let stopped = false,
    linkId = 0,
    ompVersion: string | null = null;
  let stopping: Promise<void> | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;
  let drained = process.env.KEYLIME_HOST_DRAINED === "1";
  let operationsInFlight = 0;
  const executable = realpathSync(process.execPath);
  const entrypoint =
    canonicalPath(process.argv[1] || process.execPath) ||
    resolve(process.argv[1] || process.execPath);
  const activation = new ManagedArtifactActivation(
    getAgentDir(),
    options.standaloneControl === true,
  );
  const resume = new HostResumeTracker();
  const socketPath = options.hostSocket ?? hostSocketPath();
  const attached = new Set<string>();
  const ptys = new SessionPtyManager(
    socketPath + ".attach",
    (runtimeId, on) => {
      if (on) attached.add(runtimeId);
      else attached.delete(runtimeId);
      channels.setTerminalAttached(runtimeId, on);
    },
  );
  const ptyStarted = ptys.start();
  const ptyAttachments = new Map<
    string,
    { link: DaemonLink; sessionId: string; socket: Socket }
  >();
  function closePtyAttachments(link: DaemonLink): void {
    for (const [id, attachment] of ptyAttachments)
      if (attachment.link === link) {
        ptyAttachments.delete(id);
        attachment.socket.destroy();
      }
  }
  function ptyFrame(
    link: DaemonLink,
    id: string,
    sessionId: string,
    payload: string,
  ): void {
    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (!Value.Check(TerminalAttachClientSchema, message)) return;
    let attachment = ptyAttachments.get(id);
    if (!attachment) {
      if (message.type !== "hello") return;
      const socket = createConnection(socketPath + ".attach");
      attachment = { link, sessionId, socket };
      ptyAttachments.set(id, attachment);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 8000000) {
          socket.destroy();
          link.abortTerminalLink();
          return;
        }
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event: unknown = JSON.parse(line);
            if (
              !Value.Check(TerminalAttachServerSchema, event) ||
              !link.terminalEvent(id, line)
            ) {
              socket.destroy();
              link.abortTerminalLink();
              return;
            }
          } catch {
            socket.destroy();
            link.abortTerminalLink();
            return;
          }
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        if (ptyAttachments.get(id)?.socket !== socket) return;
        ptyAttachments.delete(id);
        if (
          !link.terminalEvent(
            id,
            JSON.stringify({
              type: "error",
              message: "Terminal attachment closed",
            }),
          )
        )
          link.abortTerminalLink();
      });
      socket.write(
        JSON.stringify({
          type: "hello",
          sessionId,
          cols: message.cols,
          rows: message.rows,
        }) + "\n",
      );
      return;
    }
    if (
      attachment.link !== link ||
      attachment.sessionId !== sessionId ||
      message.type === "hello"
    )
      return;
    if (
      attachment.socket.writableLength + Buffer.byteLength(payload) >
      262144
    ) {
      attachment.socket.destroy();
      link.abortTerminalLink();
      return;
    }
    attachment.socket.write(payload + "\n");
  }
  const pendingPtys = new Map<
    number,
    {
      resolve(spawned: SpawnResult): void;
      reject(error: Error): void;
      kill(): void;
    }
  >();
  const channels = new ChannelTable({
    spawn: async (launch) => {
      if (!launch.sessionFile) {
        let cwd = resolve(launch.cwd);
        try {
          cwd = realpathSync(cwd);
        } catch {}
        if (
          !readHierarchy().projects.some((project) =>
            project.workspaces.some(
              (workspace) =>
                cwd === workspace.path || cwd.startsWith(workspace.path + sep),
            ),
          )
        )
          throw new HostOpError(
            409,
            "workspace_not_registered",
            "Register a project and choose a workspace before creating a session",
          );
      }
      if (drained)
        throw new HostOpError(
          409,
          "host_drained",
          "This host is locally drained for maintenance",
        );
      const resolved =
        launch.creationId === undefined
          ? resolveSpawnCwdResult(launch.recordedCwd ?? launch.cwd)
          : { cwd: launch.cwd, fellBack: false };
      await ptyStarted;
      if (!(await hostSocket))
        throw new Error("Host socket is unavailable for terminal launch");
      if (stopped) throw new Error("Host is stopping");
      const prepared = await prepareInteractiveLaunch(
        { ...launch, cwd: resolved.cwd },
        { KEYLIME_HOST_SOCKET: socketPath },
      );
      if (stopped) throw new Error("Host is stopping");
      const runtimeId = randomUUID();
      const child = ptys.spawn({
        runtimeId,
        argv: prepared.argv,
        cwd: prepared.cwd,
        env: prepared.env,
      });
      const handshake = Promise.withResolvers<SpawnResult>();
      pendingPtys.set(child.pid, {
        resolve: handshake.resolve,
        reject: handshake.reject,
        kill: () => child.kill(true),
      });
      const timeout = setTimeout(
        () =>
          handshake.reject(
            new Error("Timed out waiting for the terminal runner to connect"),
          ),
        LINK_LIMITS.channelReadyMs,
      );
      timeout.unref?.();
      void child.exited.then((code) =>
        handshake.reject(
          new Error(`Terminal runner exited before connecting (${code})`),
        ),
      );
      try {
        const connected = await handshake.promise;
        const socket = connected.transport;
        socket.onExit(() => child.kill());
        return {
          ...connected,
          cwd: prepared.cwd,
          fellBack: resolved.fellBack,
          launchAdvisor: prepared.launchAdvisor,
          transport: {
            ...socket,
            id: runtimeId,
            killTree: (force: boolean) => child.kill(force),
            onExit: (
              listener: (
                code: number | null,
                signal: NodeJS.Signals | null,
              ) => void,
            ) => {
              void child.exited.then((code) => listener(code, null));
            },
          },
        };
      } catch (error) {
        child.kill(true);
        throw error;
      } finally {
        clearTimeout(timeout);
        pendingPtys.delete(child.pid);
      }
    },
    bindTerminal: (runtimeId, sessionId) => ptys.bind(runtimeId, sessionId),
    terminalAttached: (runtimeId) => attached.has(runtimeId),
    workspaceDeleting: isEffortCleaningPath,
    prepareLaunch: (launch) => {
      if (
        !isRecord(launch) ||
        typeof launch.cwd !== "string" ||
        !(
          launch.recordedCwd === null ||
          launch.recordedCwd === undefined ||
          typeof launch.recordedCwd === "string"
        ) ||
        typeof launch.sessionFile !== "string" ||
        typeof launch.advisor !== "boolean" ||
        !(
          launch.toolNames === undefined ||
          (Array.isArray(launch.toolNames) &&
            launch.toolNames.every((name) => typeof name === "string"))
        ) ||
        !(
          launch.spawnModel === undefined ||
          typeof launch.spawnModel === "string"
        ) ||
        !(
          launch.creationId === undefined ||
          (typeof launch.creationId === "string" &&
            CREATION_ID_RE.test(launch.creationId))
        )
      )
        throw new HostOpError(400, "invalid_request", "Invalid spawn request");
      return {
        cwd: launch.cwd,
        recordedCwd: launch.recordedCwd ?? null,
        sessionFile: launch.sessionFile ? sessionsPath(launch.sessionFile) : "",
        advisor: launch.advisor,
        ...(launch.toolNames === undefined
          ? {}
          : { toolNames: launch.toolNames }),
        ...(launch.spawnModel === undefined
          ? {}
          : { spawnModel: launch.spawnModel }),
        ...(launch.creationId === undefined
          ? {}
          : { creationId: launch.creationId }),
      };
    },
    autoApproveExtension: () => localHost.autoApproveExtension(),
    log,
    runningChanged: () => {
      try {
        resume.recordRunning(channels.running());
      } catch (error) {
        log("could not save interrupted sessions: " + reason(error));
      }
    },
    sessionsChanged,
    channelsChanged,
    sessionCreated: (cwd, id) => {
      registerCreatedSession(cwd, id);
      sessionsChanged();
    },
    sessionIdentityChanged: (previous, next, moved, cwd) => {
      if (
        readHierarchy().projects.some((project) =>
          project.workspaces.some((workspace) =>
            workspace.sessionIds.includes(previous),
          ),
        )
      ) {
        if (moved) moveRegisteredSession(previous, next);
        else registerCreatedSession(cwd, next);
        sessionsChanged();
      }
    },
  });
  const terminalOverflow = new Set<string>();
  const terminals = new TerminalManager((id, event) => {
    const link = controller;
    if (link?.isUp()) {
      const key = link.id + ":" + id;
      if (
        link.queue({ type: "terminal_event", id, event }, "terminal:" + id) ===
        null
      ) {
        if (!terminalOverflow.has(key)) {
          terminalOverflow.add(key);
          link.queue(
            { type: "terminal_event", id, event: { type: "disconnected" } },
            "terminal:" + id,
          );
        }
      } else terminalOverflow.delete(key);
    }
  }, isEffortCleaningPath);
  const processes: WorkspaceDeletionAdapter = {
    fence: (directory) => {
      const releaseChannels = channels.fenceWorkspace(directory);
      const releaseTerminals = terminals.fence(directory);
      return () => {
        releaseTerminals();
        releaseChannels();
      };
    },
    inspect: async (directory) => [
      ...(await channels.inspectWorkspace(directory)),
      ...terminals.inspect(directory),
    ],
    stop: async (directory) => {
      await Promise.all([
        channels.stopWorkspace(directory),
        terminals.stopWorkspace(directory),
      ]);
    },
  };
  setWorkspaceDeletionAdapter(processes);
  const hostSocket: Promise<HostSocket | undefined> = listenHostSocket(
    socketPath,
    {
      adopt: async (spawned, launch, sessionId) => {
        const pending = pendingPtys.get(Number(spawned.transport.id));
        if (pending) {
          pendingPtys.delete(Number(spawned.transport.id));
          pending.resolve(spawned);
          return;
        }
        if (stopped)
          throw new HostOpError(503, "host_stopping", "This host is stopping");
        if (drained)
          throw new HostOpError(
            409,
            "host_drained",
            "This host is locally drained for maintenance",
          );
        return channels.adopt(spawned, launch, sessionId);
      },
      log,
    },
  ).catch((error) => {
    log("omps started from a TUI cannot attach: " + reason(error));
    return undefined;
  });
  const uploads = new StagedUploads((ack) => {
    const link = uploadAttempts.get(ack.id + ":" + ack.attempt);
    link?.queue({ type: "upload_ack", ...ack }, "up:" + ack.id);
  });
  const uploadRetention = new UploadRetention();
  if (!drained) void uploadRetention.start();
  function sweepUploads(): Promise<void> | undefined {
    if (drained || stopped) return;
    operationsInFlight++;
    return uploads.sweep().finally(() => operationsInFlight--);
  }
  const startupSweep = sweepUploads();
  const sweepTimer = setInterval(sweepUploads, UPLOAD_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  const configDir = join(getAgentDir(), "keylime");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const watcher = watch(configDir, (_event, name) => {
    if (name !== null && String(name) !== "host.json") return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reconcile(), 200);
    reloadTimer.unref?.();
  });
  watcher.unref();
  watcher.on("error", (error) => log("host.json watch: " + reason(error)));

  function busyReason(allowIdleChannels = false): string | null {
    if (workspaceCreationBusy())
      return "Wait for workspace creation/setup to finish.";
    if (systemsBusy()) return "Wait for Effort setup or cleanup to finish.";
    if (shipWorkBusy()) return "Wait for Ship work to finish.";
    if (!allowIdleChannels && terminals.hasLiveProcesses())
      return "Close this host's workspace terminals and service shells before updating its daemon.";
    if (
      allowIdleChannels
        ? channels.hasBusyChannels
        : channels.size > 0 || channels.spawnsInFlight > 0
    )
      return "Close this host's sessions before updating its daemon; sessions and subagents must not be interrupted.";
    if (uploads.busy() || uploadRetention.busy())
      return "Wait for this host's active uploads and control writes to finish.";
    if (stops.size > 0)
      return "Wait for active filesystem operations to finish.";
    for (const service of services.values())
      if (service.busy())
        return "Wait for active filesystem operations to finish.";
    if (operationsInFlight > 0)
      return "Wait for pending host operations to finish.";
    if (controller?.busy())
      return "Wait for reliable host results to be delivered.";
    return null;
  }
  function control(command: HostControlCommand): HostControlStatus {
    if (command === "drain-force") {
      if (stopped)
        throw new HostOpError(503, "host_stopping", "This host is stopping");
      drained = true;
      uploadRetention.stop();
      channels.stopForMaintenance("asked");
    } else if ((command === "drain" || command === "drain-idle") && !drained) {
      if (stopped)
        throw new HostOpError(503, "host_stopping", "This host is stopping");
      const busy = busyReason(command === "drain-idle");
      if (busy) throw new HostOpError(409, "host_busy", busy);
      drained = true;
      uploadRetention.stop();
      if (command === "drain-idle") channels.stopForMaintenance("idle");
    } else if (command === "resume") {
      const wasDrained = drained;
      drained = false;
      if (wasDrained) void uploadRetention.start();
      recover();
    }
    return {
      pid: process.pid,
      version: packageJson.version,
      protocol: LINK_PROTOCOL_VERSION,
      linked: !stopped && (controller?.isUp() ?? false),
      drained,
      executable,
      entrypoint,
    };
  }
  startShipWatcher(
    sessionsChanged,
    offerShipDigest,
    () => !drained && !stopped,
  );

  function offerShipDigest(owner: string, digest: ShipPrDigest): void {
    const link = shipOwners.get(owner);
    if (!stopped && link?.isUp())
      link.queue({ type: "ship_pr_digest", ...digest }, "ship-pr-digest");
  }

  function sessionsChanged(): void {
    localHost.invalidateSessionLists();
    invalidateWorkspaceRoots();
    if (!stopped) controller?.queue({ type: "sessions_changed" }, "sessions");
  }
  function channelsChanged(ch: string): void {
    const link = controller;
    if (!stopped && link?.isUp())
      link.queue(
        { type: "channels_changed", channels: channels.listing(link) },
        ch,
      );
  }
  /** Retire the old controller's workspace service and invalidate its upload ownership. */
  function dropLink(link: DaemonLink): void {
    const shipOwner = shipOwnerByLink.get(link);
    if (shipOwner && shipOwners.get(shipOwner) === link)
      shipOwners.delete(shipOwner);
    const service = services.get(link.id);
    services.delete(link.id);
    if (service) {
      const stop: Promise<void> = service
        .stop()
        .catch((error) =>
          log("could not stop a workspace service: " + reason(error)),
        )
        .finally(() => stops.delete(stop));
      stops.add(stop);
    }
    for (const [id, owner] of uploadOwners)
      if (owner.link === link) uploadOwners.delete(id);
    for (const [key, owner] of uploadAttempts)
      if (owner === link) uploadAttempts.delete(key);
  }
  function makeLink(login: HostLink): DaemonLink {
    // The bearer identifies a configured server relationship, not just an address.
    const shipOwner = createHash("sha256")
      .update(
        JSON.stringify(["keylime-ship-server-v1", login.url, login.token]),
      )
      .digest("hex");
    const link = new DaemonLink(login, "l" + ++linkId, {
      allowHttp: options.allowHttp,
      log,
      hello: (link, replay) =>
        encodeLine({
          type: "hello",
          v: link.version,
          ompVersion,
          keylimeVersion: packageJson.version,
          workspaceOps: Object.keys(WORKSPACE_OP_PARAMS),
          canReportUsage: true,
          canStageArtifact: true,
          ...(activation.supported()
            ? { canActivateArtifact: true, canReportBinaryDigests: true }
            : {}),
          platform: process.platform,
          arch: process.arch,
          home: homedir(),
          autoApproveExtension: localHost.autoApproveExtension(),
          ack: link.ackedDown,
          channels: channels.listing(link, replay),
        }),
      handleDown,
      onState: (link, up) => {
        if (up) {
          channels.linkUp(link);
          link.queue(
            {
              type: "channels_changed",
              channels: channels.listing(link, false),
            },
            "channels",
          );
        } else {
          closePtyAttachments(link);
          services.get(link.id)?.onDisconnect();
          channels.linkDown(link);
        }
      },
      onBlob: (link, id, bytes) => {
        if (!drained && uploadOwners.get(id)?.link === link)
          uploads.write(id, bytes);
      },
      reload: (source, unauthorized) => reconcile(source, unauthorized),
      onEnd: (link, why) => {
        if (controller !== link) return;
        controller = undefined;
        channels.linkGone(link);
        dropLink(link);
        log(
          why === "revoked"
            ? "the server rejected this host's token (revoked?); stopping its omp sessions"
            : "the controller link ended",
        );
        void shutdown(why === "replaced" ? 0 : 1);
      },
    });
    services.set(
      link.id,
      createWorkspaceService(
        uploads,
        (id, epoch, event) =>
          link.queue(
            { type: "workspace_file", id, epoch, event },
            "watch:" + id,
          ),
        {
          shipOwner,
          assertShipMonitorAvailable: (directory) => {
            if (!link.isUp() || controller !== link)
              throw new HostOpError(
                403,
                "link_not_authenticated",
                "The server link is no longer authenticated",
              );
            // Probe the deletion fence without holding it across remote reads.
            channels.fenceWorkspace(directory)();
          },
        },
      ),
    );
    controller = link;
    shipOwners.set(shipOwner, link);
    shipOwnerByLink.set(link, shipOwner);
    return link;
  }

  function reconcile(source?: DaemonLink, unauthorized = false): boolean {
    if (stopped || (source && controller !== source)) return false;
    let saved: HostLink | null;
    try {
      saved = readHostLogin();
    } catch (error) {
      log("could not reload host.json: " + reason(error));
      return false;
    }
    if (saved && !dialable(saved.url, options.allowHttp)) return false;
    const previous = controller;
    if (unauthorized) {
      if (
        !source ||
        !saved ||
        saved.url !== source.login.url ||
        saved.token === source.login.token
      )
        return false;
      log(
        "the server rejected this host's token; using the new one from host.json",
      );
    } else if (explicit && !saved) return false;
    if (
      saved?.url === previous?.login.url &&
      saved?.token === previous?.login.token
    )
      return false;
    if (previous) {
      // Do not rekey in place: sequence windows and queued results belong to the old credential.
      controller = undefined;
      channels.linkGone(previous);
      dropLink(previous);
      void previous.stop();
    }
    if (saved) {
      log("host.json changed; dialing " + saved.url);
      makeLink(saved).start();
    }
    return true;
  }

  function handleDown(
    link: DaemonLink,
    message: DownMessage | UnknownMessage,
  ): void {
    try {
      switch (message.type) {
        case "ship_pr_digest_receipt": {
          const shipOwner = shipOwnerByLink.get(link);
          if (shipOwner && shipOwners.get(shipOwner) === link && link.isUp())
            acceptShipDigestReceipt(shipOwner, message.id);
          return;
        }
        case "pty_attach":
          ptyFrame(link, message.id, message.sessionId, message.payload);
          return;
        case "stdin":
          channels.stdin(link, message.ch, message.line, drained);
          return;
        case "kill":
          channels.kill(link, message.ch, message.force);
          return;
        case "interest":
          channels.setInterest(link, message.ch, message.on, message.preparing);
          return;
        case "host_tools":
          channels.setTools(link, message.ch, message.tools, message.schemes);
          return;
        case "req":
          void answer(link, message.id, message.op, message.args);
          return;
      }
    } catch (error) {
      log("ignored a channel command: " + reason(error));
    }
  }
  async function answer(
    link: DaemonLink,
    id: string,
    op: string,
    args: unknown,
  ): Promise<void> {
    const session =
      isRecord(args) && typeof args.id === "string" && isValidSessionId(args.id)
        ? args.id
        : null;
    let opened: string | undefined;
    operationsInFlight++;
    try {
      const result = await runOp(link, op, args);
      if (op === "open" && isRecord(result) && typeof result.ch === "string")
        opened = result.ch;
      const media =
        (op === "readMedia" || op === "readFileChunk") &&
        isRecord(result) &&
        result.ok === true &&
        result.value instanceof Uint8Array
          ? result.value
          : null;
      if (media && media.byteLength > LINK_LIMITS.blobBytes)
        throw new HostOpError(
          413,
          "result_too_large",
          "The result is too large for the host link",
        );
      link.result(id, result, { session, key: opened, media });
      if (opened) {
        channelsChanged(opened);
        channels.release(link, opened);
      }
    } catch (error) {
      if (opened) channels.close(link, opened);
      const failure =
        error instanceof HostOpError
          ? { status: error.status, code: error.code, message: error.message }
          : error instanceof ProjectPathError
            ? { status: 400, code: error.code, message: error.message }
            : { status: 500, code: "host_op_failed", message: reason(error) };
      link.queue({ type: "res", id, ok: false, error: failure }, id, {
        session,
      });
    } finally {
      operationsInFlight--;
    }
  }
  function requireUploadOwner(link: DaemonLink, id: unknown): void {
    const owner = typeof id === "string" ? uploadOwners.get(id) : undefined;
    if (owner && owner.link !== link)
      throw new HostOpError(
        409,
        "upload_running_elsewhere",
        "Another server owns this upload attempt",
      );
  }
  async function readManagedBinaryDigests(): Promise<HostInstalledBinaryDigests> {
    let install: string;
    try {
      install = join(realpathSync(homedir()), STANDALONE_HOST_INSTALL);
    } catch {
      throw new HostOpError(
        500,
        "host_binary_digest_failed",
        "Could not locate the managed installation",
      );
    }
    async function digest(binary: "keylime" | "keylime-omp") {
      try {
        const file = await openBinary(join(install, binary)).catch(
          (error: unknown) => {
            if (
              binary === "keylime-omp" &&
              (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
            )
              return null;
            throw error;
          },
        );
        if (file === null) return null;
        try {
          return (await digestBinary(file)).sha256;
        } finally {
          await file.close();
        }
      } catch {
        throw new HostOpError(
          500,
          "host_binary_digest_failed",
          `Could not read the managed ${binary} binary`,
        );
      }
    }
    const keylime = await digest("keylime");
    if (keylime === null)
      throw new HostOpError(
        500,
        "host_binary_digest_failed",
        "The managed keylime binary is absent",
      );
    return { keylime, runner: await digest("keylime-omp") };
  }
  async function runOp(
    link: DaemonLink,
    op: string,
    args: unknown,
  ): Promise<unknown> {
    if (!isHostOp(op))
      throw new HostOpError(501, "unknown_op", "Unknown host op: " + op);
    if (!isRecord(args))
      throw new HostOpError(
        400,
        "invalid_request",
        "Host op arguments must be an object",
      );
    if (stopped)
      throw new HostOpError(503, "host_stopping", "This host is stopping");
    if (
      drained &&
      ![
        "closeFile",
        "unwatchFile",
        "cancelClone",
        "close",
        "ptySessions",
        "hostArtifactActivationStatus",
        "hostInstalledBinaryDigests",
        "hostSettingsGet",
      ].includes(op)
    ) {
      throw new HostOpError(
        409,
        "host_drained",
        "This host is locally drained for maintenance; resume it before starting new work",
      );
    }
    if (isWorkspaceOp(op)) {
      if (
        (op === "startShip" ||
          op === "startShipMonitor" ||
          op === "stopShipMonitor") &&
        (!link.isUp() || controller !== link)
      )
        throw new HostOpError(
          403,
          "link_not_authenticated",
          "The server link is no longer authenticated",
        );
      if (op === "planning")
        return planningOperation(args.operation, () =>
          systemsOperation(
            { action: "list" },
            { terminals, processes, sessionsChanged },
          ),
        );
      if (op === "terminals" || op === "systems") {
        try {
          const input = args.input;
          if (op === "systems") {
            if (!Value.Check(SystemsRequestSchema, input))
              throw new HostOpError(
                400,
                "invalid_request",
                "Invalid Systems request",
              );
            const value = await systemsOperation(input, {
              terminals,
              processes,
              sessionsChanged,
              checkPlanningAdmission,
            });
            return { ok: true, value };
          }
          if (!isRecord(input) || typeof args.action !== "string")
            throw new HostOpError(
              400,
              "invalid_request",
              "Invalid terminal request",
            );
          const id = input.id as string;
          switch (args.action) {
            case "list":
              return {
                ok: true,
                value: { terminals: terminals.list(input.cwd as string) },
              };
            case "create":
              return {
                ok: true,
                value: {
                  terminal: terminals.create(
                    input.cwd as string,
                    input.cols as number,
                    input.rows as number,
                  ),
                },
              };
            case "snapshot":
              return { ok: true, value: await terminals.snapshot(id) };
            case "input":
              terminals.input(id, input.data as string);
              break;
            case "resize":
              await terminals.resize(
                id,
                input.cols as number,
                input.rows as number,
              );
              break;
            case "focus":
              terminals.focus(
                id,
                input.viewer as string,
                input.focused as boolean,
              );
              break;
            case "close":
              await terminals.close(id);
              break;
            default:
              throw new HostOpError(
                400,
                "invalid_request",
                "Invalid terminal action",
              );
          }
          return { ok: true, value: {} };
        } catch (error) {
          if (error instanceof HostOpError)
            return {
              ok: false,
              status: error.status,
              code: error.code,
              error: error.message,
            };
          throw error;
        }
      }
      if (op === "publishUpload") requireUploadOwner(link, args.id);
      const input = isRecord(args.input) ? args.input : null;
      const owner = isRecord(input?.owner)
        ? input.owner
        : isRecord(args.owner)
          ? args.owner
          : null;
      if (owner && typeof owner.sessionId === "string") {
        const cwd = channels.cwdForSession(owner.sessionId);
        if (cwd) owner.cwd = cwd;
      }
      const run = services.get(link.id)!.ops[op] as (
        ...values: unknown[]
      ) => Promise<unknown>;
      return run(...WORKSPACE_OP_PARAMS[op].map((name) => args[name]));
    }
    switch (op) {
      case "ptySessions":
        return ptys.listSessions();
      case "browserList":
      case "browserCapture": {
        if (
          typeof args.sessionId !== "string" ||
          !isValidSessionId(args.sessionId) ||
          (op === "browserCapture" &&
            (typeof args.tabId !== "string" ||
              args.tabId.length === 0 ||
              args.tabId.length > 1024))
        )
          throw new HostOpError(
            400,
            "invalid_request",
            "Invalid browser request",
          );
        const result = await channels.browserCommand(
          args.sessionId,
          op === "browserCapture" ? (args.tabId as string) : undefined,
        );
        if (
          !Value.Check(
            op === "browserList" ? BrowserListSchema : BrowserFrameSchema,
            result,
          )
        )
          throw new HostOpError(
            502,
            "invalid_browser_result",
            "Invalid browser result from runner",
          );
        return result;
      }
      case "browserVideoStart":
      case "browserVideoNext":
      case "browserVideoStop": {
        const kind =
          op === "browserVideoStart"
            ? "start"
            : op === "browserVideoNext"
              ? "next"
              : "stop";
        const argsSchema =
          kind === "start"
            ? BrowserVideoStartArgsSchema
            : BrowserVideoStreamArgsSchema;
        if (
          typeof args.sessionId !== "string" ||
          !isValidSessionId(args.sessionId) ||
          !Value.Check(argsSchema, args.input)
        )
          throw new HostOpError(
            400,
            "invalid_request",
            "Invalid browser video request",
          );
        const result = await channels.browserVideo(
          args.sessionId,
          kind,
          args.input as { id: string; streamId?: string },
        );
        const resultSchema =
          kind === "start"
            ? BrowserVideoStartResultSchema
            : kind === "next"
              ? BrowserVideoNextResultSchema
              : BrowserVideoStopResultSchema;
        if (!Value.Check(resultSchema, result))
          throw new HostOpError(
            502,
            "invalid_browser_result",
            "Invalid browser video result from runner",
          );
        if (
          kind === "next" &&
          Value.Check(BrowserVideoNextResultSchema, result) &&
          result.packets.reduce((n, packet) => n + packet.data.length, 0) >
            512 * 1024
        )
          throw new HostOpError(
            502,
            "invalid_browser_result",
            "Invalid browser video result from runner",
          );
        return result;
      }
      case "browserControl": {
        if (
          typeof args.sessionId !== "string" ||
          !isValidSessionId(args.sessionId) ||
          !Value.Check(BrowserControlArgsSchema, args.control)
        )
          throw new HostOpError(
            400,
            "invalid_request",
            "Invalid browser request",
          );
        const result = await channels.browserControl(
          args.sessionId,
          args.control,
        );
        if (!Value.Check(BrowserControlResultSchema, result))
          throw new HostOpError(
            502,
            "invalid_browser_result",
            "Invalid browser result from runner",
          );
        return result;
      }
      case "open":
        return channels.open(link, args as unknown as OpenChannelRequest);
      case "close":
        if (typeof args.ch !== "string")
          throw new HostOpError(400, "invalid_request", "Invalid channel id");
        channels.close(link, args.ch);
        return {};
      case "editLease":
        if (typeof args.ch !== "string" || typeof args.on !== "boolean")
          throw new HostOpError(400, "invalid_request", "Invalid edit lease");
        channels.editLease(link, args.ch, args.on);
        return {};
      case "deleteSession":
      case "archiveSession": {
        if (typeof args.id !== "string")
          throw new HostOpError(400, "invalid_request", "Invalid session id");
        const result = await channels.mutateSession<unknown>(
          args.id,
          (id, liveIds) =>
            op === "deleteSession"
              ? sessionOps.deleteSession(id, [
                  ...new Set([
                    ...(Array.isArray(args.liveSessionIds)
                      ? args.liveSessionIds.filter(
                          (value): value is string => typeof value === "string",
                        )
                      : []),
                    ...liveIds,
                  ]),
                ])
              : sessionOps.archiveSession(id),
        );
        if (isRecord(result) && result.ok === true) {
          removeShipMonitorsForSession(args.id);
          sessionsChanged();
        }
        return result;
      }
      case "sessionFileExists":
        return localHost.sessionFileExists(sessionsPath(args.path));
      case "invalidateSessionLists":
        invalidateWorkspaceRoots();
        localHost.invalidateSessionLists(
          args.path === undefined ? undefined : sessionsPath(args.path),
        );
        sessionsChanged();
        return;
      case "validateCwd": {
        if (typeof args.path !== "string")
          throw new HostOpError(
            400,
            "invalid_request",
            "Invalid workspace path",
          );
        const selected = await sessionOps.validateCwd(args.path);
        if (selected.ok) grantWorkspaceRoot(selected.value.cwd);
        return selected;
      }
      case "uploadStart": {
        requireUploadOwner(link, args.id);
        const old =
          typeof args.id === "string" ? uploadOwners.get(args.id) : undefined;
        if (typeof args.id === "string" && typeof args.attempt === "string") {
          uploadOwners.set(args.id, { link, attempt: args.attempt });
          uploadAttempts.set(args.id + ":" + args.attempt, link);
        }
        try {
          return await uploads.start(args);
        } catch (error) {
          if (
            typeof args.id === "string" &&
            uploadOwners.get(args.id)?.attempt === args.attempt
          ) {
            if (old) uploadOwners.set(args.id, old);
            else uploadOwners.delete(args.id);
          }
          throw error;
        }
      }
      case "uploadAbort":
        requireUploadOwner(link, args.id);
        return uploads.abort(args.id);
      case "stageHostArtifact": {
        requireUploadOwner(link, args.id);
        const owner = shipOwnerByLink.get(link);
        const ownedUpload =
          typeof args.id === "string" &&
          uploadOwners.get(args.id)?.link === link;
        const staged = await uploads.stageHostArtifact(args.id);
        if (ownedUpload && owner && controller === link)
          activation.stage(args.id as string, staged.path, owner);
        return staged;
      }
      case "activateHostArtifact":
      case "hostArtifactActivationStatus":
      case "hostInstalledBinaryDigests": {
        const owner = shipOwnerByLink.get(link);
        if (!owner || !link.isUp() || controller !== link)
          throw new HostOpError(
            403,
            "link_not_authenticated",
            "The server link is no longer authenticated",
          );
        if (op === "hostInstalledBinaryDigests") {
          if (Object.keys(args).length !== 0)
            throw new HostOpError(
              400,
              "invalid_request",
              "This operation accepts no arguments",
            );
          if (!activation.supported())
            throw new HostOpError(
              409,
              "artifact_activation_unsupported",
              "This daemon is not the supervised standalone host",
            );
          return readManagedBinaryDigests();
        }
        return op === "activateHostArtifact"
          ? activation.start(args, owner)
          : activation.status(args.operationId, owner);
      }
      case "uploadAttach":
        requireUploadOwner(link, args.id);
        return uploads.attach(
          args.id,
          sessionsPath(args.sessionFile),
          args.sessionId,
        );
      case "hostSettingsGet":
        return loadHostSettings();
      case "hostSettingsSet": {
        const patch = parseHostSettingsPatch(args);
        if (!patch)
          throw new HostOpError(
            400,
            "invalid_request",
            "Invalid host settings patch",
          );
        const settings = saveHostSettings(patch);
        if (Object.hasOwn(patch, "uploadRetentionDays"))
          void uploadRetention.sweep();
        return settings;
      }
      case "modelsList":
        if (args.refresh !== undefined && typeof args.refresh !== "boolean")
          throw new HostOpError(
            400,
            "invalid_request",
            "refresh must be a boolean",
          );
        return getHostModels(args.refresh === true);
      case "chatRolesList": {
        if (typeof args.cwd !== "string" || !isAbsolute(args.cwd))
          throw new HostOpError(400, "invalid_request", "An absolute workspace path is required");
        if (args.thinkingLevel !== undefined && typeof args.thinkingLevel !== "string")
          throw new HostOpError(400, "invalid_request", "thinkingLevel must be a string");
        if ((args.currentProvider !== undefined || args.currentModelId !== undefined) &&
            (typeof args.currentProvider !== "string" || !args.currentProvider.trim() || typeof args.currentModelId !== "string" || !args.currentModelId.trim()))
          throw new HostOpError(400, "invalid_request", "currentProvider and currentModelId must be non-empty strings together");
        const selected = await sessionOps.validateCwd(args.cwd);
        if (!selected.ok) throw new HostOpError(selected.status, selected.code, selected.error);
        let result: unknown;
        try {
          result = await runIsolatedUtilityCommand({ type: "get_chat_roles", currentModelFallback: false, ...(args.thinkingLevel === undefined ? {} : { thinkingLevel: args.thinkingLevel }), ...(args.currentProvider === undefined ? {} : { currentProvider: args.currentProvider, currentModelId: args.currentModelId }) }, { cwd: selected.value.cwd, env: getAgentEnvOverrides(), timeoutMs: 120_000 });
        } catch {
          throw new HostOpError(503, "chat_roles_unavailable", "Chat roles are unavailable. Check the host runner and workspace configuration.");
        }
        if (!Value.Check(ChatRolesSchema, result))
          throw new HostOpError(502, "invalid_runner_result", "Invalid chat roles response from runner");
        return result;
      }
      case "usageReport":
        if (!Value.Check(UsageQuerySchema, args))
          throw new HostOpError(
            400,
            "invalid_request",
            "Invalid usage filters",
          );
        return localHost.getUsageReport(args);
      default: {
        const run = sessionOps[op] as (
          ...params: unknown[]
        ) => Promise<unknown>;
        const result = await run.apply(
          sessionOps,
          SESSION_OP_PARAMS[op].map((name) => args[name]),
        );
        if (
          op === "addProject" ||
          op === "updateProject" ||
          op === "hideProject"
        )
          invalidateWorkspaceRoots();
        if (
          [
            "renameSessionFile",
            "deleteSession",
            "archiveSession",
            "restoreArchive",
          ].includes(op) &&
          !(isRecord(result) && result.ok === false)
        )
          sessionsChanged();
        return result;
      }
    }
  }
  function shutdown(code: number): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    watcher.close();
    clearTimeout(reloadTimer);
    clearInterval(sweepTimer);
    uploadRetention.stop();
    // Freeze before exit handlers observe children stopping.
    resume.freeze();
    stopping = (async () => {
      stopShipWatcher();
      const shutdownWork = await Promise.allSettled([
        stopSystems(),
        stopWorkspaceCreation(),
      ]);
      for (const result of shutdownWork)
        if (result.status === "rejected")
          log("could not stop workspace jobs: " + reason(result.reason));
      await terminals.stop();
      await controller?.stop();
      await Promise.all([
        ...stops,
        ...[...services.values()].map((service) => service.stop()),
      ]);
      await (await hostSocket)?.close();
      for (const pending of pendingPtys.values()) {
        pending.reject(new Error("Host is stopping"));
        pending.kill();
      }
      await channels.stop();
      await ptys.close();
      resume.dispose();
      finish(code);
    })();
    return stopping;
  }
  if (initial) makeLink(initial);
  let interrupted: HostResumeEntry[] = [];
  try {
    interrupted = resume.takeRunning();
  } catch (error) {
    log("could not recover interrupted sessions: " + reason(error));
  }
  let recovering = false;
  function recover(): Promise<void> | undefined {
    if (drained || stopped || recovering) return;
    recovering = true;
    operationsInFlight++;
    return channels
      .recover(interrupted)
      .then((failed) => resume.retireClaim(channels.running(), failed))
      .catch((error) =>
        log("could not retire recovered sessions: " + reason(error)),
      )
      .finally(() => operationsInFlight--);
  }
  const startupRecovery = recover();
  operationsInFlight++;
  const versionRead = getOmpVersion()
    .then((version) => {
      ompVersion = version;
    })
    .catch((error) => log("could not read omp version: " + reason(error)))
    .finally(() => {
      operationsInFlight--;
      if (!stopped) controller?.start();
    });
  const started = Promise.all([
    startupSweep,
    startupRecovery,
    versionRead,
    ptyStarted,
    hostSocket,
  ]).then(() => {});
  return { stop: () => shutdown(0), done, control, started };
}
