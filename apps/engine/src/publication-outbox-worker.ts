import type { BackendRepository, OutboxEffect } from "../../../packages/database/src/backend-repository.ts";

export interface PublicationEffectProcessor {
  process(effect: OutboxEffect): Promise<{
    state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
    resultRef?: string;
    lastError?: string;
  }>;
}

export interface PublicationOutboxWorker {
  stop(): void;
}

export interface PublicationOutboxWorkerOptions {
  /**
   * Receives a redacted diagnostic error when storage bookkeeping itself
   * fails. This must never receive a connector response or raw database
   * detail because it can reach local support diagnostics.
   */
  onFault?(error: Error): void;
}

const MAX_TRANSIENT_PUBLICATION_ATTEMPTS = 3;
const SAFE_OUTBOX_FAULT = "OUTBOX_STORAGE_UNAVAILABLE";

/**
 * Reconciles durable publication intents without ever creating a second
 * effect for the same idempotency key. The real GitHub/hosting connector is
 * injected by the desktop host; without it, intents remain visibly pending
 * instead of being falsely marked as published.
 */
export function startPublicationOutboxWorker(
  repository: BackendRepository,
  processor: PublicationEffectProcessor,
  intervalMs = 1_000,
  options: PublicationOutboxWorkerOptions = {}
): PublicationOutboxWorker {
  let running = true;
  let active = false;
  const reportFault = () => {
    const safeError = new Error(SAFE_OUTBOX_FAULT);
    try {
      if (options.onFault) {
        options.onFault(safeError);
      } else {
        // The engine bridge captures stderr in its redacted local diagnostics.
        // Keep stdout exclusively for the versioned NDJSON protocol.
        process.stderr.write(`[Blogbot] ${SAFE_OUTBOX_FAULT}\n`);
      }
    } catch {
      // A diagnostic sink must never take down the durable worker.
    }
  };
  const tick = async () => {
    if (!running || active) return;
    active = true;
    try {
      const effects = await repository.listOutbox();
      // IN_PROGRESS is reclaimable after a process crash because the worker
      // is single-writer and the external processor is idempotency-keyed.
      for (const effect of effects.filter((item) => item.state === "PENDING" || item.state === "UNKNOWN" || item.state === "IN_PROGRESS")) {
        if (!running) break;
        const claimed = await repository.updateOutbox({ ...effect, state: "IN_PROGRESS", attempts: effect.attempts + 1 });
        try {
          const result = await processor.process(claimed);
          await repository.updateOutbox({
            ...claimed,
            state: result.state,
            ...(result.resultRef ? { resultRef: result.resultRef } : {}),
            ...(result.lastError ? { lastError: result.lastError } : {}),
            ...(result.state === "SUCCEEDED" ? { completedAt: new Date().toISOString() } : {})
          });
        } catch (error) {
          await repository.updateOutbox({
            ...claimed,
            // A process crash or transient connector outage must be visible
            // and reclaimable after restart. The idempotency key prevents the
            // retry from creating a duplicate external effect. Bound retries
            // so a persistent programming or configuration error becomes an
            // explicit terminal failure instead of an endless tight loop.
            state: claimed.attempts >= MAX_TRANSIENT_PUBLICATION_ATTEMPTS ? "FAILED" : "UNKNOWN",
            lastError: error instanceof Error ? error.message.slice(0, 512) : "Publication processor failed"
          });
        }
      }
    } finally {
      active = false;
    }
  };
  const runTick = () => { void tick().catch(reportFault); };
  const timer = setInterval(runTick, intervalMs);
  timer.unref?.();
  runTick();
  return {
    stop() {
      running = false;
      clearInterval(timer);
    }
  };
}
