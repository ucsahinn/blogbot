import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPersistentEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import type { PublicationEffectsPort, PublicationFile, PullRequestState } from "../../apps/publisher/src/publication.ts";
import { computeRevisionHash, computeWarningSetHash, type RevisionPackageV2 } from "../../packages/editorial/src/revision.ts";

function command(kind: string, payload: Record<string, unknown>, expectedVersion: number, suffix: string) {
  return {
    version: 1,
    id: `composition-envelope-${suffix}`,
    kind: "command",
    command: {
      version: 1,
      requestId: `composition-request-${suffix}`,
      idempotencyKey: `composition-command-${suffix}`,
      expectedVersion,
      kind,
      payload
    }
  };
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("PRODUCTION_PUBLICATION_TIMEOUT");
}

test("production composition resolves approved engine media before durable PR, checks, merge, and deploy effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-production-publication-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));

  const revisionId = "revision-production-media";
  const mediaBytes = Buffer.from("trusted engine-owned image bytes\n", "utf8");
  const mediaHash = createHash("sha256").update(mediaBytes).digest("hex");
  const articleFiles = [
    { path: "content/tr/production.md", content: "onaylı Türkçe içerik\n" },
    { path: "content/en/production.md", content: "approved English content\n" }
  ];
  const mediaPublicationPath = "assets/production.webp";
  const generatedFiles = [
    ...articleFiles.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      size: Buffer.byteLength(file.content)
    })),
    { path: mediaPublicationPath, sha256: mediaHash, size: mediaBytes.byteLength }
  ];
  const revision: RevisionPackageV2 = {
    id: revisionId,
    translationKey: "story-production-media",
    state: "REVIEW_REQUIRED",
    tr: { title: "Üretim yayını", slug: "uretim-yayini", description: "Doğrulanmış özet.", bodyMarkdown: "## Özet\n\nÖzgün içerik.", heroImageAlt: "Soyut kapak" },
    en: { title: "Production publication", slug: "production-publication", description: "Verified summary.", bodyMarkdown: "## Summary\n\nOriginal content.", heroImageAlt: "Abstract cover" },
    section: "haberler",
    articleType: "news",
    author: "Ulaş Şahin",
    tags: ["üretim"],
    claims: [{
      id: "claim-1", locale: "both", text: "Gelişme doğrulandı.", sourceIds: ["source-1"], status: "VERIFIED",
      claimKey: "claim.production", trText: "Gelişme doğrulandı.", enText: "The development was verified.",
      evidenceAnchors: [{ sourceId: "source-1", quoteHash: "a".repeat(64), start: 0, end: 10 }]
    }],
    sources: [{
      id: "source-1", url: "https://example.com/report", title: "Report", fetchedAt: "2026-08-12T08:00:00.000Z",
      contentHash: "b".repeat(64), evidenceAnchors: [{ sourceId: "source-1", quoteHash: "a".repeat(64), start: 0, end: 10 }],
      trustStatus: "APPROVED", rightsStatus: "APPROVED"
    }],
    media: [{
      role: "hero", path: `media/${revisionId}/production.webp`, sha256: mediaHash,
      width: 1600, height: 900
    }],
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    adapterVersion: "test@1",
    editorialDesk: "Yerel Editorya",
    riskLevel: "STANDARD",
    translationParity: { status: "MATCHED", reportHash: "d".repeat(64) },
    editorialPolicyHash: "e".repeat(64),
    editorialReviewReportHash: "f".repeat(64),
    targetRepository: "owner/site",
    targetBaseBranch: "main",
    targetBaseSha: "a".repeat(40),
    generatedFiles,
    qualityGates: [
      { id: "claims", group: "editorial", state: "PASS", detail: "checked", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "contradictions", group: "editorial", state: "PASS", detail: "checked", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "bilingual-parity", group: "editorial", state: "PASS", detail: "checked", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "markdown-safety", group: "security", state: "PASS", detail: "checked", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "seo", group: "seo", state: "PASS", detail: "checked", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "media", group: "media", state: "PASS", detail: "checked", policyVersion: "2", reasonCode: "CHECKED" }
    ]
  };
  const revisionHash = computeRevisionHash(revision);
  await mkdir(join(dataDir, "media", revisionId), { recursive: true });
  await writeFile(join(dataDir, "media", revisionId, "production.webp"), mediaBytes);

  const calls: string[] = [];
  let pullRequest: PullRequestState | null = null;
  const effects: PublicationEffectsPort & { getBaseBranchSha(): Promise<string> } = {
    async getBaseBranchSha() { calls.push("base-sha"); return "a".repeat(40); },
    async findPullRequest() { calls.push("find-pr"); return pullRequest; },
    async createPullRequest(input) {
      calls.push("create-pr");
      const media = input.files.find((file) => file.path === mediaPublicationPath);
      if (!(media?.content instanceof Uint8Array)) {
        throw new Error("engine media must be materialized before crossing the effects boundary");
      }
      assert.deepEqual(Buffer.from(media.content), mediaBytes);
      pullRequest = { number: 7, headSha: "c".repeat(40), merged: false, requiredChecks: "PASSED" };
      return pullRequest;
    },
    async mergePullRequest() {
      calls.push("merge-pr");
      pullRequest = { number: 7, headSha: "c".repeat(40), merged: true, mergeSha: "d".repeat(40), requiredChecks: "PASSED" };
      return pullRequest;
    },
    async findDeployIntent() { calls.push("find-deploy"); return null; },
    async createDeployIntent(input) { calls.push("create-deploy"); return { key: input.key, revisionId: input.revisionId, mergeSha: input.mergeSha }; }
  };

  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false,
    allowUnsafeRevisionSaveForTests: true,
    publicationBroker: { connector: { state: "READY" }, effects }
  });
  t.after(() => runtime.close());

  const doctor = await runtime.handle({ version: 1, id: "production-publication-doctor", kind: "doctor" });
  assert.equal(doctor.ok, true);
  assert.ok((doctor.capabilities as string[]).includes("PUBLICATION.ENQUEUE"));

  const saved = await runtime.handle(command("REVISION.SAVE", { revision }, 0, "save"));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const approved = await runtime.handle(command("APPROVAL.GRANT", {
    revisionId, revisionHash, deviceId: "windows-local-device-v1", warningSetHash: computeWarningSetHash(revision.qualityGates)
  }, 1, "approve"));
  assert.equal(approved.ok, true, JSON.stringify(approved));

  const manifestPath = `.blogbot/manifests/${revisionId}.json`;
  const previewFiles: PublicationFile[] = [
    ...articleFiles,
    {
      path: mediaPublicationPath,
      content: { kind: "engine-media-ref", revisionId, sha256: mediaHash, byteSize: mediaBytes.byteLength }
    }
  ];
  const preview = await runtime.handle({
    version: 1, id: "production-preview", kind: "publication.preview", revisionId, revisionHash,
    expectedVersion: 2, idempotencyKey: "production-preview-key",
    payload: {
      targetRepository: "owner/site", baseBranch: "main", siteOrigin: "", contentRoot: "C:\\Blogbot-Test", now: new Date().toISOString(),
      files: [...previewFiles, {
        path: manifestPath,
        content: JSON.stringify({
          version: 1, revisionId, revisionHash, adapterVersion: "test@1", generatedAt: new Date().toISOString(),
          entries: generatedFiles.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.size }))
        })
      }],
      bundlePolicy: { adapterId: "test", manifestPath, allowedPathPrefixes: [...generatedFiles.map((file) => file.path), manifestPath] }
    }
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const previewHash = (preview.value as { previewHash: string }).previewHash;
  const enqueued = await runtime.handle({
    version: 1, id: "production-enqueue", kind: "publication.enqueue", revisionId, revisionHash, previewHash,
    idempotencyKey: "production-enqueue-key", expectedVersion: 3
  });
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));

  const outbox = await waitFor(async () => {
    const state = await runtime.handle({ version: 1, id: "production-state", kind: "state", afterCursor: 0 });
    return (state.snapshot as { outbox: Array<{ aggregateId: string; state: string; attempts: number; resultRef?: string }> }).outbox
      .find((effect) => effect.aggregateId === revisionId);
  }, (effect) => effect?.state === "UNKNOWN" && effect.resultRef?.startsWith("blogbot:deploy:") === true);

  assert.equal(outbox?.attempts, 1);
  assert.deepEqual(calls, ["base-sha", "find-pr", "create-pr", "merge-pr", "find-deploy", "create-deploy"]);
});
