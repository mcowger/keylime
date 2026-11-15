import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react");

const { ChatInput } = await import("./ChatInput");
const { MAX_ATTACHED_IMAGE_BYTES } = await import("@/lib/image-attachments");

// jsdom implements neither object URLs nor the async Clipboard API, so both are
// modeled here. The object-URL stub records the composer/blob lifetime the way
// a real tab would leak it: every create needs a matching revoke.
const objectUrls: { created: string[]; revoked: string[] } = {
  created: [],
  revoked: [],
};
let objectUrlCounter = 0;
const previousClipboard = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "clipboard",
);
const previousMatchMedia = window.matchMedia;
const previousFileReader = globalThis.FileReader;
// setup-dom.ts tears the DOM globals back down after this file's tests, so hold
// the window reference now rather than reading the global in the restore hook.
const domWindow = window;

// Node ships no global FileReader, and jsdom's one brand-checks against its own
// realm's Blob, so it refuses the Node Blob the clipboard stand-in produces.
// The composer only uses readAsDataURL -> `result` string, so model just that.
class TestFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  readAsDataURL(blob: Blob) {
    setTimeout(() => {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
          this.onload?.();
        })
        .catch((error) => {
          this.error = error;
          this.onerror?.(error);
        });
    }, 0);
  }
}
globalThis.FileReader = TestFileReader as unknown as typeof FileReader;

// jsdom 29 ships no matchMedia, and the composer reads one at mount for the
// word-completion default (`(pointer: fine)`). Never match: desktop composer.
window.matchMedia = (media) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false;
  },
});

URL.createObjectURL = function createObjectURL() {
  objectUrlCounter += 1;
  const url = `blob:omp-test/${objectUrlCounter}`;
  objectUrls.created.push(url);
  return url;
};
URL.revokeObjectURL = function revokeObjectURL(url) {
  objectUrls.revoked.push(url);
};

function setClipboard(
  clipboard:
    | {
        read: () => Promise<
          Array<{ types: string[]; getType: (type: string) => Promise<Blob> }>
        >;
      }
    | undefined,
) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: clipboard,
  });
}

/** A ClipboardItem stand-in: `types` is browser-reported, `getType` resolves a Blob. */
function clipboardImage(type: string, bytes: number) {
  return {
    types: [type],
    async getType(requested: string) {
      if (requested !== type)
        throw new Error(`unexpected clipboard type ${requested}`);
      return new Blob([new Uint8Array(bytes)], { type });
    },
  };
}

const PLUS_MENU = /More actions|chatInput\.plusMenu/;
const PASTE_ITEM = /Paste image|chatInput\.pasteImage/;
const FAILURE = /No image could be pasted|chatInput\.clipboardImageFailed/;
const AS_FILE = /too large to send inline|chatInput\.imagesAsFile/;
const SWITCH_TO_INLINE = /Switch to Inline|chatInput\.imageSwitchToInline/;
// Any notice the composer raises about the batch it was handed.
const NOTICE =
  /No image could be pasted|too large to send inline|chatInput\.(clipboardImageFailed|imagesAsFile)/;

function previews(container: HTMLElement) {
  return [...container.querySelectorAll("img")].filter((img) =>
    img.getAttribute("src")?.startsWith("blob:"),
  );
}

async function pasteFromClipboard(
  container: HTMLElement,
  settled = () =>
    objectUrls.created.length > 0 || NOTICE.test(container.textContent ?? ""),
) {
  const trigger = screen.getByRole("button", { name: PLUS_MENU });
  await act(async () => {
    trigger.click();
  });
  const item = screen.getByRole("menuitem", { name: PASTE_ITEM });
  await act(async () => {
    item.click();
  });
  // The modeled FileReader settles asynchronously; wait for the batch to land.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    if (settled()) break;
  }
  return container;
}

function renderComposer() {
  return render(
    React.createElement(ChatInput, {
      async onSend(): Promise<{ status: "accepted" }> {
        return { status: "accepted" };
      },
      onAbort() {},
      isStreaming: false,
    }),
  ).container;
}

after(() => {
  if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia;
  else Reflect.deleteProperty(domWindow, "matchMedia");
  if (previousFileReader) globalThis.FileReader = previousFileReader;
  else Reflect.deleteProperty(globalThis, "FileReader");
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    setClipboard(undefined);
    if (previousClipboard) {
      Object.defineProperty(
        globalThis.navigator,
        "clipboard",
        previousClipboard,
      );
    } else {
      Reflect.deleteProperty(globalThis.navigator, "clipboard");
    }
    // The object-URL stubs stay installed for the whole file: restoring them
    // after the first test would leave later tests with no createObjectURL at
    // all, and every read would die inside the reader callback.
    objectUrls.created.length = 0;
    objectUrls.revoked.length = 0;
  }
});

test("mixed clipboard paste leaves text insertion to the browser and attaches the image", async () => {
  const container = renderComposer();
  const textarea = container.querySelector("textarea")!;
  const image = new File([new Uint8Array([1, 2, 3])], "paste.png", { type: "image/png" });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
      getData: (type: string) => type === "text/plain" ? "pasted text" : "",
    },
  });
  await act(async () => { textarea.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, false);
  await waitFor(() => assert.equal(previews(container).length, 1));
});

test("rich text with an embedded image attaches the image without cancelling text", async () => {
  const container = renderComposer();
  const textarea = container.querySelector("textarea")!;
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "string", type: "text/html" }, { kind: "string", type: "text/plain" }],
      getData: (type: string) => type === "text/html"
        ? '<p>Hello <img src="data:image/png;base64,AQID"></p>'
        : type === "text/plain" ? "Hello" : "",
    },
  });
  await act(async () => { textarea.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, false);
  await waitFor(() => assert.equal(previews(container).length, 1));
});

test("attaches a clipboard image through the shared composer attachment path", async () => {
  setClipboard({ read: async () => [clipboardImage("image/png", 8)] });
  const container = await pasteFromClipboard(renderComposer());

  assert.equal(
    previews(container).length,
    1,
    "one preview for the pasted image",
  );
  assert.equal(objectUrls.created.length, 1);
  assert.doesNotMatch(container.textContent ?? "", FAILURE);
  // The menu closes on tap, so the item is no longer offered.
  assert.equal(screen.queryByRole("menuitem", { name: PASTE_ITEM }), null);
});

test("an oversized pasted image goes As file, as from the file picker", async () => {
  setClipboard({
    read: async () => [
      clipboardImage("image/png", MAX_ATTACHED_IMAGE_BYTES + 1),
    ],
  });
  const container = await pasteFromClipboard(renderComposer());

  // Past the inline budget it is uploaded instead (spec U2): its chip keeps the thumbnail.
  assert.equal(previews(container).length, 1);
  assert.match(container.textContent ?? "", AS_FILE);
  assert.ok(screen.getByRole("button", { name: SWITCH_TO_INLINE }));
});

test("reports a clean failure when the clipboard holds no image", async () => {
  setClipboard({
    read: async () => [
      {
        types: ["text/plain"],
        async getType() {
          return new Blob(["hi"]);
        },
      },
    ],
  });
  const container = await pasteFromClipboard(renderComposer());

  assert.equal(previews(container).length, 0);
  assert.match(container.textContent ?? "", FAILURE);
});

test("hides the item where the browser cannot read images from the clipboard", async () => {
  // `navigator.clipboard` exists only in a secure context. On a plain-http LAN
  // session the item could only ever produce the failure banner, so the plus
  // menu hides it rather than offering a dead end.
  setClipboard(undefined);
  renderComposer();
  const trigger = screen.getByRole("button", { name: PLUS_MENU });
  await act(async () => {
    trigger.click();
  });

  assert.equal(screen.queryByRole("menuitem", { name: PASTE_ITEM }), null);
  // Only this entry is hidden; attaching a file is unaffected.
  assert.ok(
    screen.getAllByRole("menuitem").length > 0,
    "the rest of the plus menu still renders",
  );
});

test("reports a clean failure when the clipboard read is denied", async () => {
  // The item is offered, but Chrome's clipboard-read permission can still be
  // denied per origin; the rejection must not escape the tap.
  setClipboard({
    read: async () => {
      throw new DOMException("Read permission denied.", "NotAllowedError");
    },
  });
  const container = await pasteFromClipboard(renderComposer());

  assert.equal(previews(container).length, 0);
  assert.equal(objectUrls.created.length, 0);
  assert.match(container.textContent ?? "", FAILURE);
});

test("an oversized clipboard image goes As file beside an in-range one that stays inline", async () => {
  setClipboard({
    read: async () => [
      clipboardImage("image/png", MAX_ATTACHED_IMAGE_BYTES + 1),
      clipboardImage("image/png", 8),
    ],
  });
  const container = await pasteFromClipboard(
    renderComposer(),
    () => objectUrls.created.length >= 2,
  );

  assert.equal(previews(container).length, 2, "both are attached");
  assert.equal(
    screen.getAllByRole("button", { name: SWITCH_TO_INLINE }).length,
    1,
    "only the oversized one As file",
  );
});

test("revokes pasted image previews on unmount", async () => {
  setClipboard({ read: async () => [clipboardImage("image/png", 8)] });
  const view = render(
    React.createElement(ChatInput, {
      async onSend(): Promise<{ status: "accepted" }> {
        return { status: "accepted" };
      },
      onAbort() {},
      isStreaming: false,
    }),
  );
  await pasteFromClipboard(view.container);
  assert.equal(objectUrls.created.length, 1);

  await act(async () => {
    view.unmount();
  });

  assert.deepEqual(objectUrls.revoked, objectUrls.created);
});
