"use client";

import { Value } from "@sinclair/typebox/value";
import { Wand2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import {
  PlanningResultSchema,
  type PlanningBoard,
  type PlanningHttpInput,
  type PlanningLaunch,
  type PlanningImageEdit,
  type PlanningImageRef,
  type PlanningLaunchReview,
  type PlanningOwner,
  type PlanningResult,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api-contracts/planning";
import {
  attachedImageBytes,
  MAX_ATTACHED_IMAGES,
  MAX_TOTAL_ATTACHED_IMAGE_BYTES,
} from "@/lib/image-attachments";
import { MarkdownBody } from "./MarkdownBody";
import { SystemsButton } from "./SystemsForms";
import { ConfirmDialog } from "./ui/field";

const columns = [
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["in_progress", "In progress"],
  ["done", "Done"],
] as const satisfies readonly (readonly [PlanningStatus, string])[];
const phases: Record<PlanningLaunch["phase"], string> = {
  creating: "Setting up…",
  setup_failed: "Setup failed",
  review_required: "Setup plan changed",
  ready: "Setup complete",
  sending: "Sending prompt…",
  sent: "Prompt sent",
  delivery_failed: "Prompt not delivered",
  delivery_unknown:
    "Unknown delivery. Check the chat before sending anything else.",
};
const isActive = (launch?: PlanningLaunch) =>
  launch?.phase === "creating" ||
  launch?.phase === "ready" ||
  launch?.phase === "sending";

class PlanningRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function planningRequest(
  host: string,
  owner: PlanningOwner,
  input: PlanningHttpInput,
): Promise<PlanningResult> {
  const response = await fetch("/api/planning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, owner, input }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body && typeof body === "object" ? body : {};
    const message =
      "error" in error && typeof error.error === "string"
        ? error.error
        : `Request failed (HTTP ${response.status}).`;
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    throw new PlanningRequestError(message, response.status, code);
  }
  if (!Value.Check(PlanningResultSchema, body))
    throw new Error("Invalid planning response.");
  return body;
}

type TaskEdit = Pick<PlanningTask, "brief" | "prompt" | "status"> &
  Partial<Pick<PlanningTask, "id" | "revision">> & { images?: DraftImage[] };

type DraftImage = PlanningImageRef | Exclude<PlanningImageEdit, string>;
const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

function PlanningImages({
  label,
  target,
  images,
  disabled,
  onChange,
  run,
}: {
  label: string;
  target: { host: string; kind: PlanningOwner["kind"]; ownerId: string };
  images: readonly DraftImage[];
  disabled: boolean;
  onChange: (images: DraftImage[]) => void;
  run: (work: () => Promise<void>) => Promise<void>;
}) {
  return (
    <div className="planning-images">
      <label>
        {label}
        <input
          type="file"
          multiple
          accept={imageTypes.join(",")}
          disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (!files.length) return;
            void run(async () => {
              const bytes = images.reduce(
                (sum, image) =>
                  sum +
                  ("bytes" in image ? image.bytes : attachedImageBytes(image)),
                0,
              );
              if (
                images.length + files.length > MAX_ATTACHED_IMAGES ||
                bytes + files.reduce((sum, file) => sum + file.size, 0) >
                  MAX_TOTAL_ATTACHED_IMAGE_BYTES
              )
                throw new Error("Attach up to 10 images totaling 5 MiB.");
              const added = await Promise.all(
                files.map(async (file) => {
                  const mimeType = imageTypes.find(
                    (type) => type === file.type,
                  );
                  if (!mimeType || !file.size)
                    throw new Error("Choose a PNG, JPEG, GIF or WebP image.");
                  const { promise, resolve, reject } =
                    Promise.withResolvers<string>();
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve(
                      String(reader.result).slice(
                        String(reader.result).indexOf(",") + 1,
                      ),
                    );
                  reader.onerror = () =>
                    reject(new Error(`Couldn't read ${file.name}.`));
                  reader.readAsDataURL(file);
                  return {
                    name: file.name.slice(0, 255),
                    mimeType,
                    data: await promise,
                  };
                }),
              );
              onChange([...images, ...added]);
            });
          }}
        />
      </label>
      {images.length > 0 && (
        <ul className="planning-image-list">
          {images.map((image, index) => {
            const src =
              "id" in image
                ? `/api/planning?${new URLSearchParams({ ...target, imageId: image.id })}`
                : `data:${image.mimeType};base64,${image.data}`;
            return (
              <li key={"id" in image ? image.id : index}>
                <a
                  href={src.startsWith("/api/") ? src : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img src={src} alt={image.name} loading="lazy" />
                </a>
                <SystemsButton
                  disabled={disabled}
                  aria-label={`Remove ${image.name}`}
                  onClick={() => onChange(images.filter((_, i) => i !== index))}
                >
                  Remove
                </SystemsButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Keep the card recognizable when an improved brief starts with a generic Markdown heading.
function taskTitle(brief: string): string {
  return brief
    .trim()
    .split(/[\r\n]/, 1)[0]
    .slice(0, 240)
    .trim();
}

export function PlanningPage({
  host,
  owner: { kind, id },
  launchDisabled,
  onClose,
  onChanged,
  onOpenTarget,
  onOpenChat,
}: {
  host: string;
  owner: PlanningOwner;
  launchDisabled?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onOpenTarget: (launch: PlanningLaunch) => void | Promise<void>;
  onOpenChat?: (sessionId: string) => void;
}) {
  const heading = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [board, setBoard] = useState<PlanningBoard>();
  const [notes, setNotes] = useState<{
    text: string;
    revision: number;
    images?: DraftImage[];
  }>();
  const [preview, setPreview] = useState(false);
  const [edit, setEdit] = useState<TaskEdit>();
  const [taskToDelete, setTaskToDelete] = useState<PlanningTask>();
  const [review, setReview] = useState<{
    task: PlanningTask;
    action: "launch" | "resume";
    plan: PlanningLaunchReview;
  }>();
  const [pending, setPending] = useState(false);
  const actionVersion = useRef(0);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const request = useCallback(
    (input: PlanningHttpInput) => planningRequest(host, { kind, id }, input),
    [host, kind, id],
  );

  const run = useCallback(
    async (work: () => Promise<void>) => {
      if (locked.current) return;
      locked.current = true;
      actionVersion.current++;
      setPending(true);
      setError("");
      try {
        await work();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (
          cause instanceof PlanningRequestError &&
          (cause.status === 409 ||
            cause.code === "planning_task_not_found" ||
            cause.code === "task_not_found")
        ) {
          try {
            const latest = await request({ action: "read" });
            if (latest.board) setBoard(latest.board);
          } catch {
            setError(
              `${message} Couldn't reload the board. Your edits are still here.`,
            );
            return;
          }
        }
        setError(message);
      } finally {
        locked.current = false;
        setPending(false);
      }
    },
    [request],
  );

  const readBoard = useCallback(
    () =>
      run(async () => {
        const result = await request({ action: "read" });
        if (!result.board) throw new Error("No board returned.");
        setBoard(result.board);
      }),
    [request, run],
  );

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    void readBoard();
  }, [readBoard]);
  const activeTaskIds =
    board?.tasks
      .filter((task) => isActive(task.launch))
      .map(({ id }) => id)
      .join(",") ?? "";
  const notifyChanged = useEffectEvent(onChanged);
  useEffect(() => {
    if (!activeTaskIds) return;
    const ids = activeTaskIds.split(",");
    let stopped = false;
    let timer: number;
    const follow = async () => {
      try {
        if (locked.current || document.hidden) return;
        const version = actionVersion.current;
        let latest: PlanningBoard | undefined;
        for (const taskId of ids) {
          latest = (await request({ action: "refresh", taskId })).board;
          if (stopped || actionVersion.current !== version) return;
        }
        if (latest) {
          setBoard(latest);
          if (
            ids.some(
              (id) =>
                !isActive(latest.tasks.find((task) => task.id === id)?.launch),
            )
          )
            notifyChanged();
        }
      } catch {
        // Keep the last board during a transport error. Manual refresh shows the error.
      } finally {
        if (!stopped) timer = window.setTimeout(follow, 2000);
      }
    };
    timer = window.setTimeout(follow, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [activeTaskIds, request]);
  const editingTask = !!edit;
  const editingTaskId = edit?.id;
  useEffect(() => {
    if (editingTask) editorRef.current?.focus();
  }, [editingTaskId, editingTask]);

  const save = (input: PlanningHttpInput, after?: () => void) =>
    run(async () => {
      const result = await request(input);
      if (!result.board) throw new Error("No board returned.");
      setBoard(result.board);
      after?.();
    });
  const launchTask = async (
    action: "launch" | "resume",
    task: PlanningTask,
    confirmation?: LaunchSelection,
  ) => {
    setReview(undefined);
    const fields = { taskId: task.id, review: confirmation };
    const result = await request(
      action === "launch"
        ? { action, ...fields, revision: task.revision }
        : { action, ...fields },
    );
    if (result.board) setBoard(result.board);
    if (result.review) setReview({ action, task, plan: result.review });
    else onChanged();
  };
  const submitLaunch = (
    action: "launch" | "resume",
    task: PlanningTask,
    confirmation?: LaunchSelection,
  ) => run(() => launchTask(action, task, confirmation));
  const saveTask = (task: TaskEdit, launch = false) =>
    run(async () => {
      const brief = task.brief || taskTitle(task.prompt);
      const result = await request({
        action: "saveTask",
        taskId: task.id,
        revision: task.revision,
        brief,
        prompt: task.prompt === brief ? "" : task.prompt,
        images: task.images?.map((image) => ("id" in image ? image.id : image)),
        status: task.status,
      });
      if (!result.board) throw new Error("No board returned.");
      setBoard(result.board);
      setEdit(undefined);
      if (launch) {
        // A create appends its new card to the daemon's committed snapshot.
        const saved = task.id
          ? result.board.tasks.find(({ id }) => id === task.id)
          : result.board.tasks.at(-1);
        if (!saved) throw new Error("Saved task not found.");
        await launchTask("launch", saved);
      }
    });
  const editTask = (task: PlanningTask) =>
    setEdit({
      id: task.id,
      revision: task.revision,
      brief: task.brief,
      prompt: task.prompt.trim() ? task.prompt : task.brief,
      images: task.images,
      status: task.status,
    });

  const notesText = notes?.text ?? board?.notes ?? "";
  const imageTarget = { host, kind, ownerId: id };
  const notesConflict = !!notes && notes.revision !== board?.notesRevision;
  const savedTask = edit?.id
    ? board?.tasks.find((task) => task.id === edit.id)
    : undefined;
  const taskConflict = !!edit?.id && edit.revision !== savedTask?.revision;
  const canLaunch = !!board?.canLaunch && !launchDisabled;

  return (
    <section className="planning-page" aria-labelledby={heading}>
      <div className="planning-content">
        <header>
          <h1 id={heading} ref={headingRef} tabIndex={-1}>
            {kind === "repo" ? "Repo" : "System"} Notes &amp; Tasks
            {board ? `: ${board.name}` : ""}
          </h1>
          <SystemsButton disabled={pending} onClick={onClose}>
            Back to workspace
          </SystemsButton>
        </header>
        {pending && <p role="status">Working…</p>}
        {error && <p role="alert">{error}</p>}
        {!board ? (
          !pending && (
            <SystemsButton onClick={() => void readBoard()}>
              Reload board
            </SystemsButton>
          )
        ) : (
          <>
            <section aria-labelledby={`${heading}-notes`}>
              <header>
                <h2 id={`${heading}-notes`}>Notes</h2>
                <SystemsButton
                  aria-pressed={preview}
                  onClick={() => setPreview(!preview)}
                >
                  Markdown preview
                </SystemsButton>
              </header>
              {preview ? (
                <div className="planning-preview">
                  {notesText ? (
                    <MarkdownBody>{notesText}</MarkdownBody>
                  ) : (
                    <p>No notes yet.</p>
                  )}
                </div>
              ) : (
                <textarea
                  aria-label="Notes (Markdown)"
                  rows={6}
                  value={notesText}
                  disabled={pending}
                  maxLength={128 * 1024}
                  onChange={(event) =>
                    setNotes({
                      ...notes,
                      text: event.target.value,
                      revision: notes?.revision ?? board.notesRevision,
                    })
                  }
                />
              )}
              <PlanningImages
                label="Attach Notes images"
                target={imageTarget}
                images={notes?.images ?? board.notesImages ?? []}
                disabled={pending}
                run={run}
                onChange={(images) =>
                  setNotes({
                    text: notesText,
                    revision: notes?.revision ?? board.notesRevision,
                    images,
                  })
                }
              />
              <p className="planning-muted">
                Notes and their images aren't sent to models or agents.
              </p>
              {notesConflict && (
                <details>
                  <summary>
                    Notes changed elsewhere. Compare the saved version.
                  </summary>
                  <p className="planning-text">
                    {board.notes || "No saved notes."}
                  </p>
                  <SystemsButton
                    disabled={pending}
                    onClick={() =>
                      setNotes({
                        ...notes,
                        text: notesText,
                        revision: board.notesRevision,
                      })
                    }
                  >
                    Keep my edits
                  </SystemsButton>{" "}
                  <SystemsButton
                    disabled={pending}
                    onClick={() => setNotes(undefined)}
                  >
                    Use saved notes
                  </SystemsButton>
                </details>
              )}
              <div className="planning-actions">
                <SystemsButton
                  disabled={
                    pending ||
                    notesConflict ||
                    (notesText === board.notes && notes?.images === undefined)
                  }
                  onClick={() => {
                    if (notes)
                      void save(
                        {
                          action: "saveNotes",
                          notes: notes.text,
                          images: notes.images?.map((image) =>
                            "id" in image ? image.id : image,
                          ),
                          revision: notes.revision,
                        },
                        () => setNotes(undefined),
                      );
                  }}
                >
                  Save notes
                </SystemsButton>
              </div>
            </section>
            <section aria-labelledby={`${heading}-tasks`}>
              <header>
                <h2 id={`${heading}-tasks`}>Tasks</h2>
                <div className="planning-actions">
                  <SystemsButton
                    disabled={pending}
                    onClick={() => void readBoard()}
                  >
                    Refresh board
                  </SystemsButton>
                  <SystemsButton
                    disabled={pending || !!edit || !!review}
                    onClick={() =>
                      setEdit({ brief: "", prompt: "", status: "backlog" })
                    }
                  >
                    Add task
                  </SystemsButton>
                </div>
              </header>
              {!canLaunch && (
                <p className="planning-muted">
                  Launch isn't available for this{" "}
                  {kind === "repo" ? "Repo" : "System"}.
                </p>
              )}
              {edit && (
                <form
                  className="planning-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!edit.prompt.trim() || taskConflict || pending) return;
                    void saveTask(edit);
                  }}
                >
                  <div className="planning-actions planning-brief-heading">
                    <label htmlFor={`${heading}-brief`}>Brief</label>
                    <SystemsButton
                      disabled={pending || !edit.prompt.trim()}
                      onClick={() =>
                        void run(async () => {
                          const result = await request({
                            action: "draft",
                            brief: edit.prompt,
                            taskId: edit.id,
                            images: edit.images?.map((image) =>
                              "id" in image ? image.id : image,
                            ),
                          });
                          if (result.draft === undefined)
                            throw new Error("No improved brief returned.");
                          setEdit({
                            ...edit,
                            brief: edit.brief || taskTitle(edit.prompt),
                            prompt: result.draft,
                          });
                        })
                      }
                    >
                      <Wand2 size={15} aria-hidden="true" /> Improve
                    </SystemsButton>
                  </div>
                  <textarea
                    id={`${heading}-brief`}
                    ref={editorRef}
                    rows={5}
                    value={edit.prompt}
                    required
                    maxLength={32 * 1024}
                    placeholder="What should the agent do?"
                    disabled={pending}
                    onChange={(event) =>
                      setEdit({ ...edit, prompt: event.target.value })
                    }
                  />
                  <PlanningImages
                    label="Attach task images"
                    target={imageTarget}
                    images={edit.images ?? []}
                    disabled={pending}
                    run={run}
                    onChange={(images) => setEdit({ ...edit, images })}
                  />
                  {taskConflict && (
                    <details>
                      <summary>
                        {savedTask
                          ? "Task changed elsewhere. Compare the saved version."
                          : "This task was deleted elsewhere."}
                      </summary>
                      {savedTask ? (
                        <>
                          <p>
                            {savedTask.brief} (
                            {
                              columns.find(
                                ([status]) => status === savedTask.status,
                              )?.[1]
                            }
                            )
                          </p>
                          <p className="planning-text">
                            {savedTask.prompt.trim()
                              ? savedTask.prompt
                              : savedTask.brief}
                          </p>
                          <SystemsButton
                            disabled={pending}
                            onClick={() =>
                              setEdit({
                                ...edit,
                                revision: savedTask.revision,
                                status: savedTask.status,
                              })
                            }
                          >
                            Keep my edits
                          </SystemsButton>{" "}
                          <SystemsButton
                            disabled={pending}
                            onClick={() => editTask(savedTask)}
                          >
                            Use saved task
                          </SystemsButton>
                        </>
                      ) : (
                        <SystemsButton
                          disabled={pending}
                          onClick={() =>
                            setEdit({
                              brief: edit.brief,
                              prompt: edit.prompt,
                              status: edit.status,
                              images: edit.images?.filter(
                                (image) => !("id" in image),
                              ),
                            })
                          }
                        >
                          Keep as new task
                        </SystemsButton>
                      )}
                    </details>
                  )}
                  <div className="planning-actions">
                    {!savedTask?.launch && (
                      <SystemsButton
                        disabled={
                          pending ||
                          !canLaunch ||
                          taskConflict ||
                          !edit.prompt.trim()
                        }
                        onClick={() => void saveTask(edit, true)}
                      >
                        Launch
                      </SystemsButton>
                    )}
                    <SystemsButton
                      type="submit"
                      disabled={pending || taskConflict || !edit.prompt.trim()}
                    >
                      Save task
                    </SystemsButton>
                    <SystemsButton
                      disabled={pending}
                      onClick={() => setEdit(undefined)}
                    >
                      Cancel
                    </SystemsButton>
                  </div>
                </form>
              )}
              {review && (
                <LaunchReview
                  key={review.plan.confirmation}
                  plan={review.plan}
                  disabled={pending || !canLaunch}
                  onCancel={() => setReview(undefined)}
                  onConfirm={(selection) =>
                    void submitLaunch(review.action, review.task, selection)
                  }
                />
              )}
              <div className="planning-columns">
                {columns.map(([status, label]) => (
                  <section
                    className="planning-column"
                    key={status}
                    aria-labelledby={`${heading}-${status}`}
                  >
                    <h3 id={`${heading}-${status}`}>{label}</h3>
                    {board.tasks.some((task) => task.status === status) ? (
                      <ul>
                        {board.tasks
                          .filter((task) => task.status === status)
                          .map((task) => {
                            const launchState = task.launch;
                            const resumable =
                              launchState?.phase === "setup_failed" ||
                              launchState?.phase === "review_required" ||
                              launchState?.phase === "delivery_failed";
                            const editing = edit?.id === task.id;
                            return (
                              <li key={task.id}>
                                <article
                                  className="planning-card"
                                  aria-label={task.brief}
                                >
                                  <strong>{task.brief}</strong>
                                  <label>
                                    Move task
                                    <select
                                      aria-label={`Move ${task.brief}`}
                                      value={task.status}
                                      disabled={pending || editing || !!review}
                                      onChange={(event) => {
                                        const next = columns.find(
                                          ([value]) =>
                                            value === event.target.value,
                                        )?.[0];
                                        if (next)
                                          void save({
                                            action: "saveTask",
                                            taskId: task.id,
                                            revision: task.revision,
                                            brief: task.brief,
                                            prompt: task.prompt,
                                            status: next,
                                          });
                                      }}
                                    >
                                      {columns.map(([value, name]) => (
                                        <option value={value} key={value}>
                                          {name}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <div className="planning-actions">
                                    <SystemsButton
                                      disabled={pending || !!edit || !!review}
                                      onClick={() => editTask(task)}
                                    >
                                      Edit
                                    </SystemsButton>
                                    {!launchState && (
                                      <SystemsButton
                                        disabled={
                                          pending ||
                                          !canLaunch ||
                                          !!review ||
                                          !!edit
                                        }
                                        onClick={() =>
                                          void submitLaunch("launch", task)
                                        }
                                      >
                                        Launch
                                      </SystemsButton>
                                    )}
                                    <SystemsButton
                                      disabled={
                                        pending ||
                                        editing ||
                                        !!review ||
                                        isActive(launchState)
                                      }
                                      onClick={() => setTaskToDelete(task)}
                                    >
                                      Delete
                                    </SystemsButton>
                                  </div>
                                  {launchState && (
                                    <>
                                      <p role="status">
                                        {phases[launchState.phase]}
                                      </p>
                                      {launchState.setup?.kind === "repo" && (
                                        <p>
                                          Branch:{" "}
                                          <code>
                                            {launchState.setup.branch}
                                          </code>
                                        </p>
                                      )}
                                      {launchState.error && (
                                        <p role="alert">{launchState.error}</p>
                                      )}
                                      <div className="planning-actions">
                                        {isActive(launchState) && (
                                          <SystemsButton
                                            disabled={pending}
                                            onClick={() =>
                                              void save(
                                                {
                                                  action: "refresh",
                                                  taskId: task.id,
                                                },
                                                onChanged,
                                              )
                                            }
                                          >
                                            Refresh progress
                                          </SystemsButton>
                                        )}
                                        {resumable && (
                                          <SystemsButton
                                            disabled={
                                              pending || !canLaunch || !!review
                                            }
                                            onClick={() =>
                                              void submitLaunch("resume", task)
                                            }
                                          >
                                            Resume
                                          </SystemsButton>
                                        )}
                                        {(kind === "repo"
                                          ? launchState.path
                                          : launchState.effortId) && (
                                          <SystemsButton
                                            disabled={pending}
                                            onClick={() =>
                                              void run(async () => {
                                                await onOpenTarget(launchState);
                                                onClose();
                                              })
                                            }
                                          >
                                            {kind === "repo"
                                              ? "Open Workspace"
                                              : "Open Effort"}
                                          </SystemsButton>
                                        )}
                                        {launchState.sessionId &&
                                          onOpenChat && (
                                            <SystemsButton
                                              disabled={pending}
                                              onClick={() => {
                                                onClose();
                                                onOpenChat(
                                                  launchState.sessionId!,
                                                );
                                              }}
                                            >
                                              Open chat
                                            </SystemsButton>
                                          )}
                                      </div>
                                    </>
                                  )}
                                </article>
                              </li>
                            );
                          })}
                      </ul>
                    ) : (
                      <p className="planning-muted">No tasks</p>
                    )}
                  </section>
                ))}
              </div>
            </section>
          </>
        )}
        <ConfirmDialog
          open={!!taskToDelete}
          onOpenChange={(open) => {
            if (!open) setTaskToDelete(undefined);
          }}
          title="Delete task?"
          description={
            taskToDelete &&
            `${taskToDelete.brief}\n\nThis removes the task from the board. Any linked workspace, Effort, or chat stays.`
          }
          confirmLabel="Delete task"
          danger
          onConfirm={() => {
            if (!taskToDelete) return;
            setTaskToDelete(undefined);
            void save({
              action: "deleteTask",
              taskId: taskToDelete.id,
              revision: taskToDelete.revision,
            });
          }}
        />
      </div>
    </section>
  );
}

type LaunchSelection = NonNullable<
  Extract<PlanningHttpInput, { action: "launch" }>["review"]
>;

function LaunchReview({
  plan,
  disabled,
  onCancel,
  onConfirm,
}: {
  plan: PlanningLaunchReview;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: (selection: LaunchSelection) => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const [baseRef, setBaseRef] = useState(plan.repo?.baseRef ?? "");
  const [bases, setBases] = useState(() =>
    Object.fromEntries(
      plan.effort?.members.map((member) => [
        member.repoPath,
        member.baseCommit ? member.baseRef : "",
      ]) ?? [],
    ),
  );
  useEffect(() => {
    title.current?.focus();
  }, []);
  const branches = plan.repo?.branches;
  const refs = branchRefs(branches, plan.repo?.baseRef);
  const members = plan.effort?.members ?? [];
  const missingBase =
    (!!branches && !baseRef) ||
    members.some(({ repoPath }) => !bases[repoPath]);
  const changedBase = members.some(
    ({ repoPath, baseRef }) => bases[repoPath] !== baseRef,
  );
  return (
    <form
      className="planning-editor"
      aria-label="Review launch"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || missingBase) return;
        onConfirm({
          confirmation: plan.confirmation,
          effortName: plan.effort?.name,
          baseRef: branches ? baseRef : undefined,
          bases: plan.effort
            ? members.map(({ repoPath }) => ({
                repoPath,
                ref: bases[repoPath]!,
              }))
            : undefined,
        });
      }}
    >
      <h4 ref={title} tabIndex={-1}>
        Review launch: {plan.name}
      </h4>
      <p>
        Confirm the branch and bases before setup starts. Keylime will send the
        saved prompt after setup.
      </p>
      {branches && (
        <>
          <p>Branch: a new branch named when setup starts.</p>
          <label>
            Base ref
            <select
              required
              value={baseRef}
              disabled={disabled}
              onChange={(event) => setBaseRef(event.target.value)}
            >
              <option value="">Choose a base</option>
              {refs.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {plan.effort && (
        <>
          <p>
            Branch: <code>{plan.effort.branch}</code>
          </p>
          {members.some(({ skipsCustomCreate }) => skipsCustomCreate) && (
            <p>
              Custom Workspace creation won't run for the members marked below.
            </p>
          )}
          {members.map((member) => {
            const refs = branchRefs(
              member.branches,
              member.baseCommit ? member.baseRef : undefined,
            );
            return (
              <label key={member.repoPath}>
                Base for <code>{member.repoPath}</code>
                {member.skipsCustomCreate ? " (skips custom creation)" : ""}
                {member.baseCommit &&
                  bases[member.repoPath] === member.baseRef && (
                    <span>
                      Starting commit: <code>{member.baseCommit}</code>
                    </span>
                  )}
                <select
                  required
                  disabled={disabled}
                  value={bases[member.repoPath]}
                  onChange={(event) => {
                    const ref = event.target.value;
                    setBases((previous) => ({
                      ...previous,
                      [member.repoPath]: ref,
                    }));
                  }}
                >
                  <option value="">
                    {refs.length ? "Choose a base" : "No bases available"}
                  </option>
                  {refs.map((ref) => (
                    <option key={ref} value={ref}>
                      {ref}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </>
      )}
      <div className="planning-actions">
        <SystemsButton type="submit" disabled={disabled || missingBase}>
          {changedBase ? "Review selected bases" : "Confirm launch"}
        </SystemsButton>
        <SystemsButton onClick={onCancel}>Cancel review</SystemsButton>
      </div>
    </form>
  );
}

function branchRefs(
  branches?: NonNullable<PlanningLaunchReview["repo"]>["branches"],
  selected?: string,
) {
  return [
    ...new Set(
      [
        selected,
        branches?.defaultRef,
        branches?.originAheadRef,
        ...(branches?.otherRefs ?? []),
        ...(branches?.local ?? []),
        ...(branches?.remote ?? []),
      ].filter((ref): ref is string => !!ref),
    ),
  ];
}
