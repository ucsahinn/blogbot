import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  PGliteSourceRepository,
  SourceRepositoryError
} from "../../packages/database/src/source-repository.ts";

test("source catalog and feed entries persist across repository restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-repo-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const first = await PGliteSourceRepository.open(dataDir);
  const source = await first.saveSource({
    id: "source-1",
    url: "https://news.example/feed.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "PENDING",
    rightsStatus: "PENDING",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  });
  await first.saveEntries(source.id, [
    {
      externalId: "story-1",
      title: "Patch released",
      url: "https://news.example/stories/patch",
      publishedAt: "2026-07-29T08:00:00.000Z",
      summary: "Vendor published a security update."
    }
  ]);
  await first.close();

  const second = await PGliteSourceRepository.open(dataDir);
  t.after(() => second.close());

  assert.deepEqual(await second.getSource("source-1"), source);
  assert.deepEqual(await second.listEntries("source-1"), [
    {
      sourceId: "source-1",
      externalId: "story-1",
      title: "Patch released",
      url: "https://news.example/stories/patch",
      publishedAt: "2026-07-29T08:00:00.000Z",
      summary: "Vendor published a security update."
    }
  ]);
});

test("source approval state gates publication but never blocks scanning", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-gate-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  await repository.saveSource({
    id: "source-1",
    url: "https://news.example/feed.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "PENDING",
    rightsStatus: "PENDING",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  });

  assert.deepEqual(await repository.getSourceCapabilities("source-1"), {
    canScan: true,
    canPublish: false,
    blockers: ["TRUST_REVIEW_REQUIRED", "RIGHTS_REVIEW_REQUIRED"]
  });
});

test("source updates enforce optimistic version checks", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-version-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  await repository.saveSource({
    id: "source-1",
    url: "https://news.example/feed.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "PENDING",
    rightsStatus: "PENDING",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  });

  await assert.rejects(
    repository.saveSource(
      {
        id: "source-1",
        url: "https://news.example/feed.xml",
        kind: "RSS",
        status: "DISABLED",
        trustStatus: "APPROVED",
        rightsStatus: "APPROVED",
        language: "en",
        discoveredFeeds: [],
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T11:00:00.000Z",
        version: 2
      },
      0
    ),
    (error: unknown) =>
      error instanceof SourceRepositoryError &&
      error.code === "VERSION_CONFLICT"
  );

  const updated = await repository.saveSourceIdempotent(
    {
      id: "source-1",
      url: "https://news.example/feed.xml",
      kind: "RSS",
      status: "DISABLED",
      trustStatus: "APPROVED",
      rightsStatus: "APPROVED",
      language: "en",
      discoveredFeeds: [],
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T11:00:00.000Z",
      version: 2
    },
    1,
    "source-update-1"
  );
  assert.equal(updated.version, 2);
  assert.equal(updated.status, "DISABLED");
  assert.deepEqual(
    await repository.saveSourceIdempotent(
      updated,
      1,
      "source-update-1"
    ),
    updated
  );
});

test("source ciphertext is bound to its row identity", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-binding-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  for (const id of ["source-a", "source-b"]) {
    await repository.saveSource({
      id,
      url: `https://${id}.example/feed.xml`,
      kind: "RSS",
      status: "ACTIVE",
      trustStatus: "PENDING",
      rightsStatus: "PENDING",
      language: "en",
      discoveredFeeds: [],
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:00.000Z",
      version: 1
    });
  }
  await repository.close();

  const raw = new PGlite(dataDir);
  await raw.waitReady;
  await raw.exec(
    `UPDATE blogbot_sources
        SET value = (SELECT value FROM blogbot_sources WHERE id = 'source-b')
      WHERE id = 'source-a'`
  );
  await raw.close();

  await assert.rejects(
    PGliteSourceRepository.open(dataDir),
    /LOCAL_DATA_DECRYPT_FAILED/
  );
});

test("completed source encryption migration never accepts injected plaintext", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-plaintext-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  await repository.saveSource({
    id: "source-a",
    url: "https://source-a.example/feed.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "PENDING",
    rightsStatus: "PENDING",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  });
  await repository.close();

  const raw = new PGlite(dataDir);
  await raw.waitReady;
  await raw.query(
    "UPDATE blogbot_sources SET value = $2::jsonb WHERE id = $1",
    ["source-a", JSON.stringify({ id: "source-a", version: 1 })]
  );
  await raw.close();

  await assert.rejects(
    PGliteSourceRepository.open(dataDir),
    /LOCAL_DATA_ENVELOPE_INVALID/
  );
});

test("completed source encryption migration rejects plaintext scan records", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-scan-plaintext-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  await repository.saveSource({
    id: "source-a",
    url: "https://source-a.example/feed.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "PENDING",
    rightsStatus: "PENDING",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  });
  const [scan] = await repository.prepareScanBatch(
    "engine:scan-plaintext",
    "scan request",
    [{ sourceId: "source-a", expectedVersion: 1 }],
    "2026-07-29T10:05:00.000Z"
  );
  assert.ok(scan);
  await repository.close();

  const raw = new PGlite(dataDir);
  await raw.waitReady;
  await raw.query(
    "UPDATE blogbot_source_scans SET value = $2::jsonb WHERE id = $1",
    [scan.id, JSON.stringify(scan)]
  );
  await raw.close();

  await assert.rejects(
    PGliteSourceRepository.open(dataDir),
    /LOCAL_DATA_ENVELOPE_INVALID/
  );
});
