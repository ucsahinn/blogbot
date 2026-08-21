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

export type EditorialSourceRoleV3 = "primary" | "independent" | "supporting";

export interface EditorialSourceEvidenceV3 {
  readonly sourceId: string;
  readonly cited: boolean;
  readonly official: boolean;
  readonly role: EditorialSourceRoleV3;
}

export interface EditorialAssessmentV3 {
  readonly articleType: EditorialArticleType;
  readonly intentSatisfied: boolean;
  readonly titleIsHonest: boolean;
  readonly originalValuePresent: boolean;
  readonly allClaimsVerified: boolean;
  readonly sources: readonly EditorialSourceEvidenceV3[];
  readonly singleOfficialSourceRationale: string | null;
  readonly authorTransparent: boolean;
  readonly aiDisclosureMatchesUsage: boolean;
  readonly isYmyl: boolean;
  readonly leadHasFiveWOneH: boolean;
  readonly unverifiedClaimsClearlyLabeled: boolean;
  readonly newsSchemaComplete: boolean;
  readonly sensitiveTopic: boolean;
  readonly clusterKey: string | null;
  readonly aboveFoldAnswersIntent: boolean;
  readonly headingHierarchyValid: boolean;
  readonly internalLinkCount: number;
  readonly internalLinkOmissionRationale: string | null;
}

export type EditorialApprovalRequirementV3 =
  | "EDITORIAL_REVIEW"
  | "EXPERT_REVIEW"
  | "ETHICS_REVIEW";

export interface EditorialSourceRoleAttestationV3 {
  readonly sourceId: string;
  readonly role: EditorialSourceRoleV3;
}

export interface EditorialReviewAttestationV3 {
  readonly reviewer: string;
  readonly sourceRoles: readonly EditorialSourceRoleAttestationV3[];
}

export interface EditorialExpertReviewAttestationV3 {
  readonly reviewer: string;
  readonly qualifications: string;
  readonly reviewScope: string;
}

export interface EditorialEthicsReviewAttestationV3 {
  readonly reviewer: string;
  readonly reviewScope: string;
  readonly rationale: string;
}

export interface EditorialApprovalAttestationV3 {
  readonly editorialReview: EditorialReviewAttestationV3 | null;
  readonly expertReview: EditorialExpertReviewAttestationV3 | null;
  readonly ethicsReview: EditorialEthicsReviewAttestationV3 | null;
}

export interface EditorialPreApprovalQualityResultV3 {
  readonly readyForApproval: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly approvalRequirements: readonly EditorialApprovalRequirementV3[];
}

export type EditorialAttestationIssueV3 =
  | "EDITORIAL_REVIEWER_REQUIRED"
  | "SOURCE_ROLE_ATTESTATION_REQUIRED"
  | "SOURCE_ROLE_ATTESTATION_MISMATCH"
  | "EXPERT_REVIEW_DETAILS_REQUIRED"
  | "ETHICS_REVIEW_DETAILS_REQUIRED";

export interface EditorialQualityResultV3 {
  readonly passed: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly approvalRequirements: readonly EditorialApprovalRequirementV3[];
  readonly unmetApprovalRequirements: readonly EditorialApprovalRequirementV3[];
  readonly attestationIssues: readonly EditorialAttestationIssueV3[];
}

function citedSources(
  assessment: EditorialAssessmentV3
): readonly EditorialSourceEvidenceV3[] {
  if (!Array.isArray(assessment.sources)) {
    return [];
  }
  return assessment.sources.filter((source) => source.cited && hasText(source.sourceId));
}

function independentSourcingSatisfied(
  sources: readonly EditorialSourceEvidenceV3[]
): boolean {
  const primaryIds = new Set(
    sources.filter((source) => source.role === "primary").map((source) => source.sourceId)
  );
  const independentIds = new Set(
    sources
      .filter((source) => source.role === "independent")
      .map((source) => source.sourceId)
  );

  return [...primaryIds].some((primaryId) =>
    [...independentIds].some((independentId) => independentId !== primaryId)
  );
}

function officialSourceExceptionSatisfied(
  assessment: EditorialAssessmentV3,
  sources: readonly EditorialSourceEvidenceV3[]
): boolean {
  if (sources.length !== 1 || !hasText(assessment.singleOfficialSourceRationale)) {
    return false;
  }

  const source = sources[0];
  return source !== undefined && source.official && source.role === "primary";
}

function approvalRequirementsFor(
  assessment: EditorialAssessmentV3
): readonly EditorialApprovalRequirementV3[] {
  const requirements: EditorialApprovalRequirementV3[] = ["EDITORIAL_REVIEW"];
  if (assessment.isYmyl) {
    requirements.push("EXPERT_REVIEW");
  }
  if (assessment.sensitiveTopic) {
    requirements.push("ETHICS_REVIEW");
  }
  return requirements;
}

export function evaluatePreApprovalEditorialQuality(
  assessment: EditorialAssessmentV3
): EditorialPreApprovalQualityResultV3 {
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
  } else if (
    assessment.articleType === "analysis" ||
    assessment.articleType === "deep_dive" ||
    assessment.articleType === "guide"
  ) {
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
      !Number.isFinite(assessment.internalLinkCount) ||
      (assessment.internalLinkCount < 1 &&
        !hasText(assessment.internalLinkOmissionRationale))
    ) {
      blockers.push("INTERNAL_LINK_OR_RATIONALE_REQUIRED");
    }
  } else {
    blockers.push("ARTICLE_TYPE_INVALID");
  }

  const cited = citedSources(assessment);
  const independentSourcesPresent = independentSourcingSatisfied(cited);
  const officialExceptionPresent = officialSourceExceptionSatisfied(assessment, cited);
  if (!independentSourcesPresent && !officialExceptionPresent) {
    blockers.push("INSUFFICIENT_INDEPENDENT_SOURCING");
  } else if (officialExceptionPresent) {
    warnings.push("SINGLE_OFFICIAL_SOURCE_EXCEPTION");
  }

  if (!assessment.aiDisclosureMatchesUsage) {
    blockers.push("AI_DISCLOSURE_INACCURATE");
  }
  if (!assessment.authorTransparent) {
    blockers.push("AUTHOR_TRANSPARENCY_REQUIRED");
  }

  return {
    readyForApproval: blockers.length === 0,
    blockers,
    warnings,
    approvalRequirements: approvalRequirementsFor(assessment)
  };
}

function sourceRoleAttestationMatches(
  assessment: EditorialAssessmentV3,
  sourceRoles: readonly EditorialSourceRoleAttestationV3[]
): boolean {
  const expectedSources = citedSources(assessment);
  if (sourceRoles.length !== expectedSources.length) {
    return false;
  }

  const expected = new Set(
    expectedSources.map((source) => `${source.sourceId}\u0000${source.role}`)
  );
  const actual = new Set(
    sourceRoles
      .filter((source) => hasText(source.sourceId))
      .map((source) => `${source.sourceId}\u0000${source.role}`)
  );

  return (
    expected.size === expectedSources.length &&
    actual.size === sourceRoles.length &&
    expected.size === actual.size &&
    [...expected].every((source) => actual.has(source))
  );
}

function expertReviewIsComplete(
  review: EditorialExpertReviewAttestationV3 | null | undefined
): boolean {
  return (
    review !== null &&
    review !== undefined &&
    hasText(review.reviewer) &&
    hasText(review.qualifications) &&
    hasText(review.reviewScope)
  );
}

function ethicsReviewIsComplete(
  review: EditorialEthicsReviewAttestationV3 | null | undefined
): boolean {
  return (
    review !== null &&
    review !== undefined &&
    hasText(review.reviewer) &&
    hasText(review.reviewScope) &&
    hasText(review.rationale)
  );
}

export function evaluateEditorialQualityV3(
  assessment: EditorialAssessmentV3,
  attestation: EditorialApprovalAttestationV3
): EditorialQualityResultV3 {
  const preApproval = evaluatePreApprovalEditorialQuality(assessment);
  const attestationIssues: EditorialAttestationIssueV3[] = [];
  const unmetApprovalRequirements: EditorialApprovalRequirementV3[] = [];

  const editorialReview = attestation?.editorialReview;
  if (
    editorialReview === null ||
    editorialReview === undefined ||
    !hasText(editorialReview.reviewer)
  ) {
    attestationIssues.push("EDITORIAL_REVIEWER_REQUIRED");
  }
  if (
    editorialReview === null ||
    editorialReview === undefined ||
    editorialReview.sourceRoles.length === 0
  ) {
    attestationIssues.push("SOURCE_ROLE_ATTESTATION_REQUIRED");
  } else if (!sourceRoleAttestationMatches(assessment, editorialReview.sourceRoles)) {
    attestationIssues.push("SOURCE_ROLE_ATTESTATION_MISMATCH");
  }
  if (attestationIssues.length > 0) {
    unmetApprovalRequirements.push("EDITORIAL_REVIEW");
  }

  if (assessment.isYmyl && !expertReviewIsComplete(attestation?.expertReview)) {
    attestationIssues.push("EXPERT_REVIEW_DETAILS_REQUIRED");
    unmetApprovalRequirements.push("EXPERT_REVIEW");
  }
  if (
    assessment.sensitiveTopic &&
    !ethicsReviewIsComplete(attestation?.ethicsReview)
  ) {
    attestationIssues.push("ETHICS_REVIEW_DETAILS_REQUIRED");
    unmetApprovalRequirements.push("ETHICS_REVIEW");
  }

  return {
    passed: preApproval.readyForApproval && unmetApprovalRequirements.length === 0,
    blockers: preApproval.blockers,
    warnings: preApproval.warnings,
    approvalRequirements: preApproval.approvalRequirements,
    unmetApprovalRequirements,
    attestationIssues
  };
}
