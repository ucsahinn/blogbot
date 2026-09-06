import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createOwnedTempRoot, type OwnedTempRoot } from "../helpers/owned-temp-root.ts";

interface Snapshot {
  rowCount: number;
  sealedCount: number;
  firstId: string;
  lastId: string;
  plaintextHash: string;
  firstPageCipherHash: string;
  ciphertextHash: string;
  schemaHash: string;
  sentinel: number | null;
  progress: Array<{ table_name: string; last_key: string }>;
  listIndexCount: number;
  outboxCount: number;
}

test("a real migration process kill preserves its committed page and resumes without changing data", {
  timeout: 150_000
}, async (t) => {
  const root = await createOwnedTempRoot(t, "blogbot-migration-crash-");
  const initial = await runPhase(root, "seed", "seed");
  assert.equal(initial.rowCount, 401);
  assert.equal(initial.sealedCount, 0);
  assert.equal(initial.firstId, "legacy-000000");
  assert.equal(initial.lastId, "legacy-000400");
  assert.equal(initial.sentinel, null);
  assert.deepEqual(initial.progress, []);
  await cp(join(root.path, "seed"), join(root.path, "baseline"), { recursive: true, force: false, errorOnExist: true });
  await cp(join(root.path, "seed"), join(root.path, "interrupted"), { recursive: true, force: false, errorOnExist: true });

  const baseline = await runPhase(root, "normal", "baseline");
  assertCompleted(baseline, initial);
  const interrupted = await interruptAtBarrier(root, "interrupt", "interrupted");
  assert.equal(interrupted.sealedCount, 200);
  assert.equal(interrupted.listIndexCount, 0);
  assert.deepEqual(interrupted.progress, [{ table_name: "blogbot_revisions", last_key: "legacy-000199" }]);
  assert.equal(interrupted.plaintextHash, initial.plaintextHash);
  assert.equal(interrupted.schemaHash, initial.schemaHash);

  const recovered = await runPhase(root, "normal", "interrupted");
  assertCompleted(recovered, initial);
  assert.equal(recovered.plaintextHash, baseline.plaintextHash);
  assert.equal(recovered.firstPageCipherHash, interrupted.firstPageCipherHash,
    "already committed envelopes must not be resealed on resume");
  const reopened = await runPhase(root, "normal", "interrupted");
  assertCompleted(reopened, initial);
  assert.equal(reopened.ciphertextHash, recovered.ciphertextHash,
    "the completed migration sentinel must make a later startup idempotent");
  console.log(JSON.stringify({ verification: "SYNTHETIC_MIGRATION_CRASH_OBSERVATION", rows: 401,
    committedBeforeKill: interrupted.sealedCount, recoveredRows: recovered.rowCount,
    realLegacyProfileVerified: false, externalEffectsVerified: false }));
});

test("the migration crash verifier rejects termination after migration already completed", {
  timeout: 90_000
}, async (t) => {
  const root = await createOwnedTempRoot(t, "blogbot-migration-crash-");
  await runPhase(root, "seed", "seed");
  await cp(join(root.path, "seed"), join(root.path, "completed"), { recursive: true, force: false, errorOnExist: true });
  await assert.rejects(interruptAtBarrier(root, "late", "completed"), {
    message: "MIGRATION_NOT_INTERRUPTED"
  });
});

function assertCompleted(snapshot: Snapshot, original: Snapshot): void {
  assert.equal(snapshot.rowCount, 401);
  assert.equal(snapshot.sealedCount, 401);
  assert.equal(snapshot.firstId, "legacy-000000");
  assert.equal(snapshot.lastId, "legacy-000400");
  assert.equal(snapshot.plaintextHash, original.plaintextHash);
  assert.equal(snapshot.schemaHash, original.schemaHash);
  assert.equal(snapshot.sentinel, 2);
  assert.deepEqual(snapshot.progress, []);
  assert.equal(snapshot.listIndexCount, 401);
  assert.equal(snapshot.outboxCount, 0);
}

interface Terminal {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
}

function startPhase(root: OwnedTempRoot, phase: string, directory: string) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const child = spawn(process.execPath, [
    "--experimental-transform-types",
    fileURLToPath(new URL("../fixtures/legacy-migration-crash-child.ts", import.meta.url)),
    root.path, phase, directory
  ], {
    cwd: root.path, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      SystemRoot: systemRoot, WINDIR: systemRoot,
      PATH: dirname(process.execPath) + ";" + join(systemRoot, "System32"),
      TEMP: root.path, TMP: root.path, USERPROFILE: root.path,
      LOCALAPPDATA: root.path, APPDATA: root.path,
      CODEX_HOME: join(root.path, "empty-codex-home"),
      BLOGBOT_MIGRATION_TEST_PARENT_TMP: tmpdir(),
      BLOGBOT_DATA_KEY_HEX: "77".repeat(32), NODE_ENV: "test"
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-65_536); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
  let terminal: Terminal | undefined;
  let spawnError: Error | undefined;
  const done = new Promise<Terminal>((resolveDone) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      terminal ??= { code, signal, error: spawnError };
      resolveDone(terminal);
    };
    child.once("error", (error: Error) => {
      spawnError = error;
      if (child.pid === undefined) finish(null, null);
    });
    child.once("close", finish);
  });
  const stop = root.track(async () => {
    if (!terminal && child.pid !== undefined) child.kill("SIGKILL");
    await bounded(done, 10_000, "MIGRATION_CHILD_CLEANUP_TIMEOUT");
  });
  return { child, done, stop, get terminal() { return terminal; },
    get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function runPhase(root: OwnedTempRoot, phase: string, directory: string): Promise<Snapshot> {
  const running = startPhase(root, phase, directory);
  try {
    const result = await bounded(running.done, 45_000, "MIGRATION_CHILD_TIMEOUT");
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, "MIGRATION_CHILD_FAILED: " + running.stderr);
    return JSON.parse(running.stdout.trim()) as Snapshot;
  } finally {
    await running.stop();
  }
}

async function interruptAtBarrier(root: OwnedTempRoot, phase: "interrupt" | "late",
  directory: string): Promise<Snapshot> {
  const running = startPhase(root, phase, directory);
  try {
    const marker = join(root.path, directory + ".barrier.json");
    const deadline = Date.now() + 45_000;
    let observed = false;
    while (Date.now() < deadline) {
      if (running.terminal) throw new Error("MIGRATION_FINISHED_BEFORE_BARRIER");
      try {
        const value = JSON.parse(await readFile(marker, "utf8")) as { barrier?: string };
        assert.equal(value.barrier, "owned-migration-child");
        observed = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(50);
    }
    assert.equal(observed, true, "MIGRATION_BARRIER_TIMEOUT");
    assert.equal(running.child.kill("SIGKILL"), true);
    const terminal = await bounded(running.done, 10_000, "MIGRATION_KILL_TIMEOUT");
    assert.equal(terminal.error, undefined);
    assert.ok(terminal.code !== 0 || terminal.signal !== null, "owned termination must not be a clean exit");
    const snapshot = await runPhase(root, "inspect", directory);
    if (snapshot.sentinel !== null || snapshot.sealedCount === 0
      || snapshot.sealedCount >= snapshot.rowCount || snapshot.progress.length === 0) {
      throw new Error("MIGRATION_NOT_INTERRUPTED");
    }
    return snapshot;
  } finally {
    await running.stop();
  }
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
