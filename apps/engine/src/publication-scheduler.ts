import type { BackendRepository } from "../../../packages/database/src/backend-repository.ts";
import { deriveAutomationCapabilities } from "../../../packages/editorial/src/automation.ts";
import {
  computeRevisionHash,
  evaluatePublishEligibility,
  type ApprovalBundle,
  type PublishBlockReason
} from "../../../packages/editorial/src/revision.ts";

export type PublicationSchedulerSkipReason = PublishBlockReason | "PREVIEW_REQUIRED" | "PREVIEW_STALE";

export interface PublicationSchedulerResult {
  enqueued: string[];
  skipped: Array<{ revisionId: string; reason: PublicationSchedulerSkipReason }>;
}

/**
 * Claims due, already-approved revisions into the durable publication outbox.
 * Preview metadata is treated as a binding preflight: a missing or stale
 * preview never reaches the outbox. The outbox's revision/hash idempotency key
 * makes restart and repeated ticks safe.
 */
export class PublicationScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;

  constructor(
    private readonly backend: BackendRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly pollMs = 60_000
  ) {}

  start(): void {
    if (this.timer) return;
    // Do not race the startup migration/source-worker transaction. The first
    // durable scheduling pass runs on the normal poll boundary.
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<PublicationSchedulerResult> {
    if (this.tickInFlight) return { enqueued: [], skipped: [] };
    this.tickInFlight = true;
    try {
      const snapshot = (await this.backend.sync(0)).snapshot;
      const existingPublicationKeys = new Set(snapshot.outbox.map((effect) => effect.idempotencyKey));
      const capabilities = deriveAutomationCapabilities(snapshot.automation);
      const result: PublicationSchedulerResult = { enqueued: [], skipped: [] };
      const now = this.now();
      for (const revision of snapshot.revisions) {
        if (Date.parse(revision.scheduledAt) > now.getTime()) continue;
        const approval = snapshot.approvals.find((item) => item.revisionId === revision.id);
        const highRisk = snapshot.highRiskApprovals.find((item) => item.revisionId === revision.id) ?? null;
        const approvalBundle: ApprovalBundle | null = approval ? { editorial: approval, highRisk } : null;
        const eligibility = evaluatePublishEligibility(revision, approvalBundle, {
          now,
          publishingPaused: !capabilities.canPublishApproved
        });
        if (!eligibility.eligible) {
          result.skipped.push({ revisionId: revision.id, reason: eligibility.reason });
          continue;
        }
        const revisionHash = computeRevisionHash(revision);
        const preview = await this.backend.getLocalState(`publication.preview:${revision.id}`);
        if (!preview || typeof preview !== "object") {
          result.skipped.push({ revisionId: revision.id, reason: "PREVIEW_REQUIRED" });
          continue;
        }
        const previewRecord = preview as { revisionHash?: unknown };
        if (previewRecord.revisionHash !== revisionHash) {
          result.skipped.push({ revisionId: revision.id, reason: "PREVIEW_STALE" });
          continue;
        }
        const key = `scheduler:publication:${revision.id}:${revisionHash}`;
        const effect = await this.backend.runIdempotent(key, revisionHash, (transaction) => transaction.enqueuePublication(revision.id, revisionHash));
        if (!existingPublicationKeys.has(effect.idempotencyKey)) {
          result.enqueued.push(revision.id);
          existingPublicationKeys.add(effect.idempotencyKey);
        }
      }
      return result;
    } finally {
      this.tickInFlight = false;
    }
  }
}
