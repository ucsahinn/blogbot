export type EditorialArticleType = "news" | "analysis" | "deep_dive" | "guide";

export interface EditorialAssessment {
  articleType: EditorialArticleType;
  intentSatisfied: boolean;
  titleIsHonest: boolean;
  originalValuePresent: boolean;
  humanReviewed: boolean;
  allClaimsVerified: boolean;
  sourceCount: number;
  hasPrimarySource: boolean;
  hasIndependentSecondSource: boolean;
  singleOfficialSourceRationale: string | null;
  authorTransparent: boolean;
  aiDisclosureAccurate: boolean;
  isYmyl: boolean;
  expertReviewer: string | null;
  leadHasFiveWOneH: boolean;
  unverifiedClaimsClearlyLabeled: boolean;
  newsSchemaComplete: boolean;
  sensitiveTopic: boolean;
  ethicsReviewComplete: boolean;
  clusterKey: string | null;
  aboveFoldAnswersIntent: boolean;
  headingHierarchyValid: boolean;
  internalLinkCount: number;
  internalLinkOmissionRationale: string | null;
}

export interface EditorialQualityResult {
  passed: boolean;
  blockers: string[];
  warnings: string[];
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

export function evaluateEditorialQuality(
  assessment: EditorialAssessment
): EditorialQualityResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!assessment.intentSatisfied) {
    blockers.push("SEARCH_INTENT_NOT_SATISFIED");
  }
  if (!assessment.titleIsHonest) {
    blockers.push("MISLEADING_OR_CLICKBAIT_TITLE");
  }
  if (!assessment.originalValuePresent) {
    blockers.push("ORIGINAL_VALUE_REQUIRED");
  }
  if (!assessment.humanReviewed) {
    blockers.push("HUMAN_REVIEW_REQUIRED");
  }
  if (!assessment.allClaimsVerified) {
    blockers.push("UNVERIFIED_CLAIMS");
  }

  if (assessment.articleType === "news") {
    if (!assessment.leadHasFiveWOneH) {
      blockers.push("NEWS_LEAD_MISSING_5W1H");
    }
    if (!assessment.unverifiedClaimsClearlyLabeled) {
      blockers.push("UNVERIFIED_CLAIMS_NOT_LABELED");
    }
    if (!assessment.newsSchemaComplete) {
      blockers.push("NEWS_SCHEMA_INCOMPLETE");
    }
    if (assessment.sensitiveTopic && !assessment.ethicsReviewComplete) {
      blockers.push("SENSITIVE_TOPIC_ETHICS_REVIEW_REQUIRED");
    }
  } else {
    if (!hasText(assessment.clusterKey)) {
      blockers.push("TOPIC_CLUSTER_REQUIRED");
    }
    if (!assessment.aboveFoldAnswersIntent) {
      blockers.push("ABOVE_FOLD_ANSWER_REQUIRED");
    }
    if (!assessment.headingHierarchyValid) {
      blockers.push("HEADING_HIERARCHY_INVALID");
    }
    if (
      assessment.internalLinkCount < 1 &&
      !hasText(assessment.internalLinkOmissionRationale)
    ) {
      blockers.push("INTERNAL_LINK_OR_RATIONALE_REQUIRED");
    }
  }

  const independentSourcingSatisfied =
    assessment.sourceCount >= 2 &&
    assessment.hasPrimarySource &&
    assessment.hasIndependentSecondSource;
  const explicitOfficialException =
    assessment.sourceCount >= 1 &&
    assessment.hasPrimarySource &&
    hasText(assessment.singleOfficialSourceRationale);
  if (!independentSourcingSatisfied && !explicitOfficialException) {
    blockers.push("INSUFFICIENT_INDEPENDENT_SOURCING");
  } else if (explicitOfficialException && !independentSourcingSatisfied) {
    warnings.push("SINGLE_OFFICIAL_SOURCE_EXCEPTION");
  }

  if (!assessment.aiDisclosureAccurate) {
    blockers.push("AI_DISCLOSURE_INACCURATE");
  }
  if (!assessment.authorTransparent) {
    blockers.push("AUTHOR_TRANSPARENCY_REQUIRED");
  }
  if (assessment.isYmyl && !hasText(assessment.expertReviewer)) {
    blockers.push("YMYL_EXPERT_REVIEW_REQUIRED");
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings
  };
}
