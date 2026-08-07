import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { computeRevisionHash, computeWarningSetHash } from "../../packages/editorial/src/revision.ts";
import { PublicationScheduler } from "../../apps/engine/src/publication-scheduler.ts";

function revision(scheduledAt: string) {
  return {
    id: "rev-1", translationKey: "tk-1", state: "SCHEDULED" as const,
    tr: { title: "Başlık", slug: "baslik", description: "Açıklama", bodyMarkdown: "Gövde", heroImageAlt: "Görsel" },
    en: { title: "Title", slug: "title", description: "Description", bodyMarkdown: "Body", heroImageAlt: "Image" },
    section: "haberler" as const, articleType: "news" as const, author: "Ada", tags: [],
    claims: [{ id: "c1", locale: "both" as const, text: "claim", sourceIds: ["s1"], status: "VERIFIED" as const, claimKey: "c1", trText: "iddia", enText: "claim", evidenceAnchors: [{ sourceId: "s1", quoteHash: "a".repeat(64) }] }],
    sources: [{ id: "s1", url: "https://example.test", title: "Source", fetchedAt: "2026-07-30T00:00:00.000Z", contentHash: "b".repeat(64) }], media: [], scheduledAt, adapterVersion: "1",
    editorialDesk: "Blogbot Editorya", riskLevel: "STANDARD" as const,
    translationParity: { status: "MATCHED" as const, reportHash: "c".repeat(64) },
    editorialPolicyHash: "d".repeat(64), editorialReviewReportHash: "e".repeat(64),
    targetRepository: "owner/site", targetBaseBranch: "main", targetBaseSha: "f".repeat(40),
    generatedFiles: [{ path: "content/tr/story.md", sha256: "1".repeat(64), size: 10 }],
    qualityGates: [{ id: "claims", group: "editorial" as const, state: "PASS" as const, detail: "Kanıt doğrulandı.", policyVersion: "1" }]
  };
}

async function setup(now: string, scheduledAt = now) {
  const backend = new InMemoryBackendStore();
  await backend.setAutomation({ mode: "PUBLISH_APPROVED", onboardingComplete: true, ingestionPaused: false, publishingPaused: false, timezone: "Europe/Istanbul", scanIntervalMinutes: 30 });
  const rev = revision(scheduledAt);
  await backend.insertRevision(rev);
  const hash = computeRevisionHash(rev);
  await backend.saveApproval({ revisionId: rev.id, revisionHash: hash, deviceId: "device", approvedAt: now, warningSetHash: computeWarningSetHash(rev.qualityGates) });
  await backend.setLocalState(`publication.preview:${rev.id}`, { revisionId: rev.id, revisionHash: hash, previewHash: "c".repeat(64) });
  return { backend, now: new Date(now) };
}

test("publication scheduler enqueues a due approved revision once", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  const scheduler = new PublicationScheduler(backend, () => now);
  assert.equal((await scheduler.tick()).enqueued.length, 1);
  assert.equal((await scheduler.tick()).enqueued.length, 0);
  assert.equal((await backend.listOutbox()).length, 1);
});

test("publication scheduler does not enqueue without a matching preview or after missed slot", async () => {
  const { backend, now } = await setup("2026-07-31T20:00:00.000Z", "2026-07-30T10:00:00.000Z");
  await backend.setLocalState("publication.preview:rev-1", undefined);
  const scheduler = new PublicationScheduler(backend, () => now);
  assert.equal((await scheduler.tick()).enqueued.length, 0);
  assert.equal((await backend.listOutbox()).length, 0);
});

test("publication scheduler reports a transient snapshot fault and resumes without bypassing approval", async () => {
  const { backend, now } = await setup("2026-07-30T10:00:00.000Z", "2026-07-30T09:00:00.000Z");
  const originalSync = backend.sync.bind(backend);
  let failOnce = true;
  backend.sync = async (afterCursor) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("database temporarily unavailable");
    }
    return originalSync(afterCursor);
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
