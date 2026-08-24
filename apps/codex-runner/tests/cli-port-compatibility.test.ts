import assert from "node:assert/strict";
import test from "node:test";

import { codexSessionRecordIsReusable, versionIsSupported } from "../src/cli-port.ts";

test("a capability-compatible Codex banner is not rejected only because its version label differs", () => {
  assert.equal(versionIsSupported("Codex CLI version 0.149.0"), true);
});
test("Boby rotates an oversized app-owned Codex conversation instead of resuming it", () => {
  const now = Date.now();
  const sessionId = "019fae00-0000-7000-8000-000000000001";
  assert.equal(codexSessionRecordIsReusable({
    path: `C:/safe/sessions/rollout-${sessionId}.jsonl`,
    modifiedAt: now - 1_000,
    size: 80 * 1024
  }, sessionId, now), true);
  assert.equal(codexSessionRecordIsReusable({
    path: `C:/safe/sessions/rollout-${sessionId}.jsonl`,
    modifiedAt: now - 1_000,
    size: 184 * 1024
  }, sessionId, now), false);
});

test("Boby never resumes a different or expired app-owned conversation", () => {
  const now = Date.now();
  const sessionId = "019fae00-0000-7000-8000-000000000001";
  const record = { path: "C:/safe/sessions/rollout-019fae00-0000-7000-8000-000000000002.jsonl", modifiedAt: now, size: 1024 };
  assert.equal(codexSessionRecordIsReusable(record, sessionId, now), false);
  assert.equal(codexSessionRecordIsReusable({ ...record, path: `C:/safe/sessions/rollout-${sessionId}.jsonl`, modifiedAt: 0 }, sessionId, now), false);
});
