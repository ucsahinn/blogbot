import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEditorialQuality,
  type EditorialAssessment
} from "../../packages/editorial/src/quality-gates.ts";

function passingNews(): EditorialAssessment {
  return {
    articleType: "news",
    intentSatisfied: true,
    titleIsHonest: true,
    originalValuePresent: true,
    humanReviewed: true,
    allClaimsVerified: true,
    sourceCount: 2,
    hasPrimarySource: true,
    hasIndependentSecondSource: true,
    singleOfficialSourceRationale: null,
    authorTransparent: true,
    aiDisclosureAccurate: true,
    isYmyl: false,
    expertReviewer: null,
    leadHasFiveWOneH: true,
    unverifiedClaimsClearlyLabeled: true,
    newsSchemaComplete: true,
    sensitiveTopic: false,
    ethicsReviewComplete: false,
    clusterKey: null,
    aboveFoldAnswersIntent: true,
    headingHierarchyValid: true,
    internalLinkCount: 1,
    internalLinkOmissionRationale: null
  };
}

test("a sourced, transparent, human-reviewed news package passes", () => {
  assert.deepEqual(evaluateEditorialQuality(passingNews()), {
    passed: true,
    blockers: [],
    warnings: []
  });
});

test("news requires 5N1K, source sufficiency, and honest AI transparency", () => {
  const assessment = passingNews();
  assessment.leadHasFiveWOneH = false;
  assessment.hasIndependentSecondSource = false;
  assessment.singleOfficialSourceRationale = null;
  assessment.aiDisclosureAccurate = false;

  assert.deepEqual(evaluateEditorialQuality(assessment).blockers, [
    "NEWS_LEAD_MISSING_5W1H",
    "INSUFFICIENT_INDEPENDENT_SOURCING",
    "AI_DISCLOSURE_INACCURATE"
  ]);
});

test("YMYL publication requires an identified expert reviewer", () => {
  const assessment = passingNews();
  assessment.isYmyl = true;

  assert.ok(
    evaluateEditorialQuality(assessment).blockers.includes("YMYL_EXPERT_REVIEW_REQUIRED")
  );
});

test("evergreen guide must belong to a topic cluster and answer early", () => {
  const assessment: EditorialAssessment = {
    ...passingNews(),
    articleType: "guide",
    leadHasFiveWOneH: false,
    newsSchemaComplete: false,
    clusterKey: null,
    aboveFoldAnswersIntent: false
  };

  assert.deepEqual(evaluateEditorialQuality(assessment).blockers, [
    "TOPIC_CLUSTER_REQUIRED",
    "ABOVE_FOLD_ANSWER_REQUIRED"
  ]);
});
