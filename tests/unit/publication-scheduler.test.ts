import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { computeRevisionHash, computeWarningSetHash } from "../../packages/editorial/src/revision.ts";
import { PublicationScheduler } from "../../apps/engine/src/publication-scheduler.ts";

function revision(scheduledAt: string, id = "rev-1") {
  const evidenceExcerpt = "Kaynak kanıtı doğrulandı.";
  const evidenceHash = createHash("sha256").update(evidenceExcerpt, "utf8").digest("hex");
  return {
    id, translationKey: `tk-${id}`, state: "SCHEDULED" as const,
    tr: { title: "Başlık", slug: "baslik", description: "Açıklama", bodyMarkdown: "Gövde", heroImageAlt: "Görsel" },
    en: { title: "Title", slug: "title", description: "Description", bodyMarkdown: "Body", heroImageAlt: "Image" },
    section: "haberler" as const, articleType: "news" as const, author: "Ada", tags: [],
    claims: [{ id: "c1", locale: "both" as const, text: "claim", sourceIds: ["s1"], status: "VERIFIED" as const, claimKey: "c1", trText: "iddia", enText: "claim", evidenceAnchors: [{ sourceId: "s1", start: 0, end: evidenceExcerpt.length, quoteHash: evidenceHash }] }],
    sources: [{ id: "s1", url: "https://example.test", title: "Source", fetchedAt: "2026-07-30T00:00:00.000Z", contentHash: evidenceHash, evidenceExcerpt, evidenceExcerptHash: evidenceHash, evidenceAnchors: [{ sourceId: "s1", start: 0, end: evidenceExcerpt.length, quoteHash: evidenceHash }], trustStatus: "APPROVED" as const, rightsStatus: "APPROVED" as const }], media: [], scheduledAt, adapterVersion: "1",
    editorialDesk: "Blogbot Editorya", riskLevel: "STANDARD" as const,
    translationParity: { status: "MATCHED" as const, reportHash: "c".repeat(64) },
    editorialPolicyHash: "d".repeat(64), editorialReviewReportHash: "e".repeat(64),
    targetRepository: "owner/site", targetBaseBranch: "main", targetBaseSha: "f".repeat(40),
    generatedFiles: [{ path: "content/tr/story.md", sha256: "1".repeat(64), size: 10 }],
    qualityGates: [
      { id: "claims", group: "editorial" as const, state: "PASS" as const, detail: "Kanıt doğrulandı.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "contradictions", group: "editorial" as const, state: "PASS" as const, detail: "Checked.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "bilingual-parity", group: "editorial" as const, state: "PASS" as const, detail: "Checked.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "markdown-safety", group: "security" as const, state: "PASS" as const, detail: "Checked.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "seo", group: "seo" as const, state: "PASS" as const, detail: "Checked.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "media", group: "media" as const, state: "PASS" as const, detail: "Checked.", policyVersion: "2", reasonCode: "CHECKED" }
    ]
  };
}

async function setup(now: string, scheduledAt = now) {
  const backend = new InMemoryBackendStore();
  await backend.setAutomation({ mode: "PUBLISH_APPROVED", onboardingComplete: true, ingestionPaused: false, publishingPaused: false, timezone: "Europe/Istanbul", scanIntervalMinutes: 30 });
  const rev = revision(scheduledAt);
  await backend.insertRevision(rev);
  const hash = computeRevisionHash(rev);
  await backend.saveApproval({ revisionId: rev.id, revisionHash: hash, deviceId: "device", approvedAt: now, warningSetHash: computeWarningSetHash(rev.qualityGates) });
  await backend.setLocalState(`publication.preview:${rev.id}`, {
    revisionId: rev.id,
    revisionHash: hash,
    previewHash: "c".repeat(64),
    expiresAtUnixMs: Date.parse(now) + 24 * 60 * 60 * 1_000
  });
  return { backend, now: new Date(now) };
}

test("publication scheduler enqueues a due approved revision once", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  const scheduler = new PublicationScheduler(backend, () => now);
  const firstTick = await scheduler.tick();
  assert.equal(firstTick.enqueued.length, 1, JSON.stringify(firstTick));
  assert.equal((await scheduler.tick()).enqueued.length, 0);
  const effects = await backend.listOutbox();
  assert.equal(effects.length, 1);
  assert.deepEqual(effects[0] && {
    previewHash: effects[0].previewHash,
    targetRepository: effects[0].targetRepository,
    baseBranch: effects[0].baseBranch,
    targetBaseSha: effects[0].targetBaseSha,
    adapterVersion: effects[0].adapterVersion
  }, {
    previewHash: "c".repeat(64),
    targetRepository: "owner/site",
    baseBranch: "main",
    targetBaseSha: "f".repeat(40),
    adapterVersion: "1"
  });
});

test("publication scheduler never enqueues a revision after its exact approval is revoked", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  const rev = await backend.getRevision("rev-1");
  await backend.revokeApproval({
    revisionId: rev.id,
    revisionHash: computeRevisionHash(rev),
    deviceId: "device",
    reason: "Editorial approval withdrawn before publication",
    revokedAt: now.toISOString()
  });

  const result = await new PublicationScheduler(backend, () => now).tick();

  assert.deepEqual(result.skipped, [{ revisionId: "rev-1", reason: "APPROVAL_REVOKED" }]);
  assert.deepEqual(result.enqueued, []);
  assert.equal((await backend.listOutbox()).length, 0);
});

test("publication scheduler uses the indexed reads instead of loading a full snapshot", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  backend.sync = async () => {
    throw new Error("FULL_SNAPSHOT_MUST_NOT_RUN");
  };

  const result = await new PublicationScheduler(backend, () => now).tick();

  assert.equal(result.enqueued.length, 1, JSON.stringify(result));
});

test("publication scheduler does not enqueue without a matching preview or after missed slot", async () => {
  const { backend, now } = await setup("2026-07-31T20:00:00.000Z", "2026-07-30T10:00:00.000Z");
  await backend.setLocalState("publication.preview:rev-1", undefined);
  const scheduler = new PublicationScheduler(backend, () => now);
  assert.equal((await scheduler.tick()).enqueued.length, 0);
  assert.equal((await backend.listOutbox()).length, 0);
});

test("publication scheduler rejects an expired matching preview", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  const current = await backend.getLocalState("publication.preview:rev-1") as Record<string, unknown>;
  await backend.setLocalState("publication.preview:rev-1", {
    ...current,
    expiresAtUnixMs: now.getTime()
  });

  const result = await new PublicationScheduler(backend, () => now).tick();

  assert.deepEqual(result.skipped, [{ revisionId: "rev-1", reason: "PREVIEW_STALE" }]);
  assert.equal((await backend.listOutbox()).length, 0);
});

test("publication scheduler pages past expired and already-enqueued revisions", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  for (let index = 0; index < 50; index += 1) {
    await backend.insertRevision(revision("2026-07-29T00:00:00.000Z", `expired-${String(index).padStart(3, "0")}`));
  }
  for (let index = 0; index < 50; index += 1) {
    const prior = revision("2026-07-30T08:00:00.000Z", `enqueued-${String(index).padStart(3, "0")}`);
    await backend.insertRevision(prior);
    await backend.enqueuePublication(prior.id, computeRevisionHash(prior), {
      previewHash: "9".repeat(64),
      targetRepository: "owner/site",
      baseBranch: "main",
      targetBaseSha: "f".repeat(40),
      adapterVersion: "1"
    });
  }

  const result = await new PublicationScheduler(backend, () => now).tick();

  assert.deepEqual(result.enqueued, ["rev-1"]);
  assert.equal((await backend.listOutbox()).length, 51);
});

test("publication scheduler reports a transient indexed-read fault and resumes without bypassing approval", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  const originalGetAutomation = backend.getAutomation.bind(backend);
  let failOnce = true;
  backend.getAutomation = async () => {
    if (failOnce) {
      failOnce = false;
      throw new Error("database temporarily unavailable");
    }
    return originalGetAutomation();
  };
  const faults: string[] = [];
  const scheduler = new PublicationScheduler(
    backend,
    () => now,
    5,
    { onFault: (error) => faults.push(error.message) }
  );

  scheduler.start();
  for (let attempt = 0; attempt < 40 && (await backend.listOutbox()).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  scheduler.stop();

  assert.deepEqual(faults, ["PUBLICATION_SCHEDULER_UNAVAILABLE"]);
  assert.equal((await backend.listOutbox()).length, 1);
});

test("publication scheduler does not enqueue after stop cancels an in-flight read", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  const originalGetAutomation = backend.getAutomation.bind(backend);
  let releaseAutomation!: () => void;
  let automationReadStarted!: () => void;
  const automationRead = new Promise<void>((resolve) => { releaseAutomation = resolve; });
  const started = new Promise<void>((resolve) => { automationReadStarted = resolve; });
  backend.getAutomation = async () => {
    automationReadStarted();
    await automationRead;
    return originalGetAutomation();
  };
  const scheduler = new PublicationScheduler(backend, () => now, 5);

  scheduler.start();
  await started;
  scheduler.stop();
  releaseAutomation();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal((await backend.listOutbox()).length, 0);
});

test("a regenerated preview never poisons the scheduler for the rest of the workspace", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  // A second due revision proves one poisoned key cannot stop unrelated work.
  const other = revision("2026-07-30T09:30:00.000Z", "rev-2");
  await backend.insertRevision(other);
  const otherHash = computeRevisionHash(other);
  await backend.saveApproval({
    revisionId: other.id,
    revisionHash: otherHash,
    deviceId: "device",
    approvedAt: "2026-07-30T10:00:00.000Z",
    warningSetHash: computeWarningSetHash(other.qualityGates)
  });
  await backend.setLocalState(`publication.preview:${other.id}`, {
    revisionId: other.id,
    revisionHash: otherHash,
    previewHash: "a".repeat(64),
    expiresAtUnixMs: Date.parse("2026-07-30T10:00:00.000Z") + 24 * 60 * 60 * 1_000
  });

  const scheduler = new PublicationScheduler(backend, () => now);
  assert.equal((await scheduler.tick()).enqueued.length, 2);

  // The editor regenerates the preview for the same immutable revision, so the
  // bundle bytes change while the approved revision hash stays identical.
  const first = await backend.getRevision("rev-1");
  await backend.setLocalState("publication.preview:rev-1", {
    revisionId: first.id,
    revisionHash: computeRevisionHash(first),
    previewHash: "d".repeat(64),
    expiresAtUnixMs: Date.parse("2026-07-30T10:00:00.000Z") + 24 * 60 * 60 * 1_000
  });

  const second = await scheduler.tick();
  assert.deepEqual(second.skipped, [], "a regenerated preview must not be reported as a skip");
  assert.deepEqual(second.enqueued, ["rev-1"], "the regenerated preview needs its own durable intent");

  const effects = await backend.listOutbox();
  assert.deepEqual(
    effects.map((effect) => effect.previewHash).sort(),
    ["a".repeat(64), "c".repeat(64), "d".repeat(64)],
    "every distinct approved preview must own exactly one outbox effect"
  );

  // The scheduler must stay usable afterwards instead of failing every tick.
  assert.deepEqual((await scheduler.tick()).enqueued, []);
});

test("a preview record without a usable preview hash is a skip, not a workspace-wide fault", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  // A second due revision proves the malformed record only costs its own slot.
  const other = revision("2026-07-30T09:30:00.000Z", "rev-2");
  await backend.insertRevision(other);
  const otherHash = computeRevisionHash(other);
  await backend.saveApproval({
    revisionId: other.id,
    revisionHash: otherHash,
    deviceId: "device",
    approvedAt: "2026-07-30T10:00:00.000Z",
    warningSetHash: computeWarningSetHash(other.qualityGates)
  });
  await backend.setLocalState(`publication.preview:${other.id}`, {
    revisionId: other.id,
    revisionHash: otherHash,
    previewHash: "a".repeat(64),
    expiresAtUnixMs: Date.parse("2026-07-30T10:00:00.000Z") + 24 * 60 * 60 * 1_000
  });
  // An older build's record shape, or a raw `LOCAL_STATE.SET` write: the
  // approved revision hash is current, but there is no preview hash to bind.
  const { previewHash: _previewHash, ...withoutPreviewHash } =
    await backend.getLocalState("publication.preview:rev-1") as Record<string, unknown>;
  await backend.setLocalState("publication.preview:rev-1", withoutPreviewHash);
  const faults: string[] = [];

  const result = await new PublicationScheduler(
    backend,
    () => now,
    60_000,
    { onFault: (error) => faults.push(error.message) }
  ).tick();

  assert.deepEqual(result.skipped, [{ revisionId: "rev-1", reason: "PREVIEW_STALE" }]);
  assert.deepEqual(result.enqueued, ["rev-2"], "the other approved revision must still be scheduled");
  assert.deepEqual(faults, [], "a regenerable preview is not a scheduler fault");
  assert.deepEqual((await backend.listOutbox()).map((effect) => effect.aggregateId), ["rev-2"]);
});
