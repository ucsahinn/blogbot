import { createHash } from "node:crypto";

import type {
  BackendRepository
} from "../../../packages/database/src/backend-repository.ts";
import type {
  SourceRepository,
  SourceScanTarget
} from "../../../packages/database/src/source-repository.ts";
import { deriveAutomationCapabilities } from "../../../packages/editorial/src/automation.ts";
import { canonicalJson } from "../../../packages/editorial/src/revision.ts";
import type { SourceScanCoordinator } from "./source-scan.ts";

export interface SourceScanSchedulerOptions {
  /** Receives only a redacted scheduler diagnostic code. */
  onFault?(error: Error, phase?: "automation" | "catalog" | "queue"): void;
}

const SAFE_SOURCE_SCHEDULER_FAULT = "SOURCE_SCHEDULER_UNAVAILABLE";

/**
 * Owns the local recurring source scan. It is deliberately a timer in the
 * engine process: when Windows is off no work is claimed, and on restart the
 * durable scan queue recovers without creating a duplicate batch.
 */
export class SourceScanScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;
  private stopped = false;
  private lastBucket: string | undefined;
  private faultReported = false;

  constructor(
    private readonly backend: BackendRepository,
    private readonly sources: SourceRepository,
    private readonly coordinator: SourceScanCoordinator,
    private readonly now: () => Date = () => new Date(),
    private readonly pollMs = 60_000,
    private readonly options: SourceScanSchedulerOptions = {}
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.pollMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private runTick(): void {
    void this.tick()
      .then(() => {
        this.faultReported = false;
      })
      .catch((_error: unknown) => {
        if (this.faultReported) return;
        this.faultReported = true;
        try {
          if (this.options.onFault) {
            this.options.onFault(new Error(SAFE_SOURCE_SCHEDULER_FAULT), this.lastFaultPhase);
          } else {
            process.stderr.write(`[Blogbot] ${SAFE_SOURCE_SCHEDULER_FAULT}\n`);
          }
        } catch {
          // Diagnostics must not stop the durable scheduler.
        }
      });
  }

  private lastFaultPhase: "automation" | "catalog" | "queue" | undefined;

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<boolean> {
    if (this.stopped || this.tickInFlight) return false;
    this.tickInFlight = true;
    try {
      this.lastFaultPhase = "automation";
      const settings = await this.backend.getAutomation();
      if (this.stopped) return false;
      const capabilities = deriveAutomationCapabilities(settings);
      if (!capabilities.canIngest) return false;

      const intervalMs = Math.max(5, settings.scanIntervalMinutes) * 60_000;
      const nowMs = this.now().getTime();
      const bucket = Math.floor(nowMs / intervalMs).toString(10);
      if (bucket === this.lastBucket) return false;

      this.lastFaultPhase = "catalog";
      const targets: SourceScanTarget[] = (await this.sources.listSources())
        .filter((source) => source.status === "ACTIVE")
        .map((source) => ({ sourceId: source.id, expectedVersion: source.version }));
      if (this.stopped) return false;
      if (targets.length === 0) return false;

      // The batch key must cover everything the stored request fingerprint
      // covers. A successful scan bumps the source version, so a key made from
      // the time bucket alone described a different target list after the very
      // first scan; the in-memory bucket guard hid that until a restart, and
      // then every tick in the window was rejected as a reused key. Covering
      // the targets costs at most one extra batch per window after a version
      // change, and never stalls scanning.
      const key = `scheduler:source-scan:${bucket}:${scanTargetsFingerprint(targets)}`;
      this.lastFaultPhase = "queue";
      if (this.stopped) return false;
      try {
        await this.coordinator.enqueue({
          version: 1,
          requestId: key,
          idempotencyKey: key,
          expectedVersion: 0,
          kind: "SOURCE.SCAN",
          payload: { targets }
        });
      } catch (error) {
        // A key that already belongs to another request means this window was
        // scheduled; it is not a store fault. Treating it as one left the
        // bucket unclaimed and made every later tick repeat the rejection.
        if (!(error instanceof Error) || !error.message.includes("IDEMPOTENCY_KEY_REUSED")) throw error;
      }
      if (this.stopped) return false;
      this.lastBucket = bucket;
      return true;
    } finally {
      this.tickInFlight = false;
    }
  }
}

function scanTargetsFingerprint(targets: SourceScanTarget[]): string {
  return createHash("sha256").update(canonicalJson(targets)).digest("hex");
}
