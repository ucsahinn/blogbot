import { createHash, randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

import { canonicalJson } from "../../../packages/editorial/src/revision.ts";

export type LocalQueueName =
  | "blogbot.source-scan"
  | "blogbot.ingest"
  | "blogbot.draft"
  | "blogbot.codex"
  | "blogbot.publish";

const POLL_MS = 500;
const STOP_WAIT_MS = 10_000;

const QUEUE_PLANS: Record<LocalQueueName, { retryLimit: number; retryDelaySeconds: number }> = {
  "blogbot.source-scan": { retryLimit: 5, retryDelaySeconds: 30 },
  "blogbot.ingest": { retryLimit: 5, retryDelaySeconds: 30 },
  "blogbot.draft": { retryLimit: 4, retryDelaySeconds: 60 },
  "blogbot.codex": { retryLimit: 3, retryDelaySeconds: 120 },
  "blogbot.publish": { retryLimit: 8, retryDelaySeconds: 30 }
};

interface QueueRow {
  id: string;
  queue_name: LocalQueueName;
  payload: unknown;
  state: "created" | "active" | "completed" | "failed";
  attempts: number;
  available_at_unix_ms: number;
}

interface LocalJob<T extends object> {
  id: string;
  data: T;
  state: QueueRow["state"];
}

interface Worker<T extends object> {
  queue: LocalQueueName;
  handler: (job: LocalJob<T>) => Promise<void>;
  timer: ReturnType<typeof setInterval>;
  running: boolean;
}

/**
 * Minimal durable local queue owned by the embedded PGlite database. It avoids
 * pg-boss' secondary embedded connection and lifecycle loops, which can block
 * a desktop close indefinitely. The table is intentionally independent from
 * editorial state: queue recovery cannot invalidate an approval or revision.
 */
export class LocalQueueRuntime {
  private started = false;
  private stopping = false;
  private readonly workers = new Map<string, Worker<object>>();
  private readonly activeRuns = new Set<Promise<void>>();

  constructor(private readonly database: PGlite) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.database.exec(`
CREATE TABLE IF NOT EXISTS blogbot_local_queue_jobs (
  id text PRIMARY KEY,
  queue_name text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('created', 'active', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at_unix_ms bigint NOT NULL,
  updated_at_unix_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS blogbot_local_queue_claim_idx
  ON blogbot_local_queue_jobs (queue_name, state, available_at_unix_ms);
`);
    // One desktop engine owns this PGlite directory. If Windows closed while
    // a handler was active, make its durable reservation visible again.
    const now = Date.now();
    await this.database.query(
      "UPDATE blogbot_local_queue_jobs SET state = 'created', available_at_unix_ms = $1, updated_at_unix_ms = $1 WHERE state = 'active'",
      [now]
    );
    this.stopping = false;
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    for (const worker of this.workers.values()) clearInterval(worker.timer);
    this.workers.clear();
    const outstanding = Promise.allSettled([...this.activeRuns]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([outstanding, deadline]);
    if (timer) clearTimeout(timer);
    this.activeRuns.clear();
    this.started = false;
  }

  async enqueue(
    name: LocalQueueName,
    data: object,
    idempotencyKey: string,
    options?: { startAfterSeconds?: number }
  ): Promise<string> {
    this.assertStarted();
    const id = deterministicQueueJobId(idempotencyKey);
    const existing = await this.database.query<QueueRow>(
      "SELECT id, queue_name, payload, state, attempts, available_at_unix_ms FROM blogbot_local_queue_jobs WHERE id = $1",
      [id]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.queue_name !== name || canonicalJson(row.payload) !== canonicalJson(data)) {
        throw new Error("IDEMPOTENCY_KEY_REUSED: queue key already belongs to different payload");
      }
      return id;
    }
    const now = Date.now();
    await this.database.query(
      `INSERT INTO blogbot_local_queue_jobs
        (id, queue_name, payload, state, attempts, available_at_unix_ms, updated_at_unix_ms)
       VALUES ($1, $2, $3::jsonb, 'created', 0, $4, $5)`,
      [id, name, JSON.stringify(data), now + Math.max(0, options?.startAfterSeconds ?? 0) * 1_000, now]
    );
    return id;
  }

  async getJob<T extends object>(name: LocalQueueName, id: string): Promise<LocalJob<T> | null> {
    this.assertStarted();
    const result = await this.database.query<QueueRow>(
      "SELECT id, queue_name, payload, state, attempts, available_at_unix_ms FROM blogbot_local_queue_jobs WHERE id = $1 AND queue_name = $2",
      [id, name]
    );
    const row = result.rows[0];
    return row ? { id: row.id, data: structuredClone(row.payload) as T, state: row.state } : null;
  }

  async recoverInterrupted(name: LocalQueueName, id: string): Promise<boolean> {
    this.assertStarted();
    const result = await this.database.query<{ id: string }>(
      `UPDATE blogbot_local_queue_jobs
          SET state = 'created', available_at_unix_ms = $3, updated_at_unix_ms = $3
        WHERE id = $1 AND queue_name = $2 AND state = 'active'
        RETURNING id`,
      [id, name, Date.now()]
    );
    return Boolean(result.rows[0]);
  }

  async work<T extends object>(name: LocalQueueName, handler: (job: LocalJob<T>) => Promise<void>): Promise<string> {
    this.assertStarted();
    const id = randomUUID();
    const worker: Worker<T> = {
      queue: name,
      handler,
      timer: setInterval(() => { void this.poll(id); }, POLL_MS),
      running: false
    };
    worker.timer.unref?.();
    this.workers.set(id, worker as Worker<object>);
    void this.poll(id);
    return id;
  }

  private async poll(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker || worker.running || this.stopping || !this.started) return;
    worker.running = true;
    const run = this.runWorker(worker).finally(() => {
      worker.running = false;
      this.activeRuns.delete(run);
    });
    this.activeRuns.add(run);
    await run;
  }

  private async runWorker(worker: Worker<object>): Promise<void> {
    const job = await this.claim(worker.queue);
    if (!job || this.stopping) return;
    try {
      await worker.handler(job);
      await this.database.query(
        "UPDATE blogbot_local_queue_jobs SET state = 'completed', updated_at_unix_ms = $2 WHERE id = $1 AND state = 'active'",
        [job.id, Date.now()]
      );
    } catch {
      const plan = QUEUE_PLANS[worker.queue];
      const row = await this.database.query<{ attempts: number }>(
        "SELECT attempts FROM blogbot_local_queue_jobs WHERE id = $1",
        [job.id]
      );
      const attempts = row.rows[0]?.attempts ?? plan.retryLimit;
      const now = Date.now();
      const retryable = attempts <= plan.retryLimit && !this.stopping;
      await this.database.query(
        `UPDATE blogbot_local_queue_jobs
            SET state = $2, available_at_unix_ms = $3, updated_at_unix_ms = $4
          WHERE id = $1 AND state = 'active'`,
        [job.id, retryable ? "created" : "failed", retryable ? now + plan.retryDelaySeconds * 1_000 : now, now]
      );
    }
  }

  private async claim(name: LocalQueueName): Promise<LocalJob<object> | null> {
    const now = Date.now();
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<QueueRow>(
        `SELECT id, queue_name, payload, state, attempts, available_at_unix_ms
           FROM blogbot_local_queue_jobs
          WHERE queue_name = $1 AND state = 'created' AND available_at_unix_ms <= $2
          ORDER BY available_at_unix_ms, id
          LIMIT 1`,
        [name, now]
      );
      const row = selected.rows[0];
      if (!row) return null;
      const claimed = await transaction.query<{ id: string }>(
        `UPDATE blogbot_local_queue_jobs
            SET state = 'active', attempts = attempts + 1, updated_at_unix_ms = $2
          WHERE id = $1 AND state = 'created'
          RETURNING id`,
        [row.id, now]
      );
      return claimed.rows[0]
        ? { id: row.id, data: structuredClone(row.payload) as object, state: "active" as const }
        : null;
    });
  }

  private assertStarted(): void {
    if (!this.started) throw new Error("Local queue runtime is not started");
  }
}

export function deterministicQueueJobId(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex");
  const variant = (Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8;
  return [
    hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`,
    `${variant.toString(16)}${hex.slice(17, 20)}`, hex.slice(20, 32)
  ].join("-");
}
