import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExtensionDialog } from "@/components/ExtensionDialog";
import type { UiDialogRequest, UiDialogValue } from "@/lib/types";

const request: UiDialogRequest = {
  type: "ui_request",
  id: 1,
  method: "formDialog",
  args: [`<form>
    <p>Choose the approach and add any details.</p>
    <fieldset><legend>Storage</legend>
      <label><input type="radio" name="storage" value="sqlite" required> SQLite</label>
      <label><input type="radio" name="storage" value="redis"> Redis</label>
    </fieldset>
    <label>Notes <textarea name="notes" required></textarea></label>
  </form>`],
};

function Fixture() {
  const [result, setResult] = useState<UiDialogValue | undefined>();
  const [done, setDone] = useState(false);
  return <main style={{ padding: 20, maxWidth: 760, margin: "auto" }}>
    <h1>Question form</h1>
    {done ? <pre aria-label="Submitted answer" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(result)}</pre> :
      <ExtensionDialog request={request} attached onRespond={async (_request, value) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 750);
        await promise;
        setResult(value);
        setDone(true);
        return true;
      }} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
