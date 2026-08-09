import assert from "node:assert/strict";
import test from "node:test";

import {
  createDraftCodexTaskResolver,
  finalizeReviewedRevision,
  isFinalReviewCodexOutput,
  isDraftCodexOutput,
  materializeDraftRevision,
  normalizeDraftCodexOutput,
  type DraftCodexOutput
} from "../../apps/engine/src/codex-draft.ts";
import { assertRevisionGeneratedFilesMatch } from "../../apps/engine/src/stdio-entrypoint.ts";
import { validateClaimEvidence, validateRevisionPackageV2 } from "../../packages/editorial/src/revision.ts";
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
    { id: "claims", group: "editorial" as const, state: "PASS" as const, detail: "İddialar kanıta bağlı." },
    { id: "contradictions", group: "editorial" as const, state: "PASS" as const, detail: "Çelişki bulunmadı." },
    { id: "bilingual-parity", group: "editorial" as const, state: "PASS" as const, detail: "Parite doğrulandı." },
    { id: "markdown-safety", group: "security" as const, state: "PASS" as const, detail: "Markdown güvenli." },
    { id: "seo", group: "seo" as const, state: "PASS" as const, detail: "Başlık ve açıklamalar uygun." },
    { id: "media", group: "media" as const, state: "PASS" as const, detail: "Medya gerekmiyor." }
  ]
};

test("final review is a separate DEEP_REVIEW task with a strict output contract", async () => {
  const resolver = createDraftCodexTaskResolver();
  const task = await resolver.resolve({ jobId: "r:review", idempotencyKey: "k", definitionId: "REVISION.FINAL_REVIEW", payload: { draft }, state: "RUNNING", version: 1 });
  assert.equal(task.taskKind, "FINAL_QUALITY");
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

test("materialization binds a claim to the immutable source anchor instead of trusting a model hash", () => {
  const quoteHash = "b".repeat(64);
  const revision = materializeDraftRevision(
    "r-anchored-claim",
    {
      sources: [{
        id: "source-1",
        url: "https://example.org/evidence",
        title: "Evidence",
        contentHash: "c".repeat(64),
        fetchedAt: "2026-08-02T00:00:00.000Z",
        evidenceAnchors: [{ sourceId: "source-1", start: 0, end: 32, quoteHash }]
      }]
    },
    {
      ...draft,
      claims: [{ ...draft.claims[0]!, sourceIds: ["source-1"], quoteHash: "d".repeat(64) }]
    },
    "2026-08-02T00:00:00.000Z"
  );

  assert.deepEqual(revision.sources[0]?.evidenceAnchors, [{ sourceId: "source-1", start: 0, end: 32, quoteHash }]);
  assert.deepEqual(revision.claims[0]?.evidenceAnchors, [{ sourceId: "source-1", start: 0, end: 32, quoteHash }]);
  assert.equal(validateClaimEvidence(revision), true);
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
