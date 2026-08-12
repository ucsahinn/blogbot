import assert from "node:assert/strict";
import test from "node:test";

import { createConnectorAwarePublicationProcessor, resultToProcessorResult } from "../../apps/publisher/src/runtime.ts";
import type { OutboxEffect } from "../../packages/database/src/backend-repository.ts";

const effect: OutboxEffect = {
  id: "effect-1",
  type: "PUBLISH_REVISION",
  aggregateId: "revision-1",
  revisionHash: "a".repeat(64),
  previewHash: "b".repeat(64),
  targetRepository: "owner/site",
  baseBranch: "main",
  targetBaseSha: "c".repeat(40),
  adapterVersion: "astro-generic@2.0.0",
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

test("publisher runtime rejects an outbox effect whose revision hash no longer matches the immutable command", async () => {
  let effectsCalled = 0;
  const processor = createConnectorAwarePublicationProcessor({
    connector: { state: "READY" },
    resolver: {
      async resolve() {
        return {
          revisionId: "revision-1",
          approvedRevisionHash: "b".repeat(64)
        } as never;
      }
    },
    effects: {
      findPullRequest: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      createPullRequest: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      mergePullRequest: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      findDeployIntent: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      createDeployIntent: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); }
    }
  });
  const result = await processor.process({ ...effect, revisionHash: "a".repeat(64) });
  assert.equal(result.state, "UNKNOWN");
  assert.match(result.lastError ?? "", /hash/i);
  assert.equal(effectsCalled, 0);
});

test("publisher runtime rejects an outbox effect whose reviewed target tuple changed", async () => {
  let effectsCalled = 0;
  const processor = createConnectorAwarePublicationProcessor({
    connector: { state: "READY" },
    resolver: {
      async resolve() {
        return {
          revisionId: "revision-1",
          approvedRevisionHash: "a".repeat(64),
          previewHash: "b".repeat(64),
          targetRepository: "owner/other-site",
          baseBranch: "main",
          approvedBaseSha: "c".repeat(40),
          adapterVersion: "astro-generic@2.0.0"
        } as never;
      }
    },
    effects: {
      findPullRequest: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      createPullRequest: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      mergePullRequest: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      findDeployIntent: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); },
      createDeployIntent: async () => { effectsCalled += 1; throw new Error("must not call remote effects"); }
    }
  });
  const result = await processor.process(effect);
  assert.equal(result.state, "UNKNOWN");
  assert.match(result.lastError ?? "", /target/i);
  assert.equal(effectsCalled, 0);
});

test("deployment dispatch remains unknown until an independent deployment verifier confirms it", () => {
  const result = resultToProcessorResult({
    state: "READY_TO_DEPLOY",
    pullRequestKey: "pr:1",
    mergeKey: "merge:1",
    deployKey: "deploy:1",
    pullRequest: { number: 1, headSha: "a".repeat(40), merged: true, requiredChecks: "PASSED" },
    deployIntent: { key: "deploy:1", revisionId: "revision-1", mergeSha: "b".repeat(40) }
  });
  assert.equal(result.state, "UNKNOWN");
  assert.equal(result.resultRef, "deploy:1");
  assert.match(result.lastError ?? "", /verification/i);
});
