import assert from "node:assert/strict";
import test from "node:test";

import { createInvokeBridge } from "../src/bridge.ts";

test("desktop bridge sends the exact V3 human approval attestation to native", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push(args === undefined ? { command } : { command, args });
    return {
      approvedAt: "2026-08-20T12:00:00.000Z",
      revisionHash: "a".repeat(64),
      state: "APPROVED"
    };
  });
  const attestation = {
    editorialReview: {
      reviewer: "Deniz Editor",
      sourceRoles: [
        { sourceId: "source-primary", role: "primary" as const },
        { sourceId: "source-independent", role: "independent" as const }
      ]
    },
    expertReview: {
      reviewer: "Dr. Ada Uzman",
      qualifications: "Siber guvenlik ve risk uzmani",
      reviewScope: "Yuksek etkili iddialar"
    },
    ethicsReview: null
  };

  await bridge.approveRevision({
    revisionId: "revision-v3",
    expectedHash: "A".repeat(64),
    warningSetHash: "B".repeat(64),
    packageVersion: 3,
    attestation
  });

  assert.deepEqual(calls, [{
    command: "approve_revision",
    args: {
      revisionId: "revision-v3",
      expectedHash: "A".repeat(64),
      warningSetHash: "B".repeat(64),
      packageVersion: 3,
      attestation
    }
  }]);
});
