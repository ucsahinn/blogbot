import assert from "node:assert/strict";
import test from "node:test";

import { formatOperationTimestamp } from "../../apps/desktop/src/operation-timestamp.ts";

test("operation timeline shows a Turkish date and Istanbul time for an ISO event", () => {
  const timestamp = "2031-12-24T15:45:00.000Z";

  const formatted = formatOperationTimestamp(timestamp);

  assert.match(formatted.label, /24 Aralık 2031/u);
  assert.match(formatted.label, /18:45/u);
  assert.equal(formatted.dateTime, timestamp);
});

test("operation timeline handles malformed timestamps without rendering an implementation value", () => {
  const formatted = formatOperationTimestamp("not-a-timestamp");

  assert.equal(formatted.label, "Zaman bilgisi alınamadı");
  assert.equal(formatted.dateTime, undefined);
});
