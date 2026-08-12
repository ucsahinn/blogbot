import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createDraftCodexTaskResolver,
  draftLengthRequirements,
  finalizeReviewedRevision,
  isFinalReviewCodexOutput,
  isDraftCodexOutput,
  materializeDraftRevision,
  normalizeDraftCodexOutput,
  type DraftCodexOutput
} from "../../apps/engine/src/codex-draft.ts";
import { assertRevisionGeneratedFilesMatch, fallbackDraftSourceEvidence } from "../../apps/engine/src/stdio-entrypoint.ts";
import { evaluateSourcePolicy, validateClaimEvidence, validateRevisionPackageV2 } from "../../packages/editorial/src/revision.ts";
import { astroGenericAdapter } from "../../packages/site-adapter/src/astro-generic.ts";

const draft: DraftCodexOutput = {
  translationKey: "ornek",
  author: "Editör",
  tags: ["örnek"],
  tr: { title: "Türkçe başlık", slug: "turkce-baslik", description: "Türkçe açıklama", bodyMarkdown: "Gövde.", heroImageAlt: "Görsel" },
  en: { title: "English title", slug: "english-title", description: "English description", bodyMarkdown: "Body.", heroImageAlt: "Visual" },
  claims: [{ claimKey: "c1", trText: "Doğrulanan iddia", enText: "Verified claim", sourceIds: ["s1"], status: "VERIFIED", quoteHash: "a".repeat(64) }]
};

const review = {
  translationParity: { status: "MATCHED" as const, detail: "İddialar iki dilde eşleşiyor." },
  riskLevel: "STANDARD" as const,
  gates: [
    { id: "claims", group: "editorial" as const, state: "PASS" as const, reasonCode: "CHECKED", detail: "İddialar kanıta bağlı." },
    { id: "contradictions", group: "editorial" as const, state: "PASS" as const, reasonCode: "CHECKED", detail: "Çelişki bulunmadı." },
    { id: "bilingual-parity", group: "editorial" as const, state: "PASS" as const, reasonCode: "CHECKED", detail: "Parite doğrulandı." },
    { id: "markdown-safety", group: "security" as const, state: "PASS" as const, reasonCode: "CHECKED", detail: "Markdown güvenli." },
    { id: "seo", group: "seo" as const, state: "PASS" as const, reasonCode: "CHECKED", detail: "Başlık ve açıklamalar uygun." },
    { id: "media", group: "media" as const, state: "PASS" as const, reasonCode: "CHECKED", detail: "Medya gerekmiyor." }
  ]
};

test("final review is a separate DEEP_REVIEW task with a strict output contract", async () => {
  const resolver = createDraftCodexTaskResolver();
  const task = await resolver.resolve({ jobId: "r:review", idempotencyKey: "k", definitionId: "REVISION.FINAL_REVIEW", payload: { draft }, state: "RUNNING", version: 1 });
  assert.equal(task.taskKind, "FINAL_QUALITY");
  assert.match(
    String((task.input as { policy?: unknown }).policy),
    /SEO gate: block only for a concrete, remediable article defect/u
  );
  assert.equal(isFinalReviewCodexOutput(review), true);
  assert.equal(isFinalReviewCodexOutput({ ...review, gates: review.gates.slice(1) }), false);
});

test("draft tasks retain substantial selected-source context without exposing an unbounded body", async () => {
  const resolver = createDraftCodexTaskResolver();
  const evidenceText = "Kanıt cümlesi. ".repeat(1_000);
  const task = await resolver.resolve({
    jobId: "r:source-context",
    idempotencyKey: "source-context",
    definitionId: "DRAFT.CREATE",
    payload: {
      sources: [{
        id: "source-1",
        title: "Birincil kaynak",
        url: "https://example.org/source",
        evidenceText
      }]
    },
    state: "RUNNING",
    version: 1
  });
  const sources = ((task.input as { task?: { sources?: Array<{ excerpt?: string }> } }).task?.sources);
  assert.equal(sources?.[0]?.excerpt, evidenceText.slice(0, 12_000));
  assert.equal(sources?.[0]?.excerpt?.length, 12_000);
});

test("standard drafts keep a quality floor even when one selected source is brief", () => {
  const requirements = draftLengthRequirements({
    articleType: "news",
    sources: [{ evidenceText: "Kısa ama doğrulanmış kanıt." }]
  });

  assert.equal(requirements.trMinimumWords, 700);
  assert.equal(requirements.enMinimumWords, 595);
});

test("draft tasks reject a teaser when the selected evidence supports a full standard article", async () => {
  const resolver = createDraftCodexTaskResolver();
  const task = await resolver.resolve({
    jobId: "r:substantial-news",
    idempotencyKey: "substantial-news",
    definitionId: "DRAFT.CREATE",
    payload: {
      articleType: "news",
      sources: [{
        id: "source-1",
        title: "Uzun kanıt",
        url: "https://example.org/source",
        evidenceText: "kanıt ".repeat(2_000)
      }]
    },
    state: "RUNNING",
    version: 1
  });
  const teaser = {
    ...draft,
    tr: { ...draft.tr, bodyMarkdown: "Türkçe ".repeat(699) },
    en: { ...draft.en, bodyMarkdown: "English ".repeat(699) }
  };
  const fullLength = {
    ...teaser,
    tr: { ...teaser.tr, bodyMarkdown: "Türkçe ".repeat(700) },
    en: { ...teaser.en, bodyMarkdown: "English ".repeat(700) }
  };

  assert.equal(task.validateOutput(teaser), false);
  assert.equal(task.validateOutput(fullLength), true);
});

test("draft output repair fills only derivable metadata before strict validation", () => {
  const repaired = normalizeDraftCodexOutput({
    translationKey: "ornek",
    author: "Editör",
    tags: ["haber"],
    tr: { title: "Yeni güvenlik gelişmesi", bodyMarkdown: "# Kısa açıklama\n\nDoğrulanmış içerik." },
    en: { title: "New security development", bodyMarkdown: "A short verified account." },
    claims: []
  });

  assert.equal(isDraftCodexOutput(repaired), true);
  assert.equal((repaired as DraftCodexOutput).tr.slug, "yeni-guvenlik-gelismesi");
  assert.match((repaired as DraftCodexOutput).tr.description, /Kısa açıklama/u);
  assert.match((repaired as DraftCodexOutput).en.heroImageAlt, /original cover image/u);
});

test("draft output with an unresolved empty evidence hash remains reviewable", () => {
  const unresolved = {
    ...draft,
    claims: [{
      ...draft.claims[0]!,
      status: "NEEDS_SOURCE" as const,
      quoteHash: ""
    }]
  };

  // The structured-output schema deliberately represents an absent evidence
  // hash as an empty string. It must produce a reviewable draft with the
  // evidence gate blocked, rather than leave the durable task waiting forever.
  assert.equal(isDraftCodexOutput(unresolved), true);
});

test("review completion creates an immutable V2 local package from checks that actually ran", () => {
  const base = materializeDraftRevision("r1", {
    sources: [{ id: "s1", url: "https://example.org/evidence", title: "Evidence", contentHash: "b".repeat(64), fetchedAt: "2026-08-02T00:00:00.000Z" }],
    scheduledAt: "2026-08-03T00:00:00.000Z"
  }, draft, "2026-08-02T00:00:00.000Z");
  const revision = finalizeReviewedRevision(base, review, undefined);

  assert.equal(validateRevisionPackageV2(revision), true);
  assert.equal(revision.translationParity.status, "MATCHED");
  assert.ok(revision.generatedFiles.some((file) => file.path === ".blogbot/generated/tr/haberler/turkce-baslik.md"));
  assert.equal(revision.qualityGates.some((gate) => gate.state === "NOT_RUN"), false);
});

test("final review permits only an explicitly coded SEO polish warning", () => {
  const quoteHash = "b".repeat(64);
  const base = materializeDraftRevision("r-review-warning", {
    sources: [{
      id: "s1",
      url: "https://example.org/evidence",
      title: "Evidence",
      contentHash: "c".repeat(64),
      fetchedAt: "2026-08-09T00:00:00.000Z",
      evidenceAnchors: [{ sourceId: "s1", quoteHash }]
    }],
    scheduledAt: "2026-08-10T00:00:00.000Z"
  }, draft, "2026-08-09T00:00:00.000Z");
  const modelReportedBlock = {
    ...review,
    gates: review.gates.map((gate) => gate.id === "seo"
      ? { ...gate, state: "WARN" as const, reasonCode: "SEO_POLISH", detail: "İç bağlantı önerisi eklenebilir." }
      : gate)
  };

  const revision = finalizeReviewedRevision(base, modelReportedBlock, undefined);

  assert.deepEqual(revision.qualityGates.find((gate) => gate.id === "seo"), {
    id: "seo",
    group: "seo",
    state: "WARN",
    reasonCode: "SEO_POLISH",
    detail: "İç bağlantı önerisi eklenebilir.",
    policyVersion: "2"
  });
});

test("final review never silently downgrades a structural SEO block", () => {
  const base = materializeDraftRevision("r-review-seo-block", {
    sources: [{
      id: "s1",
      url: "https://example.org/evidence",
      title: "Evidence",
      contentHash: "c".repeat(64),
      fetchedAt: "2026-08-09T00:00:00.000Z",
      evidenceAnchors: [{ sourceId: "s1", quoteHash: "b".repeat(64) }]
    }]
  }, draft, "2026-08-09T00:00:00.000Z");
  const modelReportedBlock = {
    ...review,
    gates: review.gates.map((gate) => gate.id === "seo"
      ? { ...gate, state: "BLOCK" as const, reasonCode: "SEO_STRUCTURAL_DEFECT", detail: "Başlık yapısı eksik." }
      : gate)
  };

  const revision = finalizeReviewedRevision(base, modelReportedBlock, undefined);

  assert.equal(revision.qualityGates.find((gate) => gate.id === "seo")?.state, "BLOCK");
});

test("final review never downgrades a missing hero image into an acknowledgeable warning", () => {
  const base = materializeDraftRevision("r-review-media-required", {
    sources: [{
      id: "s1",
      url: "https://example.org/evidence",
      title: "Evidence",
      contentHash: "c".repeat(64),
      fetchedAt: "2026-08-09T00:00:00.000Z",
      evidenceAnchors: [{ sourceId: "s1", quoteHash: "b".repeat(64) }]
    }]
  }, draft, "2026-08-09T00:00:00.000Z");

  const revision = finalizeReviewedRevision(base, review, undefined);
  assert.deepEqual(revision.qualityGates.find((gate) => gate.id === "media"), {
    id: "media",
    group: "media",
    state: "BLOCK",
    detail: "Zorunlu hero görseli üretilemedi veya yerel olarak doğrulanamadı.",
    policyVersion: "2",
    reasonCode: "HERO_MEDIA_REQUIRED"
  });
});

test("a finalized review package matches the publication preview file boundary", () => {
  const base = materializeDraftRevision("r-preview", {
    sources: [{ id: "s1", url: "https://example.org/evidence", title: "Evidence", contentHash: "b".repeat(64), fetchedAt: "2026-08-02T00:00:00.000Z" }],
    scheduledAt: "2026-08-03T00:00:00.000Z"
  }, draft, "2026-08-02T00:00:00.000Z");
  const revision = finalizeReviewedRevision(base, review, undefined);
  const generated = astroGenericAdapter.buildRevisionFiles({
    id: revision.id,
    revisionHash: "0".repeat(64),
    translationKey: revision.translationKey,
    tr: {
      ...revision.tr,
      section: revision.section,
      articleType: revision.articleType,
      authorId: revision.author,
      publishedAt: revision.scheduledAt,
      tags: revision.tags,
      sources: revision.sources
    },
    en: {
      ...revision.en,
      section: "news",
      articleType: revision.articleType,
      authorId: revision.author,
      publishedAt: revision.scheduledAt,
      tags: revision.tags,
      sources: revision.sources
    }
  }, { siteOrigin: "", repositoryPath: "", adapterId: astroGenericAdapter.id });
  const files = Object.entries(generated).map(([path, content]) => ({
    path: path.replace(/^src\/content\/articles\//u, ".blogbot/generated/"),
    content
  }));
  const manifestPath = `.blogbot/manifests/${revision.id}.json`;

  assert.doesNotThrow(() => assertRevisionGeneratedFilesMatch(revision, {
    files: [...files, { path: manifestPath, content: "{}" }],
    bundlePolicy: { manifestPath }
  }));

  assert.throws(() => assertRevisionGeneratedFilesMatch(revision, {
    files: [...files, { path: "package.json", content: "{}" }],
    bundlePolicy: { manifestPath: "package.json" }
  }), /APPROVAL_BOUND_FILE_SET_MISMATCH/u);
});

test("materialization applies the locally configured editorial author", () => {
  const revision = materializeDraftRevision(
    "r-preferences",
    {
      preferredAuthor: "Yerel Editorya",
      sources: [{ id: "s1", url: "https://example.org/evidence", title: "Evidence", contentHash: "b".repeat(64), fetchedAt: "2026-08-02T00:00:00.000Z" }]
    },
    draft,
    "2026-08-02T00:00:00.000Z"
  );
  assert.equal(revision.author, "Yerel Editorya");
});

test("materialization preserves approved source policy decisions for publication eligibility", () => {
  const revision = materializeDraftRevision(
    "r-approved-source-policy",
    {
      sources: [{
        id: "s1",
        url: "https://example.org/evidence",
        title: "Approved evidence",
        contentHash: "b".repeat(64),
        fetchedAt: "2026-08-02T00:00:00.000Z",
        trustStatus: "APPROVED",
        rightsStatus: "APPROVED"
      }]
    },
    draft,
    "2026-08-02T00:00:00.000Z"
  );

  assert.deepEqual(revision.sources[0], {
    id: "s1",
    url: "https://example.org/evidence",
    title: "Approved evidence",
    contentHash: "b".repeat(64),
    fetchedAt: "2026-08-02T00:00:00.000Z",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED"
  });
  assert.deepEqual(evaluateSourcePolicy(revision), { eligible: true });
});

test("materialization keeps pending source policy decisions fail-closed", () => {
  const revision = materializeDraftRevision(
    "r-pending-source-policy",
    {
      sources: [{
        id: "s1",
        url: "https://example.org/evidence",
        title: "Pending evidence",
        contentHash: "b".repeat(64),
        fetchedAt: "2026-08-02T00:00:00.000Z",
        trustStatus: "PENDING",
        rightsStatus: "PENDING"
      }]
    },
    draft,
    "2026-08-02T00:00:00.000Z"
  );

  assert.deepEqual(revision.sources[0], {
    id: "s1",
    url: "https://example.org/evidence",
    title: "Pending evidence",
    contentHash: "b".repeat(64),
    fetchedAt: "2026-08-02T00:00:00.000Z",
    trustStatus: "PENDING",
    rightsStatus: "PENDING"
  });
  assert.deepEqual(evaluateSourcePolicy(revision), { eligible: false, reason: "SOURCE_TRUST_NOT_APPROVED" });
});

test("materialization binds a claim to the immutable source anchor instead of trusting a model hash", () => {
  const evidenceText = "Exact immutable source evidence.";
  const quoteHash = createHash("sha256").update(evidenceText, "utf8").digest("hex");
  const revision = materializeDraftRevision(
    "r-anchored-claim",
    {
      sources: [{
        id: "source-1",
        url: "https://example.org/evidence",
        title: "Evidence",
        contentHash: "c".repeat(64),
        fetchedAt: "2026-08-02T00:00:00.000Z",
        evidenceText,
        evidenceAnchors: [{ sourceId: "source-1", start: 0, end: evidenceText.length, quoteHash }]
      }]
    },
    {
      ...draft,
      claims: [{ ...draft.claims[0]!, sourceIds: ["source-1"], quoteHash: "d".repeat(64) }]
    },
    "2026-08-02T00:00:00.000Z"
  );

  assert.deepEqual(revision.sources[0]?.evidenceAnchors, [{ sourceId: "source-1", start: 0, end: evidenceText.length, quoteHash }]);
  assert.deepEqual(revision.claims[0]?.evidenceAnchors, [{ sourceId: "source-1", start: 0, end: evidenceText.length, quoteHash }]);
  assert.equal(validateClaimEvidence(revision), true);
});

test("materialization retains the exact bounded evidence excerpt in the immutable revision package", () => {
  const evidenceText = "Yerel kaynak kaydı, bu iddiayı açıkça doğrular.";
  const quoteHash = createHash("sha256").update(evidenceText, "utf8").digest("hex");
  const revision = materializeDraftRevision(
    "r-immutable-evidence",
    {
      sources: [{
        id: "source-immutable",
        url: "https://example.org/evidence",
        title: "Evidence",
        contentHash: "c".repeat(64),
        fetchedAt: "2026-08-02T00:00:00.000Z",
        evidenceText,
        evidenceAnchors: [{ sourceId: "source-immutable", start: 0, end: evidenceText.length, quoteHash }]
      }]
    },
    { ...draft, claims: [{ ...draft.claims[0]!, sourceIds: ["source-immutable"] }] },
    "2026-08-02T00:00:00.000Z"
  );

  assert.equal(revision.sources[0]?.evidenceExcerpt, evidenceText);
  assert.equal(revision.sources[0]?.evidenceExcerptHash, quoteHash);
  assert.equal(validateClaimEvidence(revision), true);
  assert.equal(validateClaimEvidence({
    ...revision,
    sources: [{ ...revision.sources[0]!, evidenceExcerpt: `${evidenceText} değiştirildi` }]
  }), false);
});

test("materialization downgrades a verified claim when any requested source cannot be anchored", () => {
  const revision = materializeDraftRevision(
    "r-unanchored-claim",
    { sources: [{ id: "source-1", url: "https://example.org/evidence", title: "Evidence", contentHash: "c".repeat(64), fetchedAt: "2026-08-02T00:00:00.000Z" }] },
    { ...draft, claims: [{ ...draft.claims[0]!, sourceIds: ["missing-source"], status: "VERIFIED" }] },
    "2026-08-02T00:00:00.000Z"
  );

  assert.equal(revision.claims[0]?.status, "NEEDS_SOURCE");
  assert.deepEqual(revision.claims[0]?.evidenceAnchors, []);
});

test("revision repair retains immutable source anchors when a source URL cannot be fetched again", () => {
  const anchor = { sourceId: "source-1", quoteHash: "e".repeat(64), start: 0, end: 42 };

  assert.deepEqual(fallbackDraftSourceEvidence([{
    id: "source-1",
    url: "https://example.org/evidence",
    title: "Archived evidence",
    fetchedAt: "2026-08-09T00:00:00.000Z",
    contentHash: "f".repeat(64),
    evidenceAnchors: [anchor]
  }]), [{
    id: "source-1",
    url: "https://example.org/evidence",
    title: "Archived evidence",
    fetchedAt: "2026-08-09T00:00:00.000Z",
    contentHash: "f".repeat(64),
    evidenceAnchors: [anchor]
  }]);
});
