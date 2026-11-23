import { expect, test } from "bun:test";
import { nativeToolTarget } from "../tool-targets";
import type { NativeToolCall } from "../tool-presentation";

const call = (toolName: string, path: string): NativeToolCall => ({
  type: "toolCall",
  toolCallId: "id",
  toolName,
  input: { path },
});

test("file targets retain their workspace and reject unresolvable schemes", () => {
  expect(nativeToolTarget(call("read", "src/a.ts:42"), "/remote/repo")).toEqual(
    { kind: "file", value: "/remote/repo/src/a.ts" },
  );
  expect(nativeToolTarget(call("edit", "/other/a.ts"), "/remote/repo")).toEqual(
    { kind: "file", value: "/other/a.ts" },
  );
  expect(nativeToolTarget(call("read", "relative"))).toBeNull();
  expect(
    nativeToolTarget(call("read", "local://file"), "/remote/repo"),
  ).toBeNull();
  expect(nativeToolTarget(call("read", "https://example.com/path"))).toEqual({
    kind: "web",
    value: "https://example.com/path",
  });
  expect(
    nativeToolTarget(call("write", "https://example.com/path")),
  ).toBeNull();
  expect(nativeToolTarget(call("bash", "/etc/passwd"))).toBeNull();
});

test("agent links try the nested subagent before the parent and never link broadcast", () => {
  expect(nativeToolTarget(call("write", "agent://Parent/Child"))).toEqual({
    kind: "agent",
    value: ["Parent.Child", "Parent"],
  });
  expect(nativeToolTarget(call("write", "agent://Parent/foo.bar"))).toEqual({
    kind: "agent",
    value: ["Parent"],
  });
  expect(nativeToolTarget(call("write", "agent://all"))).toBeNull();
});
