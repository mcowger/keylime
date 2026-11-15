import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { act } from "react";

test("a password typed into the static sign-in form is in LoginForm's field once the bundle runs", async () => {
  window.history.replaceState(null, "", "/login");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: window.location,
  });
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const staticPage = new window.DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.querySelector("#root");
  const loginShell =
    staticPage.querySelector<HTMLTemplateElement>("#login-shell");
  assert.ok(root);
  assert.ok(loginShell);
  root.append(loginShell.content.cloneNode(true));
  const staticField = document.querySelector<HTMLInputElement>(
    "#root #web-password",
  );
  assert.ok(staticField);
  staticField.value = "typed before the bundle";

  await act(async () => {
    await import("./client.tsx");
  });

  const field = document.querySelector<HTMLInputElement>("#root #web-password");
  assert.ok(
    field && field !== staticField,
    "LoginForm did not replace the static form",
  );
  assert.equal(field.value, "typed before the bundle");
});
