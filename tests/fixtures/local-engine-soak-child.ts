import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, readFile, readdir, realpath, utimes } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { mock } from "node:test";

import { LocalQueueRuntime } from "../../apps/engine/src/local-queue.ts";
import { createConsistentAutomaticBackup, createPersistentEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";

interface MaintenanceState { state: string; succeededAt?: string }
export interface SoakSnapshot {
  ready: boolean;
  jobs: { id: string; label: string; state: string; attempts: number }[];
  effects: Record<string, number>;
  oldTerminalPresent: boolean;
  manualPreserved: boolean;
  networkAttempts: number;
  backups: { name: string; sha256: string; verified: boolean }[];
  automaticBackup: MaintenanceState | null;
  sourceRetention: MaintenanceState | null;
  maintenanceEvents: { key: string; state: string; at: number }[];
  maintenanceOverflow: boolean;
  runtimeStartedAt: number;
}

const [root, phase, mode, fault] = process.argv.slice(2);
assert.ok(root && isAbsolute(root) && /^blogbot-engine-soak-/u.test(basename(root)));
assert.ok(phase === "prepare" || phase === "recover");
assert.ok(mode === "preflight" || mode === "24h");
assert.equal((await lstat(root)).isSymbolicLink(), false);
assert.equal((await realpath(root)).toLowerCase(), root.toLowerCase());
assert.equal(process.env.BLOGBOT_DATA_KEY_HEX, "55".repeat(32), "synthetic fixture key required");
const dataDir = join(root, "pgdata");
const backupDirectory = join(dataDir, "backups");
const day = 24 * 60 * 60 * 1_000;

// Transparent observation of the real instance created by the real engine.
// There is no second PGlite connection to the same directory, fake database,
// changed production method or replacement maintenance timer.
const opened: PGliteBackendRepository[] = [];
const originalOpen = PGliteBackendRepository.open.bind(PGliteBackendRepository);
mock.method(PGliteBackendRepository, "open", async (directory: string) => {
  const repository = await originalOpen(directory);
  opened.push(repository);
  return repository;
});
let networkAttempts = 0;
const denyNetwork = async (): Promise<never> => {
  networkAttempts += 1;
  throw new Error("SOAK_NETWORK_FORBIDDEN");
};
if (fault === "prepare-network" && phase === "prepare") await denyNetwork().catch(() => undefined);
const runtimeStartedAt = Date.now();
const runtime = await createPersistentEngineProtocol(dataDir, {
  sourceTransport: { resolve: denyNetwork, request: denyNetwork },
  startSourceWorker: false, startSourceScheduler: true,
  startPublicationScheduler: false
});
mock.restoreAll();
assert.equal(opened.length, 1);
const repository = opened[0]!;
const database = repository.getDatabase();
const maintenanceEvents: SoakSnapshot["maintenanceEvents"] = [];
let maintenanceOverflow = false;
const originalMaintenance = repository.setMaintenanceState.bind(repository);
mock.method(repository, "setMaintenanceState", async (key: string, value: unknown) => {
  await originalMaintenance(key, value);
  if (key === "maintenance.automatic-backup" || key === "maintenance.source-retention") {
    if (maintenanceEvents.length < 32) {
      maintenanceEvents.push({ key, state: (value as MaintenanceState).state, at: Date.now() });
    } else maintenanceOverflow = true;
  }
});
const queue = new LocalQueueRuntime(database);
await queue.start();

if (phase === "prepare") {
  await repository.setLocalState("soak.effects", {});
  const due = await queue.enqueue("blogbot.ingest", { label: "due" }, "soak-due");
  const future = await queue.enqueue("blogbot.ingest", { label: "future" }, "soak-future",
    { startAfterSeconds: mode === "24h" ? 8 * 60 : 15 });
  const interrupted = await queue.enqueue("blogbot.ingest", { label: "interrupted" }, "soak-interrupted");
  const oldTerminal = await queue.enqueue("blogbot.ingest", { label: "old-terminal" }, "soak-old-terminal");
  await database.query("UPDATE blogbot_local_queue_jobs SET available_at_unix_ms = $2 WHERE id = $1", [due, Date.now() - 60_000]);
  await database.query("UPDATE blogbot_local_queue_jobs SET state = 'completed', updated_at_unix_ms = $2 WHERE id = $1",
    [oldTerminal, Date.now() - 40 * day]);
  await repository.setLocalState("soak.jobs", { due, future, interrupted, oldTerminal });

  // Every retained fixture is a valid encrypted archive, not placeholder text.
  // This seeding call does not set the automatic-maintenance success record.
  const seed = await createConsistentAutomaticBackup(database, dataDir);
  assert.equal(seed.ok, true, "SOAK_SEED_BACKUP_FAILED");
  assert.equal(typeof seed.outputPath, "string");
  const seedPath = seed.outputPath as string;
  const seedHash = createHash("sha256").update(await readFile(seedPath)).digest("hex");
  for (const age of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 30, 40, 50, 60, 70, 80, 90]) {
    const target = join(backupDirectory, `automatic-old-${age}.backup`);
    await copyFile(seedPath, target);
    const date = new Date(Date.now() - age * day);
    await utimes(target, date, date);
  }
  const manual = join(backupDirectory, "before-upgrade.backup");
  await copyFile(seedPath, manual);
  const manualDate = new Date(Date.now() - 300 * day);
  await utimes(manual, manualDate, manualDate);
  await repository.setLocalState("soak.manualHash", seedHash);
}

// Only the slow/external effect boundary is synthetic. Actual durable claim,
// attempt, completion and restart recovery all belong to LocalQueueRuntime.
await queue.work<{ label: string }>("blogbot.ingest", async (job) => {
  if (job.data.label === "interrupted" && phase === "prepare") {
    await new Promise<void>(() => {});
    return;
  }
  const effects = await repository.getLocalState("soak.effects") as Record<string, number>;
  effects[job.data.label] = (effects[job.data.label] ?? 0) + 1;
  await repository.setLocalState("soak.effects", effects);
});
if (phase === "recover") {
  // Replaying a completed enqueue must not create another effect. Compare
  // identity against the persisted result, not a reimplementation of hashing.
  const jobs = await repository.getLocalState("soak.jobs") as Record<string, string>;
  assert.equal(await queue.enqueue("blogbot.ingest", { label: "due" }, "soak-due"), jobs.due);
}

const verifiedHashes = new Set<string>();
async function snapshot(): Promise<SoakSnapshot> {
  const doctor = await runtime.handle({ version: 1, id: "soak-doctor", kind: "doctor" });
  const rows = await database.query<{ id: string; label: string; state: string; attempts: number }>(
    "SELECT id, payload->>'label' AS label, state, attempts FROM blogbot_local_queue_jobs ORDER BY id");
  const backups: SoakSnapshot["backups"] = [];
  for (const name of (await readdir(backupDirectory)).filter((entry) => /^automatic-[A-Za-z0-9-]+\.backup$/u.test(entry)).sort()) {
    const sha256 = createHash("sha256").update(await readFile(join(backupDirectory, name))).digest("hex");
    if (!verifiedHashes.has(sha256)) {
      const verified = await runtime.handle({ version: 1, id: "soak-verify", kind: "backup.auto.verify", payload: { backupName: name } });
      assert.equal(verified.ok, true, "SOAK_BACKUP_VERIFICATION_FAILED");
      assert.equal(verified.verified, true);
      verifiedHashes.add(sha256);
    }
    backups.push({ name, sha256, verified: true });
  }
  const manualHash = createHash("sha256").update(await readFile(join(backupDirectory, "before-upgrade.backup"))).digest("hex");
  return {
    ready: doctor.ok === true && doctor.status === "READY",
    jobs: rows.rows.filter((job) => job.label !== "old-terminal"),
    effects: await repository.getLocalState("soak.effects") as Record<string, number>,
    oldTerminalPresent: rows.rows.some((job) => job.label === "old-terminal"),
    manualPreserved: manualHash === await repository.getLocalState("soak.manualHash"),
    networkAttempts, backups, maintenanceEvents: [...maintenanceEvents], maintenanceOverflow, runtimeStartedAt,
    automaticBackup: (await repository.getLocalState("maintenance.automatic-backup") ?? null) as MaintenanceState | null,
    sourceRetention: (await repository.getLocalState("maintenance.source-retention") ?? null) as MaintenanceState | null
  };
}

let closing = false;
process.on("message", (message: { id: number; action: string }) => {
  void (async () => {
    try {
      let value: unknown;
      if (message.action === "snapshot") value = await snapshot();
      else if (message.action === "manual-backup" && mode === "preflight") {
        const result = await createConsistentAutomaticBackup(database, dataDir);
        assert.equal(result.ok, true);
        value = { ok: true };
      } else if (message.action === "exit-before-close" && mode === "preflight" && fault === "exit-before-close") {
        process.send?.({ id: message.id, value: { injected: true } }, () => process.exit(23));
        return;
      } else if (message.action === "close") {
        closing = true;
        await queue.stop();
        await runtime.close();
        value = { ok: true };
      } else throw new Error("SOAK_ACTION_DENIED");
      process.send?.({ id: message.id, value }, () => { if (closing) process.disconnect?.(); });
    } catch (error) {
      process.send?.({ id: message.id, error: error instanceof Error ? error.message.slice(0, 500) : "SOAK_CHILD_FAILED" });
    }
  })();
});
process.send?.({ ready: true });
