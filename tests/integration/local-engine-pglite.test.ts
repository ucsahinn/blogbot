import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalEngine } from "../../apps/engine/src/local-engine.ts";
import { createPersistentEngineProtocol, handleBackupRequest } from "../../apps/engine/src/stdio-entrypoint.ts";
import type { EngineCommandV1 } from "../../packages/contracts/src/index.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import type { HighRiskApproval } from "../../packages/editorial/src/revision.ts";

function command(
  overrides: Partial<Extract<EngineCommandV1, { kind: "AUTOMATION.SET" }>> = {}
): Extract<EngineCommandV1, { kind: "AUTOMATION.SET" }> {
  return {
    version: 1,
    requestId: "persistent-request-1",
    idempotencyKey: "persistent-key-1",
    expectedVersion: 0,
    kind: "AUTOMATION.SET",
    payload: {
      settings: {
        mode: "DRAFT_ONLY",
        onboardingComplete: false,
        ingestionPaused: false,
        publishingPaused: true,
        timezone: "Europe/Istanbul",
        scanIntervalMinutes: 30
      }
    },
    ...overrides
  };
}

test("PGlite engine persists state and idempotent responses across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-"));
  const dataDir = join(root, "pgdata");

  const firstRepository = await PGliteBackendRepository.open(dataDir);
  const firstEngine = new LocalEngine({ repository: firstRepository });
  const first = await firstEngine.execute(command());
  assert.equal(first.ok, true);
  const encrypted = await firstRepository
    .getDatabase()
    .query<{ value: unknown }>(
      "SELECT value FROM blogbot_automation WHERE singleton_id = 1"
    );
  assert.equal(
    (encrypted.rows[0]?.value as { alg?: string } | undefined)?.alg,
    "A256GCM"
  );
  assert.doesNotMatch(
    JSON.stringify(encrypted.rows[0]?.value),
    /DRAFT_ONLY|scanIntervalMinutes/
  );
  await firstRepository.close();

  const secondRepository = await PGliteBackendRepository.open(dataDir);
  const secondEngine = new LocalEngine({ repository: secondRepository });
  const replay = await secondEngine.execute(command());
  assert.deepEqual(replay, first);

  const conflict = await secondEngine.execute(
    command({
      requestId: "persistent-request-2",
      payload: {
        settings: {
          ...command().payload.settings,
          ingestionPaused: true
        }
      }
    })
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "IDEMPOTENCY_KEY_REUSED");
  }
  assert.equal((await secondRepository.sync(0)).serverCursor, 1);
  await secondRepository.close();
});

test("backup.create writes an encrypted archive from an explicit local file allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-backup-create-"));
  const source = join(root, "source");
  const output = join(root, "backup", "blogbot.backup");
  await (await import("node:fs/promises")).mkdir(source, { recursive: true });
  await writeFile(join(source, "state.json"), "local-state");
  const response = await handleBackupRequest({
    version: 1,
    id: "backup-create-test",
    kind: "backup.create",
    payload: {
      sourceDirectory: source,
      relativePaths: ["state.json"],
      recoveryKey: "test-recovery-key-2026",
      outputPath: output
    }
  }, join(root, "engine"));
  assert.equal(response.ok, true);
  assert.equal((await readFile(output)).toString().includes("blogbot-portable-backup"), true);
  await rm(root, { recursive: true, force: true });
});

test("backup.auto creates a bounded encrypted snapshot and excludes its output directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-auto-backup-"));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "22".repeat(32);
  try {
    await writeFile(join(root, "marker.txt"), "local state", "utf8");
    const result = await handleBackupRequest({ version: 1, id: "auto-backup", kind: "backup.auto", payload: {} }, root);
    assert.equal(result.ok, true);
    assert.equal(result.kind, "backup.auto");
    const outputPath = String(result.outputPath);
    assert.match(outputPath, /backups[\\/]automatic-.*\.backup$/u);
    const archive = await readFile(outputPath);
    assert.ok(archive.byteLength > 32);
  } finally {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent stdio protocol reports ready local storage and queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-protocol-"));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"));

  const doctor = await runtime.handle({
    version: 1,
    id: "doctor-persistent",
    kind: "doctor"
  });

  assert.equal(doctor.ok, true);
  assert.equal(doctor.status, "READY");
  assert.equal(doctor.persistence, "pglite");
  assert.equal(doctor.queue, "ready");
  await runtime.close();
});

test("normal and high-risk approvals persist as separate immutable records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-dual-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const highRisk: HighRiskApproval = {
    revisionId: "revision-high-risk",
    revisionHash: "a".repeat(64),
    deviceId: "windows-device-1",
    approvedAt: "2026-07-30T10:00:00.000Z",
    approvalType: "HIGH_RISK",
    riskChecklistHash: "b".repeat(64),
    windowsReauthenticatedAt: "2026-07-30T09:59:00.000Z"
  };

  const first = await PGliteBackendRepository.open(dataDir);
  await first.saveApproval({
    revisionId: highRisk.revisionId,
    revisionHash: highRisk.revisionHash,
    deviceId: highRisk.deviceId,
    approvedAt: highRisk.approvedAt,
    approvalType: "EDITORIAL"
  });
  await first.saveHighRiskApproval(highRisk);
  await first.close();

  const reopened = await PGliteBackendRepository.open(dataDir);
  const snapshot = await reopened.sync(0);
  assert.equal(snapshot.snapshot.approvals.length, 1);
  assert.deepEqual(snapshot.snapshot.highRiskApprovals, [highRisk]);
  await reopened.close();
});

test("local database records immutable migration versions and hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-migrations-"));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  const result = await repository.getDatabase().query<{
    version: number;
    name: string;
    sha256: string;
  }>(
    "SELECT version, name, sha256 FROM blogbot_schema_migrations ORDER BY version"
  );

  assert.deepEqual(
    result.rows.map(({ version, name, sha256 }) => ({
      version,
      name,
      hashIsSha256: /^[a-f0-9]{64}$/.test(sha256)
    })),
    [
      { version: 1, name: "local-engine-core", hashIsSha256: true },
      { version: 2, name: "high-risk-approvals", hashIsSha256: true },
      { version: 3, name: "codex-jobs", hashIsSha256: true },
      { version: 4, name: "local-state", hashIsSha256: true }
    ]
  );
  await repository.close();
});

test("local database rejects a schema newer than the running binary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-future-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const repository = await PGliteBackendRepository.open(dataDir);
  await repository.getDatabase().query(
    `INSERT INTO blogbot_schema_migrations (version, name, sha256)
     VALUES (99, 'future-schema', $1)`,
    ["f".repeat(64)]
  );
  await repository.close();

  await assert.rejects(
    PGliteBackendRepository.open(dataDir),
    /LOCAL_MIGRATION_NEWER_THAN_BINARY/
  );
});
