import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { hostLinkContract } from "../lib/api-contracts/host-link";
import { socketDocument } from "./generate-api-docs";

function replySchema(name: string) {
  // Preserve published schema pointers; the enclosing AsyncAPI document is not itself JSON Schema.
  const document = JSON.parse(JSON.stringify(socketDocument(hostLinkContract)));
  assert.ok(document.components.schemas[`HostReply_${name}`]);
  return new Ajv({ strict: false, validateFormats: false }).compile({
    components: { schemas: document.components.schemas },
    $ref: `#/components/schemas/HostReply_${name}`,
  });
}

for (const [operation, failure] of [
  [
    "readMedia",
    {
      ok: false,
      status: 404,
      code: "media_not_found",
      error: "Media not found",
    },
  ],
  [
    "readFileChunk",
    {
      ok: false,
      status: 404,
      code: "file_read_missing",
      error: "The file read has ended",
    },
  ],
] as const) {
  test(`${operation} replies distinguish binary success and logical or transport errors`, () => {
    const validate = replySchema(operation);
    const envelope = { type: "res", seq: 1, id: "request-1", ok: true };
    assert.equal(validate({ ...envelope, result: failure }), true);
    assert.equal(validate({ ...envelope, blob: { bytes: 4 } }), true);
    assert.equal(
      validate({
        type: "res",
        seq: 1,
        id: "request-1",
        ok: false,
        error: { status: 500, code: "host_op_failed", message: "Failed" },
      }),
      true,
    );
    assert.equal(
      validate({
        ...envelope,
        result: { ok: false, status: 404, code: failure.code },
      }),
      false,
    );
    assert.equal(
      validate({ ...envelope, result: { ...failure, status: "404" } }),
      false,
    );
    assert.equal(
      validate({ ...envelope, result: { ...failure, code: 404 } }),
      false,
    );
    assert.equal(
      validate({ ...envelope, result: { ...failure, error: null } }),
      false,
    );
    assert.equal(
      validate({ ...envelope, result: { ok: true, value: "AA==" } }),
      false,
    );
    assert.equal(
      validate({ ...envelope, result: { ok: true, value: [0, 1] } }),
      false,
    );
  });
}
