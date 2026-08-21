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
  const faults: Array<{ code: string; phase: string | undefined }> = [];
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
    { onFault: (error, phase) => faults.push({ code: error.message, phase }) }
  );

  scheduler.start();
  for (let attempt = 0; attempt < 40 && enqueued === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  scheduler.stop();

  assert.deepEqual(faults, [{ code: "SOURCE_SCHEDULER_UNAVAILABLE", phase: "automation" }]);
  assert.equal(enqueued, 1);
});

test("source scheduler reports one diagnostic for a persistent unavailable store", async () => {
  const faults: Array<{ code: string; phase: string | undefined }> = [];
  const backend = {
    getAutomation: async () => { throw new Error("database remains unavailable"); }
  } as never;
  const sources = { listSources: async () => [] } as never;
  const coordinator = { enqueue: async () => ({ batchKey: "unused", scans: [] }) } as never;
  const scheduler = new SourceScanScheduler(
    backend,
    sources,
    coordinator,
    () => new Date("2026-07-30T10:00:00.000Z"),
    5,
    { onFault: (error, phase) => faults.push({ code: error.message, phase }) }
  );

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 35));
  scheduler.stop();

  assert.deepEqual(faults, [{ code: "SOURCE_SCHEDULER_UNAVAILABLE", phase: "automation" }]);
});

test("source scheduler does not enqueue after stop cancels an in-flight catalog read", async () => {
  let releaseSources!: () => void;
  let catalogReadStarted!: () => void;
  const catalogRead = new Promise<void>((resolve) => { releaseSources = resolve; });
  const started = new Promise<void>((resolve) => { catalogReadStarted = resolve; });
  let enqueued = 0;
  const backend = {
    getAutomation: async () => ({
      mode: "INGEST_ONLY", onboardingComplete: true, ingestionPaused: false,
      publishingPaused: false, timezone: "Europe/Istanbul", scanIntervalMinutes: 30
    })
  } as never;
  const sources = {
    listSources: async () => {
      catalogReadStarted();
      await catalogRead;
      return [{ id: "source-1", version: 1, status: "ACTIVE" }];
    }
  } as never;
  const coordinator = {
    enqueue: async () => { enqueued += 1; return { batchKey: "unexpected", scans: [] }; }
  } as never;
  const scheduler = new SourceScanScheduler(backend, sources, coordinator, () => new Date("2026-07-30T10:00:00.000Z"), 60_000);

  scheduler.start();
  await started;
  scheduler.stop();
  releaseSources();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(enqueued, 0);
});

test("a source version change inside the window schedules again instead of stalling", async () => {
  const nowMs = Date.parse("2026-07-30T10:00:00.000Z");
  const keys: string[] = [];
  const used = new Set<string>();
  let version = 3;
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
    listSources: async () => [{ id: "source-1", version, status: "ACTIVE" }]
  } as never;
  // The durable store rejects a key that was already used with a different
  // request, which is exactly what a version bump produces.
  const coordinator = {
    enqueue: async (command: { idempotencyKey: string }) => {
      if (used.has(command.idempotencyKey)) {
        throw new Error("IDEMPOTENCY_KEY_REUSED: Idempotency key was already used with a different request");
      }
      used.add(command.idempotencyKey);
      keys.push(command.idempotencyKey);
      return { batchKey: "ok", scans: [] };
    }
  } as never;

  const first = new SourceScanScheduler(backend, sources, coordinator, () => new Date(nowMs));
  assert.equal(await first.tick(), true);

  // A completed scan bumps the source version. A key built from the time bucket
  // alone then described a different target list, so the store rejected it and
  // scanning stopped for the rest of the window.
  version = 4;
  const afterRestart = new SourceScanScheduler(backend, sources, coordinator, () => new Date(nowMs));
  assert.equal(await afterRestart.tick(), true, "a version change must still schedule");
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "the batch key must cover the scan targets");
});

test("an already-scheduled window is not reported as a store fault", async () => {
  const nowMs = Date.parse("2026-07-30T10:00:00.000Z");
  const faults: string[] = [];
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
    listSources: async () => [{ id: "source-1", version: 3, status: "ACTIVE" }]
  } as never;
  const coordinator = {
    enqueue: async () => {
      throw new Error("IDEMPOTENCY_KEY_REUSED: Idempotency key was already used with a different request");
    }
  } as never;
  const scheduler = new SourceScanScheduler(
    backend,
    sources,
    coordinator,
    () => new Date(nowMs),
    undefined,
    { onFault: (_error, phase) => faults.push(String(phase)) }
  );

  // Another process already claimed this window. That is not a fault, and
  // reporting it as one left the bucket unclaimed so every later tick repeated
  // the rejection.
  assert.equal(await scheduler.tick(), true);
  assert.deepEqual(faults, []);
});
