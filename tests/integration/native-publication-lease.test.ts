import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEngineProtocol,
  recoverInterruptedNativePublications
} from "../../apps/engine/src/stdio-entrypoint.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import { computeRevisionHash, type ArticleRevision } from "../../packages/editorial/src/revision.ts";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function preparePublication(repository: PGliteBackendRepository, suffix: string) {
  const revisionId = `native-lease-${suffix}`;
  const content = `approved publication ${suffix}\n`;
  const path = `content/tr/${suffix}.md`;
  const revision = {
    id: revisionId,
    translationKey: `story-${suffix}`,
    state: "APPROVED",
    tr: { title: "Baslik", slug: suffix, description: "Aciklama", bodyMarkdown: "Govde", heroImageAlt: "Gorsel" },
    en: { title: "Title", slug: suffix, description: "Description", bodyMarkdown: "Body", heroImageAlt: "Image" },
    section: "haberler",
    articleType: "news",
    author: "Editor",
    tags: [],
    claims: [],
    sources: [],
    media: [],
    scheduledAt: "2026-08-20T12:00:00.000Z",
    adapterVersion: "test@1",
    targetRepository: "owner/site",
    targetBaseBranch: "main",
    targetBaseSha: "1".repeat(40),
    generatedFiles: [{ path, sha256: sha256(content), size: Buffer.byteLength(content) }]
  } as unknown as ArticleRevision;
  await repository.insertRevision(revision);
  await repository.setAutomation({
    mode: "PUBLISH_APPROVED",
    onboardingComplete: true,
    ingestionPaused: false,
    publishingPaused: false,
    timezone: "Europe/Istanbul",
    scanIntervalMinutes: 30
  });
  const revisionHash = computeRevisionHash(revision);
  const previewHash = "9".repeat(64);
  await repository.setLocalState(`publication.preview:${revisionId}`, {
    revisionHash,
    previewHash,
    expiresAtUnixMs: 9_999_999_999_999,
    payload: {
      files: [
        { path, content },
        { path: `.blogbot/manifests/${revisionId}.json`, content: "{}" }
      ],
      requiredChecks: ["verify"],
      deployWorkflow: "deploy.yml"
    }
  });
  const effect = await repository.enqueuePublication(revisionId, revisionHash, {
    previewHash,
    targetRepository: "owner/site",
    baseBranch: "main",
    targetBaseSha: "1".repeat(40),
    adapterVersion: "test@1"
  });
  return effect;
}

test("two native workers fence the same durable PGlite publication lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-native-publication-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());
  const effect = await preparePublication(repository, "race");
  let now = 1_800_000_000_000;
  const workerA = createEngineProtocol(repository, "ready", {
    nativePublicationBroker: true,
    nativePublicationRuntimeId: "runtime-a",
    nativePublicationLeaseMs: 60_000,
    nativePublicationNow: () => now
  });
  const workerB = createEngineProtocol(repository, "ready", {
    nativePublicationBroker: true,
    nativePublicationRuntimeId: "runtime-b",
    nativePublicationLeaseMs: 60_000,
    nativePublicationNow: () => now
  });

  const [a, b] = await Promise.all([
    workerA({ version: 1, id: "claim-a", kind: "publication.broker.claim", effectId: effect.id }),
    workerB({ version: 1, id: "claim-b", kind: "publication.broker.claim", effectId: effect.id })
  ]);
  assert.equal([a, b].filter((result) => result.ok).length, 1);
  const winner = a.ok ? workerA : workerB;
  const loser = a.ok ? workerB : workerA;
  const winnerId = a.ok ? "runtime-a" : "runtime-b";
  const loserId = a.ok ? "runtime-b" : "runtime-a";
  const durableClaim = await repository.getOutboxEffect(effect.id);
  assert.equal(durableClaim.effect.nativeClaimOwnerId, winnerId);
  assert.equal(durableClaim.effect.nativeClaimLeaseUntil, new Date(now + 60_000).toISOString());
  assert.equal(durableClaim.effect.claimAttempt, 1);

  const earlyReclaim = await loser({ version: 1, id: "reclaim-early", kind: "publication.broker.claim", effectId: effect.id });
  assert.equal(earlyReclaim.ok, false);
  assert.equal(earlyReclaim.code, "PUBLICATION_EFFECT_NOT_CLAIMABLE");

  now += 60_001;
  const reclaimed = await loser({ version: 1, id: "reclaim-expired", kind: "publication.broker.claim", effectId: effect.id });
  assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
  assert.equal((reclaimed.value as { claimAttempt: number }).claimAttempt, 2);
  const reassigned = await repository.getOutboxEffect(effect.id);
  assert.equal(reassigned.effect.nativeClaimOwnerId, loserId);

  const stale = await winner({
    version: 1,
    id: "complete-stale",
    kind: "publication.broker.complete",
    effectId: effect.id,
    claimAttempt: 1,
    state: "SUCCEEDED",
    resultRef: "merge:stale"
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "INVALID_PUBLICATION_BROKER_RESULT");

  const completed = await loser({
    version: 1,
    id: "complete-current",
    kind: "publication.broker.complete",
    effectId: effect.id,
    claimAttempt: 2,
    state: "SUCCEEDED",
    resultRef: "merge:current"
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const terminal = await repository.getOutboxEffect(effect.id);
  assert.equal(terminal.effect.state, "SUCCEEDED");
  assert.equal(terminal.effect.resultRef, "merge:current");
  assert.equal(terminal.effect.nativeClaimOwnerId, undefined);
  assert.equal(terminal.effect.nativeClaimLeaseUntil, undefined);
});

test("startup recovery leaves live leases alone and requeues only expired or ownerless claims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-native-publication-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());
  const leased = await preparePublication(repository, "leased");
  const orphaned = await preparePublication(repository, "orphaned");
  const now = 1_800_000_000_000;
  await repository.updateOutbox({
    ...leased,
    state: "IN_PROGRESS",
    attempts: 1,
    claimAttempt: 1,
    nativeClaimOwnerId: "still-live",
    nativeClaimLeaseUntil: new Date(now + 60_000).toISOString()
  }, (await repository.getOutboxEffect(leased.id)).version);
  await repository.updateOutbox({
    ...orphaned,
    state: "IN_PROGRESS",
    attempts: 1,
    claimAttempt: 1
  }, (await repository.getOutboxEffect(orphaned.id)).version);

  assert.equal(await recoverInterruptedNativePublications(repository, now), 1);
  assert.equal((await repository.getOutboxEffect(leased.id)).effect.state, "IN_PROGRESS");
  assert.equal((await repository.getOutboxEffect(orphaned.id)).effect.state, "UNKNOWN");

  assert.equal(await recoverInterruptedNativePublications(repository, now + 60_001), 1);
  const recoveredLease = (await repository.getOutboxEffect(leased.id)).effect;
  assert.equal(recoveredLease.state, "UNKNOWN");
  assert.equal(recoveredLease.lastError, "NATIVE_PUBLICATION_INTERRUPTED");
  assert.equal(recoveredLease.nativeClaimOwnerId, undefined);
  assert.equal(recoveredLease.nativeClaimLeaseUntil, undefined);
});
