import assert from "node:assert/strict";
import type { TestContext } from "node:test";

/** Serve one completed composer upload through the browser's HTTP transport. */
export function stageTestUpload(t: TestContext, file: File) {
  let id: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/uploads" && init?.method === "POST") {
      const opened = JSON.parse(String(init.body));
      id = opened.id;
      assert.equal(opened.name, file.name);
      assert.equal(opened.size, file.size);
      return Response.json({ received: 0 });
    }
    assert.equal(url, `/api/uploads/${id}?offset=0`);
    assert.equal(init?.method, "PUT");
    assert.equal(await (init?.body as Blob).text(), await file.text());
    return Response.json({ received: file.size });
  });
  return () => {
    assert.ok(id, "the composer opened the upload");
    return id;
  };
}
