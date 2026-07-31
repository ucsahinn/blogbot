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

/**
 * Reconciles durable publication intents without ever creating a second
 * effect for the same idempotency key. The real GitHub/hosting connector is
 * injected by the desktop host; without it, intents remain visibly pending
 * instead of being falsely marked as published.
 */
export function startPublicationOutboxWorker(
  repository: BackendRepository,
  processor: PublicationEffectProcessor,
  intervalMs = 1_000
): PublicationOutboxWorker {
  let running = true;
  let active = false;
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
            state: "FAILED",
            lastError: error instanceof Error ? error.message.slice(0, 512) : "Publication processor failed"
          });
        }
      }
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return {
    stop() {
      running = false;
      clearInterval(timer);
    }
  };
}
