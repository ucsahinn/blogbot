import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createOwnedTempRoot } from "../helpers/owned-temp-root.ts";
import type { SoakSnapshot } from "../fixtures/local-engine-soak-child.ts";

const day = 24 * 60 * 60 * 1_000;
const mode = process.env.BLOGBOT_SOAK_MODE ?? "preflight";
assert.ok(mode === "preflight" || mode === "24h", "SOAK_MODE_INVALID");
const fault = process.env.BLOGBOT_SOAK_FAULT ?? "none";
assert.ok(["none", "prepare-network", "exit-before-close", "cleanup-failure", "spawn-error"].includes(fault));
assert.ok(mode === "preflight" || fault === "none", "fault injection is restricted to controller preflight");
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// This is an opt-in test, outside the ordinary integration glob. Preflight
// checks the controller/restart/retention path; it never claims 24-hour proof.
test(`local engine ${mode}: durable recovery, bounded retention and real timers`, {
  timeout: mode === "24h" ? day + 20 * 60_000 : 180_000
}, async (t) => {
  const owned = await createOwnedTempRoot(t, "blogbot-engine-soak-");
  // Register before children, so the owner helper's reverse-order fallback
  // always terminates them before trying to remove their disposable data.
  const cleanupRoot = owned.track(async () => {
    if (fault === "cleanup-failure") throw new Error("SOAK_INJECTED_CLEANUP_FAILURE");
    assert.equal(dirname(owned.path), resolve(tmpdir()));
    assert.match(basename(owned.path), /^blogbot-engine-soak-[A-Za-z0-9]+$/u);
    assert.equal((await lstat(owned.path)).isSymbolicLink(), false);
    assert.equal((await realpath(owned.path)).toLowerCase(), owned.path.toLowerCase());
    async function rejectReparse(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false, "SOAK_CLEANUP_REPARSE");
        if (entry.isDirectory()) await rejectReparse(join(directory, entry.name));
      }
    }
    await rejectReparse(owned.path);
    await rm(owned.path, { recursive: true, maxRetries: 20, retryDelay: 50 });
  });
  const evidenceDirectory = resolve(repositoryRoot, "build", "verification", "local-engine-soak",
    `${mode}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(evidenceDirectory, { recursive: true });
  const evidence = (entry: object) => appendFile(join(evidenceDirectory, "evidence.ndjson"),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  const sourceIdentity = await fingerprintSources();
  console.log(JSON.stringify({ mode, evidenceDirectory, scope: "synthetic-local-engine-no-network" }));
  await evidence({ status: "RUNNING", mode, owner: "current-codex-session", fixtureRootName: basename(owned.path),
    scope: "Real PGlite/engine timers; synthetic local queue effects. No GitHub, user profile or account.",
    minimumContinuousMs: mode === "24h" ? day : 30_000,
    maxHeartbeatGapMs: 90_000, nativeDesktopAcceptance: false,
    sourceIdentity, nodeVersion: process.version, platform: process.platform, architecture: process.arch });

  try {
    const first = await startChild(owned.path, "prepare");
    const stopFirst = owned.track(() => first.stop(true));
    const prepared = await waitForSnapshot(first, (state) =>
      state.jobs.some((job) => job.label === "due" && job.state === "completed")
      && state.jobs.some((job) => job.label === "interrupted" && job.state === "active"), 45_000);
    assert.equal(prepared.effects.due, 1);
    assert.equal(prepared.effects.interrupted, undefined);
    assert.equal(prepared.effects.future, undefined);
    assert.equal(prepared.oldTerminalPresent, true);
    assert.equal(prepared.manualPreserved, true);
    await evidence({ stage: "prepared", snapshot: prepared });

    let beforeRestart: SoakSnapshot;
    if (mode === "24h") {
      // Do not accelerate or manually invoke production maintenance here.
      beforeRestart = await waitForSnapshot(first,
        (state) => state.automaticBackup?.state === "SUCCEEDED", 7 * 60_000,
        (snapshot) => evidence({ stage: "waiting-for-real-overdue-catch-up", snapshot }));
    } else {
      await first.request("manual-backup");
      beforeRestart = await first.snapshot();
    }
    assertSnapshotSafety(beforeRestart);
    if (mode === "24h") {
      assert.deepEqual(beforeRestart.maintenanceEvents.filter((event) => event.key === "maintenance.automatic-backup")
        .map((event) => event.state), ["RUNNING", "SUCCEEDED"], "exactly one catch-up operation is required");
    }
    assert.ok(beforeRestart.backups.length < prepared.backups.length, "owned old snapshots must be pruned");
    assert.equal(beforeRestart.manualPreserved, true);
    assert.equal(beforeRestart.jobs.find((job) => job.label === "interrupted")?.attempts, 1);
    await evidence({ stage: "before-owned-child-termination", snapshot: beforeRestart });
    // Kill only the child created by this test, while its fixture handler is
    // active. The next real engine process must recover the persisted claim.
    await stopFirst();

    const second = await startChild(owned.path, "recover");
    const stopSecond = owned.track(() => second.stop(true));
    const recovered = await waitForSnapshot(second, (state) =>
      state.jobs.some((job) => job.label === "interrupted" && job.state === "completed"), 45_000);
    assert.equal(recovered.oldTerminalPresent, false, "startup must prune only old terminal jobs");
    for (const label of ["due", "future", "interrupted"]) {
      assert.equal(recovered.jobs.find((job) => job.label === label)?.id,
        prepared.jobs.find((job) => job.label === label)?.id, "restart must preserve durable job identity");
    }
    assert.equal(recovered.effects.due, 1, "completed work must not be delivered again");
    assert.equal(recovered.effects.interrupted, 1);
    assert.equal(recovered.jobs.find((job) => job.label === "interrupted")?.attempts, 2);
    if (mode === "24h") {
      assert.equal(recovered.automaticBackup?.succeededAt, beforeRestart.automaticBackup?.succeededAt);
    }
    await evidence({ stage: "recovered", snapshot: recovered });

    const continuousStart = Date.now();
    const monotonicStart = process.hrtime.bigint();
    const requiredDuration = mode === "24h" ? day + 60_000 : 30_000;
    let lastHeartbeat = continuousStart;
    let latest = recovered;
    const successfulBackups = new Set<string>();
    if (beforeRestart.automaticBackup?.succeededAt) successfulBackups.add(beforeRestart.automaticBackup.succeededAt);
    while (Date.now() - continuousStart < requiredDuration) {
      await delay(mode === "24h" ? 30_000 : 2_000);
      const now = Date.now();
      assert.ok(now >= lastHeartbeat && now - lastHeartbeat <= 90_000,
        "SOAK_HEARTBEAT_GAP: sleep, clock change or observation interruption is not continuous proof");
      const monotonicElapsedMs = Number(process.hrtime.bigint() - monotonicStart) / 1_000_000;
      assert.ok(Math.abs(now - continuousStart - monotonicElapsedMs) < 5_000, "SOAK_CLOCK_DISCONTINUITY");
      latest = await second.snapshot();
      assertSnapshotHealthy(latest);
      if (latest.automaticBackup?.succeededAt) successfulBackups.add(latest.automaticBackup.succeededAt);
      if (mode === "24h" && now < latest.runtimeStartedAt + day - 60_000) {
        assert.equal(successfulBackups.size, 1, "restart must not duplicate a fresh automatic backup");
        assert.deepEqual(latest.maintenanceEvents.filter((event) => event.key === "maintenance.automatic-backup"), []);
      }
      await evidence({ stage: "heartbeat", elapsedMs: now - continuousStart, monotonicElapsedMs, snapshot: latest });
      lastHeartbeat = now;
    }
    for (const label of ["due", "future", "interrupted"]) {
      assert.equal(latest.effects[label], 1, `${label} must have exactly one local effect`);
      assert.equal(latest.jobs.find((job) => job.label === label)?.state, "completed");
    }
    assert.equal(latest.jobs.find((job) => job.label === "due")?.attempts, 1);
    assert.equal(latest.jobs.find((job) => job.label === "future")?.attempts, 1);
    if (mode === "24h") {
      assert.ok(Number(process.hrtime.bigint() - monotonicStart) / 1_000_000 >= day);
      assert.equal(successfulBackups.size, 2, "one overdue catch-up and one real daily backup are required");
      assert.equal(latest.sourceRetention?.state, "SUCCEEDED", "the real daily retention timer must run");
      for (const key of ["maintenance.automatic-backup", "maintenance.source-retention"]) {
        assert.deepEqual(latest.maintenanceEvents.filter((event) => event.key === key).map((event) => event.state),
          ["RUNNING", "SUCCEEDED"], "sampling must not hide duplicate maintenance operations");
      }
    }
    if (fault === "exit-before-close") {
      await second.request("exit-before-close");
      await delay(250);
    }
    await second.stop(false);
    await stopSecond();
    assert.deepEqual(await fingerprintSources(), sourceIdentity,
      "SOAK_SOURCE_CHANGED: evidence cannot attest a different final source tree");
    await cleanupRoot();
    await evidence({ status: mode === "24h" ? "PASS_LOCAL_ENGINE_24H" : "PASS_PREFLIGHT_ONLY",
      continuousElapsedMs: Date.now() - continuousStart, successfulAutomaticBackups: successfulBackups.size,
      realGithubEffectsVerified: false, installedDesktopVerified: false });
  } catch (error) {
    await evidence({ status: "FAILED", code: error instanceof Error ? error.message.slice(0, 500) : "SOAK_FAILED" });
    throw error;
  }
});

function assertSnapshotHealthy(snapshot: SoakSnapshot): void {
  assertSnapshotSafety(snapshot);
  assert.equal(snapshot.oldTerminalPresent, false);
}

function assertSnapshotSafety(snapshot: SoakSnapshot): void {
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.manualPreserved, true);
  assert.equal(snapshot.networkAttempts, 0, "SOAK_NETWORK_ATTEMPT");
  assert.equal(snapshot.maintenanceOverflow, false, "SOAK_MAINTENANCE_EVENT_OVERFLOW");
  assert.ok(snapshot.backups.length > 0);
  assert.ok(snapshot.backups.every((backup) => backup.verified));
  assert.notEqual(snapshot.automaticBackup?.state, "FAILED");
  assert.notEqual(snapshot.sourceRetention?.state, "FAILED");
  for (const count of Object.values(snapshot.effects)) assert.equal(count, 1, "duplicate local queue effect");
  assert.ok(snapshot.jobs.every((job) => job.state !== "failed"));
}

async function waitForSnapshot(child: SoakChild, predicate: (snapshot: SoakSnapshot) => boolean,
  timeoutMs: number, record?: (snapshot: SoakSnapshot) => Promise<void>): Promise<SoakSnapshot> {
  const deadline = Date.now() + timeoutMs;
  do {
    const snapshot = await child.snapshot();
    assertSnapshotSafety(snapshot);
    if (record) await record(snapshot);
    if (predicate(snapshot)) return snapshot;
    await delay(record ? 30_000 : 500);
  } while (Date.now() < deadline);
  throw new Error("SOAK_EXPECTED_STATE_TIMEOUT");
}

interface SoakChild {
  request(action: string): Promise<unknown>;
  snapshot(): Promise<SoakSnapshot>;
  stop(force: boolean): Promise<void>;
}

async function startChild(root: string, phase: string): Promise<SoakChild> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const child: ChildProcess = spawn(fault === "spawn-error" ? join(root, "missing-soak-node.exe") : process.execPath,
    ["--experimental-transform-types", fileURLToPath(new URL("../fixtures/local-engine-soak-child.ts", import.meta.url)), root, phase, mode, fault], {
      cwd: root, windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      // Deliberate allowlist: no inherited provider keys, tokens, auth home,
      // proxies, NODE_OPTIONS or runner command can reach the fixture child.
      env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        PATH: `${dirname(process.execPath)};${join(systemRoot, "System32")}`,
        TEMP: root, TMP: root, LOCALAPPDATA: root, APPDATA: root, USERPROFILE: root,
        CODEX_HOME: join(root, "empty-codex-home"), BLOGBOT_DATA_KEY_HEX: "55".repeat(32), NODE_ENV: "test" }
    });
  let sequence = 0;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1_500); });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let signalReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((accept, reject) => { signalReady = accept; rejectReady = reject; });
  const readyTimer = setTimeout(() => rejectReady(new Error("SOAK_CHILD_START_TIMEOUT")), 45_000);
  let terminated = false;
  let signalTerminal: () => void = () => {};
  const exited = new Promise<void>((accept) => { signalTerminal = accept; });
  const observeTerminal = () => {
    if (terminated) return;
    terminated = true;
    clearTimeout(readyTimer);
    const error = new Error(`SOAK_CHILD_EXIT: ${stderr}`);
    rejectReady(error);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
    signalTerminal();
  };
  child.once("exit", observeTerminal);
  child.once("close", observeTerminal);
  child.on("error", (error) => {
    rejectReady(error);
    // A refused spawn has no process ID and need not emit exit. An error
    // from an already-created process is not proof that it has terminated.
    if (child.pid === undefined) observeTerminal();
  });
  const waitForTerminal = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_accept, reject) => {
        timer = setTimeout(() => reject(new Error("SOAK_CHILD_CLEANUP_TIMEOUT")), 10_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  child.on("message", (message: { ready?: boolean; id?: number; value?: unknown; error?: string }) => {
    if (message.ready) { clearTimeout(readyTimer); signalReady(); return; }
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiter || message.id === undefined) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.value);
  });
  try { await ready; } catch (error) {
    if (!terminated) child.kill();
    await waitForTerminal();
    throw error;
  }
  const request = (action: string) => new Promise<unknown>((accept, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("SOAK_PROBE_TIMEOUT")); }, 45_000);
    pending.set(id, { resolve: accept, reject, timer });
    child.send({ id, action }, (error) => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  });
  return {
    request,
    snapshot: () => request("snapshot") as Promise<SoakSnapshot>,
    async stop(force) {
      if (terminated || child.exitCode !== null || child.signalCode !== null) {
        if (!force) throw new Error("SOAK_CHILD_EXIT_BEFORE_CLOSE");
        return;
      }
      if (force) child.kill();
      else await request("close");
      await waitForTerminal();
      if (!force) assert.equal(child.exitCode, 0, "clean engine shutdown must succeed");
    }
  };
}

async function fingerprintSources(): Promise<{ sha256: string; fileCount: number }> {
  const files = ["package.json", "package-lock.json", "tests/soak/local-engine-24h.test.ts",
    "tests/fixtures/local-engine-soak-child.ts", "tests/helpers/owned-temp-root.ts"];
  const ignored = new Set(["node_modules", "target", "dist", "build", "binaries", "resources"]);
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      assert.equal(entry.isSymbolicLink(), false, "SOAK_SOURCE_REPARSE");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(relative(repositoryRoot, path).replaceAll("\\", "/"));
    }
  }
  await collect(join(repositoryRoot, "apps"));
  await collect(join(repositoryRoot, "packages"));
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file).update("\0").update(createHash("sha256").update(await readFile(join(repositoryRoot, file))).digest()).update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}
