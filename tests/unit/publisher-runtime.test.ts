import assert from "node:assert/strict";
import test from "node:test";

import { createConnectorAwarePublicationProcessor } from "../../apps/publisher/src/runtime.ts";
import type { OutboxEffect } from "../../packages/database/src/backend-repository.ts";

const effect: OutboxEffect = {
  id: "effect-1",
  type: "PUBLISH_REVISION",
  aggregateId: "revision-1",
  idempotencyKey: "publish:revision-1:hash",
  state: "IN_PROGRESS",
  attempts: 1
};

test("publisher runtime fails closed when connector authentication is unavailable", async () => {
  let resolved = 0;
  const processor = createConnectorAwarePublicationProcessor({
    connector: { state: "LOGIN_REQUIRED" },
    resolver: { async resolve() { resolved += 1; return null; } },
    effects: { findPullRequest: async () => { throw new Error("must not call remote effects"); }, createPullRequest: async () => { throw new Error("must not call remote effects"); }, mergePullRequest: async () => { throw new Error("must not call remote effects"); }, findDeployIntent: async () => { throw new Error("must not call remote effects"); }, createDeployIntent: async () => { throw new Error("must not call remote effects"); } }
  });
  const result = await processor.process(effect);
  assert.equal(result.state, "UNKNOWN");
  assert.match(result.lastError ?? "", /login_required/i);
  assert.equal(resolved, 0);
});

test("publisher runtime fails closed when remote effects are not injected", async () => {
  let resolved = 0;
  const processor = createConnectorAwarePublicationProcessor({
    connector: { state: "READY" },
    resolver: { async resolve() { resolved += 1; return null; } }
  });
  const result = await processor.process(effect);
  assert.equal(result.state, "UNKNOWN");
  assert.match(result.lastError ?? "", /remote effects/i);
  assert.equal(resolved, 0);
});
