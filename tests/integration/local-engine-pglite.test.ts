import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { LocalEngine } from "../../apps/engine/src/local-engine.ts";
import { createPersistentEngineProtocol, handleBackupRequest } from "../../apps/engine/src/stdio-entrypoint.ts";
import type { EngineCommandV1 } from "../../packages/contracts/src/index.ts";
import type { ApprovalRevocation } from "../../packages/database/src/backend-repository.ts";
import { JsonProtector } from "../../packages/database/src/encrypted-json.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import type { ApprovalV3, ArticleRevision, ArticleState, HighRiskApproval } from "../../packages/editorial/src/revision.ts";

/** Smallest revision the list index and the due-list projection accept. */
function sampleRevision(id: string, state: ArticleState): ArticleRevision {
  return {
    id,
    translationKey: `tk-${id}`,
    state,
    tr: { title: "Baslik", slug: "baslik", description: "Aciklama", bodyMarkdown: "Govde", heroImageAlt: "Gorsel" },
    en: { title: "Title", slug: "title", description: "Description", bodyMarkdown: "Body", heroImageAlt: "Image" },
    section: "haberler",
    articleType: "news",
    author: "Ada",
    tags: [],
    claims: [],
    sources: [],
    media: [],
    scheduledAt: "2026-07-30T09:00:00.000Z",
    adapterVersion: "1"
  } as unknown as ArticleRevision;
}

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

test("PGlite dashboard paging never advances the cursor beyond delivered changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-dashboard-page-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  for (let index = 0; index < 5; index += 1) {
    await repository.setAutomation({
      mode: "INGEST_ONLY",
      onboardingComplete: index > 0,
      ingestionPaused: false,
      publishingPaused: true,
      timezone: "Europe/Istanbul",
      scanIntervalMinutes: 30 + index
    });
  }

  const first = await repository.syncDashboard(0, { changeLimit: 2 });
  assert.deepEqual(first.changes.map((change) => change.cursor), [1, 2]);
  assert.equal(first.serverCursor, 2);

  const second = await repository.syncDashboard(first.serverCursor, { changeLimit: 2 });
  assert.deepEqual(second.changes.map((change) => change.cursor), [3, 4]);
  assert.equal(second.serverCursor, 4);
});

test("completed backend encryption migration defers deep ciphertext validation until requested", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-deep-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const first = await PGliteBackendRepository.open(dataDir);
  await first.setAutomation({
    mode: "INGEST_ONLY", onboardingComplete: true, ingestionPaused: false,
    publishingPaused: true, timezone: "Europe/Istanbul", scanIntervalMinutes: 30
  });
  await first.close();

  const raw = (await import("@electric-sql/pglite")).PGlite;
  const database = new raw(dataDir);
  await database.waitReady;
  await database.query(
    "UPDATE blogbot_automation SET value = $1::jsonb WHERE singleton_id = 1",
    [JSON.stringify({ mode: "INGEST_ONLY" })]
  );
  await database.close();

  const reopened = await PGliteBackendRepository.open(dataDir);
  try {
    await assert.rejects(reopened.verifyEncryptionIntegrity(), /LOCAL_DATA_ENVELOPE_INVALID/);
  } finally {
    await reopened.close();
  }
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

test("the file-based backup handler refuses backup.auto instead of writing an unrestorable archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-auto-backup-"));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "22".repeat(32);
  try {
    await writeFile(join(root, "marker.txt"), "local state", "utf8");
    // This handler used to walk the data directory and seal whatever fit under a
    // file-count cap. A real PGlite directory is over a thousand files and
    // hundreds of megabytes, so every archive it produced was silently partial
    // and could never be restored. Automatic snapshots are now logical row
    // archives (`createConsistentAutomaticBackup`), which needs an open
    // database this handler does not have. Refusing is the honest answer.
    const result = await handleBackupRequest(
      { version: 1, id: "auto-backup", kind: "backup.auto", payload: {} },
      root
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_REQUEST");
    // Nothing may be left behind that looks like a usable snapshot.
    assert.equal(existsSync(join(root, "backups")), false);
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

test("V3 human approval attestations survive encrypted PGlite get, snapshot, and reopen roundtrips", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-v3-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const approval: ApprovalV3 = {
    revisionId: "revision-v3-roundtrip",
    revisionHash: "c".repeat(64),
    deviceId: "windows-device-v3",
    approvedAt: "2026-08-20T08:00:00.000Z",
    warningSetHash: "d".repeat(64),
    packageVersion: 3,
    approvalType: "EDITORIAL",
    attestation: {
      editorialReview: {
        reviewer: "Deniz Editor",
        sourceRoles: [
          { sourceId: "source-primary", role: "primary" },
          { sourceId: "source-independent", role: "independent" }
        ]
      },
      expertReview: {
        reviewer: "Dr. Ada Uzman",
        qualifications: "Siber guvenlik uzmani",
        reviewScope: "Yuksek etkili iddialar"
      },
      ethicsReview: null
    },
    attestationHash: "e".repeat(64)
  };

  const first = await PGliteBackendRepository.open(dataDir);
  assert.deepEqual(await first.saveApproval(approval), approval);
  assert.deepEqual(await first.getApproval(approval.revisionId), approval);
  assert.deepEqual((await first.sync(0)).snapshot.approvals, [approval]);
  const encrypted = await first.getDatabase().query<{ value: unknown }>(
    "SELECT value FROM blogbot_approvals WHERE revision_id = $1",
    [approval.revisionId]
  );
  assert.equal((encrypted.rows[0]?.value as { alg?: string } | undefined)?.alg, "A256GCM");
  assert.doesNotMatch(JSON.stringify(encrypted.rows[0]?.value), /Deniz Editor|source-primary|attestationHash/);
  await first.close();

  const reopened = await PGliteBackendRepository.open(dataDir);
  assert.deepEqual(await reopened.getApproval(approval.revisionId), approval);
  assert.deepEqual((await reopened.listRevisionSnapshot()).approvals, [approval]);
  await reopened.close();
});

test("approval revocations survive encrypted PGlite replay and reopen without plaintext audit leakage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-approval-revocation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const approval = {
    revisionId: "revision-revoked-roundtrip",
    revisionHash: "a".repeat(64),
    deviceId: "windows-device-approval",
    approvedAt: "2026-08-20T08:00:00.000Z",
    warningSetHash: "b".repeat(64),
    approvalType: "EDITORIAL" as const
  };
  const revocation: ApprovalRevocation = {
    revisionId: approval.revisionId,
    revisionHash: approval.revisionHash,
    deviceId: "windows-device-revoker",
    reason: "Kaynak lisansi degistigi icin yayin onayi geri cekildi.",
    revokedAt: "2026-08-20T09:00:00.000Z"
  };

  const first = await PGliteBackendRepository.open(dataDir);
  await first.saveApproval(approval);
  assert.deepEqual(await first.revokeApproval(revocation), revocation);
  assert.deepEqual(await first.revokeApproval(structuredClone(revocation)), revocation);
  assert.deepEqual(await first.getApprovalRevocation(revocation.revisionId), revocation);
  const encrypted = await first.getDatabase().query<{ value: unknown }>(
    "SELECT value FROM blogbot_approval_revocations WHERE revision_id = $1",
    [revocation.revisionId]
  );
  assert.equal((encrypted.rows[0]?.value as { alg?: string } | undefined)?.alg, "A256GCM");
  assert.doesNotMatch(
    JSON.stringify(encrypted.rows[0]?.value),
    /windows-device-revoker|Kaynak lisansi degistigi|revision-revoked-roundtrip/
  );
  const changes = (await first.sync(0)).changes.filter((change) => change.kind === "APPROVAL_REVOKED");
  assert.deepEqual(changes.map(({ kind, entityId }) => ({ kind, entityId })), [
    { kind: "APPROVAL_REVOKED", entityId: revocation.revisionId }
  ]);
  await first.close();

  const reopened = await PGliteBackendRepository.open(dataDir);
  assert.deepEqual(await reopened.getApprovalRevocation(revocation.revisionId), revocation);
  await assert.rejects(
    reopened.revokeApproval({ ...revocation, reason: "Farkli bir neden" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "APPROVAL_ALREADY_REVOKED"
  );
  await reopened.close();
});

test("enqueueing a PGlite publication emits an incremental outbox change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-outbox-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  const effect = await repository.enqueuePublication("revision-outbox-change", "a".repeat(64), {
    previewHash: "b".repeat(64),
    targetRepository: "owner/site",
    baseBranch: "main",
    targetBaseSha: "c".repeat(40),
    adapterVersion: "astro-generic@2.0.0"
  });
  const snapshot = await repository.sync(0);

  assert.deepEqual(snapshot.changes.map((change) => ({
    kind: change.kind,
    entityId: change.entityId
  })), [{ kind: "EFFECT_UPDATED", entityId: effect.id }]);
});

test("PGlite due revision reads support stable pagination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-due-page-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  await repository.getDatabase().query(
    `INSERT INTO blogbot_revision_list_index
       (revision_id, scheduled_at_unix_ms, value)
     VALUES ($1, $2, '{}'::jsonb), ($3, $4, '{}'::jsonb), ($5, $6, '{}'::jsonb)`,
    [
      "due-a", Date.parse("2026-07-30T08:00:00.000Z"),
      "due-b", Date.parse("2026-07-30T09:00:00.000Z"),
      "due-c", Date.parse("2026-07-30T10:00:00.000Z")
    ]
  );

  assert.deepEqual(
    await repository.listDueRevisionIds(Date.parse("2026-07-30T11:00:00.000Z"), 2, 2),
    ["due-c"]
  );
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
      { version: 4, name: "local-state", hashIsSha256: true },
      { version: 5, name: "revision-list-index", hashIsSha256: true },
      { version: 6, name: "operational-row-order-and-version", hashIsSha256: true },
      { version: 7, name: "revision-list-state", hashIsSha256: true },
      { version: 8, name: "encryption-migration-progress", hashIsSha256: true },
      { version: 9, name: "approval-revocations", hashIsSha256: true }
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

test("concurrently enqueueing the same PGlite publication is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-outbox-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  const binding = {
    previewHash: "b".repeat(64),
    targetRepository: "owner/site",
    baseBranch: "main",
    targetBaseSha: "c".repeat(40),
    adapterVersion: "astro-generic@2.0.0"
  };
  const results = await Promise.allSettled([
    repository.enqueuePublication("revision-outbox-race", "a".repeat(64), binding),
    repository.enqueuePublication("revision-outbox-race", "a".repeat(64), binding)
  ]);

  assert.equal(results.every((result) => result.status === "fulfilled"), true);
  const effects = results.map((result) => result.status === "fulfilled" ? result.value : null);
  assert.equal(effects[0]?.id, effects[1]?.id);
  assert.equal((await repository.listOutbox()).length, 1);
});

test("bounded dashboard window returns the newest outbox effects and jobs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-dashboard-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  const revisionIds: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const revisionId = `rev-${index}`;
    revisionIds.push(revisionId);
    await repository.enqueuePublication(revisionId, String(index).repeat(64).slice(0, 64), {
      previewHash: "b".repeat(64),
      targetRepository: "owner/site",
      baseBranch: "main",
      targetBaseSha: "c".repeat(40),
      adapterVersion: "astro-generic@2.0.0"
    });
    await repository.createJob({
      // A job id is an opaque client identifier, so nothing about it orders.
      id: createHash("sha256").update(revisionId).digest("hex"),
      kind: "PUBLISH",
      state: "QUEUED",
      attempts: 0,
      metadata: { ordinal: index }
    });
  }

  const dashboard = await repository.syncDashboard(0, {
    changeLimit: 200,
    outboxLimit: 3,
    jobLimit: 3
  });

  assert.deepEqual(
    dashboard.outbox.map((effect) => effect.aggregateId),
    revisionIds.slice(-3)
  );
  assert.deepEqual(
    dashboard.jobs.map((job) => job.metadata?.ordinal),
    [10, 11, 12]
  );
});

test("operational sequence migration backfills preexisting rows before newer dashboard rows are written", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-seq-backfill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const initial = await PGliteBackendRepository.open(dataDir);
  const legacyEffects = [];
  for (let index = 1; index <= 2; index += 1) {
    legacyEffects.push(await initial.enqueuePublication(
      `legacy-revision-${index}`,
      String(index).repeat(64),
      {
        previewHash: "b".repeat(64),
        targetRepository: "owner/site",
        baseBranch: "main",
        targetBaseSha: "c".repeat(40),
        adapterVersion: "astro-generic@2.0.0"
      }
    ));
    await initial.createJob({
      id: `legacy-job-${index}`,
      kind: "PUBLISH",
      state: "QUEUED",
      attempts: 0,
      metadata: { ordinal: `legacy-${index}` }
    });
  }
  const legacyOutboxBefore = await initial.getDatabase().query<{ id: string; value: unknown }>(
    "SELECT id, value FROM blogbot_outbox ORDER BY id"
  );
  const legacyJobsBefore = await initial.getDatabase().query<{ id: string; value: unknown }>(
    "SELECT id, value FROM blogbot_jobs ORDER BY id"
  );
  // Rewind only the v6 schema surface so the same encrypted rows predate the
  // identity columns when the immutable migration is replayed on reopen.
  await initial.getDatabase().exec(`
    DROP INDEX IF EXISTS blogbot_outbox_seq_idx;
    DROP INDEX IF EXISTS blogbot_jobs_seq_idx;
    ALTER TABLE blogbot_outbox DROP COLUMN seq;
    ALTER TABLE blogbot_jobs DROP COLUMN seq;
    DELETE FROM blogbot_schema_migrations WHERE version = 6;
  `);
  await initial.close();

  const repository = await PGliteBackendRepository.open(dataDir);
  t.after(() => repository.close());
  const newRevisionIds: string[] = [];
  for (let index = 1; index <= 2; index += 1) {
    const revisionId = `new-revision-${index}`;
    newRevisionIds.push(revisionId);
    await repository.enqueuePublication(revisionId, String(index + 2).repeat(64), {
      previewHash: "d".repeat(64),
      targetRepository: "owner/site",
      baseBranch: "main",
      targetBaseSha: "e".repeat(40),
      adapterVersion: "astro-generic@2.0.0"
    });
    await repository.createJob({
      id: `new-job-${index}`,
      kind: "PUBLISH",
      state: "QUEUED",
      attempts: 0,
      metadata: { ordinal: `new-${index}` }
    });
  }

  const dashboard = await repository.syncDashboard(0, {
    changeLimit: 100,
    outboxLimit: 2,
    jobLimit: 2
  });
  assert.deepEqual(
    dashboard.outbox.map((effect) => effect.aggregateId),
    newRevisionIds
  );
  assert.deepEqual(
    dashboard.jobs.map((job) => job.metadata?.ordinal),
    ["new-1", "new-2"]
  );

  const legacyOutboxAfter = await repository.getDatabase().query<{
    id: string;
    seq: string | number | null;
    value: unknown;
  }>(
    "SELECT id, seq, value FROM blogbot_outbox WHERE id = ANY($1::text[]) ORDER BY id",
    [legacyEffects.map((effect) => effect.id)]
  );
  const legacyJobsAfter = await repository.getDatabase().query<{
    id: string;
    seq: string | number | null;
    value: unknown;
  }>(
    "SELECT id, seq, value FROM blogbot_jobs WHERE id LIKE 'legacy-job-%' ORDER BY id"
  );
  assert.equal(legacyOutboxAfter.rows.every((row) => row.seq !== null), true);
  assert.equal(legacyJobsAfter.rows.every((row) => row.seq !== null), true);
  assert.deepEqual(
    legacyOutboxAfter.rows.map(({ id, value }) => ({ id, value })),
    legacyOutboxBefore.rows
  );
  assert.deepEqual(
    legacyJobsAfter.rows.map(({ id, value }) => ({ id, value })),
    legacyJobsBefore.rows
  );
});

test("a durable job or outbox write with a stale version conflicts instead of overwriting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-write-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  const job = await repository.createJob({
    id: "draft-cas-1",
    kind: "DRAFT",
    state: "RUNNING",
    attempts: 1
  });
  const observedVersion = await repository.getJobVersion(job.id);

  // The coordinator lane completes the job it read.
  await repository.saveJob(
    { ...job, state: "SUCCEEDED", metadata: { revisionId: "rev-abc" } },
    observedVersion
  );
  // The retry lane read the same job and must not silently replace that write.
  await assert.rejects(
    repository.saveJob({ ...job, state: "QUEUED", attempts: 2 }, observedVersion),
    (error: unknown) => (error as { code?: string }).code === "WRITE_VERSION_CONFLICT"
  );
  const durable = await repository.getJob(job.id);
  assert.equal(durable.state, "SUCCEEDED");
  assert.equal(durable.metadata?.revisionId, "rev-abc");

  const effect = await repository.enqueuePublication("revision-cas-1", "a".repeat(64), {
    previewHash: "b".repeat(64),
    targetRepository: "owner/site",
    baseBranch: "main",
    targetBaseSha: "c".repeat(40),
    adapterVersion: "astro-generic@2.0.0"
  });
  const effectVersion = await repository.getOutboxVersion(effect.id);
  await repository.updateOutbox({ ...effect, state: "IN_PROGRESS", attempts: 1 }, effectVersion);
  await assert.rejects(
    repository.updateOutbox({ ...effect, state: "FAILED" }, effectVersion),
    (error: unknown) => (error as { code?: string }).code === "WRITE_VERSION_CONFLICT"
  );
  assert.equal((await repository.listOutbox())[0]?.state, "IN_PROGRESS");
});

test("due revision reads skip revisions that already left the publication path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-due-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());

  for (const [revisionId, state] of [
    ["due-approved", "APPROVED"],
    ["due-published", "PUBLISHED"],
    ["due-publishing", "PUBLISHING"]
  ] as const) {
    await repository.insertRevision(sampleRevision(revisionId, state));
  }

  assert.deepEqual(
    await repository.listDueRevisionIds(Date.parse("2026-07-30T11:00:00.000Z")),
    ["due-approved"]
  );
});

test("an interrupted legacy encryption migration resumes from its recorded marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-resume-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const first = await PGliteBackendRepository.open(dataDir);
  const database = first.getDatabase();
  const protector = JsonProtector.fromEnvironment();
  // Recreate a workspace whose reseal was interrupted after three rows: the
  // sentinel is absent, the completed rows are sealed, the rest are still
  // plaintext, and the page marker names the last row that was committed.
  await database.query("DELETE FROM blogbot_encryption_migrations WHERE scope = 'backend'");
  for (let index = 0; index < 5; index += 1) {
    const id = `legacy-${String(index).padStart(3, "0")}`;
    const revision = sampleRevision(id, "APPROVED");
    await database.query(
      "INSERT INTO blogbot_revisions (id, value) VALUES ($1, $2::jsonb)",
      [
        id,
        JSON.stringify(index < 3
          ? protector.seal(revision, { table: "blogbot_revisions", key: id, field: "value" })
          : revision)
      ]
    );
  }
  await database.query(
    `INSERT INTO blogbot_encryption_migration_progress (scope, table_name, last_key)
     VALUES ('backend', 'blogbot_revisions', $1)`,
    ["legacy-002"]
  );
  const before = await database.query<{ id: string; value: { iv?: string } }>(
    "SELECT id, value FROM blogbot_revisions WHERE id LIKE 'legacy-%' ORDER BY id"
  );
  await first.close();

  const reopened = await PGliteBackendRepository.open(dataDir);
  t.after(() => reopened.close());
  const after = await reopened.getDatabase().query<{ id: string; value: { v?: number; iv?: string } }>(
    "SELECT id, value FROM blogbot_revisions WHERE id LIKE 'legacy-%' ORDER BY id"
  );

  assert.deepEqual(after.rows.map((row) => row.value.v), [2, 2, 2, 2, 2]);
  // Resealing draws a fresh nonce, so an unchanged iv proves the rows before the
  // marker were never reopened — that is what makes a restart finite.
  assert.deepEqual(
    after.rows.slice(0, 3).map((row, index) => row.value.iv === before.rows[index]?.value.iv),
    [true, true, true]
  );
  const progress = await reopened.getDatabase().query(
    "SELECT last_key FROM blogbot_encryption_migration_progress WHERE scope = 'backend'"
  );
  assert.equal(progress.rows.length, 0);
});

test("the legacy encryption migration refuses to reseal a row that is not its record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-pglite-legacy-injection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "pgdata");
  const first = await PGliteBackendRepository.open(dataDir);
  const database = first.getDatabase();
  await database.query("DELETE FROM blogbot_encryption_migrations WHERE scope = 'backend'");
  await database.query(
    "INSERT INTO blogbot_revisions (id, value) VALUES ($1, $2::jsonb)",
    ["revision-injected", JSON.stringify({ forgedBy: "outside-process" })]
  );
  await first.close();

  await assert.rejects(
    PGliteBackendRepository.open(dataDir),
    /LOCAL_DATA_LEGACY_UNVERIFIABLE/
  );

  const raw = new PGlite(dataDir);
  await raw.waitReady;
  const stored = await raw.query<{ value: { v?: number }; sentinel: number | null }>(
    `SELECT value,
            (SELECT version FROM blogbot_encryption_migrations WHERE scope = 'backend') AS sentinel
       FROM blogbot_revisions WHERE id = 'revision-injected'`
  );
  // The injected row must not have been given authentic provenance, and the
  // sentinel must not claim a completed migration.
  assert.equal(stored.rows[0]?.value.v, undefined);
  assert.equal(stored.rows[0]?.sentinel, null);
  await raw.close();
});
