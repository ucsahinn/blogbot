import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { createEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import {
  computeEditorialAttestationHash,
  computeRevisionHash,
  computeWarningSetHash,
  validateRevisionPackageV3,
  type ApprovalV3,
  type RevisionPackageV2,
  type RevisionPackageV3
} from "../../packages/editorial/src/revision.ts";
import type { EditorialApprovalAttestationV3 } from "../../packages/editorial/src/quality-gates.ts";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function v3Revision(): RevisionPackageV3 {
  const anchor = { sourceId: "source-1", quoteHash: "a".repeat(64), start: 0, end: 20 };
  const instruction = "Doğrulanmış kaynaklardan özgün ve iki dilli haber üret.";
  const gates = [
    { id: "claims", group: "editorial", state: "PASS", detail: "Kanıt bağlı.", policyVersion: "2", reasonCode: "CHECKED" },
    { id: "contradictions", group: "editorial", state: "PASS", detail: "Çelişki yok.", policyVersion: "2", reasonCode: "CHECKED" },
    { id: "bilingual-parity", group: "editorial", state: "PASS", detail: "Parite hazır.", policyVersion: "2", reasonCode: "CHECKED" },
    { id: "markdown-safety", group: "security", state: "PASS", detail: "Markdown güvenli.", policyVersion: "2", reasonCode: "CHECKED" },
    { id: "seo", group: "seo", state: "PASS", detail: "SEO hazır.", policyVersion: "2", reasonCode: "CHECKED" },
    { id: "media", group: "media", state: "PASS", detail: "Medya hazır.", policyVersion: "2", reasonCode: "CHECKED" },
    { id: "editorial-policy", group: "editorial", state: "PASS", detail: "V3 politika hazır.", policyVersion: "3", reasonCode: "CHECKED" }
  ] as RevisionPackageV3["qualityGates"];
  const revision: RevisionPackageV3 = {
    id: "revision-v3-approval",
    translationKey: "story-v3-approval",
    state: "REVIEW_REQUIRED",
    tr: { title: "Doğrulanmış güvenlik haberi", slug: "dogrulanmis-guvenlik-haberi", description: "Doğrulanmış gelişmenin özgün özeti.", bodyMarkdown: "## Özet\n\nDoğrulanmış gelişme [kaynakta](https://example.com/report) yer alıyor.", heroImageAlt: "Soyut güvenlik kapağı" },
    en: { title: "Verified security news", slug: "verified-security-news", description: "An original account of the verified development.", bodyMarkdown: "## Summary\n\nThe verified development appears in the [source](https://example.com/report).", heroImageAlt: "Abstract security cover" },
    section: "haberler",
    articleType: "news",
    author: "Yerel Editör",
    tags: ["güvenlik"],
    claims: [{ id: "claim-1", locale: "both", text: "Gelişme doğrulandı.", sourceIds: ["source-1"], status: "VERIFIED", claimKey: "claim.verified", trText: "Gelişme doğrulandı.", enText: "The development was verified.", evidenceAnchors: [anchor] }],
    sources: [{ id: "source-1", url: "https://example.com/report", title: "Official report", fetchedAt: "2026-08-20T08:00:00.000Z", contentHash: "b".repeat(64), evidenceAnchors: [anchor], trustStatus: "APPROVED", rightsStatus: "APPROVED" }],
    media: [{ role: "hero", path: "verified-security-16x9.webp", sha256: "c".repeat(64), width: 1600, height: 900, byteSize: 1_024 }],
    scheduledAt: "2026-08-20T12:00:00.000Z",
    adapterVersion: "astro-generic@2",
    editorialDesk: "Blogbot Editorial Desk",
    riskLevel: "STANDARD",
    translationParity: { status: "MATCHED", reportHash: "d".repeat(64) },
    editorialPolicyHash: "e".repeat(64),
    editorialReviewReportHash: "f".repeat(64),
    targetRepository: "owner/site",
    targetBaseBranch: "main",
    targetBaseSha: "1".repeat(40),
    generatedFiles: [
      { path: "src/content/articles/tr/haberler/dogrulanmis-guvenlik-haberi.md", sha256: "2".repeat(64), size: 1_024 },
      { path: "src/content/articles/en/news/verified-security-news.md", sha256: "3".repeat(64), size: 960 }
    ],
    qualityGates: gates,
    packageVersion: 3,
    editorialContext: { instruction, instructionHash: sha256(instruction), contentOrigin: "CODEX_ASSISTED", aiDisclosure: "GENERATED_WITH_AI" },
    editorialAssessment: {
      articleType: "news", intentSatisfied: true, titleIsHonest: true, originalValuePresent: true, allClaimsVerified: true,
      sources: [{ sourceId: "source-1", cited: true, official: true, role: "primary" }],
      singleOfficialSourceRationale: "Bu olay için tek yetkili ve birincil kayıt budur.",
      authorTransparent: true, aiDisclosureMatchesUsage: true, isYmyl: false, leadHasFiveWOneH: true,
      unverifiedClaimsClearlyLabeled: true, newsSchemaComplete: true, sensitiveTopic: false,
      clusterKey: null, aboveFoldAnswersIntent: true, headingHierarchyValid: true,
      internalLinkCount: 0, internalLinkOmissionRationale: null
    },
    publicationSources: [{ id: "source-1", title: "Official report", url: "https://example.com/report", role: "primary" }],
    deployWorkflow: "deploy.yml",
    requiredChecks: ["ci/test"]
  };
  assert.equal(validateRevisionPackageV3(revision), true);
  return revision;
}

const attestation: EditorialApprovalAttestationV3 = {
  editorialReview: { reviewer: "Ulaş Şahin", sourceRoles: [{ sourceId: "source-1", role: "primary" }] },
  expertReview: null,
  ethicsReview: null
};

function approvalCommand(revision: RevisionPackageV2 | RevisionPackageV3, expectedVersion: number, payload: Record<string, unknown>) {
  return {
    version: 1, id: `envelope-${revision.id}`, kind: "command",
    command: {
      version: 1, requestId: `request-${revision.id}`, idempotencyKey: `key-${revision.id}`,
      expectedVersion, kind: "APPROVAL.GRANT",
      payload: {
        revisionId: revision.id,
        revisionHash: computeRevisionHash(revision),
        deviceId: "windows-local-device-v1",
        warningSetHash: computeWarningSetHash(revision.qualityGates),
        ...payload
      }
    }
  };
}

test("engine stores a V3 human attestation and its engine-computed hash", async () => {
  const repository = new InMemoryBackendStore();
  const revision = v3Revision();
  await repository.insertRevision(revision);
  const handle = createEngineProtocol(repository);

  const response = await handle(approvalCommand(revision, 1, { packageVersion: 3, attestation }));

  assert.equal(response.ok, true, JSON.stringify(response));
  const saved = await repository.getApproval(revision.id) as ApprovalV3;
  assert.equal(saved.packageVersion, 3);
  assert.deepEqual(saved.attestation, attestation);
  assert.equal(saved.attestationHash, computeEditorialAttestationHash(attestation));
});

test("engine refuses to create a new legacy V2 approval", async () => {
  const repository = new InMemoryBackendStore();
  const value = structuredClone(v3Revision()) as RevisionPackageV3 & Record<string, unknown>;
  for (const key of ["packageVersion", "editorialContext", "editorialAssessment", "publicationSources", "deployWorkflow", "requiredChecks"]) delete value[key];
  value.qualityGates = (value.qualityGates as RevisionPackageV3["qualityGates"]).filter((gate) => gate.id !== "editorial-policy");
  value.id = "revision-v2-upgrade-required";
  const legacy = value as unknown as RevisionPackageV2;
  await repository.insertRevision(legacy);
  const response = await createEngineProtocol(repository)(approvalCommand(legacy, 1, {}));

  assert.equal(response.ok, false);
  assert.equal((response.result as { error: { code: string } }).error.code, "REVISION_REVIEW_UPGRADE_REQUIRED");
  assert.equal(await repository.getApproval(legacy.id), null);
});

test("engine revocation is exact-hash bound, idempotent, and recalls unclaimed publication effects", async () => {
  const repository = new InMemoryBackendStore();
  const revision = v3Revision();
  await repository.insertRevision(revision);
  const handle = createEngineProtocol(repository, "memory", { nativePublicationBroker: true });
  const revisionHash = computeRevisionHash(revision);
  const approved = await handle(approvalCommand(revision, 1, { packageVersion: 3, attestation }));
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const effect = await repository.enqueuePublication(revision.id, revisionHash, {
    previewHash: "9".repeat(64),
    targetRepository: revision.targetRepository,
    baseBranch: revision.targetBaseBranch,
    targetBaseSha: revision.targetBaseSha,
    adapterVersion: revision.adapterVersion
  });
  const expectedVersion = await repository.getVersion();
  const revoke = {
    version: 1,
    id: "revoke-envelope",
    kind: "command",
    command: {
      version: 1,
      requestId: "revoke-request",
      idempotencyKey: "revoke-key",
      expectedVersion,
      kind: "APPROVAL.REVOKE",
      payload: {
        revisionId: revision.id,
        revisionHash,
        deviceId: "windows-local-device-v1",
        reason: "Editorial approval withdrawn before publication"
      }
    }
  };

  const response = await handle(revoke);
  assert.equal(response.ok, true, JSON.stringify(response));
  const revocation = await repository.getApprovalRevocation(revision.id);
  assert.equal(revocation?.revisionHash, revisionHash);
  assert.equal(revocation?.reason, revoke.command.payload.reason);
  const projected = await handle({
    version: 1,
    id: "get-revoked-revision",
    kind: "command",
    command: {
      version: 1,
      requestId: "get-revoked-revision",
      idempotencyKey: "get-revoked-revision",
      expectedVersion: await repository.getVersion(),
      kind: "REVISION.GET",
      payload: { revisionId: revision.id }
    }
  });
  assert.equal(projected.ok, true, JSON.stringify(projected));
  assert.equal((projected.result as { value: { editorialApproval: unknown } }).value.editorialApproval, null);
  const recalled = (await repository.listOutbox()).find((item) => item.id === effect.id);
  assert.equal(recalled?.state, "FAILED");
  assert.equal(recalled?.lastError, "APPROVAL_REVOKED");

  const replay = await handle({ ...revoke, id: "revoke-replay" });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.deepEqual(replay.result, response.result);
  await repository.setAutomation({ ...(await repository.getAutomation()), publishingPaused: false });
  const claim = await handle({ version: 1, id: "claim-revoked", kind: "publication.broker.claim", effectId: effect.id });
  assert.equal(claim.ok, false);
  assert.equal(claim.code, "PUBLICATION_EFFECT_NOT_CLAIMABLE");
  const preview = await handle({
    version: 1,
    id: "preview-revoked",
    kind: "publication.preview",
    revisionId: revision.id,
    revisionHash,
    idempotencyKey: "preview-revoked-key",
    expectedVersion: await repository.getVersion(),
    payload: {}
  });
  assert.equal(preview.ok, false);
  assert.equal(preview.code, "APPROVAL_REVOKED");
  const enqueue = await handle({
    version: 1,
    id: "enqueue-revoked",
    kind: "publication.enqueue",
    revisionId: revision.id,
    revisionHash,
    previewHash: "8".repeat(64),
    idempotencyKey: "enqueue-revoked-key",
    expectedVersion: await repository.getVersion()
  });
  assert.equal(enqueue.ok, false);
  assert.equal(enqueue.code, "APPROVAL_REVOKED");

  const reapproveCommand = approvalCommand(revision, await repository.getVersion(), { packageVersion: 3, attestation });
  reapproveCommand.command.idempotencyKey = "reapprove-after-revocation";
  const reapprove = await handle(reapproveCommand);
  assert.equal(reapprove.ok, false);
  assert.equal((reapprove.result as { error: { code: string } }).error.code, "APPROVAL_REVOKED");
});
