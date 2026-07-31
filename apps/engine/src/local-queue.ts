import { createHash } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import {
  fromPglite,
  PgBoss,
  type Job,
  type JobWithMetadata
} from "pg-boss";

import { canonicalJson } from "../../../packages/editorial/src/revision.ts";

export type LocalQueueName =
  | "blogbot.source-scan"
  | "blogbot.ingest"
  | "blogbot.draft"
  | "blogbot.codex"
  | "blogbot.publish";

const QUEUE_PLANS: ReadonlyArray<{
  name: LocalQueueName;
  deadLetter: string;
  retryLimit: number;
  retryDelay: number;
  expireInSeconds: number;
}> = [
  {
    name: "blogbot.source-scan",
    deadLetter: "blogbot.source-scan.dead",
    retryLimit: 5,
    retryDelay: 30,
    expireInSeconds: 300
  },
  {
    name: "blogbot.ingest",
    deadLetter: "blogbot.ingest.dead",
    retryLimit: 5,
    retryDelay: 30,
    expireInSeconds: 300
  },
  {
    name: "blogbot.draft",
    deadLetter: "blogbot.draft.dead",
    retryLimit: 4,
    retryDelay: 60,
    expireInSeconds: 900
  },
  {
    name: "blogbot.codex",
    deadLetter: "blogbot.codex.dead",
    retryLimit: 3,
    retryDelay: 120,
    expireInSeconds: 1_800
  },
  {
    name: "blogbot.publish",
    deadLetter: "blogbot.publish.dead",
    retryLimit: 8,
    retryDelay: 30,
    expireInSeconds: 600
  }
] as const;

export class LocalQueueRuntime {
  private readonly boss: PgBoss;
  private bossStarted = false;
  private started = false;

  constructor(database: PGlite) {
    this.boss = new PgBoss({
      backend: "pglite",
      db: fromPglite(database),
      application_name: "blogbot-local-engine",
      useListenNotify: true,
      schedule: true,
      supervise: true
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    try {
      await this.boss.start();
      this.bossStarted = true;
      for (const plan of QUEUE_PLANS) {
        await this.boss.createQueue(plan.deadLetter, {
          retryLimit: 0,
          deleteAfterSeconds: 2_592_000,
          retentionSeconds: 7_776_000
        });
        await this.boss.createQueue(plan.name, {
          deadLetter: plan.deadLetter,
          retryLimit: plan.retryLimit,
          retryDelay: plan.retryDelay,
          retryBackoff: true,
          retryDelayMax: 3_600,
          expireInSeconds: plan.expireInSeconds,
          retentionSeconds: 1_209_600,
          deleteAfterSeconds: 604_800,
          warningQueueSize: 1_000
        });
      }
      this.started = true;
    } catch (error) {
      if (this.bossStarted) {
        await this.boss.stop({ graceful: false });
        this.bossStarted = false;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.bossStarted) return;
    await this.boss.stop({ graceful: true, timeout: 10_000 });
    this.bossStarted = false;
    this.started = false;
  }

  async enqueue(
    name: LocalQueueName,
    data: object,
    idempotencyKey: string
  ): Promise<string> {
    this.assertStarted();
    const id = deterministicJobId(idempotencyKey);
    const existing = await this.boss.getJobById<object>(name, id);
    if (existing) {
      assertSameJobPayload(existing.data, data);
      return id;
    }
    const created = await this.boss.send(name, data, { id });
    if (created) return created;
    const raced = await this.boss.getJobById<object>(name, id);
    if (!raced) {
      throw new Error("QUEUE_IDEMPOTENCY_RECONCILIATION_FAILED");
    }
    assertSameJobPayload(raced.data, data);
    return id;
  }

  async getJob<T extends object>(
    name: LocalQueueName,
    id: string
  ): Promise<JobWithMetadata<T> | null> {
    this.assertStarted();
    return this.boss.getJobById<T>(name, id);
  }

  async work<T extends object>(
    name: LocalQueueName,
    handler: (job: Job<T>) => Promise<void>
  ): Promise<string> {
    this.assertStarted();
    return this.boss.work<T>(name, async (jobs) => {
      const job = jobs[0];
      if (job) {
        await handler(job);
      }
    });
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error("Local queue runtime is not started");
    }
  }
}

function assertSameJobPayload(existing: object, requested: object): void {
  if (canonicalJson(existing) !== canonicalJson(requested)) {
    throw new Error(
      "IDEMPOTENCY_KEY_REUSED: queue key already belongs to different payload"
    );
  }
}

function deterministicJobId(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex");
  const variant = (Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant.toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}
