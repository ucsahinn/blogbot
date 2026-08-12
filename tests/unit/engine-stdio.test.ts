import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEngineProtocol,
  assertRevisionGeneratedFilesMatch,
  createConsistentAutomaticBackup,
  isPublicationPreviewCurrent,
  handleBackupRequest,
  protectedCatalogEvidenceReferences,
  protectedCatalogSourceIds,
  reportBackgroundTaskFault,
  reportCodexLifecycle,
  readBoundedLines,
  isParallelReadRequest
} from "../../apps/engine/src/stdio-entrypoint.ts";
import { buildPublicationPreview } from "../../apps/engine/src/publication-preview.ts";
import { createPortableBackup } from "../../packages/backup/src/portable-backup.ts";
import { InMemoryBackendStore } from "../../packages/database/src/in-memory-backend-store.ts";

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
  reportBackgroundTaskFault("SOURCE_RETENTION_UNAVAILABLE", () => { throw new Error("diagnostics unavailable"); });

  assert.deepEqual(lines, ["[Blogbot] AUTOMATIC_BACKUP_UNAVAILABLE\n"]);
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
  assert.equal((result.snapshot as { serverCursor?: number }).serverCursor, 42);
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
  assert.equal((result.snapshot as { serverCursor?: number }).serverCursor, 2);

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

test("engine backup restore writes only into a new target after verification", async () => {
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
  const result = await handleBackupRequest({
    version: 1,
    id: "backup-apply-1",
    kind: "backup.restore",
    payload: { archivePath: archive, recoveryKey: "correct-recovery-key-123", targetDirectory: target }
  }, root);
  assert.equal(result.ok, true);
  assert.equal(result.restored, true);
  assert.equal(await (await import("node:fs/promises")).readFile(join(target, "state.json"), "utf8"), "{}\n");
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
    const created = await handleBackupRequest({ version: 1, id: "auto-create", kind: "backup.auto", payload: {} }, root);
    assert.equal(created.ok, true);

    const listed = await handleBackupRequest({ version: 1, id: "auto-list", kind: "backup.auto.list", payload: {} }, root);
    assert.equal(listed.ok, true);
    const snapshots = listed.snapshots as Array<{ name: string }>;
    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0];
    assert.ok(snapshot);
    assert.match(snapshot.name, /^automatic-.+\.backup$/u);

    const verified = await handleBackupRequest({
      version: 1,
      id: "auto-verify",
      kind: "backup.auto.verify",
      payload: { backupName: snapshot.name }
    }, root);
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, true);

    const preview = await handleBackupRequest({
      version: 1,
      id: "auto-preview",
      kind: "backup.auto.restore.preview",
      payload: { backupName: snapshot.name, targetDirectory: join(root, "restored") }
    }, root);
    assert.equal(preview.ok, true);
    assert.equal(preview.verified, true);
  } finally {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("automatic snapshot checkpoints and excludes concurrent PGlite queries before reading live data", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-engine-auto-backup-checkpoint-"));
  const previousKey = process.env.BLOGBOT_DATA_KEY_HEX;
  process.env.BLOGBOT_DATA_KEY_HEX = "43".repeat(32);
  const events: string[] = [];
  try {
    await writeFile(join(root, "state.json"), "{}\n", "utf8");
    const result = await createConsistentAutomaticBackup({
      runExclusive: async <T>(work: () => Promise<T>) => {
        events.push("exclusive:start");
        const result = await work();
        events.push("exclusive:end");
        return result;
      },
      exec: async (query: string) => { events.push(query); return []; }
    }, root);

    assert.equal(result.ok, true);
    assert.deepEqual(events, ["exclusive:start", "CHECKPOINT", "exclusive:end"]);
  } finally {
    if (previousKey === undefined) delete process.env.BLOGBOT_DATA_KEY_HEX;
    else process.env.BLOGBOT_DATA_KEY_HEX = previousKey;
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});
