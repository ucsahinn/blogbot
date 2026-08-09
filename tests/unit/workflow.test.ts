import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkflowEvent,
  chooseCandidateForSlot,
  createEditedRevision
} from "../../packages/editorial/src/workflow.ts";
import type { ArticleRevision } from "../../packages/editorial/src/revision.ts";

function minimalRevision(state: ArticleRevision["state"]): ArticleRevision {
  return {
    id: "rev-1",
    translationKey: "story-1",
    state,
    tr: {
      title: "Başlık",
      slug: "baslik",
      description: "Açıklama",
      bodyMarkdown: "Özgün metin",
      heroImageAlt: "Editoryal görsel"
    },
    en: {
      title: "Title",
      slug: "title",
      description: "Description",
      bodyMarkdown: "Original localization",
      heroImageAlt: "Editorial visual"
    },
    section: "haberler",
    articleType: "news",
    author: "Yerel Editorya",
    tags: [],
    claims: [],
    sources: [],
    media: [],
    scheduledAt: "2026-07-30T09:00:00.000Z",
    adapterVersion: "1.0.0"
  };
}

test("normal workflow reaches review but never skips human approval", () => {
  let state = minimalRevision("DISCOVERED").state;
  for (const event of [
    "CLUSTER",
    "START_RESEARCH",
    "START_DRAFT",
    "REQUEST_REVIEW"
  ] as const) {
    state = applyWorkflowEvent(state, event);
  }

  assert.equal(state, "REVIEW_REQUIRED");
  assert.throws(() => applyWorkflowEvent("DRAFTING", "APPROVE"));
  assert.equal(applyWorkflowEvent("REVIEW_REQUIRED", "APPROVE"), "APPROVED");
});

test("insufficient sourcing cannot be approved", () => {
  assert.throws(() => applyWorkflowEvent("NEEDS_SOURCE", "APPROVE"));
  assert.equal(applyWorkflowEvent("NEEDS_SOURCE", "START_RESEARCH"), "RESEARCHING");
});

test("editing an approved package creates a new review-required revision", () => {
  const approved = minimalRevision("APPROVED");
  const edited = createEditedRevision(approved, "rev-2", {
    tr: { ...approved.tr, title: "Düzeltilmiş başlık" }
  });

  assert.equal(edited.id, "rev-2");
  assert.equal(edited.state, "REVIEW_REQUIRED");
  assert.equal(edited.tr.title, "Düzeltilmiş başlık");
  assert.equal(approved.tr.title, "Başlık");
});

test("editing a revision records its immutable immediate predecessor", () => {
  const approved = minimalRevision("APPROVED");

  const edited = createEditedRevision(approved, "rev-2", {
    supersedesRevisionId: "unrelated-revision"
  });

  assert.equal(edited.supersedesRevisionId, "rev-1");
  assert.equal(approved.supersedesRevisionId, undefined);
});

test("a weekly slot remains empty when no candidate passes quality", () => {
  const selected = chooseCandidateForSlot([
    { revisionId: "weak", score: 0.95, qualityPassed: false },
    { revisionId: "good-but-low", score: 0.5, qualityPassed: true }
  ], 0.8);

  assert.equal(selected, null);
});
