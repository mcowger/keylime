import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
  assertOperationSemantics,
  handlerSemantics,
  renderSemantics,
  type ContractSemantics,
} from "./api-semantics";
import { httpDocument } from "./generate-api-docs";

// These are parser inputs, not assertions about implementation source spelling.
const source = ts.createSourceFile(
  "route.ts",
  `
/**
 * @apiContract readJob
 * @apiUsage Poll the current job without launching another process.
 * @apiInputs Supply the original job ID.
 * @apiInvariants A status snapshot does not prove that a disconnected job stopped.
 * @apiEffects Reads process-memory state only.
 * @apiRecovery After a daemon replacement, retain an uncertain outcome;
 * do not treat an unknown job as proof of cancellation.
 */
export function GET() {}
/**
 * @apiContract cancelJob
 * @apiUsage Cancel the job captured at the user's click.
 * @apiInputs Supply that job's original generation and ID.
 * @apiInvariants A stale generation cannot cancel a replacement job.
 * @apiEffects Requests termination and waits for confirmation.
 * @apiRecovery Read status after an uncertain reply before sending another mutation.
 */
export function DELETE() {}
`,
  ts.ScriptTarget.Latest,
  true,
);

test("each HTTP method retains its own lifecycle and recovery obligations", () => {
  const read = handlerSemantics(source.statements[0], "GET");
  const cancel = handlerSemantics(source.statements[1], "DELETE");
  assert.match(
    read.Recovery,
    /retain an uncertain outcome;\s+do not treat an unknown job/,
  );
  assert.match(
    cancel.Invariants,
    /stale generation cannot cancel a replacement/,
  );
  assert.doesNotMatch(cancel.Recovery, /proof of cancellation/);
});

test("missing recovery guidance cannot inherit the neighboring method's guidance", () => {
  const incomplete = ts.createSourceFile(
    "route.ts",
    "/** @apiContract cancelJob */\nexport function DELETE() {}",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.throws(
    () => handlerSemantics(incomplete.statements[0], "DELETE"),
    /DELETE: expected one @apiUsage/,
  );
});

test("source usage contracts reach both human and machine readable OpenAPI sections", () => {
  const sections = handlerSemantics(source.statements[1], "DELETE");
  const document = httpDocument(new Map([["cancelJob", sections]]), [
    {
      path: "/api/jobs/{id}",
      route: "/api/jobs/[id]",
      method: "delete",
      operationId: "cancelJob",
      summary: "Cancel captured job",
      responses: { 204: { description: "Cancellation confirmed." } },
    },
  ]);
  const published = JSON.parse(JSON.stringify(document)).paths["/api/jobs/{id}"]
    .delete;
  assert.match(
    published.description,
    /### Invariants\s+A stale generation cannot cancel a replacement job/,
  );
  assert.equal(
    published["x-client-semantics"].Effects,
    "Requests termination and waits for confirmation.",
  );
});

test("command contracts require distinct nonempty semantic sections", () => {
  const sections: ContractSemantics = {
    Usage: "Read a retained transcript.",
    Inputs: "Cursor counts bytes, not characters.",
    Invariants: "Offsets belong to one transcript generation.",
    Effects: "No runner is spawned.",
    Recovery: "Honor reset and restart at the returned cursor.",
  };
  assertOperationSemantics("transcript", renderSemantics(sections));
  const missingRecovery = renderSemantics({ ...sections, Recovery: "" });
  assert.throws(
    () => assertOperationSemantics("transcript", missingRecovery),
    /transcript: Recovery must explain/,
  );
  assert.throws(
    () =>
      assertOperationSemantics(
        "transcript",
        `${renderSemantics(sections)}\nRecovery: Always retry.`,
      ),
    /expected one Recovery/,
  );
  assert.throws(
    () => assertOperationSemantics("transcript", "Read transcript."),
    /expected one Usage/,
  );
});
