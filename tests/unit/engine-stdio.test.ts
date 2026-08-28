import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEngineProtocol,
  approvalBoundFilesDigest,
  assertRevisionGeneratedFilesMatch,
  automaticBackupInitialDelayMs,
  collectDraftSourceEvidence,
  writeBackupArchiveNoReplace,
  createConsistentAutomaticBackup,
  handleAutomaticBackupAccess,
  isPublicationPreviewCurrent,
  handleBackupRequest,
  protectedCatalogEvidenceReferences,
  protectedCatalogSourceIds,
  recoverWaitingDraftJobs,
  reportBackgroundTaskFault,
  reportCodexLifecycle,
  readBoundedLines,
  htmlToEvidenceText,
  automaticBackupIsOverdue,
  isParallelReadRequest,
  scheduleOverdueAutomaticBackup,
  scrubbedRestoreEnvironment,
  DRAFT_EVIDENCE_FETCH_BUDGET_MS
} from "../../apps/engine/src/stdio-entrypoint.ts";
import { buildPublicationPreview } from "../../apps/engine/src/publication-preview.ts";
import type { CodexWorkerCoordinator } from "../../apps/engine/src/codex-worker.ts";
import { createPortableBackup } from "../../packages/backup/src/portable-backup.ts";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import { PGliteSourceRepository } from "../../packages/database/src/source-repository.ts";

/**
 * Minimal stand-in for the snapshot read port. An automatic snapshot archives
 * the rows Blogbot owns, so a fake only has to answer the catalogue query and
 * one table read.
 */
function logicalBackupGate(rows = 1) {
  const applied: unknown[][] = [];
  const read = async <Row>(sql: string) => ({
    rows: (sql.includes("information_schema.tables")
      ? [{ table_name: "blogbot_automation" }]
      : sql.includes("information_schema.columns")
        ? [{ column_name: "singleton_id" }, { column_name: "value" }]
        : Array.from({ length: rows }, (_, index) => ({
          singleton_id: index + 1,
          value: { mode: "INGEST_ONLY" }
        }))) as Row[]
  });
  return {
    applied,
    gate: {
      query: read,
      transaction: async <T>(work: (transaction: {
        query<Row>(sql: string, parameters?: readonly unknown[]): Promise<{ rows: Row[] }>;
      }) => Promise<T>) => work({
        query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
          if (parameters) applied.push([...parameters]);
          return read<Row>(sql);
        }
      })
    }
  };
}

test("portable restore child environment excludes engine credentials and user context", () => {
  const environment = scrubbedRestoreEnvironment({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    TEMP: "C:\\Temp",
    BLOGBOT_DATA_KEY_HEX: "sensitive-data-key",
    BLOGBOT_IMAGEGEN_API_KEY: "sensitive-provider-key",
    BLOGBOT_CODEX_RUNNER: "C:\\private\\runner.exe",
    GITHUB_TOKEN: "sensitive-github-token",
    USERPROFILE: "C:\\Users\\private"
  });

  assert.deepEqual(environment, {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    TEMP: "C:\\Temp"
  });
  for (const key of ["BLOGBOT_DATA_KEY_HEX", "BLOGBOT_IMAGEGEN_API_KEY", "BLOGBOT_CODEX_RUNNER", "GITHUB_TOKEN", "USERPROFILE"]) {
    assert.equal(key in environment, false);
  }
});

test("source retention protects catalog feeds referenced by immutable revision evidence", () => {
  const revisions = [{
    sources: [{ id: "official-feed:entry-42" }, { id: "url:unmanaged" }]
  }] as never;
  assert.deepEqual(
    protectedCatalogSourceIds(revisions, ["official-feed", "unrelated-feed"]),
    ["official-feed"]
  );
});

test("source retention protects exact captured evidence versions without pinning a whole catalog source", () => {
  const versionId = `entry-${"a".repeat(64)}`;
  assert.deepEqual(
    protectedCatalogEvidenceReferences([
      { sources: [{ id: "source-1:story-1", evidenceVersionId: versionId }] },
      { sources: [{ id: "source-2:legacy" }] }
    ] as never, ["source-1", "source-2"]),
    [versionId, "source-2"]
  );
});

test("engine rejects GitHub credential requests so credentials stay outside PGlite", async () => {
  const repository = new InMemoryBackendStore();
  // The cast preserves this regression test after the obsolete engine option
  // is removed: a caller must never be able to reactivate token handling by
  // passing an old-shaped options object.
  const handle = createEngineProtocol(repository, "memory", {
    githubAuthRuntime: {
      status: async () => ({ status: "authorized" })
    }
  } as never);

  const result = await handle({ version: 1, id: "github-auth-1", kind: "github.auth.status" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "GITHUB_AUTH_NATIVE_ONLY");
});

test("engine protocol exposes a truthful degraded doctor response", async () => {
  const handle = createEngineProtocol();
  const result = await handle({ version: 1, id: "doctor-1", kind: "doctor" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "DEGRADED");
  assert.equal(result.persistence, "memory");
  assert.equal(
    (result.capabilities as string[]).includes("PUBLICATION.ENQUEUE"),
    false,
    "an engine without an injected publication processor must not advertise live publication"
  );
});

test("background maintenance faults use a redacted stderr-only diagnostic code", () => {
  const lines: string[] = [];

  reportBackgroundTaskFault("AUTOMATIC_BACKUP_UNAVAILABLE", (line) => lines.push(line));
  reportBackgroundTaskFault("SOURCE_SCHEDULER_UNAVAILABLE", (line) => lines.push(line), "catalog");
  reportBackgroundTaskFault("SOURCE_RETENTION_UNAVAILABLE", () => { throw new Error("diagnostics unavailable"); });

  assert.deepEqual(lines, [
    "[Blogbot] AUTOMATIC_BACKUP_UNAVAILABLE\n",
    "[Blogbot] SOURCE_SCHEDULER_UNAVAILABLE phase=catalog\n"
  ]);
});

test("Codex lifecycle diagnostics identify a queue phase without recording job content", () => {
  const lines: string[] = [];

  reportCodexLifecycle("CODEX_JOB_STARTED", (line) => lines.push(line));
  reportCodexLifecycle("CODEX_JOB_WAITING", (line) => lines.push(line));

  assert.deepEqual(lines, [
    "[Blogbot] CODEX_JOB_STARTED\n",
    "[Blogbot] CODEX_JOB_WAITING\n"
  ]);
});

test("publication preview validates a selected generic adapter bundle and returns a stable hash", () => {
  const revisionHash = "a".repeat(64);
  const files = [
    { path: "content/tr/story.md", content: "TR\n" },
    { path: "content/en/story.md", content: "EN\n" },
    { path: "assets/story.webp", content: "image\n" }
  ];
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const manifestPath = ".blogbot/manifests/rev-1.json";
  files.push({
    path: manifestPath,
    content: JSON.stringify({
      version: 1,
      revisionId: "rev-1",
      revisionHash,
      adapterVersion: "astro@1",
      generatedAt: "2026-07-30T12:00:00.000Z",
      entries: files.map((file) => ({ path: file.path, sha256: digest(file.content), bytes: Buffer.byteLength(file.content) }))
    })
  });
  const request = {
    revisionId: "rev-1",
    approvedRevisionHash: revisionHash,
    currentRevisionHash: revisionHash,
    targetRepository: "owner/site",
    baseBranch: "main",
    files,
      bundlePolicy: {
      adapterId: "astro",
      manifestPath,
      allowedPathPrefixes: ["content/", "assets/", ".blogbot/manifests/"],
      requiredLocalePrefixes: ["content/tr/", "content/en/"],
      requiredMediaPrefix: "assets/"
      },
      siteOrigin: "https://example.org",
      contentRoot: "/srv/site",
      requiredChecks: ["ci/test"],
      deployWorkflow: "deploy.yml",
      now: "2026-07-30T12:00:00.000Z"
  } as const;
  const first = buildPublicationPreview(request);
  const second = buildPublicationPreview(request);
  assert.equal(first.plan.target.siteOrigin, "https://example.org");
  assert.equal(first.previewHash, second.previewHash);
  assert.equal(first.adapterId, "astro");
});

test("local-only publication preview accepts an empty public origin", () => {
  const revisionHash = "b".repeat(64);
  const manifestPath = ".blogbot/manifests/local.json";
  const files = [
    { path: "src/content/articles/tr/local.md", content: "# Yerel\n" },
    { path: "src/content/articles/en/local.md", content: "# Local\n" },
    { path: manifestPath, content: "" }
  ];
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  files[2] = { path: manifestPath, content: JSON.stringify({ version: 1, revisionId: "local-1", revisionHash, adapterVersion: "astro-generic@1", generatedAt: "2026-07-30T12:00:00.000Z", entries: files.slice(0, 2).map((file) => ({ path: file.path, sha256: digest(file.content), bytes: Buffer.byteLength(file.content) })) }) };
  const preview = buildPublicationPreview({
    revisionId: "local-1",
    approvedRevisionHash: revisionHash,
    currentRevisionHash: revisionHash,
    targetRepository: "local/local",
    baseBranch: "local",
    files,
    bundlePolicy: { adapterId: "astro-generic", manifestPath, allowedPathPrefixes: ["src/content/articles/", ".blogbot/manifests/"], requiredLocalePrefixes: ["src/content/articles/tr/", "src/content/articles/en/"] },
    siteOrigin: "",
    contentRoot: "C:\\Projects\\demo",
    requiredChecks: [],
    deployWorkflow: "",
    now: "2026-07-30T12:00:00.000Z"
  });
  assert.equal(preview.plan.target.siteOrigin, "");
  assert.equal(preview.adapterId, "astro-generic");
});

test("publication preview file set must exactly match the approval-bound revision manifest", () => {
  const expectedContent = "approved content\n";
  const expected = {
    path: "content/tr/story.md",
    sha256: createHash("sha256").update(expectedContent, "utf8").digest("hex"),
    size: Buffer.byteLength(expectedContent)
  };
  const revision = { id: "rev-1", adapterVersion: "local-folder-v1@1", generatedFiles: [expected] };
  const payload = {
    files: [
      { path: expected.path, content: expectedContent },
      { path: ".blogbot/manifests/rev-1.json", content: "{}" }
    ],
    bundlePolicy: { manifestPath: ".blogbot/manifests/rev-1.json" }
  };

  assert.doesNotThrow(() => assertRevisionGeneratedFilesMatch(revision, payload));
  assert.throws(
    () => assertRevisionGeneratedFilesMatch(revision, {
      ...payload,
      files: [
        { path: expected.path, content: "attacker-selected content\n" },
        payload.files[1]
      ]
    }),
    /APPROVAL_BOUND_FILE_MISMATCH/u
  );
  assert.throws(
    () => assertRevisionGeneratedFilesMatch(revision, {
      ...payload,
      files: [...payload.files, { path: "content/en/extra.md", content: "extra" }]
    }),
    /APPROVAL_BOUND_FILE_SET_MISMATCH/u
  );
});

test("publication enqueue fails closed when preview hash is absent", async () => {
  const handle = createEngineProtocol();
  const result = await handle({
    version: 1,
    id: "publish-without-preview",
    kind: "publication.enqueue",
    revisionId: "rev-1",
    revisionHash: "a".repeat(64),
    idempotencyKey: "publish-1",
    expectedVersion: 0
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_PUBLICATION_REQUEST");
});

test("engine protocol requires a command envelope and preserves correlation id", async () => {
  const handle = createEngineProtocol();
  const result = await handle({
    version: 1,
    id: "stdio-command-1",
    kind: "command",
    command: {
      version: 1,
      requestId: "automation-request-1",
      idempotencyKey: "automation-idempotency-1",
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
      }
    }
  });

  assert.equal(result.id, "stdio-command-1");
  assert.equal(result.ok, true);
  assert.equal(result.kind, "command");
});

test("engine protocol returns a versioned local state snapshot", async () => {
  const handle = createEngineProtocol();
  const result = await handle({
    version: 1,
    id: "state-1",
    kind: "state",
    afterCursor: 0
  });

  const snapshot = result.snapshot as {
    serverCursor?: number;
    automation?: { mode?: string };
    jobs?: unknown[];
    outbox?: unknown[];
    changes?: unknown[];
  };
  assert.equal(result.ok, true);
  assert.equal(result.kind, "state");
  assert.equal(snapshot.serverCursor, 0);
  assert.equal(snapshot.automation?.mode, "INGEST_ONLY");
  assert.deepEqual(snapshot.jobs, []);
  assert.deepEqual(snapshot.outbox, []);
  assert.deepEqual(snapshot.changes, []);
});

test("publication preview payload expires before it can be reused", () => {
  assert.equal(isPublicationPreviewCurrent({ expiresAtUnixMs: 10_001 }, 10_000), true);
  assert.equal(isPublicationPreviewCurrent({ expiresAtUnixMs: 10_000 }, 10_000), false);
  assert.equal(isPublicationPreviewCurrent({ previewHash: "missing-expiry" }, 10_000), false);
});

test("desktop state projection uses the lightweight repository read instead of the full revision sync", async () => {
  class DashboardProjectionRepository extends InMemoryBackendStore {
    dashboardReads = 0;

    override async sync(): Promise<never> {
      throw new Error("FULL_SYNC_MUST_NOT_RUN_FOR_DESKTOP_STATE");
    }

    override async getVersion(): Promise<number> {
      return 77;
    }

    async syncDashboard(afterCursor: number) {
      this.dashboardReads += 1;
      assert.equal(afterCursor, 42);
      return {
        serverCursor: 42,
        automation: {
          mode: "INGEST_ONLY" as const,
          onboardingComplete: false,
          ingestionPaused: false,
          publishingPaused: true,
          timezone: "Europe/Istanbul",
          scanIntervalMinutes: 30
        },
        jobs: [],
        outbox: [],
        changes: []
      };
    }
  }

  const repository = new DashboardProjectionRepository();
  const handle = createEngineProtocol(repository, "memory");

  const result = await handle({
    version: 1,
    id: "state-lightweight-projection",
    kind: "state",
    afterCursor: 42
  });

  assert.equal(result.ok, true);
  assert.equal(repository.dashboardReads, 1);
  // The optimistic version comes from the authoritative version read, while the
  // dashboard read only supplies the change-paging watermark.
  assert.equal((result.snapshot as { serverCursor?: number }).serverCursor, 77);
  assert.equal((result.snapshot as { changeCursor?: number }).changeCursor, 42);
});

test("state projection bounds stale history for desktop polling", async () => {
  const repository = new InMemoryBackendStore();
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
  const handle = createEngineProtocol(repository, "memory");

  const result = await handle({
    version: 1,
    id: "state-bounded-history",
    kind: "state",
    afterCursor: 0,
    changeLimit: 2
  });

  assert.equal(result.ok, true);
  const changes = (result.snapshot as { changes?: Array<{ cursor?: number }> }).changes ?? [];
  assert.deepEqual(changes.map((change) => change.cursor), [1, 2]);
  // The change page is bounded, but `serverCursor` is the optimistic version the
  // desktop sends back as `expectedVersion`. It must report the engine's real
  // version, not the last delivered change, or every mutation would fail with
  // VERSION_CONFLICT once a workspace outgrew one page of history.
  assert.equal((result.snapshot as { serverCursor?: number }).serverCursor, 5);
  assert.equal(
    (result.snapshot as { changeCursor?: number }).changeCursor,
    2,
    "the paging watermark stays available under its own name"
  );

  const next = await handle({
    version: 1,
    id: "state-bounded-history-next",
    kind: "state",
    afterCursor: 2,
    changeLimit: 2
  });
  assert.deepEqual(
    ((next.snapshot as { changes?: Array<{ cursor?: number }> }).changes ?? []).map((change) => change.cursor),
    [3, 4]
  );
});

test("explicit encrypted-data integrity verification is opt-in and does not advance the editorial cursor", async () => {
  const repository = new InMemoryBackendStore();
  let checks = 0;
  const handle = createEngineProtocol(repository, "memory", {
    verifyEncryptionIntegrity: async () => { checks += 1; }
  });

  const doctor = await handle({ version: 1, id: "doctor-integrity", kind: "doctor" });
  const result = await handle({ version: 1, id: "integrity-1", kind: "maintenance.integrity.verify" });

  assert.equal((doctor.capabilities as string[]).includes("MAINTENANCE.INTEGRITY_VERIFY"), true);
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  const completedAt = typeof result.completedAt === "string"
    ? result.completedAt
    : assert.fail("integrity verification must return its completion time");
  assert.equal(checks, 1);
  assert.equal(await repository.getVersion(), 0);
  const persisted = await repository.getLocalState("maintenance.integrity-verify") as {
    attemptedAt?: string;
    completedAt?: string;
    state?: string;
  };
  assert.equal(persisted.state, "SUCCEEDED");
  assert.equal(persisted.completedAt, completedAt);
  assert.equal(typeof persisted.attemptedAt, "string");
  assert.ok(
    Date.parse(persisted.attemptedAt!) <= Date.parse(completedAt),
    "integrity verification cannot complete before it is recorded as attempted"
  );
});

test("integrity verification reports a local failure without leaking data", async () => {
  const handle = createEngineProtocol(new InMemoryBackendStore(), "memory", {
    verifyEncryptionIntegrity: async () => { throw new Error("tampered encrypted row"); }
  });

  const result = await handle({ version: 1, id: "integrity-failure", kind: "maintenance.integrity.verify" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "LOCAL_INTEGRITY_VERIFY_FAILED");
  assert.equal(result.message, "tampered encrypted row");
});

test("state projection treats a zero change limit as no history", async () => {
  const repository = new InMemoryBackendStore();
  await repository.setAutomation({
    mode: "INGEST_ONLY", onboardingComplete: true, ingestionPaused: false,
    publishingPaused: true, timezone: "Europe/Istanbul", scanIntervalMinutes: 30
  });
  const handle = createEngineProtocol(repository, "memory");
  const result = await handle({ version: 1, id: "state-no-history", kind: "state", afterCursor: 0, changeLimit: 0 });

  assert.deepEqual((result.snapshot as { changes?: unknown[] }).changes, []);
});

test("state projection returns a bounded, redacted job summary", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "job-summary", kind: "DRAFT", state: "FAILED", attempts: 1,
    lastError: "CODEX_RUNNER_UNAVAILABLE diagnostic-with-user-content",
    metadata: {
      candidateTitle: "Visible title", progressStage: "DRAFTING",
      instruction: "x".repeat(1_000), sourceUrl: "https://private.example/source",
      codexDiagnosticDetail: "must not cross state boundary"
    }
  });
  const handle = createEngineProtocol(repository, "memory");
  const result = await handle({ version: 1, id: "state-job-summary", kind: "state", afterCursor: 0 });
  const job = ((result.snapshot as { jobs?: Array<Record<string, unknown>> }).jobs ?? [])[0] ?? {};
  const metadata = job.metadata as Record<string, unknown>;

  assert.equal(job.lastError, "CODEX_RUNNER_UNAVAILABLE");
  assert.equal(metadata.candidateTitle, "Visible title");
  assert.equal(metadata.progressStage, "DRAFTING");
  assert.equal(String(metadata.instruction).length, 500);
  assert.equal(metadata.sourceUrl, undefined);
  assert.equal(metadata.codexDiagnosticDetail, undefined);
});

test("engine protocol rejects malformed requests without throwing", async () => {
  const handle = createEngineProtocol();
  const result = await handle({ version: 2, id: "bad", kind: "doctor" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_REQUEST");
});

test("stdio framing rejects an oversized line without retaining or parsing it", async () => {
  const chunks = [
    Buffer.alloc(700_000, 0x61),
    Buffer.alloc(700_000, 0x62),
    Buffer.from("\n{\"version\":1}\n")
  ];
  const lines: Array<string | null> = [];

  for await (const line of readBoundedLines(Readable.from(chunks))) {
    lines.push(line);
  }

  assert.deepEqual(lines, [null, '{"version":1}']);
});

test("engine backup verification decrypts in memory and returns a preview without restoring", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-backup-"));
  const source = join(root, "source");
  const archive = join(root, "backup.blogbot");
  await mkdir(source);
  await writeFile(join(source, "state.json"), "{}\n", "utf8");
  const bytes = await createPortableBackup({
    sourceDirectory: source,
    relativePaths: ["state.json"],
    recoveryKey: "correct-recovery-key-123",
    createdAt: "2026-07-30T09:00:00.000Z"
  });
  await writeFile(archive, bytes);
  const result = await handleBackupRequest({
    version: 1,
    id: "backup-1",
    kind: "backup.restore.preview",
    payload: {
      archivePath: archive,
      recoveryKey: "correct-recovery-key-123",
      targetDirectory: join(root, "restore-target")
    }
  }, root);

  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.deepEqual(result.entries, [{
    relativePath: "state.json",
    targetPath: join(root, "restore-target", "state.json"),
    size: 3,
    sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    status: "create"
  }]);
});

test("engine backup verification rejects a directory masquerading as an archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-backup-invalid-"));
  const archive = join(root, "not-an-archive");
  await mkdir(archive);

  const result = await handleBackupRequest({
    version: 1,
    id: "backup-invalid-1",
    kind: "backup.verify",
    payload: {
      archivePath: archive,
      recoveryKey: "correct-recovery-key-123"
    }
  }, root);

  assert.equal(result.ok, false);
  assert.equal(result.code, "BACKUP_INVALID");
});

test("engine backup restore fails closed when the native restore writer is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-backup-apply-"));
  const source = join(root, "source");
  const archive = join(root, "backup.blogbot");
  const target = join(root, "restore-target");
  await mkdir(source);
  await writeFile(join(source, "state.json"), "{}\n", "utf8");
  await writeFile(archive, await createPortableBackup({
    sourceDirectory: source,
    relativePaths: ["state.json"],
    recoveryKey: "correct-recovery-key-123",
    createdAt: "2026-07-30T09:00:00.000Z"
  }));
  const previousRestoreWriter = process.env.BLOGBOT_SECURE_RESTORE_BIN;
  delete process.env.BLOGBOT_SECURE_RESTORE_BIN;
  try {
    const result = await handleBackupRequest({
      version: 1,
      id: "backup-apply-1",
      kind: "backup.restore",
      payload: { archivePath: archive, recoveryKey: "correct-recovery-key-123", targetDirectory: target }
    }, root);
    assert.equal(result.ok, false);
    assert.equal(result.code, "BACKUP_INVALID");
    assert.equal(result.message, "SECURE_RESTORE_SIDECAR_UNAVAILABLE");
    await assert.rejects(() => access(target));
  } finally {
    if (previousRestoreWriter === undefined) delete process.env.BLOGBOT_SECURE_RESTORE_BIN;
    else process.env.BLOGBOT_SECURE_RESTORE_BIN = previousRestoreWriter;
  }
});

test("stdio dispatcher keeps read-only requests out of the mutation queue", () => {
  assert.equal(isParallelReadRequest({ version: 1, id: "state", kind: "state" }), true);
  assert.equal(isParallelReadRequest({ version: 1, id: "revision-list", kind: "command", command: { kind: "REVISION.LIST" } }), true);
  assert.equal(isParallelReadRequest({ version: 1, id: "publish", kind: "publication.enqueue" }), false);
  assert.equal(isParallelReadRequest({ version: 1, id: "approve", kind: "command", command: { kind: "APPROVAL.GRANT" } }), false);
});

test("automatic snapshots can be listed, verified, and previewed without exposing their derived key", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-auto-backup-access-"));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "42".repeat(32);
  try {
    await writeFile(join(root, "state.json"), "{}\n", "utf8");
    const created = await createConsistentAutomaticBackup(logicalBackupGate().gate, root);
    assert.equal(created.ok, true);

    const listed = await handleBackupRequest({ version: 1, id: "auto-list", kind: "backup.auto.list", payload: {} }, root);
    assert.equal(listed.ok, true);
    const snapshots = listed.snapshots as Array<{ name: string }>;
    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0];
    assert.ok(snapshot);
    assert.match(snapshot.name, /^automatic-.+\.backup$/u);

    const verified = await handleAutomaticBackupAccess({
      version: 1,
      id: "auto-verify",
      kind: "backup.auto.verify",
      payload: { backupName: snapshot.name }
    }, root, logicalBackupGate().gate);
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, true);

    const preview = await handleAutomaticBackupAccess({
      version: 1,
      id: "auto-preview",
      kind: "backup.auto.restore.preview",
      payload: { backupName: snapshot.name }
    }, root, logicalBackupGate().gate);
    assert.equal(preview.ok, true);
    assert.equal(preview.verified, true);
  } finally {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("automatic backups never run in the first interactive session window", () => {
  assert.equal(automaticBackupInitialDelayMs(), 24 * 60 * 60 * 1_000);
});

test("automatic snapshot reads every table inside one transaction so the archive is consistent", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-auto-backup-consistency-"));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "43".repeat(32);
  const events: string[] = [];
  try {
    let insideTransaction = false;
    const read = async <Row>(sql: string) => {
      events.push(`${insideTransaction ? "tx" : "loose"}:${sql.includes("information_schema.tables")
        ? "list-tables"
        : sql.includes("information_schema.columns") ? "list-columns" : "select-rows"}`);
      return { rows: (sql.includes("information_schema.tables")
        ? [{ table_name: "blogbot_automation" }]
        : sql.includes("information_schema.columns")
          ? [{ column_name: "singleton_id" }, { column_name: "value" }]
          : [{ singleton_id: 1, value: { mode: "INGEST_ONLY" } }]) as Row[] };
    };
    const result = await createConsistentAutomaticBackup({
      query: read,
      transaction: async <T>(work: (transaction: {
        query<Row>(sql: string, parameters?: readonly unknown[]): Promise<{ rows: Row[] }>;
      }) => Promise<T>) => {
        insideTransaction = true;
        try {
          return await work({ query: read });
        } finally {
          insideTransaction = false;
        }
      }
    }, root);

    assert.equal(result.ok, true, JSON.stringify(result));
    // One transaction is already a consistent MVCC view, so the archive cannot
    // mix rows from before and after a concurrent write. Reading outside it, or
    // through PGlite's non-reentrant exclusive gate, would either tear the
    // snapshot or deadlock.
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.startsWith("tx:")), events.join(","));
    assert.ok(events.includes("tx:list-tables"));
    assert.ok(events.includes("tx:select-rows"));
    assert.equal(result.rows, 1);
  } finally {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed Boby answer survives the dashboard job projection", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "boby-guidance-1",
    kind: "CODEX",
    state: "SUCCEEDED",
    attempts: 1,
    metadata: {
      purpose: "BOBY_GUIDANCE",
      bobySessionId: "session-1",
      bobyReply: "Kaynak eklemek için İçerik Akışı ekranını açın.",
      bobyActions: [{ id: "OPEN_SOURCES", label: "Kaynakları aç" }]
    }
  });
  const handle = createEngineProtocol(repository, "memory");

  const result = await handle({
    version: 1,
    id: "boby-state",
    kind: "state",
    afterCursor: 0
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const jobs = (result.snapshot as { jobs: Array<Record<string, unknown>> }).jobs;
  const job = jobs.find((entry) => entry.id === "boby-guidance-1");
  assert.ok(job, "the Boby job must be visible in the desktop projection");
  const metadata = job.metadata as Record<string, unknown> | undefined;
  // The desktop resolves a Boby answer from this projection: without `purpose`
  // the lookup rejects the job as "not found", and without the reply there is
  // nothing to show even after Codex answered.
  assert.equal(metadata?.purpose, "BOBY_GUIDANCE");
  assert.equal(metadata?.bobyReply, "Kaynak eklemek için İçerik Akışı ekranını açın.");
  assert.deepEqual(metadata?.bobyActions, [{ id: "OPEN_SOURCES", label: "Kaynakları aç" }]);
  assert.equal(metadata?.bobySessionId, "session-1");
});

test("HTML evidence extraction matches the documented output and stays linear on hostile input", () => {
  assert.equal(
    htmlToEvidenceText("<h1>Başlık</h1><p>Doğrulanmış <b>gelişme</b>.</p>"),
    "Başlık Doğrulanmış gelişme ."
  );
  // Script, style and noscript bodies are evidence-free markup, not article text.
  assert.equal(
    htmlToEvidenceText("<p>Önce</p><script>var a = 1 < 2;</script><style>p{color:red}</style><p>Sonra</p>"),
    "Önce Sonra"
  );
  // A tag name that merely starts with a skipped name is a normal element.
  assert.equal(htmlToEvidenceText("<scripted>Metin</scripted>"), "Metin");

  // Untrusted source pages are frequently malformed. Each of these took tens of
  // seconds to minutes with the previous quadratic regex pipeline and blocked
  // every other engine request on the single thread.
  const budgetMs = 2_000;
  for (const hostile of [
    "<script>".repeat(128 * 1024),
    "<".repeat(512 * 1024),
    `${"<p>metin</p>".repeat(64 * 1024)}<script>`
  ]) {
    const startedAt = Date.now();
    htmlToEvidenceText(hostile);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < budgetMs, `malformed markup must stay linear, took ${elapsed} ms`);
  }
});

test("the automatic backup due-check treats a missing, stale or future timestamp as overdue", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  const day = 24 * 60 * 60 * 1_000;

  // Never taken, or no readable outcome yet.
  assert.equal(automaticBackupIsOverdue(undefined, now), true);
  assert.equal(automaticBackupIsOverdue({}, now), true);
  assert.equal(automaticBackupIsOverdue({ state: "FAILED" }, now), true);
  assert.equal(automaticBackupIsOverdue({ succeededAt: "not-a-date" }, now), true);

  // Taken within the interval.
  assert.equal(
    automaticBackupIsOverdue({ succeededAt: new Date(now - day / 2).toISOString() }, now),
    false
  );
  // Exactly one interval old counts as due.
  assert.equal(
    automaticBackupIsOverdue({ succeededAt: new Date(now - day).toISOString() }, now),
    true
  );
  // A clock moved backwards must not postpone recovery coverage indefinitely.
  assert.equal(
    automaticBackupIsOverdue({ succeededAt: new Date(now + day).toISOString() }, now),
    true
  );
});

test("a replayed Codex materialization returns the first revision instead of poisoning its key", async () => {
  const repository = new InMemoryBackendStore();
  const key = "codex-materialize:draft-job-1";
  const first = {
    id: "draft-job-1",
    translationKey: "story-1",
    state: "REVIEW_REQUIRED" as const,
    tr: { title: "İlk", slug: "ilk", description: "A", bodyMarkdown: "B", heroImageAlt: "C" },
    en: { title: "First", slug: "first", description: "A", bodyMarkdown: "B", heroImageAlt: "C" },
    section: "haberler" as const,
    articleType: "news" as const,
    author: "Ada",
    tags: [],
    claims: [],
    sources: [],
    media: [],
    scheduledAt: "2026-08-19T10:00:00.000Z",
    adapterVersion: "1"
  };
  // The durable effects run before the Codex job is CAS'd to COMPLETED. After a
  // crash in between, restart recovery re-runs the job and Codex returns
  // different prose for the same draft.
  const second = { ...first, tr: { ...first.tr, bodyMarkdown: "Yeniden üretilmiş gövde" } };

  const stored = await repository.runIdempotent(key, key, (tx) => tx.insertRevision(first));
  const replayed = await repository.runIdempotent(key, key, (tx) => tx.insertRevision(second));

  assert.equal(stored.id, "draft-job-1");
  assert.equal(
    replayed.tr.bodyMarkdown,
    "B",
    "the replay must return the first materialized revision, not a second one"
  );
  assert.equal((await repository.sync(0)).snapshot.revisions.length, 1);
});

test("an overdue daily snapshot is caught up once at startup instead of waiting a whole interval", async () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  const hour = 60 * 60 * 1_000;
  const overdueRuns: string[] = [];

  // `setInterval` alone first fires 24 h from now and is recreated on every
  // sidecar spawn, so an ordinary desktop session never reached it.
  const overdue = scheduleOverdueAutomaticBackup(
    { state: "SUCCEEDED", succeededAt: new Date(now - 30 * hour).toISOString() },
    () => overdueRuns.push("overdue"),
    now,
    0
  );
  assert.notEqual(overdue, undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(overdueRuns, ["overdue"]);

  const fresh = scheduleOverdueAutomaticBackup(
    { state: "SUCCEEDED", succeededAt: new Date(now - hour).toISOString() },
    () => overdueRuns.push("fresh"),
    now,
    0
  );
  assert.equal(fresh, undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(overdueRuns, ["overdue"]);
});

test("the approval-bound files digest orders paths by bytes so the native verifier agrees", () => {
  // The native claim verifier sorts the same bundle with byte order. Under this
  // machine's locale an ICU collation orders `_`, `-` and case differently, and
  // the resulting digest mismatch rejects an approved, immutable revision for
  // good.
  const files = [
    { path: "public/images/a_b.webp", content: "1" },
    { path: "public/images/a-b.webp", content: "2" },
    { path: "public/images/aB.webp", content: "3" },
    { path: "public/images/ab.webp", content: "4" }
  ];
  const expected = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
  )) {
    const content = Buffer.from(file.content, "utf8");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(content.byteLength));
    expected.update(file.path, "utf8").update(Buffer.from([0])).update(size).update(content);
  }

  assert.equal(approvalBoundFilesDigest(files), expected.digest("hex"));
});

test("automatic snapshot retention never deletes a backup the engine does not own", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-auto-backup-retention-"));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "44".repeat(32);
  const day = 24 * 60 * 60 * 1_000;
  try {
    await writeFile(join(root, "state.json"), "{}\n", "utf8");
    const backups = join(root, "backups");
    await mkdir(backups, { recursive: true });
    // Enough engine snapshots, spread over more than the retained daily and
    // weekly windows, that retention really plans deletions.
    for (const days of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 30, 40, 50, 60, 70, 80, 90]) {
      const name = join(backups, `automatic-old-${days}.backup`);
      await writeFile(name, "snapshot", "utf8");
      const stamp = new Date(Date.now() - days * day);
      await utimes(name, stamp, stamp);
    }
    // A user may reasonably keep their own manual archive next to the engine's
    // snapshots. No read path ever lists it, so deleting it is silent data loss.
    const manual = join(backups, "before-upgrade.backup");
    await writeFile(manual, "manual", "utf8");
    const manualStamp = new Date(Date.now() - 300 * day);
    await utimes(manual, manualStamp, manualStamp);

    const created = await createConsistentAutomaticBackup(logicalBackupGate().gate, root);
    assert.equal(created.ok, true, JSON.stringify(created));
    await access(manual);
    const remaining = await readdir(backups);
    assert.ok(remaining.some((name) => /^automatic-\d{4}-/u.test(name)), "the new snapshot must be on disk");
    assert.ok(remaining.length < 28, "retention must still remove superseded engine snapshots");
  } finally {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful backup leaves no temporary archive behind and refuses to overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-backup-temporary-"));
  try {
    await writeFile(join(root, "state.json"), "{}\n", "utf8");
    const output = join(root, "out", "manual.backup");
    const request = {
      version: 1,
      id: "backup-temporary",
      kind: "backup.create",
      payload: { outputPath: output, sourceDirectory: root, relativePaths: ["state.json"], recoveryKey: "correct-recovery-key-123" }
    };
    const created = await handleBackupRequest(request, root);
    assert.equal(created.ok, true, JSON.stringify(created));
    // A `.tmp-*` leftover is a valid encrypted archive under a name nothing
    // lists, verifies, or deletes.
    assert.deepEqual((await readdir(join(root, "out"))).filter((name) => name.includes(".tmp-")), []);

    const clobbered = await handleBackupRequest({ ...request, id: "backup-temporary-again" }, root);
    assert.equal(clobbered.ok, false);
    assert.equal(clobbered.code, "BACKUP_OUTPUT_EXISTS");
    assert.deepEqual((await readdir(join(root, "out"))).filter((name) => name.includes(".tmp-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup finalization cannot replace a destination created after the temporary archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-backup-race-"));
  try {
    const temporary = join(root, "manual.backup.tmp");
    const output = join(root, "manual.backup");
    assert.equal(await writeBackupArchiveNoReplace(
      temporary,
      output,
      Buffer.from("encrypted-archive", "utf8"),
      async (target, archive) => {
        await writeFile(target, archive, { flag: "wx" });
        // This simulates another process winning the race after Blogbot has
        // fully written its temp archive but before the filesystem commit.
        await writeFile(output, "racing-writer", { encoding: "utf8", flag: "wx" });
      }
    ), false);
    assert.equal(await (await import("node:fs/promises")).readFile(output, "utf8"), "racing-writer");
    await assert.rejects(access(temporary), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup finalization removes a partial temporary archive after a write failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-backup-write-failure-"));
  try {
    const temporary = join(root, "manual.backup.tmp");
    const output = join(root, "manual.backup");
    await assert.rejects(
      writeBackupArchiveNoReplace(
        temporary,
        output,
        Buffer.from("complete-encrypted-archive", "utf8"),
        async (target) => {
          await writeFile(target, "partial", { encoding: "utf8", flag: "wx" });
          throw Object.assign(new Error("simulated disk full"), { code: "ENOSPC" });
        }
      ),
      { code: "ENOSPC", message: "simulated disk full" }
    );
    await assert.rejects(access(temporary), { code: "ENOENT" });
    await assert.rejects(access(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup finalization never deletes a temporary archive owned by another writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-backup-temp-owner-"));
  try {
    const temporary = join(root, "manual.backup.tmp");
    const output = join(root, "manual.backup");
    await writeFile(temporary, "other-writer", { encoding: "utf8", flag: "wx" });

    await assert.rejects(
      writeBackupArchiveNoReplace(temporary, output, Buffer.from("our-archive", "utf8")),
      { code: "EEXIST" }
    );
    assert.equal(await (await import("node:fs/promises")).readFile(temporary, "utf8"), "other-writer");
    await assert.rejects(access(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore writer that stops reading fails the request instead of killing the engine", async (t) => {
  const stub = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
  try {
    await access(stub);
  } catch {
    t.skip("no stub writer available on this host");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-restore-epipe-"));
  const source = join(root, "source");
  const archive = join(root, "backup.blogbot");
  const previousRestoreWriter = process.env.BLOGBOT_SECURE_RESTORE_BIN;
  process.env.BLOGBOT_SECURE_RESTORE_BIN = stub;
  try {
    await mkdir(source);
    // Comfortably larger than the OS pipe buffer, so the payload write is still
    // in flight when the writer exits. Without a listener on the child's stdin
    // that EPIPE was an unhandled 'error' event and took the whole engine down.
    await writeFile(join(source, "state.json"), "x".repeat(2_000_000), "utf8");
    await writeFile(archive, await createPortableBackup({
      sourceDirectory: source,
      relativePaths: ["state.json"],
      recoveryKey: "correct-recovery-key-123",
      createdAt: "2026-08-19T09:00:00.000Z"
    }));

    const result = await handleBackupRequest({
      version: 1,
      id: "restore-epipe",
      kind: "backup.restore",
      payload: { archivePath: archive, recoveryKey: "correct-recovery-key-123", targetDirectory: join(root, "restore-target") }
    }, root);

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, "BACKUP_INVALID");
    assert.equal(result.message, "SECURE_RESTORE_WRITE_FAILED");
  } finally {
    if (previousRestoreWriter === undefined) delete process.env.BLOGBOT_SECURE_RESTORE_BIN;
    else process.env.BLOGBOT_SECURE_RESTORE_BIN = previousRestoreWriter;
    await rm(root, { recursive: true, force: true });
  }
});

test("job.retry refuses a Codex-waiting job when no runner exists instead of hiding the reason", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-no-runner-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 0,
    lastError: "CODEX_RUNNER_UNAVAILABLE"
  });
  const handle = createEngineProtocol(repository, "memory");

  const response = await handle({
    version: 1,
    id: "retry-no-runner",
    kind: "command",
    command: {
      version: 1,
      requestId: "retry-no-runner",
      idempotencyKey: "retry-no-runner",
      expectedVersion: await repository.getVersion(),
      kind: "JOB.RETRY",
      payload: { jobId: "draft-no-runner-1" }
    }
  });

  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal((response.result as { error: { code: string } }).error.code, "CODEX_RUNNER_UNAVAILABLE");
  const job = await repository.getJob("draft-no-runner-1");
  assert.equal(job.state, "WAITING_CODEX");
  assert.equal(job.attempts, 0);
  assert.equal(job.lastError, "CODEX_RUNNER_UNAVAILABLE");
});

test("job.retry restores the original stop condition when the durable Codex record cannot be requeued", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-unrecoverable-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 2,
    lastError: "CODEX_OUTPUT_MISSING"
  });
  const codexCoordinator = {
    async submit() { throw new Error("not used"); },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); },
    async recoverInterrupted() { return { recovered: false, snapshot: null }; }
  } satisfies CodexWorkerCoordinator;
  const handle = createEngineProtocol(repository, "memory", { codexCoordinator });

  const response = await handle({
    version: 1,
    id: "retry-unrecoverable",
    kind: "command",
    command: {
      version: 1,
      requestId: "retry-unrecoverable",
      idempotencyKey: "retry-unrecoverable",
      expectedVersion: await repository.getVersion(),
      kind: "JOB.RETRY",
      payload: { jobId: "draft-unrecoverable-1" }
    }
  });

  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal((response.result as { error: { code: string } }).error.code, "CODEX_RECOVERY_UNAVAILABLE");
  const job = await repository.getJob("draft-unrecoverable-1");
  assert.equal(job.state, "WAITING_CODEX");
  assert.equal(job.attempts, 2);
  assert.equal(job.lastError, "CODEX_OUTPUT_MISSING");
});

test("job.retry restores every terminal Codex stop when its durable record cannot be requeued", async () => {
  for (const state of ["RETRY_SCHEDULED", "FAILED", "DEAD_LETTER"] as const) {
    const repository = new InMemoryBackendStore();
    const before = {
      id: `draft-unrecoverable-${state.toLowerCase()}`,
      kind: "DRAFT",
      state,
      attempts: 2,
      lastError: "CODEX_JOB_RETRYING",
      metadata: {
        progressStage: "FINAL_REVIEW_RETRY_SCHEDULED",
        nextAttemptAtUnixMs: Date.now() - 60_000
      }
    } as const;
    await repository.createJob(before);
    const codexCoordinator = {
      async submit() { throw new Error("not used"); },
      async process() { throw new Error("not used"); },
      async retryWaiting() { throw new Error("not used"); },
      async recoverInterrupted() { return { recovered: false, snapshot: null }; }
    } satisfies CodexWorkerCoordinator;
    const handle = createEngineProtocol(repository, "memory", { codexCoordinator });

    const response = await handle({
      version: 1,
      id: `retry-unrecoverable-${state.toLowerCase()}`,
      kind: "command",
      command: {
        version: 1,
        requestId: `retry-unrecoverable-${state.toLowerCase()}`,
        idempotencyKey: `retry-unrecoverable-${state.toLowerCase()}`,
        expectedVersion: await repository.getVersion(),
        kind: "JOB.RETRY",
        payload: { jobId: before.id }
      }
    });

    assert.equal(response.ok, false, `${state}: ${JSON.stringify(response)}`);
    assert.equal((response.result as { error: { code: string } }).error.code, "CODEX_RECOVERY_UNAVAILABLE", state);
    assert.deepEqual(await repository.getJob(before.id), before, state);
  }
});

test("an interrupted Boby guidance job becomes retryable instead of staying RUNNING forever", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "boby-guidance-1",
    kind: "CODEX",
    state: "RUNNING",
    attempts: 1,
    metadata: { purpose: "BOBY_GUIDANCE", question: "Sonraki adım ne?" }
  });
  let recoveryCalls = 0;
  const coordinator = {
    async submit() { throw new Error("not used"); },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); },
    async recoverInterrupted() {
      recoveryCalls += 1;
      return { recovered: recoveryCalls > 1, snapshot: null };
    }
  } satisfies CodexWorkerCoordinator;

  await recoverWaitingDraftJobs(repository, coordinator);

  const job = await repository.getJob("boby-guidance-1");
  assert.equal(job.state, "FAILED");
  assert.equal(job.lastError, "CODEX_RUNNER_INTERRUPTED");
  // JOB.RETRY only accepts a terminal or waiting state, so the panel and
  // Operations can now both act on this record.
  const handle = createEngineProtocol(repository, "memory", { codexCoordinator: coordinator });
  const response = await handle({
    version: 1,
    id: "boby-retry",
    kind: "command",
    command: {
      version: 1,
      requestId: "boby-retry",
      idempotencyKey: "boby-retry",
      expectedVersion: await repository.getVersion(),
      kind: "JOB.RETRY",
      payload: { jobId: "boby-guidance-1" }
    }
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal((await repository.getJob("boby-guidance-1")).state, "QUEUED");
});

test("an isolation rejection is not replayed on the next engine start", async () => {
  const repository = new InMemoryBackendStore();
  await repository.createJob({
    id: "draft-denied-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 1,
    lastError: "CODEX_PROTOCOL_REJECTED",
    metadata: {
      codexWaitReason: "RUNNER_REQUIRES_RETRY",
      codexDiagnosticCode: "CODEX_PROTOCOL_REJECTED",
      sourceIds: ["source-1"],
      urls: []
    }
  });
  await repository.createJob({
    id: "draft-auth-1",
    kind: "DRAFT",
    state: "WAITING_CODEX",
    attempts: 1,
    lastError: "AUTH_REQUIRED",
    metadata: { codexWaitReason: "AUTH_REQUIRED", sourceIds: ["source-1"], urls: [] }
  });
  const recoveredIds: string[] = [];
  const coordinator = {
    async submit() { throw new Error("not used"); },
    async process() { throw new Error("not used"); },
    async retryWaiting() { throw new Error("not used"); },
    async recoverInterrupted(jobId: string) {
      recoveredIds.push(jobId);
      return { recovered: true, snapshot: null };
    }
  } satisfies CodexWorkerCoordinator;

  await recoverWaitingDraftJobs(repository, coordinator);

  // The denied job carries a completed, user-visible stop condition, and its
  // prompt may have been steered by untrusted source text.
  assert.deepEqual(recoveredIds, ["draft-auth-1"]);
  assert.equal((await repository.getJob("draft-denied-1")).state, "WAITING_CODEX");
  assert.equal((await repository.getJob("draft-auth-1")).state, "QUEUED");
});

test("draft evidence collection shares one network budget across every source fetch", async () => {
  // The desktop bridge abandons a `command` request after 30 s, so independent
  // per-fetch timeouts for up to 70 sources could never fit inside it.
  assert.ok(DRAFT_EVIDENCE_FETCH_BUDGET_MS < 20 * 1_000);
  const urls = ["one", "two", "three", "four", "five"].map((name) => `https://example.com/${name}`);
  const attempted: string[] = [];
  const startedAt = Date.now();

  const evidence = await collectDraftSourceEvidence(undefined, [], urls, {
    async resolve() { return ["93.184.216.34"]; },
    async request(plan) {
      attempted.push(plan.url);
      return new Promise(() => undefined);
    }
  }, undefined, 300);

  const elapsed = Date.now() - startedAt;
  assert.deepEqual(evidence, []);
  assert.ok(elapsed < 2_000, `evidence collection must honour its shared budget, took ${elapsed} ms`);
  assert.ok(attempted.length < urls.length, "the exhausted budget must stop further fetches");
});

test("an automatic snapshot of a real workspace round-trips through verify and restore", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-logical-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "77".repeat(32);
  t.after(() => {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
  });

  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());
  const database = repository.getDatabase();

  // Give the workspace something worth recovering.
  await repository.setLocalState("desktop.editorial", { author: "Editor", mutations: [{ kind: "CANDIDATE.PROMOTE" }] });
  const before = await repository.getLocalState("desktop.editorial");

  const created = await createConsistentAutomaticBackup(database, join(root, "pgdata"));
  assert.equal(created.ok, true, JSON.stringify(created));
  // The archive covers the rows Blogbot owns, so it is orders of magnitude
  // smaller than the PGlite data directory a file walk would have to carry.
  assert.ok((created.bytes as number) > 0);
  assert.ok((created.bytes as number) < 8 * 1024 * 1024, `archive should stay small, got ${String(created.bytes)}`);
  assert.ok((created.rows as number) > 0, "a real workspace must archive at least one row");

  const backupName = String(created.outputPath).split(/[\\/]/u).at(-1);
  const verified = await handleAutomaticBackupAccess(
    { version: 1, id: "verify", kind: "backup.auto.verify", payload: { backupName } },
    join(root, "pgdata"),
    database
  );
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.verified, true);
  assert.ok((verified.rows as number) > 0);

  // Restore replaces every local row, so it must refuse without explicit consent.
  const unconfirmed = await handleAutomaticBackupAccess(
    { version: 1, id: "restore-unconfirmed", kind: "backup.auto.restore", payload: { backupName } },
    join(root, "pgdata"),
    database
  );
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, "BACKUP_CONFIRMATION_REQUIRED");

  // Lose the data, then bring it back from the snapshot.
  await repository.setLocalState("desktop.editorial", { author: "Overwritten", mutations: [] });
  const restored = await handleAutomaticBackupAccess(
    { version: 1, id: "restore", kind: "backup.auto.restore", payload: { backupName, confirmReplaceLocalData: true } },
    join(root, "pgdata"),
    database
  );
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.ok((restored.restoredRows as number) > 0);
  assert.deepEqual(await repository.getLocalState("desktop.editorial"), before);
});

test("an automatic logical restore preserves the source foreign-key graph and its derived capabilities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-logical-source-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "78".repeat(32);
  t.after(() => {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
  });

  const repository = await PGliteBackendRepository.open(join(root, "pgdata"));
  t.after(() => repository.close());
  const database = repository.getDatabase();
  const sources = await PGliteSourceRepository.fromDatabase(database);
  const source = {
    id: "restore-source",
    url: "https://news.example/restore.xml",
    kind: "RSS" as const,
    status: "ACTIVE" as const,
    trustStatus: "APPROVED" as const,
    rightsStatus: "APPROVED" as const,
    language: "en" as const,
    discoveredFeeds: [],
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    version: 1
  };
  await sources.saveSource(source);
  await sources.saveEntries(source.id, [{
    externalId: "restore-entry",
    title: "Restore dependency ordering",
    url: "https://news.example/restore-entry",
    publishedAt: "2026-08-21T01:00:00.000Z",
    summary: "The latest pointer must still reach its archived version after restore."
  }]);
  const entriesBefore = await sources.listEntries(source.id);
  const capabilitiesBefore = await sources.getSourceCapabilities(source.id);

  const created = await createConsistentAutomaticBackup(database, join(root, "pgdata"));
  assert.equal(created.ok, true, JSON.stringify(created));
  const backupName = String(created.outputPath).split(/[\\/]/u).at(-1);
  const restored = await handleAutomaticBackupAccess(
    { version: 1, id: "restore-source-graph", kind: "backup.auto.restore", payload: { backupName, confirmReplaceLocalData: true } },
    join(root, "pgdata"),
    database
  );

  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.deepEqual(await sources.listEntries(source.id), entriesBefore);
  assert.deepEqual(await sources.getSourceCapabilities(source.id), capabilitiesBefore);
});

test("an automatic snapshot cannot be read back with the wrong local data key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-logical-snapshot-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "11".repeat(32);
  t.after(() => {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
  });

  const created = await createConsistentAutomaticBackup(logicalBackupGate().gate, root);
  assert.equal(created.ok, true, JSON.stringify(created));
  const backupName = String(created.outputPath).split(/[\\/]/u).at(-1);

  // The snapshot key is derived from the local data key, so a different profile
  // key must fail closed rather than return rows.
  process.env.BLOGBOT_DATA_KEY_HEX = "22".repeat(32);
  const verified = await handleAutomaticBackupAccess(
    { version: 1, id: "verify-wrong-key", kind: "backup.auto.verify", payload: { backupName } },
    root,
    logicalBackupGate().gate
  );
  assert.equal(verified.ok, false);
  assert.equal(verified.code, "BACKUP_INVALID");
});
