import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEngineProtocol,
  syncCodexParentJobState
} from "../../apps/engine/src/stdio-entrypoint.ts";
import {
  BackendStoreError,
  type BackendRepository
} from "../../packages/database/src/backend-repository.ts";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import {
  computeRevisionHash,
  type Approval,
  type ArticleRevision
} from "../../packages/editorial/src/revision.ts";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

test("a stale Codex lifecycle writer conflicts without losing a competing PGlite job mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-job-cas-fencing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());
  await repository.createJob({
    id: "draft-cas-race",
    kind: "DRAFT",
    state: "QUEUED",
    attempts: 0,
    metadata: { createdBy: "command" }
  });

  let injected = false;
  const competingRepository = new Proxy(repository as BackendRepository, {
    get(target, property, receiver) {
      if ((property === "getJob" || property === "getJobRecord") && !injected) {
        return async (jobId: string) => {
          injected = true;
          const observedJob = await repository.getJob(jobId);
          const observedVersion = await repository.getJobVersion!(jobId);
          await repository.saveJob({
            ...observedJob,
            metadata: {
              ...(observedJob.metadata ?? {}),
              acceptedByStdio: true
            }
          }, observedVersion);
          return property === "getJobRecord"
            ? { job: observedJob, version: observedVersion }
            : observedJob;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const submission = {
    jobId: "draft-cas-race",
    idempotencyKey: "draft:cas-race",
    definitionId: "DRAFT.CREATE",
    payload: {}
  };

  await assert.rejects(
    syncCodexParentJobState(competingRepository, submission, { kind: "STARTED" }),
    (error: unknown) => error instanceof BackendStoreError && error.code === "WRITE_VERSION_CONFLICT"
  );
  const afterConflict = await repository.getJob("draft-cas-race");
  assert.equal(afterConflict.state, "QUEUED");
  assert.equal(afterConflict.metadata?.acceptedByStdio, true);
  assert.equal(afterConflict.metadata?.progressStage, undefined);

  await syncCodexParentJobState(repository, submission, { kind: "STARTED" });
  const accepted = await repository.getJob("draft-cas-race");
  assert.equal(accepted.state, "RUNNING");
  assert.equal(accepted.metadata?.acceptedByStdio, true);
  assert.equal(accepted.metadata?.progressStage, "PREPARING_SOURCES");
});

async function prepareClaimedPublication(repository: InMemoryBackendStore) {
  const content = "approved publication\n";
  const contentPath = "content/tr/revocation-race.md";
  const revision = {
    id: "revision-revocation-race",
    translationKey: "story-revocation-race",
    state: "APPROVED",
    tr: { title: "Baslik", slug: "revocation-race", description: "Aciklama", bodyMarkdown: "Govde", heroImageAlt: "Gorsel" },
    en: { title: "Title", slug: "revocation-race", description: "Description", bodyMarkdown: "Body", heroImageAlt: "Image" },
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
    generatedFiles: [{
      path: contentPath,
      sha256: sha256(content),
      size: Buffer.byteLength(content)
    }]
  } as unknown as ArticleRevision;
  await repository.insertRevision(revision);
  const revisionHash = computeRevisionHash(revision);
  await repository.saveApproval({
    revisionId: revision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    approvedAt: "2026-08-20T11:00:00.000Z"
  } satisfies Approval);
  await repository.setAutomation({
    mode: "PUBLISH_APPROVED",
    onboardingComplete: true,
    ingestionPaused: false,
    publishingPaused: false,
    timezone: "Europe/Istanbul",
    scanIntervalMinutes: 30
  });
  const previewHash = "9".repeat(64);
  await repository.setLocalState(`publication.preview:${revision.id}`, {
    revisionHash,
    previewHash,
    expiresAtUnixMs: 9_999_999_999_999,
    payload: {
      files: [
        { path: contentPath, content },
        { path: `.blogbot/manifests/${revision.id}.json`, content: "{}" }
      ],
      requiredChecks: ["verify"],
      deployWorkflow: "deploy.yml"
    }
  });
  const effect = await repository.enqueuePublication(revision.id, revisionHash, {
    previewHash,
    targetRepository: "owner/site",
    baseBranch: "main",
    targetBaseSha: "1".repeat(40),
    adapterVersion: "test@1"
  });
  return { effect, revision, revisionHash };
}

test("approval revocation between native claim and completion fences a stale remote success", async () => {
  const repository = new InMemoryBackendStore();
  const { effect, revision, revisionHash } = await prepareClaimedPublication(repository);
  const handle = createEngineProtocol(repository, "memory", {
    nativePublicationBroker: true,
    nativePublicationRuntimeId: "runtime-revocation-race",
    nativePublicationNow: () => Date.parse("2026-08-20T12:00:00.000Z")
  });
  const claimed = await handle({
    version: 1,
    id: "claim-before-revocation",
    kind: "publication.broker.claim",
    effectId: effect.id
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const claimAttempt = (claimed.value as { claimAttempt: number }).claimAttempt;

  const revoked = await handle({
    version: 1,
    id: "revoke-during-native-claim",
    kind: "command",
    command: {
      version: 1,
      requestId: "revoke-during-native-claim",
      idempotencyKey: "revoke-during-native-claim",
      expectedVersion: await repository.getVersion(),
      kind: "APPROVAL.REVOKE",
      payload: {
        revisionId: revision.id,
        revisionHash,
        deviceId: "windows-local-device-v1",
        reason: "Publication approval was withdrawn during native reconciliation"
      }
    }
  });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  const recalled = await repository.getOutboxEffect(effect.id);
  assert.equal(recalled.effect.state, "FAILED");
  assert.equal(recalled.effect.lastError, "APPROVAL_REVOKED");

  const lateCompletion = await handle({
    version: 1,
    id: "late-success-after-revocation",
    kind: "publication.broker.complete",
    effectId: effect.id,
    claimAttempt,
    state: "SUCCEEDED",
    resultRef: "merge:already-observed-remotely"
  });
  assert.equal(lateCompletion.ok, false);
  assert.equal(lateCompletion.code, "APPROVAL_REVOKED");
  const terminal = await repository.getOutboxEffect(effect.id);
  assert.equal(terminal.effect.state, "FAILED");
  assert.equal(terminal.effect.lastError, "APPROVAL_REVOKED");
  assert.equal(
    terminal.effect.resultRef,
    "merge:already-observed-remotely",
    "the fail-closed local outcome must not erase evidence that an irreversible remote effect was observed"
  );
});
