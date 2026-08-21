import type { BackendRepository } from "../../../packages/database/src/backend-repository.ts";
import { publicationIntentBinding } from "./publication-intent.ts";
import { deriveAutomationCapabilities } from "../../../packages/editorial/src/automation.ts";
import {
  computeRevisionHash,
  evaluatePublishEligibility,
  type ApprovalBundle,
  type PublishBlockReason
} from "../../../packages/editorial/src/revision.ts";

export type PublicationSchedulerSkipReason =
  | PublishBlockReason
  | "APPROVAL_REVOKED"
  | "PREVIEW_REQUIRED"
  | "PREVIEW_STALE"
  | "SCHEDULING_FAILED";

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
  private stopped = false;

  constructor(
    private readonly backend: BackendRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly pollMs = 60_000,
    private readonly options: PublicationSchedulerOptions = {}
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // Do not race the startup migration/source-worker transaction. The first
    // durable scheduling pass runs on the normal poll boundary.
    this.timer = setInterval(() => this.runTick(), this.pollMs);
    this.timer.unref?.();
  }

  private runTick(): void {
    void this.tick().catch((error: unknown) => this.reportFault(error));
  }

  /**
   * Faults carry only a fixed diagnostic code. A scheduler fault can reference
   * a revision id, target repository or preview path, so the original error is
   * never forwarded to the host.
   */
  private reportFault(_error: unknown): void {
    const fault = new Error(SAFE_PUBLICATION_SCHEDULER_FAULT);
    try {
      if (this.options.onFault) {
        this.options.onFault(fault);
      } else {
        process.stderr.write(`[Blogbot] ${SAFE_PUBLICATION_SCHEDULER_FAULT}\n`);
      }
    } catch {
      // Diagnostics must not stop the durable scheduler.
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<PublicationSchedulerResult> {
    if (this.stopped || this.tickInFlight) return { enqueued: [], skipped: [] };
    this.tickInFlight = true;
    try {
      const result: PublicationSchedulerResult = { enqueued: [], skipped: [] };
      const now = this.now();
      const indexedRead = Boolean(this.backend.listDueRevisionIds && this.backend.listRevisionLineage);
      const snapshot = indexedRead ? undefined : (await this.backend.sync(0)).snapshot;
      if (this.stopped) return result;
      const existingPublicationKeys = new Set((indexedRead
        ? await this.backend.listOutbox()
        : snapshot!.outbox).map((effect) => effect.idempotencyKey));
      const capabilities = deriveAutomationCapabilities(indexedRead
        ? await this.backend.getAutomation()
        : snapshot!.automation);
      const lineage = indexedRead
        ? await this.backend.listRevisionLineage!()
        : snapshot!.revisions;
      if (this.stopped) return result;
      const dueRevisionIds: string[] = [];
      if (indexedRead) {
        const pageSize = 100;
        for (let offset = 0; ; offset += pageSize) {
          const page = await this.backend.listDueRevisionIds!(now.getTime(), pageSize, offset);
          dueRevisionIds.push(...page);
          if (page.length < pageSize) break;
        }
      }
      const revisions = indexedRead
        // A due-list index row can outlive the revision it points at. Reading
        // the batch with Promise.all made that single dangling id reject the
        // whole tick, so every other approved revision stayed unpublished.
        ? (await Promise.all(dueRevisionIds.map(async (id) => {
            try {
              return [await this.backend.getRevision(id)];
            } catch {
              return [];
            }
          }))).flat()
        : snapshot!.revisions.filter((revision) => Date.parse(revision.scheduledAt) <= now.getTime());
      for (const revision of revisions) {
        if (this.stopped) return result;
        // One unschedulable revision must never stop the whole workspace from
        // publishing. Every read here can reject on its own (a dangling due-list
        // row, a decrypt failure, a reused idempotency key), and an uncaught
        // throw aborted the entire tick — so no later revision was ever
        // scheduled, on this tick or any following one.
        try {
          if (await this.backend.getApprovalRevocation(revision.id)) {
            result.skipped.push({ revisionId: revision.id, reason: "APPROVAL_REVOKED" });
            continue;
          }
          const approval = indexedRead
            ? await this.backend.getApproval(revision.id)
            : snapshot!.approvals.find((item) => item.revisionId === revision.id) ?? null;
          const highRisk = indexedRead
            ? (await this.backend.getHighRiskApproval?.(revision.id)) ?? null
            : snapshot!.highRiskApprovals.find((item) => item.revisionId === revision.id) ?? null;
          const approvalBundle: ApprovalBundle | null = approval ? { editorial: approval, highRisk } : null;
          const eligibility = evaluatePublishEligibility(revision, approvalBundle, {
            now,
            publishingPaused: !capabilities.canPublishApproved,
            revisionLineage: lineage
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
          const previewRecord = preview as { revisionHash?: unknown; previewHash?: unknown; expiresAtUnixMs?: unknown };
          // A stored preview can carry the approved revision hash and still have
          // no usable preview hash: it may predate the current record shape, or
          // have been written through `LOCAL_STATE.SET`, which accepts any key.
          // The intent binding below rejects such a record by throwing, which
          // turned a regenerable preview into an opaque scheduling fault, so the
          // preflight has to cover every field the binding requires.
          if (previewRecord.revisionHash !== revisionHash
            || typeof previewRecord.previewHash !== "string"
            || !/^[a-f0-9]{64}$/iu.test(previewRecord.previewHash)
            || !Number.isSafeInteger(previewRecord.expiresAtUnixMs)
            || Number(previewRecord.expiresAtUnixMs) <= now.getTime()) {
            result.skipped.push({ revisionId: revision.id, reason: "PREVIEW_STALE" });
            continue;
          }
          const binding = publicationIntentBinding(revision, previewRecord);
          // The key must cover every input in the fingerprint. Regenerating a
          // preview keeps the approved revision hash but changes the bundle
          // bytes; a key that omitted previewHash would reuse the stored key
          // with a new fingerprint, and `runIdempotent` rejects that
          // permanently. The outbox itself dedupes on revision/hash/preview, so
          // a per-preview key still cannot create a duplicate external effect.
          const key = `scheduler:publication:${revision.id}:${revisionHash}:${binding.previewHash}`;
          if (this.stopped) return result;
          const effect = await this.backend.runIdempotent(
            key,
            `${revisionHash}:${binding.previewHash}`,
            (transaction) => transaction.enqueuePublication(revision.id, revisionHash, binding)
          );
          if (this.stopped) return result;
          if (!existingPublicationKeys.has(effect.idempotencyKey)) {
            result.enqueued.push(revision.id);
            existingPublicationKeys.add(effect.idempotencyKey);
          }
        } catch (error) {
          result.skipped.push({ revisionId: revision.id, reason: "SCHEDULING_FAILED" });
          this.reportFault(error);
        }
      }
      return result;
    } finally {
      this.tickInFlight = false;
    }
  }
}
