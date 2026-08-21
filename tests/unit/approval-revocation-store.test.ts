import assert from "node:assert/strict";
import test from "node:test";

import { validateEngineCommandV1 } from "../../packages/contracts/src/index.ts";
import {
  BackendStoreError,
  type ApprovalRevocation
} from "../../packages/database/src/backend-repository.ts";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";

const approval = {
  revisionId: "revision-revoke-1",
  revisionHash: "a".repeat(64),
  deviceId: "windows-device-approval",
  approvedAt: "2026-08-20T08:00:00.000Z",
  warningSetHash: "b".repeat(64),
  approvalType: "EDITORIAL" as const
};

const revocation: ApprovalRevocation = {
  revisionId: approval.revisionId,
  revisionHash: approval.revisionHash,
  deviceId: "windows-device-revoker",
  reason: "Kaynak lisansi degistigi icin yayin onayi geri cekildi.",
  revokedAt: "2026-08-20T09:00:00.000Z"
};

test("APPROVAL.REVOKE accepts only the exact hash-bound operator payload", () => {
  const base = {
    version: 1,
    requestId: "revoke-request",
    idempotencyKey: "revoke-key",
    expectedVersion: 4,
    kind: "APPROVAL.REVOKE"
  } as const;
  const payload = {
    revisionId: approval.revisionId,
    revisionHash: "A".repeat(64),
    deviceId: revocation.deviceId,
    reason: revocation.reason
  };
  const valid = validateEngineCommandV1({ ...base, payload });

  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.deepEqual(valid.command.payload, {
      ...payload,
      revisionHash: approval.revisionHash
    });
  }

  for (const invalidPayload of [
    { ...payload, revisionHash: "not-a-hash" },
    { ...payload, reason: " " },
    { ...payload, revokedAt: revocation.revokedAt },
    { revisionId: payload.revisionId, revisionHash: payload.revisionHash, reason: payload.reason }
  ]) {
    assert.equal(validateEngineCommandV1({ ...base, payload: invalidPayload }).valid, false);
  }
});

test("in-memory revocation is immutable, idempotent, and exact-hash bound", async () => {
  const repository = new InMemoryBackendStore();
  await repository.saveApproval(approval);

  assert.deepEqual(await repository.revokeApproval(revocation), revocation);
  assert.deepEqual(await repository.revokeApproval(structuredClone(revocation)), revocation);
  assert.deepEqual(await repository.getApprovalRevocation(approval.revisionId), revocation);

  const sync = await repository.sync(0);
  assert.deepEqual(
    sync.changes.filter((change) => change.kind === "APPROVAL_REVOKED"),
    [{ cursor: 2, kind: "APPROVAL_REVOKED", entityId: approval.revisionId }]
  );

  await assert.rejects(
    repository.revokeApproval({ ...revocation, reason: "Baska bir neden" }),
    (error: unknown) => error instanceof BackendStoreError && error.code === "APPROVAL_ALREADY_REVOKED"
  );
});

test("revocation fails closed for an absent or mismatched immutable approval", async () => {
  const repository = new InMemoryBackendStore();

  await assert.rejects(
    repository.revokeApproval(revocation),
    (error: unknown) => error instanceof BackendStoreError && error.code === "APPROVAL_NOT_FOUND"
  );

  await repository.saveApproval(approval);
  await assert.rejects(
    repository.revokeApproval({ ...revocation, revisionHash: "c".repeat(64) }),
    (error: unknown) => error instanceof BackendStoreError && error.code === "APPROVAL_HASH_MISMATCH"
  );
  assert.equal(await repository.getApprovalRevocation(approval.revisionId), null);
});

test("revocation persistence rejects malformed immutable audit data", async () => {
  const repository = new InMemoryBackendStore();
  await repository.saveApproval(approval);

  await assert.rejects(
    repository.revokeApproval({ ...revocation, revokedAt: "2026-08-20T09:00:00Z" }),
    (error: unknown) => error instanceof BackendStoreError && error.code === "INVALID_APPROVAL_REVOCATION"
  );
  assert.equal(await repository.getApprovalRevocation(approval.revisionId), null);
});
