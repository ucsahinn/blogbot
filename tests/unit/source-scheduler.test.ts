import test from "node:test";
import assert from "node:assert/strict";

import { SourceScanScheduler } from "../../apps/engine/src/source-scheduler.ts";

test("source scheduler enqueues one idempotent batch per configured interval", async () => {
  let nowMs = Date.parse("2026-07-30T10:00:00.000Z");
  const calls: unknown[] = [];
  const backend = {
    getAutomation: async () => ({
      mode: "INGEST_ONLY",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: false,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    })
  } as never;
  const sources = {
    listSources: async () => [
      { id: "source-1", version: 3, status: "ACTIVE" },
      { id: "disabled", version: 1, status: "DISABLED" }
    ]
  } as never;
  const coordinator = {
    enqueue: async (command: unknown) => { calls.push(command); return { batchKey: "ok", scans: [] }; }
  } as never;
  const scheduler = new SourceScanScheduler(
    backend,
    sources,
    coordinator,
    () => new Date(nowMs)
  );

  assert.equal(await scheduler.tick(), true);
  assert.equal(await scheduler.tick(), false);
  nowMs += 31 * 60_000;
  assert.equal(await scheduler.tick(), true);
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[0] as { payload: { targets: unknown[] } }).payload.targets, [
    { sourceId: "source-1", expectedVersion: 3 }
  ]);
});

test("source scheduler remains idle while ingestion is paused or disabled", async () => {
  let calls = 0;
  const backend = {
    getAutomation: async () => ({
      mode: "OFF",
      onboardingComplete: true,
      ingestionPaused: false,
      publishingPaused: false,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30
    })
  } as never;
  const sources = { listSources: async () => [{ id: "source-1", version: 1, status: "ACTIVE" }] } as never;
  const coordinator = { enqueue: async () => { calls += 1; return { batchKey: "x", scans: [] }; } } as never;
  const scheduler = new SourceScanScheduler(backend, sources, coordinator);
  assert.equal(await scheduler.tick(), false);
  assert.equal(calls, 0);
});

test("source scheduler reports a transient store fault and resumes the next interval", async () => {
  let reads = 0;
  let enqueued = 0;
  const faults: string[] = [];
  const backend = {
    getAutomation: async () => {
      reads += 1;
      if (reads === 1) throw new Error("database temporarily unavailable");
      return { mode: "DRAFT_ONLY", ingestionPaused: false, publishingPaused: false, scanIntervalMinutes: 5 };
    }
  } as never;
  const sources = {
    listSources: async () => [{ id: "source-recovery", version: 1, status: "ACTIVE" }]
  } as never;
  const coordinator = {
    enqueue: async () => { enqueued += 1; return { batchKey: "recovered", scans: [] }; }
  } as never;
  const scheduler = new SourceScanScheduler(
    backend,
    sources,
    coordinator,
    () => new Date("2026-07-30T10:00:00.000Z"),
    5,
    { onFault: (error) => faults.push(error.message) }
  );

  scheduler.start();
  for (let attempt = 0; attempt < 40 && enqueued === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  scheduler.stop();

  assert.deepEqual(faults, ["SOURCE_SCHEDULER_UNAVAILABLE"]);
  assert.equal(enqueued, 1);
});
