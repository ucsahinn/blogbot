import type {
  BackendRepository
} from "../../../packages/database/src/backend-repository.ts";
import type {
  SourceRepository,
  SourceScanTarget
} from "../../../packages/database/src/source-repository.ts";
import { deriveAutomationCapabilities } from "../../../packages/editorial/src/automation.ts";
import type { SourceScanCoordinator } from "./source-scan.ts";

export interface SourceScanSchedulerOptions {
  /** Receives only a redacted scheduler diagnostic code. */
  onFault?(error: Error): void;
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
  private lastBucket: string | undefined;

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
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.pollMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private runTick(): void {
    void this.tick().catch(() => {
      const error = new Error(SAFE_SOURCE_SCHEDULER_FAULT);
      try {
        if (this.options.onFault) {
          this.options.onFault(error);
        } else {
          process.stderr.write(`[Blogbot] ${SAFE_SOURCE_SCHEDULER_FAULT}\n`);
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

  async tick(): Promise<boolean> {
    if (this.tickInFlight) return false;
    this.tickInFlight = true;
    try {
      const settings = await this.backend.getAutomation();
      const capabilities = deriveAutomationCapabilities(settings);
      if (!capabilities.canIngest) return false;

      const intervalMs = Math.max(5, settings.scanIntervalMinutes) * 60_000;
      const nowMs = this.now().getTime();
      const bucket = Math.floor(nowMs / intervalMs).toString(10);
      if (bucket === this.lastBucket) return false;

      const targets: SourceScanTarget[] = (await this.sources.listSources())
        .filter((source) => source.status === "ACTIVE")
        .map((source) => ({ sourceId: source.id, expectedVersion: source.version }));
      if (targets.length === 0) return false;

      const key = `scheduler:source-scan:${bucket}`;
      await this.coordinator.enqueue({
        version: 1,
        requestId: key,
        idempotencyKey: key,
        expectedVersion: 0,
        kind: "SOURCE.SCAN",
        payload: { targets }
      });
      this.lastBucket = bucket;
      return true;
    } finally {
      this.tickInFlight = false;
    }
  }
}
