import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  createPersistentEngineProtocol as createProductionEngineProtocol,
  pruneSupersededRevisionMedia
} from "../../apps/engine/src/stdio-entrypoint.ts";
import type { ImageGenerationRequest } from "../../apps/engine/src/imagegen-provider.ts";
import {
  computeRevisionHash,
  computeWarningSetHash,
  computeEditorialAttestationHash,
  type ArticleRevision,
  type RevisionPackageV2,
  type RevisionPackageV3
} from "../../packages/editorial/src/revision.ts";
import type { EditorialApprovalAttestationV3 } from "../../packages/editorial/src/quality-gates.ts";

const editorialAttestation: EditorialApprovalAttestationV3 = {
  editorialReview: {
    reviewer: "Ulaş Şahin",
    sourceRoles: [{ sourceId: "source-1", role: "primary" }]
  },
  expertReview: null,
  ethicsReview: null
};

function revision(
  overrides: Partial<RevisionPackageV3> = {}
): RevisionPackageV3 {
  const instruction = "Doğrulanmış kaynaklardan özgün ve iki dilli haber üret.";
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
        height: 900,
        byteSize: 1_024
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
      { id: "media", group: "media", state: "PASS", detail: "Medya denetlendi.", policyVersion: "2", reasonCode: "CHECKED" },
      { id: "editorial-policy", group: "editorial", state: "PASS", detail: "V3 politika denetlendi.", policyVersion: "3", reasonCode: "CHECKED" }
    ],
    packageVersion: 3,
    editorialContext: {
      instruction,
      instructionHash: createHash("sha256").update(instruction, "utf8").digest("hex"),
      contentOrigin: "CODEX_ASSISTED",
      aiDisclosure: "GENERATED_WITH_AI"
    },
    editorialAssessment: {
      articleType: "news",
      intentSatisfied: true,
      titleIsHonest: true,
      originalValuePresent: true,
      allClaimsVerified: true,
      sources: [{ sourceId: "source-1", cited: true, official: true, role: "primary" }],
      singleOfficialSourceRationale: "Bu olay için tek yetkili ve birincil kayıt budur.",
      authorTransparent: true,
      aiDisclosureMatchesUsage: true,
      isYmyl: false,
      leadHasFiveWOneH: true,
      unverifiedClaimsClearlyLabeled: true,
      newsSchemaComplete: true,
      sensitiveTopic: false,
      clusterKey: null,
      aboveFoldAnswersIntent: true,
      headingHierarchyValid: true,
      internalLinkCount: 0,
      internalLinkOmissionRationale: null
    },
    publicationSources: [{
      id: "source-1",
      title: "Primary report",
      url: "https://example.com/report",
      role: "primary"
    }],
    deployWorkflow: "deploy.yml",
    requiredChecks: ["ci/test"],
    ...overrides
  };
}

function command(
  kind: string,
  payload: Record<string, unknown>,
  expectedVersion: number,
  suffix: string
) {
  const normalizedPayload = kind === "APPROVAL.GRANT" && !("packageVersion" in payload)
    ? { ...payload, packageVersion: 3, attestation: editorialAttestation }
    : payload;
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
      payload: normalizedPayload
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
  const abandonedMediaRoot = join(dataDir, "media", original.id);
  await mkdir(abandonedMediaRoot, { recursive: true });
  await writeFile(join(abandonedMediaRoot, "abandoned.webp"), "abandoned", "utf8");

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
  assert.ok(value.revision.media.every((asset) => asset.source === "LOCAL_RENDERER"));
  assert.ok(value.revision.generatedFiles.some((file) => file.path.includes("images/")));
  // No ImageGen provider is configured here, so the repair produced the generic
  // local cover. The gate has to say so instead of reporting a checked hero
  // package the reviewer would read as a verified article visual.
  const repairedMediaGate = value.revision.qualityGates.find((gate) => gate.id === "media");
  assert.equal(repairedMediaGate?.state, "PASS");
  assert.equal(repairedMediaGate?.reasonCode, "LOCAL_FALLBACK_VISUAL");
  await assert.rejects(stat(abandonedMediaRoot), (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
  );

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
  // A caller switches on `code`, so it must stay an enumerable sentinel and must
  // never carry the raw exception text or the requested revision id.
  const missingRead = await runtime.handle({
    version: 1,
    id: "media-read-missing-revision",
    kind: "media.read",
    revisionId: "revision-media-absent",
    sha256: asset.sha256,
    offset: 0,
    length: 1_024
  });
  assert.equal(missingRead.ok, false);
  assert.ok(
    ["MEDIA_ASSET_NOT_FOUND", "MEDIA_READ_FAILED"].includes(String(missingRead.code)),
    `unexpected media read code ${String(missingRead.code)}`
  );
  assert.equal(String(missingRead.code).includes("revision-media-absent"), false);

  const originalLoaded = valueOf<{ revision: RevisionPackageV2 }>(
    await runtime.handle(command("REVISION.GET", { revisionId: original.id }, 2, "media-repair-original"))
  );
  assert.deepEqual(originalLoaded.revision.media, []);
});

test("a media repair backed by ImageGen records a different provenance and revision hash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-editorial-media-repair-imagegen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generatedImage = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: "#2456a6" }
  }).png().toBuffer();
  let imageRequest: ImageGenerationRequest | undefined;
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false,
    imageGenerator: { async generate(request) { imageRequest = request; return generatedImage; } }
  });
  t.after(() => runtime.close());
  const original = revision({ id: "revision-media-imagegen", media: [] });

  await runtime.handle(command("REVISION.SAVE", { revision: original }, 0, "media-imagegen-save"));
  const repaired = await runtime.handle(
    command("REVISION.REPAIR_MEDIA", { revisionId: original.id }, 1, "media-imagegen-repair")
  );
  const value = valueOf<{ revision: RevisionPackageV2; revisionHash: string }>(repaired);

  // The reviewer has to be able to tell an article-specific visual from the
  // generic local cover, and the distinction is approval-bound because the gate
  // is part of the revision hash.
  const mediaGate = value.revision.qualityGates.find((gate) => gate.id === "media");
  assert.equal(mediaGate?.state, "PASS");
  assert.equal(mediaGate?.reasonCode, "IMAGEGEN_VISUAL");
  assert.ok(value.revision.media.every((asset) => asset.source === "IMAGEGEN"));
  assert.equal(imageRequest?.summary, original.tr.description);
  assert.deepEqual(imageRequest?.keyClaims, original.claims.map((claim) => claim.trText ?? claim.text));
  assert.match(imageRequest?.visualIntent ?? "", /metinsiz/u);
  // The provenance is approval-bound: it sits inside the revision hash, so a
  // local fallback and an ImageGen visual can never share one approval.
  const asFallback = {
    ...value.revision,
    media: value.revision.media.map((asset) => ({ ...asset, source: "LOCAL_RENDERER" as const }))
  };
  assert.notEqual(
    computeRevisionHash(asFallback as unknown as ArticleRevision),
    computeRevisionHash(value.revision as unknown as ArticleRevision)
  );
});

test("media pruning removes only bounded superseded roots that no current revision references", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-media-prune-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const supersededId = "revision-media-superseded";
  const mediaRoot = join(dataDir, "media", supersededId);
  await mkdir(mediaRoot, { recursive: true });
  await writeFile(join(mediaRoot, "old.webp"), "old-media", "utf8");
  const predecessor = revision({
    id: supersededId,
    media: [{
      role: "hero",
      path: `media/${supersededId}/old.webp`,
      sha256: "8".repeat(64),
      width: 1600,
      height: 900,
      byteSize: 9,
      source: "LOCAL_RENDERER"
    }]
  });
  const successor = revision({
    id: "revision-media-current",
    supersedesRevisionId: supersededId,
    media: []
  });

  assert.deepEqual(
    await pruneSupersededRevisionMedia(dataDir, [predecessor, successor], [supersededId]),
    [supersededId]
  );
  await assert.rejects(stat(mediaRoot), (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
  );

  await mkdir(mediaRoot, { recursive: true });
  await writeFile(join(mediaRoot, "old.webp"), "old-media", "utf8");
  const currentReference = revision({
    id: "revision-media-branch",
    media: [{
      ...predecessor.media[0]!,
      path: `media\\${supersededId}\\old.webp`
    }]
  });
  assert.deepEqual(
    await pruneSupersededRevisionMedia(
      dataDir,
      [predecessor, successor, currentReference],
      [supersededId]
    ),
    []
  );
  assert.equal((await stat(join(mediaRoot, "old.webp"))).isFile(), true);
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
    packageVersion: 3;
    attestation: EditorialApprovalAttestationV3;
    attestationHash: string;
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
      warningSetHash,
      packageVersion: 3,
      attestation: editorialAttestation,
      attestationHash: computeEditorialAttestationHash(editorialAttestation)
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
    // The native host derives this from the clock immediately after Windows
    // consent, so the engine only accepts a recent reauthentication.
    windowsReauthenticatedAt: new Date().toISOString()
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

  // The audit record must not be able to assert a Windows reauthentication that
  // is not recent, in either direction, even though the timestamp itself can
  // only come from the native host that ran the verifier.
  const stale = await runtime.handle(command("APPROVAL.GRANT_HIGH_RISK", {
    ...highRiskPayload,
    windowsReauthenticatedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
  }, 2, "high-risk-stale-reauth"));
  assert.equal(stale.ok, false);
  assert.equal((stale.result as { error: { code: string } }).error.code, "WINDOWS_REAUTH_STALE");
  const ahead = await runtime.handle(command("APPROVAL.GRANT_HIGH_RISK", {
    ...highRiskPayload,
    windowsReauthenticatedAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString()
  }, 2, "high-risk-future-reauth"));
  assert.equal(ahead.ok, false);
  assert.equal((ahead.result as { error: { code: string } }).error.code, "WINDOWS_REAUTH_STALE");

  const secondApproval = await runtime.handle(command("APPROVAL.GRANT_HIGH_RISK", highRiskPayload, 2, "high-risk-second"));
  assert.equal(secondApproval.ok, true);
  assert.notEqual(
    ((secondApproval.result as { value?: { riskChecklistHash?: string } }).value ?? {}).riskChecklistHash,
    highRiskPayload.riskChecklistHash,
    "engine must persist its own checklist digest, not the caller-provided one"
  );
});

test("a successor revision invalidates the old exact-hash approval for preview and enqueue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-revision-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    { path: "content/tr/lineage.md", content: "onaylanan Turkce icerik\n" },
    { path: "content/en/lineage.md", content: "approved English content\n" }
  ];
  const original = revision({
    id: "revision-lineage-original",
    targetRepository: "owner/site",
    adapterVersion: "test@1",
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    generatedFiles: files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      size: Buffer.byteLength(file.content)
    }))
  });
  const originalHash = computeRevisionHash(original);
  const manifestPath = `.blogbot/manifests/${original.id}.json`;
  const previewPayload = {
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
          revisionId: original.id,
          revisionHash: originalHash,
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
  };
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false,
    nativePublicationBroker: true
  });
  t.after(() => runtime.close());

  await runtime.handle(command("REVISION.SAVE", { revision: original }, 0, "lineage-save-original"));
  await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: original.id,
    revisionHash: originalHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(original.qualityGates)
  }, 1, "lineage-approve-original"));
  await runtime.handle(command("LOCAL_STATE.SET", {
    key: "desktop.connectors",
    value: { deploy: { workflowName: "deploy.yml", requiredChecks: ["build"] } }
  }, 2, "lineage-connector-policy"));
  const unpaused = await runtime.handle(command("AUTOMATION.SET", {
    settings: {
      mode: "PUBLISH_APPROVED",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: false,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    }
  }, 3, "lineage-unpause"));
  assert.equal(unpaused.ok, true, JSON.stringify(unpaused));
  const preview = await runtime.handle({
    version: 1,
    id: "lineage-preview-before-edit",
    kind: "publication.preview",
    revisionId: original.id,
    revisionHash: originalHash,
    expectedVersion: 4,
    idempotencyKey: "lineage-preview-before-edit-key",
    payload: previewPayload
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const previewHash = (preview.value as { previewHash: string }).previewHash;

  const successor = revision({
    id: "revision-lineage-successor",
    supersedesRevisionId: original.id,
    scheduledAt: original.scheduledAt
  });
  const savedSuccessor = await runtime.handle(command("REVISION.SAVE", { revision: successor }, 5, "lineage-save-successor"));
  assert.equal(savedSuccessor.ok, true, JSON.stringify(savedSuccessor));

  const enqueuedOldRevision = await runtime.handle({
    version: 1,
    id: "lineage-enqueue-after-edit",
    kind: "publication.enqueue",
    revisionId: original.id,
    revisionHash: originalHash,
    previewHash,
    idempotencyKey: "lineage-enqueue-after-edit-key",
    expectedVersion: 6
  });
  assert.equal(enqueuedOldRevision.ok, false, JSON.stringify(enqueuedOldRevision));
  assert.match(String(enqueuedOldRevision.message), /REVISION_SUPERSEDED/u);

  const previewedOldRevision = await runtime.handle({
    version: 1,
    id: "lineage-preview-after-edit",
    kind: "publication.preview",
    revisionId: original.id,
    revisionHash: originalHash,
    expectedVersion: 6,
    idempotencyKey: "lineage-preview-after-edit-key",
    payload: previewPayload
  });
  assert.equal(previewedOldRevision.ok, false, JSON.stringify(previewedOldRevision));
  assert.match(String(previewedOldRevision.message), /REVISION_SUPERSEDED/u);
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
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false,
    nativePublicationBroker: true
  });
  t.after(() => runtime.close());
  const currentVersion = async (suffix: string): Promise<number> => {
    const state = await runtime.handle({ version: 1, id: `enqueue-state-${suffix}`, kind: "state", afterCursor: 0 });
    return (state.snapshot as { serverCursor: number }).serverCursor;
  };

  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, 0, "enqueue-save"));
  await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(expectedRevision.qualityGates)
  }, 1, "enqueue-approve"));
  const connectorPolicySaved = await runtime.handle(command("LOCAL_STATE.SET", {
    key: "desktop.connectors",
    value: {
      deploy: { workflowName: "deploy.yml", requiredChecks: ["build", "test / windows"] }
    }
  }, 2, "enqueue-connector-policy"));
  assert.equal(connectorPolicySaved.ok, true, JSON.stringify(connectorPolicySaved));
  const preview = await runtime.handle({
    version: 1,
    id: "enqueue-preview",
    kind: "publication.preview",
    revisionId: expectedRevision.id,
    revisionHash,
    expectedVersion: 3,
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

  const pausedEnqueue = await runtime.handle({
    version: 1,
    id: "enqueue-publication-while-paused",
    kind: "publication.enqueue",
    revisionId: expectedRevision.id,
    revisionHash,
    previewHash,
    idempotencyKey: "enqueue-publication-paused-key",
    expectedVersion: await currentVersion("paused-enqueue")
  });
  assert.equal(pausedEnqueue.ok, false, JSON.stringify(pausedEnqueue));
  assert.equal(pausedEnqueue.code, "PUBLISHING_PAUSED");

  const unpaused = await runtime.handle(command("AUTOMATION.SET", {
    settings: {
      mode: "PUBLISH_APPROVED",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: false,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    }
  }, await currentVersion("unpause"), "enqueue-unpause"));
  assert.equal(unpaused.ok, true, JSON.stringify(unpaused));

  const enqueued = await Promise.race([
    runtime.handle({
      version: 1,
      id: "enqueue-publication",
      kind: "publication.enqueue",
      revisionId: expectedRevision.id,
      revisionHash,
      previewHash,
      idempotencyKey: "enqueue-publication-key",
      expectedVersion: await currentVersion("enqueue")
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PUBLICATION_ENQUEUE_TIMEOUT")), 1_000))
  ]);
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  const effectId = (enqueued.value as { id: string }).id;
  const [claimed, concurrentClaim] = await Promise.all([
    runtime.handle({
      version: 1,
      id: "claim-native-publication",
      kind: "publication.broker.claim",
      effectId
    }),
    runtime.handle({
      version: 1,
      id: "concurrent-native-publication-claim",
      kind: "publication.broker.claim",
      effectId
    })
  ]);
  const successfulClaim = claimed.ok ? claimed : concurrentClaim;
  const rejectedClaim = claimed.ok ? concurrentClaim : claimed;
  assert.equal(successfulClaim.ok, true, JSON.stringify(successfulClaim));
  const claim = successfulClaim.value as {
    effectId: string;
    claimAttempt: number;
    approvedFilesSha: string;
    requiredChecks: string[];
    deployWorkflow: string;
    adapterVersion: string;
    bundlePolicy: {
      adapterId: string;
      manifestPath: string;
      allowedPathPrefixes: string[];
    };
    files: Array<{ path: string; content: string | Uint8Array }>;
  };
  assert.equal(claim.effectId, effectId);
  assert.equal(claim.claimAttempt, 1);
  assert.equal("priorResultRef" in (successfulClaim.value as Record<string, unknown>), false);
  const approvedFilesDigest = createHash("sha256");
  for (const file of [...claim.files].sort((left, right) => left.path.localeCompare(right.path))) {
    const content = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : Buffer.from(file.content);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(content.byteLength));
    approvedFilesDigest.update(file.path, "utf8").update(Buffer.from([0])).update(size).update(content);
  }
  assert.equal(claim.approvedFilesSha, approvedFilesDigest.digest("hex"));
  assert.equal(claim.adapterVersion, expectedRevision.adapterVersion);
  assert.deepEqual(claim.requiredChecks, expectedRevision.requiredChecks);
  assert.equal(claim.deployWorkflow, expectedRevision.deployWorkflow);
  assert.deepEqual(claim.bundlePolicy, {
    adapterId: "test",
    manifestPath,
    allowedPathPrefixes: [...files.map((file) => file.path), manifestPath]
  });
  assert.equal("token" in (successfulClaim.value as Record<string, unknown>), false);
  assert.equal(rejectedClaim.ok, false);
  assert.equal(rejectedClaim.code, "PUBLICATION_EFFECT_NOT_CLAIMABLE");
  const duplicateClaim = await runtime.handle({
    version: 1,
    id: "duplicate-native-publication-claim",
    kind: "publication.broker.claim",
    effectId
  });
  assert.equal(duplicateClaim.ok, false);
  assert.equal(duplicateClaim.code, "PUBLICATION_EFFECT_NOT_CLAIMABLE");
  const priorResultRef = "p".repeat(600);
  const waiting = await runtime.handle({
    version: 1,
    id: "wait-native-publication",
    kind: "publication.broker.complete",
    effectId,
    claimAttempt: claim.claimAttempt,
    state: "UNKNOWN",
    resultRef: priorResultRef,
    lastError: "GITHUB_REQUIRED_CHECKS_PENDING",
    retryAfterMs: 50
  });
  assert.equal(waiting.ok, true, JSON.stringify(waiting));
  const waitingEffect = waiting.value as { state: string; resultRef?: string; lastError?: string; nextAttemptAt?: string };
  assert.equal(waitingEffect.state, "UNKNOWN");
  assert.equal(waitingEffect.resultRef, priorResultRef.slice(0, 512));
  assert.equal(waitingEffect.lastError, "GITHUB_REQUIRED_CHECKS_PENDING");
  assert.ok(Number.isFinite(Date.parse(waitingEffect.nextAttemptAt ?? "")));

  const notDue = await runtime.handle({
    version: 1,
    id: "pending-native-publication-not-due",
    kind: "publication.broker.pending"
  });
  assert.deepEqual((notDue.value as { effectIds: string[] }).effectIds, []);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const due = await runtime.handle({
    version: 1,
    id: "pending-native-publication-due",
    kind: "publication.broker.pending"
  });
  assert.deepEqual((due.value as { effectIds: string[] }).effectIds, [effectId]);

  const paused = await runtime.handle(command("AUTOMATION.SET", {
    settings: {
      mode: "PUBLISH_APPROVED",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: true,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    }
  }, await currentVersion("pause-retry"), "enqueue-pause-retry"));
  assert.equal(paused.ok, true, JSON.stringify(paused));
  const pendingWhilePaused = await runtime.handle({
    version: 1,
    id: "pending-native-publication-paused",
    kind: "publication.broker.pending"
  });
  assert.deepEqual((pendingWhilePaused.value as { effectIds: string[] }).effectIds, []);
  const reclaimWhilePaused = await runtime.handle({
    version: 1,
    id: "reclaim-native-publication-paused",
    kind: "publication.broker.claim",
    effectId
  });
  assert.equal(reclaimWhilePaused.ok, false, JSON.stringify(reclaimWhilePaused));
  assert.equal(reclaimWhilePaused.code, "PUBLISHING_PAUSED");
  const resumed = await runtime.handle(command("AUTOMATION.SET", {
    settings: {
      mode: "PUBLISH_APPROVED",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: false,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    }
  }, await currentVersion("resume-retry"), "enqueue-resume-retry"));
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const pendingAfterResume = await runtime.handle({
    version: 1,
    id: "pending-native-publication-resumed",
    kind: "publication.broker.pending"
  });
  assert.deepEqual((pendingAfterResume.value as { effectIds: string[] }).effectIds, [effectId]);

  const reclaimed = await runtime.handle({
    version: 1,
    id: "reclaim-native-publication",
    kind: "publication.broker.claim",
    effectId
  });
  assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
  const reclaimedValue = reclaimed.value as { priorResultRef?: string; claimAttempt: number };
  assert.equal(reclaimedValue.priorResultRef, priorResultRef.slice(0, 512));
  assert.equal(reclaimedValue.claimAttempt, 2);
  const staleCompletion = await runtime.handle({
    version: 1,
    id: "stale-native-publication-complete",
    kind: "publication.broker.complete",
    effectId,
    claimAttempt: claim.claimAttempt,
    state: "SUCCEEDED",
    resultRef: "merge:stale"
  });
  assert.equal(staleCompletion.ok, false);
  assert.equal(staleCompletion.code, "INVALID_PUBLICATION_BROKER_RESULT");
  const completed = await runtime.handle({
    version: 1,
    id: "complete-native-publication",
    kind: "publication.broker.complete",
    effectId,
    claimAttempt: reclaimedValue.claimAttempt,
    state: "SUCCEEDED",
    resultRef: "merge:fake-native"
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const persisted = (await runtime.handle({ version: 1, id: "enqueue-state", kind: "state", afterCursor: 0 })).snapshot as { outbox: Array<{ aggregateId: string; state: string; resultRef?: string; nextAttemptAt?: string }> };
  const savedEffect = persisted.outbox.find((effect) => effect.aggregateId === expectedRevision.id);
  assert.equal(savedEffect?.state, "SUCCEEDED");
  assert.equal(savedEffect?.resultRef, "merge:fake-native");
  assert.equal(savedEffect?.nextAttemptAt, undefined);
});

test("a substituted preview payload cannot be claimed and terminates the outbox effect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-publication-claim-binding-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    { path: "content/tr/claim.md", content: "onaylı Türkçe içerik\n" },
    { path: "content/en/claim.md", content: "approved English content\n" }
  ];
  const expectedRevision = revision({
    id: "revision-claim-binding",
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
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false,
    nativePublicationBroker: true
  });
  t.after(() => runtime.close());
  const currentVersion = async (suffix: string): Promise<number> => {
    const state = await runtime.handle({ version: 1, id: `claim-binding-state-${suffix}`, kind: "state", afterCursor: 0 });
    return (state.snapshot as { serverCursor: number }).serverCursor;
  };

  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, await currentVersion("save"), "claim-binding-save"));
  await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(expectedRevision.qualityGates)
  }, await currentVersion("approve"), "claim-binding-approve"));
  await runtime.handle(command("LOCAL_STATE.SET", {
    key: "desktop.connectors",
    value: { deploy: { workflowName: "deploy.yml", requiredChecks: ["build"] } }
  }, await currentVersion("policy"), "claim-binding-policy"));
  const unpaused = await runtime.handle(command("AUTOMATION.SET", {
    settings: {
      mode: "PUBLISH_APPROVED",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: false,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    }
  }, await currentVersion("unpause"), "claim-binding-unpause"));
  assert.equal(unpaused.ok, true, JSON.stringify(unpaused));
  const previewFiles = [
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
  ];
  const preview = await runtime.handle({
    version: 1,
    id: "claim-binding-preview",
    kind: "publication.preview",
    revisionId: expectedRevision.id,
    revisionHash,
    expectedVersion: await currentVersion("preview"),
    idempotencyKey: "claim-binding-preview-key",
    payload: {
      targetRepository: "owner/site",
      baseBranch: "main",
      siteOrigin: "",
      contentRoot: "C:\\Blogbot-Test",
      now: "2026-07-30T12:00:00.000Z",
      files: previewFiles,
      bundlePolicy: {
        adapterId: "test",
        manifestPath,
        allowedPathPrefixes: ["content/", ".blogbot/manifests/"],
        requiredLocalePrefixes: ["content/tr/", "content/en/"]
      }
    }
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const previewHash = (preview.value as { previewHash: string }).previewHash;
  const enqueued = await runtime.handle({
    version: 1,
    id: "claim-binding-enqueue",
    kind: "publication.enqueue",
    revisionId: expectedRevision.id,
    revisionHash,
    previewHash,
    idempotencyKey: "claim-binding-enqueue-key",
    expectedVersion: await currentVersion("enqueue")
  });
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  const effectId = (enqueued.value as { id: string }).id;

  // The stored preview row is ordinary local state, and both hashes are readable
  // by any protocol caller. Substituting the reviewed bytes while keeping the
  // hashes and expiry intact must not produce a publishable claim.
  const substituted = await runtime.handle(command("LOCAL_STATE.SET", {
    key: `publication.preview:${expectedRevision.id}`,
    value: {
      previewHash,
      revisionHash,
      expiresAtUnixMs: Date.now() + 60 * 60 * 1_000,
      payload: {
        requiredChecks: ["build"],
        deployWorkflow: "deploy.yml",
        files: [
          { path: files[0]!.path, content: "gözden geçirilmemiş içerik\n" },
          files[1]!,
          previewFiles[2]!
        ]
      }
    }
  }, await currentVersion("substitute"), "claim-binding-substitute"));
  assert.equal(substituted.ok, true, JSON.stringify(substituted));

  const claimed = await runtime.handle({
    version: 1,
    id: "claim-binding-claim",
    kind: "publication.broker.claim",
    effectId
  });
  assert.equal(claimed.ok, false, JSON.stringify(claimed));
  assert.equal(claimed.code, "PUBLICATION_EFFECT_STALE");

  // A mismatched preview cannot be published without a new preview, so the row
  // must record that reason instead of being reclaimed on every drainer tick.
  const persisted = (await runtime.handle({ version: 1, id: "claim-binding-outbox", kind: "state", afterCursor: 0 }))
    .snapshot as { outbox: Array<{ id: string; state: string; lastError?: string }> };
  const savedEffect = persisted.outbox.find((effect) => effect.id === effectId);
  assert.equal(savedEffect?.state, "FAILED");
  assert.equal(savedEffect?.lastError, "PUBLICATION_EFFECT_STALE");
  const pending = await runtime.handle({ version: 1, id: "claim-binding-pending", kind: "publication.broker.pending" });
  assert.deepEqual((pending.value as { effectIds: string[] }).effectIds, []);
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

test("the shipped native-broker engine really schedules a due approved revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-scheduled-publication-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    { path: "content/tr/scheduled.md", content: "planlı Türkçe içerik\n" },
    { path: "content/en/scheduled.md", content: "scheduled English content\n" }
  ];
  const expectedRevision = revision({
    id: "revision-scheduled-publication",
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

  // These are exactly the options `runStdioEngine` ships with, plus a short
  // poll so the test does not wait a full minute for the first tick.
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceScheduler: true,
    startPublicationScheduler: true,
    nativePublicationBroker: true,
    publicationSchedulerPollMs: 25
  });
  t.after(() => runtime.close());

  // Every accepted mutation advances the optimistic version by one.
  let version = 0;
  const nextVersion = (): number => version++;

  const automation = await runtime.handle(command("AUTOMATION.SET", {
    settings: {
      mode: "PUBLISH_APPROVED",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: false,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    }
  }, nextVersion(), "scheduled-automation"));
  assert.equal(automation.ok, true, JSON.stringify(automation));

  const saved = await runtime.handle(
    command("REVISION.SAVE", { revision: expectedRevision }, nextVersion(), "scheduled-save")
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const approved = await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(expectedRevision.qualityGates)
  }, nextVersion(), "scheduled-approve"));
  assert.equal(approved.ok, true, JSON.stringify(approved));

  const connectorPolicy = await runtime.handle(command("LOCAL_STATE.SET", {
    key: "desktop.connectors",
    value: {
      deploy: { workflowName: "deploy.yml", requiredChecks: ["build", "test / windows"] }
    }
  }, nextVersion(), "scheduled-connector-policy"));
  assert.equal(connectorPolicy.ok, true, JSON.stringify(connectorPolicy));

  const preview = await runtime.handle({
    version: 1,
    id: "scheduled-preview",
    kind: "publication.preview",
    revisionId: expectedRevision.id,
    revisionHash,
    expectedVersion: nextVersion(),
    idempotencyKey: "scheduled-preview-key",
    payload: {
      targetRepository: "owner/site",
      baseBranch: "main",
      siteOrigin: "",
      contentRoot: "C:\\Blogbot-Test",
      now: new Date().toISOString(),
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
  assert.equal(preview.ok, true, JSON.stringify(preview));

  // No manual `publication.enqueue`: the durable scheduler must claim the due
  // approved revision on its own, or scheduled publishing does not exist for a
  // real user.
  const deadline = Date.now() + 10_000;
  let pending: string[];
  for (;;) {
    const response = await runtime.handle({
      version: 1,
      id: "scheduled-pending",
      kind: "publication.broker.pending"
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    pending = ((response.value as { effectIds?: unknown }).effectIds ?? []) as string[];
    if (pending.length > 0 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(pending.length, 1, "the publication scheduler never enqueued the due approved revision");
});

test("the reported state version stays usable after more changes than one dashboard page", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-state-version-page-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false
  });
  t.after(() => runtime.close());

  // The desktop reads state with a bounded change page (changeLimit 50). Once a
  // normal workspace has produced more changes than fit in one page, the value
  // it uses as `expectedVersion` must still be the engine's optimistic version.
  const pageSize = 50;
  const mutations = pageSize + 10;
  for (let index = 0; index < mutations; index += 1) {
    const applied = await runtime.handle(command(
      "LOCAL_STATE.SET",
      { key: "desktop.editorial", value: { counter: index } },
      index,
      `bulk-${index}`
    ));
    assert.equal(applied.ok, true, JSON.stringify(applied));
  }

  const state = await runtime.handle({
    version: 1,
    id: "desktop-state",
    kind: "state",
    afterCursor: 0,
    changeLimit: pageSize
  });
  assert.equal(state.ok, true, JSON.stringify(state));
  const snapshot = state.snapshot as { serverCursor: number; changes: unknown[] };
  assert.equal(snapshot.changes.length, pageSize, "the change page must really be capped");

  const afterPage = await runtime.handle(command(
    "LOCAL_STATE.SET",
    { key: "desktop.editorial", value: { counter: "after-page" } },
    snapshot.serverCursor,
    "after-page"
  ));
  assert.equal(
    afterPage.ok,
    true,
    `a mutation using the reported state version must not fail: ${JSON.stringify(afterPage)}`
  );
});

test("regenerating an identical publication preview is idempotent instead of permanently rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-preview-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    { path: "content/tr/replay.md", content: "yeniden önizleme\n" },
    { path: "content/en/replay.md", content: "preview replay\n" }
  ];
  const expectedRevision = revision({
    id: "revision-preview-replay",
    targetRepository: "owner/site",
    adapterVersion: "test@1",
    generatedFiles: files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
      size: Buffer.byteLength(file.content)
    }))
  });
  const revisionHash = computeRevisionHash(expectedRevision);
  const manifestPath = `.blogbot/manifests/${expectedRevision.id}.json`;
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    startSourceWorker: false,
    nativePublicationBroker: true
  });
  t.after(() => runtime.close());

  await runtime.handle(command("REVISION.SAVE", { revision: expectedRevision }, 0, "replay-save"));
  await runtime.handle(command("APPROVAL.GRANT", {
    revisionId: expectedRevision.id,
    revisionHash,
    deviceId: "windows-local-device-v1",
    warningSetHash: computeWarningSetHash(expectedRevision.qualityGates)
  }, 1, "replay-approve"));
  await runtime.handle(command("LOCAL_STATE.SET", {
    key: "desktop.connectors",
    value: { deploy: { workflowName: "deploy.yml", requiredChecks: ["build"] } }
  }, 2, "replay-connector-policy"));

  const payload = {
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
  };

  // The desktop derives this key from the revision and payload only, so the
  // second attempt reuses it while the engine version has moved on.
  const preview = (expectedVersion: number) => runtime.handle({
    version: 1,
    id: "replay-preview",
    kind: "publication.preview",
    revisionId: expectedRevision.id,
    revisionHash,
    expectedVersion,
    idempotencyKey: "replay-preview-key",
    payload
  });

  const first = await preview(3);
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await preview(4);
  assert.equal(
    second.ok,
    true,
    `regenerating the same preview must not be permanently rejected: ${JSON.stringify(second)}`
  );
  assert.equal(
    (second.value as { previewHash: string }).previewHash,
    (first.value as { previewHash: string }).previewHash
  );
});
