import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPersistentEngineProtocol as createProductionEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import {
  computeRevisionHash,
  computeWarningSetHash,
  type ArticleRevision,
  type RevisionPackageV2
} from "../../packages/editorial/src/revision.ts";

function revision(
  overrides: Partial<RevisionPackageV2> = {}
): RevisionPackageV2 {
  return {
    id: "revision-editorial-1",
    translationKey: "story-editorial-1",
    state: "REVIEW_REQUIRED",
    tr: {
      title: "Kimlik güvenliği değişiyor",
      slug: "kimlik-guvenligi-degisiyor",
      description: "Doğrulanmış gelişmenin özgün Türkçe özeti.",
      bodyMarkdown: "## Özet\n\nDoğrulanmış gelişme [kaynakta](https://example.com/report) yer alıyor.",
      heroImageAlt: "Kimlik güvenliğini gösteren soyut kapak"
    },
    en: {
      title: "Identity security is changing",
      slug: "identity-security-is-changing",
      description: "An original English account of the verified development.",
      bodyMarkdown: "## Summary\n\nThe verified development appears in the [source](https://example.com/report).",
      heroImageAlt: "An abstract cover representing identity security"
    },
    section: "haberler",
    articleType: "news",
    author: "Ulaş Şahin",
    tags: ["kimlik", "güvenlik"],
    claims: [
      {
        id: "claim-1",
        locale: "both",
        text: "Gelişme doğrulandı.",
        sourceIds: ["source-1"],
        status: "VERIFIED",
        claimKey: "claim.identity.change",
        trText: "Gelişme doğrulandı.",
        enText: "The development was verified.",
        evidenceAnchors: [
          {
            sourceId: "source-1",
            quoteHash: "a".repeat(64),
            start: 10,
            end: 40
          }
        ]
      }
    ],
    sources: [
      {
        id: "source-1",
        url: "https://example.com/report",
        title: "Primary report",
        fetchedAt: "2026-07-30T08:00:00.000Z",
        contentHash: "b".repeat(64),
        evidenceAnchors: [{ sourceId: "source-1", quoteHash: "a".repeat(64), start: 10, end: 40 }],
        trustStatus: "APPROVED",
        rightsStatus: "APPROVED"
      }
    ],
    media: [
      {
        role: "hero",
        path: "identity-security-16x9.webp",
        sha256: "c".repeat(64),
        width: 1600,
        height: 900
      }
    ],
    scheduledAt: "2026-07-30T12:00:00.000Z",
    adapterVersion: "2.0.0",
    editorialDesk: "Yerel Editorya",
    riskLevel: "STANDARD",
    translationParity: {
      status: "MATCHED",
      reportHash: "d".repeat(64)
    },
    editorialPolicyHash: "e".repeat(64),
    editorialReviewReportHash: "f".repeat(64),
    targetRepository: "owner/site",
    targetBaseBranch: "main",
    targetBaseSha: "1".repeat(40),
    generatedFiles: [
      {
        path: "src/content/articles/tr/kimlik-guvenligi-degisiyor.md",
        sha256: "2".repeat(64),
        size: 1_024
      },
      {
        path: "src/content/articles/en/identity-security-is-changing.md",
        sha256: "3".repeat(64),
        size: 960
      }
    ],
    qualityGates: [
      { id: "claims", group: "editorial", state: "PASS", detail: "Kanıt doğrulandı.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "contradictions", group: "editorial", state: "PASS", detail: "Çelişki denetlendi.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "bilingual-parity", group: "editorial", state: "PASS", detail: "Dil eşitliği doğrulandı.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "markdown-safety", group: "security", state: "PASS", detail: "Markdown güvenli.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "seo", group: "seo", state: "PASS", detail: "SEO denetlendi.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "media", group: "media", state: "PASS", detail: "Medya denetlendi.", policyVersion: "2", reasonCode: "CHECKED" }
    ],
    ...overrides
  };
}

function command(
  kind: string,
  payload: Record<string, unknown>,
  expectedVersion: number,
  suffix: string
) {
  return {
    version: 1,
    id: `editorial-envelope-${suffix}`,
    kind: "command",
    command: {
      version: 1,
      requestId: `editorial-request-${suffix}`,
      idempotencyKey: `editorial-key-${suffix}`,
      expectedVersion,
      kind,
      payload
    }
  };
}

function valueOf<T>(response: Record<string, unknown>): T {
  assert.equal(response.ok, true);
  return (response.result as { value: T }).value;
}

/** Fixtures may seed immutable revisions without exposing that mutation in production. */
function createPersistentEngineProtocol(
  dataDir: string,
  options: Parameters<typeof createProductionEngineProtocol>[1] = {}
) {
  return createProductionEngineProtocol(dataDir, {
    ...options,
    allowUnsafeRevisionSaveForTests: true
  });
}

test("production protocol rejects caller-supplied revision packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-save-closed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createProductionEngineProtocol(join(root, "pgdata"), { startSourceWorker: false });
  t.after(() => runtime.close());

  const response = await runtime.handle(command("REVISION.SAVE", { revision: revision() }, 0, "external-save"));
  assert.equal(response.ok, false);
  assert.equal((response.result as { error: { code: string } }).error.code, "REVISION_SAVE_INTERNAL_ONLY");
});

test("background maintenance does not advance the editorial optimistic-version cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-maintenance-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createProductionEngineProtocol(join(root, "pgdata"), { startSourceWorker: false });
  t.after(() => runtime.close());

  const response = await runtime.handle(command("REVISION.LIST", { summaryOnly: true }, 0, "list-with-maintenance"));
  assert.equal(response.ok, true, JSON.stringify(response));
});

test("revision save, list, and get are versioned, exact-hash bound, and durable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-protocol-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedRevision = revision();

  const firstRuntime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  let firstRuntimeClosed = false;
  t.after(async () => {
    if (!firstRuntimeClosed) {
      await firstRuntime.close();
    }
  });
  const saved = await firstRuntime.handle(
    command("REVISION.SAVE", { revision: expectedRevision }, 0, "save")
  );
  assert.deepEqual(valueOf(saved), {
    revision: expectedRevision,
    revisionHash: computeRevisionHash(expectedRevision)
  });

  const listed = await firstRuntime.handle(
    command("REVISION.LIST", {}, 1, "list")
  );
  assert.deepEqual(valueOf(listed), [
    {
      revision: expectedRevision,
      revisionHash: computeRevisionHash(expectedRevision),
      editorialApproval: null,
      highRiskApproval: null
    }
  ]);
  await firstRuntime.close();
  firstRuntimeClosed = true;

  const secondRuntime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  t.after(() => secondRuntime.close());
  const loaded = await secondRuntime.handle(
    command(
      "REVISION.GET",
      { revisionId: expectedRevision.id },
      1,
      "get-after-restart"
    )
  );
  assert.deepEqual(valueOf<{
    revision: ArticleRevision;
    revisionHash: string;
    editorialApproval: null;
    highRiskApproval: null;
  }>(loaded), {
    revision: expectedRevision,
    revisionHash: computeRevisionHash(expectedRevision),
    editorialApproval: null,
    highRiskApproval: null
  });
});

test("a missing-media draft gets an immutable successor with local hero variants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-media-repair-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(dataDir, { startSourceWorker: false });
  t.after(() => runtime.close());
  const doctor = await runtime.handle({ version: 1, id: "media-repair-doctor", kind: "doctor" });
  assert.equal(doctor.ok, true);
  assert.ok(
    "capabilities" in doctor &&
    Array.isArray(doctor.capabilities) &&
    doctor.capabilities.includes("REVISION.REPAIR_MEDIA")
  );
  const original = revision({
    id: "revision-media-missing",
    media: []
  });

  const saved = await runtime.handle(
    command("REVISION.SAVE", { revision: original }, 0, "media-repair-save")
  );
  assert.equal(saved.ok, true);

  const repaired = await runtime.handle(
    command("REVISION.REPAIR_MEDIA", { revisionId: original.id }, 1, "media-repair")
  );
  const value = valueOf<{
    revision: RevisionPackageV2;
    revisionHash: string;
  }>(repaired);
  assert.notEqual(value.revision.id, original.id);
  assert.equal(value.revision.supersedesRevisionId, original.id);
  assert.equal(value.revision.state, "REVIEW_REQUIRED");
  assert.equal(value.revision.media.length, 3);
  assert.deepEqual(
    value.revision.media.map((asset) => [asset.width, asset.height]),
    [[1600, 900], [1200, 900], [1200, 1200]]
  );
  assert.ok(value.revision.media.every((asset) => asset.contentBase64 === undefined));
  assert.ok(value.revision.media.every((asset) => Number.isSafeInteger(asset.byteSize) && asset.byteSize! > 0));
  assert.ok(value.revision.generatedFiles.some((file) => file.path.includes("images/")));

  const asset = value.revision.media[0]!;
  const mediaRead = await runtime.handle({
    version: 1,
    id: "media-read-first-chunk",
    kind: "media.read",
    revisionId: value.revision.id,
    sha256: asset.sha256,
    offset: 0,
    length: 64 * 1024
  });
  assert.equal(mediaRead.ok, true, JSON.stringify(mediaRead));
  const mediaValue = (mediaRead as unknown as { value: { contentBase64: string; totalBytes: number } }).value;
  assert.ok(mediaValue.contentBase64.length > 0);
  assert.equal(mediaValue.totalBytes, asset.byteSize);
  const rejectedRead = await runtime.handle({
    version: 1,
    id: "media-read-invalid",
    kind: "media.read",
    revisionId: value.revision.id,
    sha256: "f".repeat(64),
    offset: 0,
    length: 64 * 1024 + 1
  });
  assert.equal(rejectedRead.ok, false);

  const originalLoaded = valueOf<{ revision: RevisionPackageV2 }>(
    await runtime.handle(command("REVISION.GET", { revisionId: original.id }, 2, "media-repair-original"))
  );
  assert.deepEqual(originalLoaded.revision.media, []);
});

test("revision summary list omits editor bodies and media payloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false
  });
  t.after(() => runtime.close());
  const expectedRevision = revision({
    media: [{
      role: "hero",
      path: "large-cover.webp",
      sha256: "c".repeat(64),
      width: 1600,
      height: 900
    }]
  });

  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, 0, "summary-save"));
  const listed = await runtime.handle(
    command("REVISION.LIST", { summaryOnly: true }, 1, "summary-list")
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const summary = valueOf<Array<{ revision: Record<string, unknown> }>>(listed)[0]?.revision;

  assert.ok(summary);
  assert.equal(summary?.id, expectedRevision.id);
  assert.equal((summary?.tr as { title?: string }).title, expectedRevision.tr.title);
  assert.equal("media" in summary!, false);
  assert.equal("en" in summary!, false);
  assert.equal("generatedFiles" in summary!, false);
});

test("normal approval is exact-hash bound, idempotent, and durable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-approval-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  let closed = false;
  t.after(async () => {
    if (!closed) await runtime.close();
  });
  const expectedRevision = revision();
  const expectedHash = computeRevisionHash(expectedRevision);
  const warningSetHash = computeWarningSetHash(expectedRevision.qualityGates);
  await runtime.handle(
    command("REVISION.SAVE", { revision: expectedRevision }, 0, "approve-save")
  );

  const rejected = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: expectedRevision.id,
        revisionHash: "0".repeat(64),
        deviceId: "windows-local-device-v1",
        warningSetHash
      },
      1,
      "approve-wrong-hash"
    )
  );
  assert.equal(rejected.ok, false);

  const approved = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: expectedRevision.id,
        revisionHash: expectedHash,
        deviceId: "windows-local-device-v1",
        warningSetHash
      },
      1,
      "approve"
    )
  );
  const approvalValue = valueOf<{
    revisionId: string;
    revisionHash: string;
    deviceId: string;
    approvedAt: string;
    approvalType: "EDITORIAL";
    warningSetHash: string;
  }>(approved);
  assert.deepEqual(
    {
      ...approvalValue,
      approvedAt: "<engine-time>"
    },
    {
      revisionId: expectedRevision.id,
      revisionHash: expectedHash,
      deviceId: "windows-local-device-v1",
      approvedAt: "<engine-time>",
      approvalType: "EDITORIAL",
      warningSetHash
    }
  );
  assert.equal(
    new Date(approvalValue.approvedAt).toISOString(),
    approvalValue.approvedAt
  );
  const replay = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: expectedRevision.id,
        revisionHash: expectedHash,
        deviceId: "windows-local-device-v1",
        warningSetHash
      },
      1,
      "approve"
    )
  );
  assert.deepEqual(replay, approved);
  await runtime.close();
  closed = true;

  const reopened = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false
  });
  t.after(() => reopened.close());
  const listed = await reopened.handle(
    command("REVISION.LIST", {}, 2, "approval-list")
  );
  const rows = valueOf<
    Array<{ editorialApproval: { revisionHash: string } | null }>
  >(listed);
  assert.equal(rows[0]?.editorialApproval?.revisionHash, expectedHash);
});

test("high-risk approval is accepted only after the matching editorial approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-high-risk-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false
  });
  t.after(() => runtime.close());
  const expectedRevision = revision({ id: "revision-high-risk-order", riskLevel: "HIGH" });
  const revisionHash = computeRevisionHash(expectedRevision);
  const warningSetHash = computeWarningSetHash(expectedRevision.qualityGates);
  const highRiskPayload = {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash,
    riskChecklistHash: "9".repeat(64),
    windowsReauthenticatedAt: "2026-07-30T12:00:00.000Z"
  };
  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, 0, "high-risk-save"));

  const premature = await runtime.handle(command("APPROVAL.GRANT_HIGH_RISK", highRiskPayload, 1, "high-risk-premature"));
  assert.equal(premature.ok, false);
  assert.equal((premature.result as { error: { code: string } }).error.code, "EDITORIAL_APPROVAL_REQUIRED");

  const editorial = await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash
  }, 1, "high-risk-editorial"));
  assert.equal(editorial.ok, true);

  const secondApproval = await runtime.handle(command("APPROVAL.GRANT_HIGH_RISK", highRiskPayload, 2, "high-risk-second"));
  assert.equal(secondApproval.ok, true);
});

test("approved revision rejects a self-consistent but substituted publication bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-publication-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false
  });
  t.after(() => runtime.close());
  const approvedFiles = [
    { path: "content/tr/story.md", content: "onaylanan Türkçe içerik\n" },
    { path: "content/en/story.md", content: "approved English content\n" }
  ];
  const expectedRevision = revision({
    id: "revision-publication-binding",
    targetRepository: "owner/site",
    generatedFiles: approvedFiles.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      size: Buffer.byteLength(file.content)
    }))
  });
  const revisionHash = computeRevisionHash(expectedRevision);
  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, 0, "binding-save"));
  await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(expectedRevision.qualityGates)
  }, 1, "binding-approve"));

  const substitutedFiles = [
    { ...approvedFiles[0]!, content: "saldırgan tarafından seçilen içerik\n" },
    approvedFiles[1]!
  ];
  const manifestPath = `.blogbot/manifests/${expectedRevision.id}.json`;
  const response = await runtime.handle({
    version: 1,
    id: "binding-preview",
    kind: "publication.preview",
    revisionId: expectedRevision.id,
    revisionHash,
    expectedVersion: 2,
    idempotencyKey: "binding-preview-key",
    payload: {
      targetRepository: "owner/site",
      baseBranch: "main",
      siteOrigin: "https://example.org",
      contentRoot: "/site",
      now: "2026-07-30T12:00:00.000Z",
      files: [
        ...substitutedFiles,
        {
          path: manifestPath,
          content: JSON.stringify({
            version: 1,
            revisionId: expectedRevision.id,
            revisionHash,
            adapterVersion: "test@1",
            generatedAt: "2026-07-30T12:00:00.000Z",
            entries: substitutedFiles.map((file) => ({
              path: file.path,
              sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
              bytes: Buffer.byteLength(file.content)
            }))
          })
        }
      ],
      bundlePolicy: {
        adapterId: "test",
        manifestPath,
        allowedPathPrefixes: ["content/", ".blogbot/manifests/"],
        requiredLocalePrefixes: ["content/tr/", "content/en/"]
      }
    }
  });

  assert.equal(response.ok, false);
  assert.match(String(response.message), /APPROVAL_BOUND_FILE_MISMATCH/u);
});

test("approved revision rejects publication target metadata changed after approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-publication-target-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), { startSourceWorker: false });
  t.after(() => runtime.close());
  const files = [
    { path: "content/tr/target.md", content: "onaylanan Türkçe içerik\n" },
    { path: "content/en/target.md", content: "approved English content\n" }
  ];
  const expectedRevision = revision({
    id: "revision-target-binding",
    targetRepository: "owner/site",
    targetBaseBranch: "main",
    targetBaseSha: "1".repeat(40),
    adapterVersion: "test@1",
    generatedFiles: files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      size: Buffer.byteLength(file.content)
    }))
  });
  const revisionHash = computeRevisionHash(expectedRevision);
  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, 0, "target-binding-save"));
  await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(expectedRevision.qualityGates)
  }, 1, "target-binding-approve"));
  const manifestPath = `.blogbot/manifests/${expectedRevision.id}.json`;
  const response = await runtime.handle({
    version: 1,
    id: "target-binding-preview",
    kind: "publication.preview",
    revisionId: expectedRevision.id,
    revisionHash,
    expectedVersion: 2,
    idempotencyKey: "target-binding-preview-key",
    payload: {
      targetRepository: "owner/changed-site",
      baseBranch: "release",
      approvedBaseSha: "2".repeat(40),
      adapterVersion: "other@9",
      siteOrigin: "https://example.org",
      contentRoot: "/site",
      now: "2026-07-30T12:00:00.000Z",
      files: [
        ...files,
        {
          path: manifestPath,
          content: JSON.stringify({
            version: 1,
            revisionId: expectedRevision.id,
            revisionHash,
            adapterVersion: "other@9",
            generatedAt: "2026-07-30T12:00:00.000Z",
            entries: files.map((file) => ({
              path: file.path,
              sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
              bytes: Buffer.byteLength(file.content)
            }))
          })
        }
      ],
      bundlePolicy: {
        adapterId: "other",
        manifestPath,
        allowedPathPrefixes: ["content/", ".blogbot/manifests/"],
        requiredLocalePrefixes: ["content/tr/", "content/en/"]
      }
    }
  });

  assert.equal(response.ok, false);
  assert.match(String(response.message), /APPROVAL_TARGET_MISMATCH/u);
});

test("publication enqueue persists one approved preview without nesting the PGlite transaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-publication-enqueue-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    { path: "content/tr/enqueue.md", content: "onaylı Türkçe içerik\n" },
    { path: "content/en/enqueue.md", content: "approved English content\n" }
  ];
  const expectedRevision = revision({
    id: "revision-publication-enqueue",
    targetRepository: "owner/site",
    adapterVersion: "test@1",
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    generatedFiles: files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      size: Buffer.byteLength(file.content)
    }))
  });
  const revisionHash = computeRevisionHash(expectedRevision);
  const manifestPath = `.blogbot/manifests/${expectedRevision.id}.json`;
  const runtime = await createPersistentEngineProtocol(dataDir, { startSourceWorker: false });
  t.after(() => runtime.close());

  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, 0, "enqueue-save"));
  await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(expectedRevision.qualityGates)
  }, 1, "enqueue-approve"));
  const preview = await runtime.handle({
    version: 1,
    id: "enqueue-preview",
    kind: "publication.preview",
    revisionId: expectedRevision.id,
    revisionHash,
    expectedVersion: 2,
    idempotencyKey: "enqueue-preview-key",
    payload: {
      targetRepository: "owner/site",
      baseBranch: "main",
      siteOrigin: "",
      contentRoot: "C:\\Blogbot-Test",
      now: "2026-07-30T12:00:00.000Z",
      files: [
        ...files,
        {
          path: manifestPath,
          content: JSON.stringify({
            version: 1,
            revisionId: expectedRevision.id,
            revisionHash,
            adapterVersion: "test@1",
            generatedAt: "2026-07-30T12:00:00.000Z",
            entries: files.map((file) => ({
              path: file.path,
              sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
              bytes: Buffer.byteLength(file.content)
            }))
          })
        }
      ],
      bundlePolicy: {
        adapterId: "test",
        manifestPath,
        allowedPathPrefixes: ["content/", ".blogbot/manifests/"],
        requiredLocalePrefixes: ["content/tr/", "content/en/"]
      }
    }
  });
  assert.equal(preview.ok, true);
  const previewHash = (preview.value as { previewHash: string }).previewHash;

  const enqueued = await Promise.race([
    runtime.handle({
      version: 1,
      id: "enqueue-publication",
      kind: "publication.enqueue",
      revisionId: expectedRevision.id,
      revisionHash,
      previewHash,
      idempotencyKey: "enqueue-publication-key",
      expectedVersion: 3
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PUBLICATION_ENQUEUE_TIMEOUT")), 1_000))
  ]);
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  const persisted = (await runtime.handle({ version: 1, id: "enqueue-state", kind: "state", afterCursor: 0 })).snapshot as { outbox: Array<{ aggregateId: string }> };
  assert.equal(persisted.outbox.filter((effect) => effect.aggregateId === expectedRevision.id).length, 1);
});

test("normal approval rejects a revision that is not awaiting review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-state-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false
  });
  t.after(() => runtime.close());

  const draftingRevision = revision({
    id: "revision-editorial-drafting",
    state: "DRAFTING"
  });
  const revisionHash = computeRevisionHash(draftingRevision);
  const warningSetHash = computeWarningSetHash(draftingRevision.qualityGates);
  await runtime.handle(
    command(
      "REVISION.SAVE",
      { revision: draftingRevision },
      0,
      "drafting-save"
    )
  );

  const response = await runtime.handle(
    command(
      "APPROVAL.GRANT",
      {
        revisionId: draftingRevision.id,
        revisionHash,
        deviceId: "windows-local-device-v1",
        warningSetHash
      },
      1,
      "drafting-approve"
    )
  );

  assert.equal(response.ok, false);
  assert.equal(
    (response.result as { error: { code: string } }).error.code,
    "REVISION_NOT_REVIEWABLE"
  );
});
