import { test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdvisorReviewStatus } from "./AdvisorReviewStatus";
import assert from "node:assert/strict";

test("shows an accessible transient advisor review status only while pending", () => {
  const visible = renderToStaticMarkup(<AdvisorReviewStatus pending />);
  assert.match(visible, /role="status"/);
  assert.match(visible, /(Advisor reviewing…|chatInput\.advisorReviewing)/);
  assert.equal(renderToStaticMarkup(<AdvisorReviewStatus pending={false} />), "");
});
