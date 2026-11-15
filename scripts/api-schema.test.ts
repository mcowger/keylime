import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { Type } from "@sinclair/typebox";
import { portableDocument } from "./api-schema";
import {
  AgentCommandSchema,
  NewAgentCommandSchema,
} from "../lib/api-contracts/runner-messages";
import { hostOperations } from "../lib/api-contracts/host-operations";
import {
  NativeAssistantContentBlockSchema,
  runnerEventSchemas,
  browserNativeEventSchemas,
} from "../lib/api-contracts/runner-native-events";
import { ToolCallContentSchema } from "../lib/api-contracts/domain";

const ajv = () => new Ajv({ strict: false, validateFormats: false });

test("recursive resources remain local when two embedded models reuse an id", () => {
  const textTree = Type.Recursive(
    (self) => Type.Object({ value: Type.String(), children: Type.Array(self) }),
    { $id: "Node" },
  );
  const numberTree = Type.Recursive(
    (self) => Type.Object({ value: Type.Number(), children: Type.Array(self) }),
    { $id: "Node" },
  );
  const document = portableDocument(
    Type.Object({ text: textTree, numeric: numberTree }),
  );
  const validate = ajv().compile(document);
  assert.equal(
    validate({
      text: { value: "a", children: [{ value: "b", children: [] }] },
      numeric: { value: 1, children: [{ value: 2, children: [] }] },
    }),
    true,
  );
  assert.equal(
    validate({
      text: { value: "a", children: [{ value: 2, children: [] }] },
      numeric: { value: 1, children: [] },
    }),
    false,
  );
});

test("undefined values describe actual JSON omission and positional nulls", () => {
  const schema = Type.Object({
    required: Type.String(),
    result: Type.Union([Type.String(), Type.Undefined()]),
    args: Type.Tuple([
      Type.String(),
      Type.Union([Type.Number(), Type.Undefined()]),
    ]),
  });
  const validate = ajv().compile(portableDocument(schema));
  const serialized = JSON.parse(
    JSON.stringify({
      required: "yes",
      result: undefined,
      args: ["a", undefined],
    }),
  );
  assert.equal(validate(serialized), true);
  assert.equal(validate({ ...serialized, args: ["a", "not-a-number"] }), false);
  assert.equal(validate({ result: "value", args: ["a", null] }), false);
});

test("module-local definition references survive embedding in document components", () => {
  const document = portableDocument({
    definitions: {
      model: {
        $defs: { Value: { type: "string" } },
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        required: ["value"],
      },
    },
    $ref: "#/definitions/model",
  });
  const validate = ajv().compile(document);
  assert.equal(validate({ value: "native-client" }), true);
  assert.equal(validate({ value: 42 }), false);
});

test("native clients can distinguish agent command payloads rather than accepting arbitrary bodies", () => {
  const validate = ajv().compile(portableDocument(AgentCommandSchema));
  assert.equal(
    validate({ type: "set_model", provider: "provider", modelId: "model" }),
    true,
  );
  assert.equal(validate({ type: "set_model", provider: "provider" }), false);
  assert.equal(validate({ type: "not_a_registered_command" }), false);
  assert.equal(validate({ type: "navigate_tree", entryId: "entry" }), false);
});

test("host upload metadata is generation-bound and models MIME type under its wire name", () => {
  const operation = hostOperations.find((item) => item.name === "uploadStart");
  assert.ok(operation);
  const validate = ajv().compile(portableDocument(operation.args));
  const input = {
    id: "11111111-1111-4111-8111-111111111111",
    attempt: "22222222-2222-4222-8222-222222222222",
    name: "note.txt",
    size: 12,
    type: "text/plain",
  };
  assert.equal(validate(input), true);
  const { attempt: _attempt, ...missingAttempt } = input;
  assert.equal(validate(missingAttempt), false);
  const { type: _type, ...missingType } = input;
  assert.equal(validate({ ...missingType, mime: "text/plain" }), false);
});

test("native and normalized tool call models preserve their different wire field names", () => {
  const native = ajv().compile(
    portableDocument(NativeAssistantContentBlockSchema),
  );
  const display = ajv().compile(portableDocument(ToolCallContentSchema));
  const raw = {
    type: "toolCall",
    id: "call-1",
    name: "read",
    arguments: { path: "file.txt" },
  };
  const normalized = {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "file.txt" },
  };
  assert.equal(native(raw), true);
  assert.equal(native(normalized), false);
  assert.equal(display(normalized), true);
  assert.equal(display(raw), false);
});

test("native tool results require inline images while browser events accept cached URLs", () => {
  for (const kind of ["tool_execution_end", "message_end"]) {
    const nativeSchema = runnerEventSchemas.find(
      (schema) => schema.properties?.type?.const === kind,
    );
    const browserSchema = browserNativeEventSchemas.find(
      (schema) => schema.properties?.type?.const === kind,
    );
    assert.ok(nativeSchema);
    assert.ok(browserSchema);
    const native = ajv().compile(portableDocument(nativeSchema));
    const browser = ajv().compile(portableDocument(browserSchema));
    const inline = { type: "image", mimeType: "image/png", data: "AA==" };
    const cached = {
      type: "image",
      mimeType: "image/png",
      url: "/api/media/hash",
    };
    const result = (image: typeof inline | typeof cached) =>
      kind === "tool_execution_end"
        ? {
            type: kind,
            toolCallId: "call-1",
            toolName: "read",
            isError: false,
            result: { content: [image] },
          }
        : {
            type: kind,
            messageId: "msg-1",
            message: {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              isError: false,
              timestamp: 1,
              content: [image],
            },
          };
    assert.equal(native(result(inline)), true);
    assert.equal(native(result(cached)), false);
    assert.equal(browser(result(cached)), true);
  }
});

test("ensure_session belongs to initialization, not the existing-session command channel", () => {
  const initialize = ajv().compile(portableDocument(NewAgentCommandSchema));
  const existing = ajv().compile(portableDocument(AgentCommandSchema));
  assert.equal(initialize({ type: "ensure_session", cwd: "/workspace" }), true);
  assert.equal(existing({ type: "ensure_session", cwd: "/workspace" }), false);
});
