import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEditorialQuality,
  evaluateEditorialQualityV3,
  evaluatePreApprovalEditorialQuality,
  type EditorialApprovalAttestationV3,
  type EditorialAssessment,
  type EditorialAssessmentV3
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

function passingNewsV3(): EditorialAssessmentV3 {
  return {
    articleType: "news",
    intentSatisfied: true,
    titleIsHonest: true,
    originalValuePresent: true,
    allClaimsVerified: true,
    sources: [
      {
        sourceId: "official-bulletin",
        cited: true,
        official: true,
        role: "primary"
      },
      {
        sourceId: "independent-report",
        cited: true,
        official: false,
        role: "independent"
      }
    ],
    singleOfficialSourceRationale: null,
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
    internalLinkCount: 1,
    internalLinkOmissionRationale: null
  };
}

function passingApprovalV3(): EditorialApprovalAttestationV3 {
  return {
    editorialReview: {
      reviewer: "Deniz Editör",
      sourceRoles: [
        { sourceId: "official-bulletin", role: "primary" },
        { sourceId: "independent-report", role: "independent" }
      ]
    },
    expertReview: null,
    ethicsReview: null
  };
}

test("pre-approval keeps human reviews separate from article blockers", () => {
  const assessment: EditorialAssessmentV3 = {
    ...passingNewsV3(),
    titleIsHonest: false,
    isYmyl: true,
    sensitiveTopic: true
  };

  assert.deepEqual(evaluatePreApprovalEditorialQuality(assessment), {
    readyForApproval: false,
    blockers: ["MISLEADING_OR_CLICKBAIT_TITLE"],
    warnings: [],
    approvalRequirements: ["EDITORIAL_REVIEW", "EXPERT_REVIEW", "ETHICS_REVIEW"]
  });
});

test("pre-approval accepts a single official source only when it is a cited primary with rationale", async (t) => {
  const validException: EditorialAssessmentV3 = {
    ...passingNewsV3(),
    sources: [
      {
        sourceId: "official-bulletin",
        cited: true,
        official: true,
        role: "primary"
      }
    ],
    singleOfficialSourceRationale: "Olayın tek yetkili ve doğrudan kayıt sistemi budur."
  };

  assert.deepEqual(evaluatePreApprovalEditorialQuality(validException), {
    readyForApproval: true,
    blockers: [],
    warnings: ["SINGLE_OFFICIAL_SOURCE_EXCEPTION"],
    approvalRequirements: ["EDITORIAL_REVIEW"]
  });

  const invalidCases: ReadonlyArray<readonly [string, EditorialAssessmentV3]> = [
    [
      "uncited source",
      {
        ...validException,
        sources: [{ ...validException.sources[0]!, cited: false }]
      }
    ],
    [
      "non-primary source",
      {
        ...validException,
        sources: [{ ...validException.sources[0]!, role: "supporting" }]
      }
    ],
    [
      "non-official source",
      {
        ...validException,
        sources: [{ ...validException.sources[0]!, official: false }]
      }
    ],
    ["blank rationale", { ...validException, singleOfficialSourceRationale: "  " }]
  ];

  for (const [name, assessment] of invalidCases) {
    await t.test(name, () => {
      assert.ok(
        evaluatePreApprovalEditorialQuality(assessment).blockers.includes(
          "INSUFFICIENT_INDEPENDENT_SOURCING"
        )
      );
    });
  }
});

test("full V3 evaluation requires a named editorial reviewer and a complete source-role attestation", () => {
  const missingAttestation: EditorialApprovalAttestationV3 = {
    editorialReview: {
      reviewer: "  ",
      sourceRoles: []
    },
    expertReview: null,
    ethicsReview: null
  };

  assert.deepEqual(evaluateEditorialQualityV3(passingNewsV3(), missingAttestation), {
    passed: false,
    blockers: [],
    warnings: [],
    approvalRequirements: ["EDITORIAL_REVIEW"],
    unmetApprovalRequirements: ["EDITORIAL_REVIEW"],
    attestationIssues: [
      "EDITORIAL_REVIEWER_REQUIRED",
      "SOURCE_ROLE_ATTESTATION_REQUIRED"
    ]
  });

  assert.deepEqual(evaluateEditorialQualityV3(passingNewsV3(), passingApprovalV3()), {
    passed: true,
    blockers: [],
    warnings: [],
    approvalRequirements: ["EDITORIAL_REVIEW"],
    unmetApprovalRequirements: [],
    attestationIssues: []
  });
});

test("source-role attestation must cover every cited source with its declared role", () => {
  const approval: EditorialApprovalAttestationV3 = {
    ...passingApprovalV3(),
    editorialReview: {
      reviewer: "Deniz Editör",
      sourceRoles: [{ sourceId: "official-bulletin", role: "supporting" }]
    }
  };

  const result = evaluateEditorialQualityV3(passingNewsV3(), approval);

  assert.equal(result.passed, false);
  assert.deepEqual(result.unmetApprovalRequirements, ["EDITORIAL_REVIEW"]);
  assert.deepEqual(result.attestationIssues, ["SOURCE_ROLE_ATTESTATION_MISMATCH"]);
});

test("YMYL approval requires explicit reviewer, qualifications, and review scope", () => {
  const assessment: EditorialAssessmentV3 = { ...passingNewsV3(), isYmyl: true };
  const incompleteApproval: EditorialApprovalAttestationV3 = {
    ...passingApprovalV3(),
    expertReview: {
      reviewer: "Dr. Ada Uzman",
      qualifications: " ",
      reviewScope: "Tıbbi iddialar"
    }
  };

  assert.deepEqual(evaluateEditorialQualityV3(assessment, incompleteApproval), {
    passed: false,
    blockers: [],
    warnings: [],
    approvalRequirements: ["EDITORIAL_REVIEW", "EXPERT_REVIEW"],
    unmetApprovalRequirements: ["EXPERT_REVIEW"],
    attestationIssues: ["EXPERT_REVIEW_DETAILS_REQUIRED"]
  });

  const completeApproval: EditorialApprovalAttestationV3 = {
    ...passingApprovalV3(),
    expertReview: {
      reviewer: "Dr. Ada Uzman",
      qualifications: "Enfeksiyon hastalıkları uzmanı",
      reviewScope: "Tıbbi iddialar ve risk ifadeleri"
    }
  };
  assert.equal(evaluateEditorialQualityV3(assessment, completeApproval).passed, true);
});

test("sensitive-topic approval requires explicit ethics reviewer, scope, and rationale", () => {
  const assessment: EditorialAssessmentV3 = {
    ...passingNewsV3(),
    sensitiveTopic: true
  };
  const incompleteApproval: EditorialApprovalAttestationV3 = {
    ...passingApprovalV3(),
    ethicsReview: {
      reviewer: "Etik Editörü",
      reviewScope: "Hassas kimlik bilgileri",
      rationale: ""
    }
  };

  const incomplete = evaluateEditorialQualityV3(assessment, incompleteApproval);
  assert.deepEqual(incomplete.unmetApprovalRequirements, ["ETHICS_REVIEW"]);
  assert.deepEqual(incomplete.attestationIssues, ["ETHICS_REVIEW_DETAILS_REQUIRED"]);

  const completeApproval: EditorialApprovalAttestationV3 = {
    ...passingApprovalV3(),
    ethicsReview: {
      reviewer: "Etik Editörü",
      reviewScope: "Hassas kimlik bilgileri ve zarar riski",
      rationale: "Kimlik ayrıntıları çıkarıldı ve kamu yararı doğrulandı."
    }
  };
  assert.equal(evaluateEditorialQualityV3(assessment, completeApproval).passed, true);
});

test("V3 keeps deterministic evergreen structure and AI disclosure mismatches as blockers", () => {
  const assessment: EditorialAssessmentV3 = {
    ...passingNewsV3(),
    articleType: "guide",
    clusterKey: " ",
    internalLinkCount: 0,
    internalLinkOmissionRationale: null,
    aiDisclosureMatchesUsage: false
  };

  assert.deepEqual(evaluatePreApprovalEditorialQuality(assessment).blockers, [
    "TOPIC_CLUSTER_REQUIRED",
    "INTERNAL_LINK_OR_RATIONALE_REQUIRED",
    "AI_DISCLOSURE_INACCURATE"
  ]);
});

test("V3 rejects a missing article type instead of treating it as evergreen", () => {
  const assessment = {
    ...passingNewsV3(),
    articleType: undefined,
    clusterKey: "guvenlik-rehberleri"
  } as unknown as EditorialAssessmentV3;

  assert.deepEqual(evaluatePreApprovalEditorialQuality(assessment).blockers, [
    "ARTICLE_TYPE_INVALID"
  ]);
});

test("V3 fails closed when the editorial approval object is absent at runtime", () => {
  const malformedApproval = {
    expertReview: null,
    ethicsReview: null
  } as unknown as EditorialApprovalAttestationV3;

  assert.deepEqual(evaluateEditorialQualityV3(passingNewsV3(), malformedApproval), {
    passed: false,
    blockers: [],
    warnings: [],
    approvalRequirements: ["EDITORIAL_REVIEW"],
    unmetApprovalRequirements: ["EDITORIAL_REVIEW"],
    attestationIssues: [
      "EDITORIAL_REVIEWER_REQUIRED",
      "SOURCE_ROLE_ATTESTATION_REQUIRED"
    ]
  });
});
