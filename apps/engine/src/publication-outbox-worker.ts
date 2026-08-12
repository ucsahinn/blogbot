import type { BackendRepository, OutboxEffect } from "../../../packages/database/src/backend-repository.ts";

export interface PublicationEffectProcessor {
  process(effect: OutboxEffect): Promise<{
    state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
    resultRef?: string;
    lastError?: string;
    /** Explicit connector retry advice; bounded by the local worker policy. */
    retryAfterMs?: number;
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
  /** Base duration for exponential retry backoff. Defaults to five seconds. */
  retryBaseMs?: number;
}

const MAX_TRANSIENT_PUBLICATION_ATTEMPTS = 3;
const SAFE_OUTBOX_FAULT = "OUTBOX_STORAGE_UNAVAILABLE";
const DEFAULT_RETRY_BASE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

function retryDelayMs(attempt: number, requested: number | undefined, baseMs: number): number {
  if (Number.isSafeInteger(requested) && requested! >= 0) {
    return Math.min(requested!, MAX_RETRY_DELAY_MS);
  }
  return Math.min(baseMs * (2 ** Math.max(0, attempt - 1)), MAX_RETRY_DELAY_MS);
}

function isRetryDue(effect: OutboxEffect, nowMs: number): boolean {
  if (effect.state === "PENDING" || effect.state === "IN_PROGRESS") return true;
  if (effect.state !== "UNKNOWN" || !effect.nextAttemptAt) return effect.state === "UNKNOWN";
  const deadlineMs = Date.parse(effect.nextAttemptAt);
  return !Number.isFinite(deadlineMs) || deadlineMs <= nowMs;
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
  intervalMs = 1_000,
  options: PublicationOutboxWorkerOptions = {}
): PublicationOutboxWorker {
  let running = true;
  let active = false;
  const retryBaseMs = Number.isSafeInteger(options.retryBaseMs) && options.retryBaseMs! >= 0
    ? options.retryBaseMs!
    : DEFAULT_RETRY_BASE_MS;
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
      const nowMs = Date.now();
      for (const effect of effects.filter((item) => isRetryDue(item, nowMs))) {
        if (!running) break;
        const claimed = await repository.updateOutbox({ ...effect, state: "IN_PROGRESS", attempts: effect.attempts + 1 });
        try {
          const result = await processor.process(claimed);
          const { nextAttemptAt: _previousRetryDeadline, ...withoutPreviousRetryDeadline } = claimed;
          const terminalUnknown = result.state === "UNKNOWN" && claimed.attempts >= MAX_TRANSIENT_PUBLICATION_ATTEMPTS;
          const nextAttemptAt = result.state === "UNKNOWN" && !terminalUnknown
            ? new Date(Date.now() + retryDelayMs(claimed.attempts, result.retryAfterMs, retryBaseMs)).toISOString()
            : undefined;
          await repository.updateOutbox({
            ...withoutPreviousRetryDeadline,
            state: terminalUnknown ? "FAILED" : result.state,
            ...(nextAttemptAt ? { nextAttemptAt } : {}),
            ...(result.resultRef ? { resultRef: result.resultRef } : {}),
            ...(result.lastError ? { lastError: result.lastError } : {}),
            ...(result.state === "SUCCEEDED" ? { completedAt: new Date().toISOString() } : {})
          });
        } catch (error) {
          const { nextAttemptAt: _previousRetryDeadline, ...withoutPreviousRetryDeadline } = claimed;
          const terminalFailure = claimed.attempts >= MAX_TRANSIENT_PUBLICATION_ATTEMPTS;
          const nextAttemptAt = terminalFailure
            ? undefined
            : new Date(Date.now() + retryDelayMs(claimed.attempts, undefined, retryBaseMs)).toISOString();
          await repository.updateOutbox({
            ...withoutPreviousRetryDeadline,
            // A process crash or transient connector outage must be visible
            // and reclaimable after restart. The idempotency key prevents the
            // retry from creating a duplicate external effect. Bound retries
            // so a persistent programming or configuration error becomes an
            // explicit terminal failure instead of an endless tight loop.
            state: terminalFailure ? "FAILED" : "UNKNOWN",
            ...(nextAttemptAt ? { nextAttemptAt } : {}),
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
