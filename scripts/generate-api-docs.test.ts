import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { Type } from "@sinclair/typebox";
import { socketDocument } from "./generate-api-docs";
import { hostLinkContract } from "../lib/api-contracts/host-link";
import { browserLinkContract } from "../lib/api-contracts/browser-link";

function messageSchema(contract: typeof hostLinkContract, title: string) {
  // Consume a serialized artifact as a non-TypeScript client would; no TypeBox symbols or runtime parser involved.
  const document = JSON.parse(JSON.stringify(socketDocument(contract)));
  const schema = document.components.schemas[title];
  assert.ok(schema, `Missing public schema ${title}`);
  return new Ajv({ strict: false, validateFormats: false }).compile(schema);
}

test("host request schema preserves required opaque arguments and safe sequence bounds", () => {
  const validate = messageSchema(hostLinkContract, "HostLinkRequest");
  assert.equal(
    validate({
      type: "req",
      seq: 1,
      id: "request-1",
      op: "readContext",
      args: { id: "session-1" },
      futureField: true,
    }),
    true,
  );
  assert.equal(
    validate({ type: "req", seq: 1, id: "request-1", op: "readContext" }),
    false,
  );
  assert.equal(
    validate({
      type: "req",
      seq: -1,
      id: "request-1",
      op: "readContext",
      args: {},
    }),
    false,
  );
  assert.equal(
    validate({
      type: "req",
      seq: Number.MAX_SAFE_INTEGER + 1,
      id: "request-1",
      op: "readContext",
      args: {},
    }),
    false,
  );
});

test("host hello schema preserves nullable identity and optional creation metadata", () => {
  const validate = messageSchema(hostLinkContract, "HostLinkHello");
  const hello = {
    type: "hello",
    v: 11,
    ompVersion: null,
    platform: "linux",
    home: "/home/agent",
    autoApproveExtension: false,
    ack: 0,
    channels: [
      { ch: "child-1", sessionId: null, cwd: "/workspace", pending: null },
    ],
  };
  assert.equal(validate(hello), true);
  assert.equal(validate({ ...hello, ompVersion: undefined }), false);
  assert.equal(
    validate({
      ...hello,
      channels: [{ ...hello.channels[0], creationId: "../../outside" }],
    }),
    false,
  );
});

test("browser upload responses expose generation and completion proof without confusing binary frames with JSON", () => {
  const document = JSON.parse(
    JSON.stringify(socketDocument(browserLinkContract)),
  );
  const binary = Object.values(document.components.messages).find(
    (message: unknown) =>
      typeof message === "object" &&
      message !== null &&
      "contentType" in message &&
      message.contentType === "application/octet-stream",
  );
  assert.ok(binary, "Native clients need a binary upload frame contract");
  const validate = messageSchema(browserLinkContract, "BrowserUploadAck");
  assert.equal(
    validate({
      type: "up_ack",
      id: "upload-1",
      received: 4096,
      done: true,
      start: 2,
      proof: "opaque-proof",
      seq: 10,
    }),
    true,
  );
  assert.equal(
    validate({
      type: "up_ack",
      id: "upload-1",
      received: -1,
      done: false,
      start: 2,
      seq: 10,
    }),
    false,
  );
});

test("conflicting schema names cannot silently replace a native client's message model", () => {
  assert.throws(
    () =>
      socketDocument({
        ...hostLinkContract,
        send: [
          Type.Object({ type: Type.Literal("first") }, { title: "Collision" }),
        ],
        receive: [
          Type.Object({ type: Type.Literal("second") }, { title: "Collision" }),
        ],
      }),
    /conflicting message schema title Collision/,
  );
});

test("document validators reject invalid OpenAPI, AsyncAPI and JSON Schema", async () => {
  for (const [name, document] of [
    [
      "invalid.openapi.json",
      {
        openapi: "3.1.0",
        info: { title: "API", version: "1" },
        paths: "invalid",
      },
    ],
    [
      "invalid.asyncapi.json",
      {
        asyncapi: "3.0.0",
        info: { title: "API", version: "1" },
        operations: { bad: { action: "fly" } },
      },
    ],
    ["invalid.schema.json", { type: "not-a-json-schema-type" }],
  ] as const) {
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/validate-api-document.ts`, name],
      {
        stdin: new Blob([JSON.stringify(document)]),
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [code, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    assert.notEqual(code, 0, `${name} accepted an invalid document`);
    assert.ok(error, `${name} did not report its validation error`);
  }
});
