import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { ApiErrorSchema } from "../lib/api-contracts/http-helpers";
import { sessionHttpOperations } from "../lib/api-contracts/http-sessions";
import { browserEventSchemas } from "../lib/api-contracts/runner-events";
import { mergeDeltaUpdates } from "../lib/message-delta";
import { portableDocument } from "./api-schema";

const compile = (schema: unknown) =>
  new Ajv({ strict: false, validateFormats: false }).compile(
    portableDocument(schema),
  );

test("browser event schemas accept a merged delta's inclusive cursor", () => {
  const delta = (sequence: number, chunk: string) => ({
    type: "message_update",
    messageId: "message-1",
    message: { role: "assistant" },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: chunk,
    },
    web: { streamId: "stream-1", sequence },
  });
  const merged = mergeDeltaUpdates(delta(5, "a"), delta(6, "b"));
  assert.ok(merged);
  assert.deepEqual(merged.web, { streamId: "stream-1", sequence: 6, first: 5 });
  const validate = compile({ anyOf: browserEventSchemas });
  assert.equal(validate(merged), true, JSON.stringify(validate.errors));
  assert.equal(validate(delta(7, "c")), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({ ...merged, web: { ...merged.web, first: "5" } }),
    false,
  );
});

test("shared and session recovery errors validate actual wire shapes", () => {
  const validate = compile(ApiErrorSchema);
  const response = sessionHttpOperations.find(
    (operation) => operation.operationId === "sendAgentCommand",
  );
  assert.ok(response);
  const conflict = response.responses["409"] as {
    content: { "application/json": { schema: unknown } };
  };
  const validateSession = compile(conflict.content["application/json"].schema);
  const errors = [
    {
      error: "Host offline",
      code: "host_offline",
      hostOffline: true,
      delivery: "refused",
    },
    {
      error: "Host offline",
      code: "host_offline",
      hostOffline: true,
      delivery: "unknown",
    },
    { error: "Host offline", code: "host_offline", hostOffline: true },
    { error: "Operation failed" },
  ];
  for (const error of errors) {
    assert.equal(validate(error), true, JSON.stringify(validate.errors));
    assert.equal(
      validateSession(error),
      true,
      JSON.stringify(validateSession.errors),
    );
  }
  const invalid = { ...errors[0], delivery: "delivered" };
  assert.equal(validate(invalid), false);
  assert.equal(validateSession(invalid), false);
  assert.equal(
    validateSession({ ...errors[1], host: "host-1", sessionId: "session-1" }),
    true,
  );
});
