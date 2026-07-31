import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEngineProtocol,
  handleBackupRequest,
  readBoundedLines
} from "../../apps/engine/src/stdio-entrypoint.ts";
import { buildPublicationPreview } from "../../apps/engine/src/publication-preview.ts";
import { createPortableBackup } from "../../packages/backup/src/portable-backup.ts";

test("engine protocol exposes a truthful degraded doctor response", async () => {
  const handle = createEngineProtocol();
  const result = await handle({ version: 1, id: "doctor-1", kind: "doctor" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "DEGRADED");
  assert.equal(result.persistence, "memory");
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
