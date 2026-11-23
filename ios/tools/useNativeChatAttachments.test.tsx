import "../../tests/setup-dom.ts";
import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type * as ReactTypes from "react";
import type { NativeAttachmentSelection } from "../native-network";
import { MAX_UPLOAD_BYTES } from "../../lib/upload-limits";

const React = createRequire(new URL("../../package.json", import.meta.url))(
  "react",
) as typeof ReactTypes;

const nativeRequire = createRequire(
  new URL("../ChatAttachments.tsx", import.meta.url),
);
mock.module(nativeRequire.resolve("react"), () => React);
mock.module(nativeRequire.resolve("react-native"), () => ({
  Image: () => null,
  Pressable: () => null,
  ScrollView: () => null,
  Text: () => null,
  View: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useColorScheme: () => "dark",
}));
let selection: () => Promise<NativeAttachmentSelection> = async () => ({
  files: [],
  errors: [],
});
let nextId = 0;
const removed: string[] = [];
mock.module("../native-network", () => ({
  pickNativeAttachments: () => selection(),
  pasteNativeAttachment: async () => null,
  readNativeAttachment: async () => "AQID",
  removeNativeAttachment: async (file: string) => {
    removed.push(file);
  },
  newUploadId: () => `upload-${++nextId}`,
  nativeRequest: async (
    _origin: string,
    _path: string,
    options: RequestInit,
  ) => {
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(options.body)) as { size: number };
    return Response.json({ received: body.size, proof: "fixture-proof" });
  },
  nativeFileChunk: async () => {
    throw new Error("Unexpected chunk");
  },
}));
// Load the renderer and hook only after installing native-module mocks and DOM.
const { act, renderHook, waitFor } =
  await import("@testing-library/react/pure.js");
const { useChatAttachments } = await import("../ChatAttachments");

test("supported photos go inline and unsupported photos retain their original file", async () => {
  selection = async () => ({
    files: [
      { file: "png", name: "photo.png", size: 3, mimeType: "image/png" },
      { file: "heic", name: "photo.heic", size: 3, mimeType: "image/heic" },
    ],
    errors: [],
  });
  const view = renderHook(() =>
    useChatAttachments("https://example.test", "local", "chat"),
  );
  try {
    await act(async () => {
      await view.result.current.pick();
    });
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(view.result.current.payload.images).toEqual([
      { type: "image", mimeType: "image/png", data: "AQID" },
    ]);
    const file = view.result.current.items.find(
      (item) => item.name === "photo.heic",
    );
    if (!file) throw new Error("HEIC attachment was not retained");
    expect(file.mode).toBe("file");
    expect(view.result.current.payload.uploads).toEqual([file.id]);
    expect(view.result.current.payload.uploadProofs?.[file.id]).toBe(
      "fixture-proof",
    );
    expect(view.result.current.error).toContain("not supported inline");
    act(() => view.result.current.switchMode(file.id));
    expect(
      view.result.current.items.find((item) => item.id === file.id)?.mode,
    ).toBe("file");
    expect(view.result.current.error).toContain("cannot be sent inline");
  } finally {
    view.unmount();
  }
});
test("a failed or oversized photo does not discard the successful selection", async () => {
  removed.length = 0;
  selection = async () => ({
    files: [
      { file: "usable", name: "usable.png", size: 3, mimeType: "image/png" },
      {
        file: "oversized",
        name: "huge.png",
        size: MAX_UPLOAD_BYTES + 1,
        mimeType: "image/png",
      },
    ],
    errors: ["Could not open cloud photo"],
  });
  const view = renderHook(() =>
    useChatAttachments("https://example.test", "local", "chat"),
  );
  try {
    await act(async () => {
      await view.result.current.pick();
    });
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(view.result.current.payload.images).toEqual([
      { type: "image", mimeType: "image/png", data: "AQID" },
    ]);
    expect(view.result.current.error).toContain("Could not open cloud photo");
    expect(view.result.current.error).toContain("huge.png");
    expect(removed).toContain("oversized");
  } finally {
    view.unmount();
  }
});

test("a completed picker cannot attach a photo to a different chat", async () => {
  removed.length = 0;
  const pending = Promise.withResolvers<NativeAttachmentSelection>();
  selection = () => pending.promise;
  const view = renderHook(
    ({ chat }) => useChatAttachments("https://example.test", "local", chat),
    { initialProps: { chat: "first" } },
  );
  try {
    let picking!: Promise<void>;
    act(() => {
      picking = view.result.current.pick();
    });
    view.rerender({ chat: "second" });
    await act(async () => {
      pending.resolve({
        files: [
          {
            file: "late-photo",
            name: "late.png",
            size: 3,
            mimeType: "image/png",
          },
        ],
        errors: [],
      });
      await picking;
    });
    expect(view.result.current.items).toEqual([]);
    expect(removed).toContain("late-photo");
  } finally {
    view.unmount();
  }
});
