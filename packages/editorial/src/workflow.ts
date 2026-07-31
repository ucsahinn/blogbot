import type { ArticleRevision, ArticleState } from "./revision.ts";

export type WorkflowEvent =
  | "CLUSTER"
  | "START_RESEARCH"
  | "MARK_NEEDS_SOURCE"
  | "START_DRAFT"
  | "REQUEST_ROUTING"
  | "REQUEST_REVIEW"
  | "APPROVE"
  | "MARK_PR_READY"
  | "SCHEDULE"
  | "START_PUBLISH"
  | "PUBLISH_SUCCESS"
  | "INVALIDATE";

const transitions: Readonly<
  Partial<Record<ArticleState, Partial<Record<WorkflowEvent, ArticleState>>>>
> = {
  DISCOVERED: { CLUSTER: "CLUSTERED" },
  CLUSTERED: { START_RESEARCH: "RESEARCHING" },
  RESEARCHING: {
    MARK_NEEDS_SOURCE: "NEEDS_SOURCE",
    START_DRAFT: "DRAFTING",
    REQUEST_ROUTING: "ROUTING_REQUIRED"
  },
  NEEDS_SOURCE: { START_RESEARCH: "RESEARCHING" },
  ROUTING_REQUIRED: {
    START_DRAFT: "DRAFTING",
    MARK_NEEDS_SOURCE: "NEEDS_SOURCE"
  },
  DRAFTING: {
    REQUEST_REVIEW: "REVIEW_REQUIRED",
    MARK_NEEDS_SOURCE: "NEEDS_SOURCE",
    REQUEST_ROUTING: "ROUTING_REQUIRED"
  },
  REVIEW_REQUIRED: {
    APPROVE: "APPROVED",
    START_DRAFT: "DRAFTING",
    MARK_NEEDS_SOURCE: "NEEDS_SOURCE"
  },
  APPROVED: {
    MARK_PR_READY: "PR_READY",
    INVALIDATE: "REVIEW_REQUIRED"
  },
  PR_READY: {
    SCHEDULE: "SCHEDULED",
    INVALIDATE: "REVIEW_REQUIRED"
  },
  SCHEDULED: {
    START_PUBLISH: "PUBLISHING",
    INVALIDATE: "REVIEW_REQUIRED"
  },
  PUBLISHING: {
    PUBLISH_SUCCESS: "PUBLISHED"
  },
  PUBLISHED: {
    INVALIDATE: "REVIEW_REQUIRED"
  }
};

export function applyWorkflowEvent(
  current: ArticleState,
  event: WorkflowEvent
): ArticleState {
  const next = transitions[current]?.[event];
  if (!next) {
    throw new Error(`Illegal article transition: ${current} -> ${event}`);
  }
  return next;
}

export function createEditedRevision(
  current: ArticleRevision,
  nextRevisionId: string,
  patch: Partial<ArticleRevision>
): ArticleRevision {
  if (!nextRevisionId || nextRevisionId === current.id) {
    throw new Error("An edit must create a distinct revision id");
  }
  return {
    ...current,
    ...patch,
    id: nextRevisionId,
    translationKey: current.translationKey,
    state: "REVIEW_REQUIRED"
  };
}

export interface SlotCandidate {
  revisionId: string;
  score: number;
  qualityPassed: boolean;
}

export function chooseCandidateForSlot(
  candidates: SlotCandidate[],
  minimumScore: number
): SlotCandidate | null {
  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.qualityPassed &&
        Number.isFinite(candidate.score) &&
        candidate.score >= minimumScore
    )
    .sort((left, right) => right.score - left.score);

  return eligible[0] ?? null;
}
