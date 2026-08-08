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

export interface PublicationSchedulerOptions {
  /** Receives only a redacted scheduler diagnostic code. */
  onFault?(error: Error): void;
}

const SAFE_PUBLICATION_SCHEDULER_FAULT = "PUBLICATION_SCHEDULER_UNAVAILABLE";

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
    private readonly pollMs = 60_000,
    private readonly options: PublicationSchedulerOptions = {}
  ) {}

  start(): void {
    if (this.timer) return;
    // Do not race the startup migration/source-worker transaction. The first
    // durable scheduling pass runs on the normal poll boundary.
    this.timer = setInterval(() => this.runTick(), this.pollMs);
    this.timer.unref?.();
  }

  private runTick(): void {
    void this.tick().catch(() => {
      const error = new Error(SAFE_PUBLICATION_SCHEDULER_FAULT);
      try {
        if (this.options.onFault) {
          this.options.onFault(error);
        } else {
          process.stderr.write(`[Blogbot] ${SAFE_PUBLICATION_SCHEDULER_FAULT}\n`);
        }
      } catch {
        // Diagnostics must not stop the durable scheduler.
      }
    });
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
          publishingPaused: !capabilities.canPublishApproved,
          revisionLineage: snapshot.revisions
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
