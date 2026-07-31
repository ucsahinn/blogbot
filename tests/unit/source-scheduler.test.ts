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
