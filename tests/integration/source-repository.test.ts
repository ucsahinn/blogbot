import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { JsonProtector } from "../../packages/database/src/encrypted-json.ts";
import {
  PGliteSourceRepository,
  SourceRepositoryError
} from "../../packages/database/src/source-repository.ts";

function activeSource(id: string, url: string) {
  return {
    id,
    url,
    kind: "RSS" as const,
    status: "ACTIVE" as const,
    trustStatus: "APPROVED" as const,
    rightsStatus: "APPROVED" as const,
    language: "en" as const,
    discoveredFeeds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1
  };
}

function rawDatabase(repository: PGliteSourceRepository): PGlite {
  return (repository as unknown as { database: PGlite }).database;
}

function countTransactionalQueries(repository: PGliteSourceRepository) {
  const holder = repository as unknown as { database: PGlite };
  const database = holder.database;
  const originalTransaction = database.transaction.bind(database);
  let count = 0;
  holder.database = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (callback: (transaction: PGlite) => Promise<unknown>) => originalTransaction(async (transaction) => callback(new Proxy(transaction, {
          get(transactionTarget, transactionProperty, transactionReceiver) {
            if (transactionProperty === "query") {
              return async (...args: Parameters<PGlite["query"]>) => {
                count += 1;
                return transactionTarget.query(...args);
              };
            }
            const value = Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
            return typeof value === "function" ? value.bind(transactionTarget) : value;
          }
        }) as unknown as PGlite));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as PGlite;
  return () => count;
}

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
  const [entry] = await second.listEntries("source-1");
  assert.equal(entry?.sourceId, "source-1");
  assert.equal(entry?.externalId, "story-1");
  assert.equal(entry?.title, "Patch released");
  assert.equal(entry?.url, "https://news.example/stories/patch");
  assert.match(entry?.contentHash ?? "", /^[a-f0-9]{64}$/u);
  assert.match(entry?.versionId ?? "", /^entry-[a-f0-9]{64}$/u);
});

test("source entries retain append-only content-addressed versions while latest points to the newest capture", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-repo-versions-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());
  const source = {
    id: "source-versions",
    url: "https://news.example/versions.xml",
    kind: "RSS" as const,
    status: "ACTIVE" as const,
    trustStatus: "PENDING" as const,
    rightsStatus: "PENDING" as const,
    language: "en" as const,
    discoveredFeeds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1
  };
  await repository.saveSource(source);

  await repository.saveEntries(source.id, [{
    externalId: "story-1",
    title: "First capture",
    url: "https://news.example/stories/patch",
    summary: "Initial publisher text."
  }]);
  await repository.saveEntries(source.id, [{
    externalId: "story-1",
    title: "Revised capture",
    url: "https://news.example/stories/patch",
    summary: "Publisher corrected the source text."
  }]);

  const versions = await repository.listEntryVersions(source.id, "story-1");
  const latest = await repository.listEntries(source.id);
  const resolved = await repository.findEntryByUrl(source.id, "https://news.example/stories/patch");
  assert.equal(versions.length, 2);
  assert.equal(new Set(versions.map((entry) => entry.contentHash)).size, 2);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]?.title, "Revised capture");
  assert.equal(resolved?.title, "Revised capture");
  assert.equal(versions.some((entry) => entry.title === "First capture"), true);
});

test("bounded source entry reads avoid decrypting the entire feed catalog", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-repo-bounded-"));
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
  await repository.saveEntries("source-1", Array.from({ length: 8 }, (_, index) => ({
    externalId: `story-${String(index).padStart(2, "0")}`,
    title: `Story ${index}`,
    url: `https://news.example/stories/${index}`,
    summary: "Bounded test entry",
    // Deliberately reverse the lexical ID order: the query must use the
    // indexed publication time before it applies its bounded limit.
    publishedAt: `2026-08-${String(8 - index).padStart(2, "0")}T12:00:00.000Z`
  })));

  const entries = await repository.listEntriesBounded("source-1", 3);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.externalId), ["story-00", "story-01", "story-02"]);
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

test("concurrent source updates use an atomic version compare-and-swap", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-cas-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  const initial = {
    id: "source-1",
    url: "https://news.example/feed.xml",
    kind: "RSS" as const,
    status: "ACTIVE" as const,
    trustStatus: "PENDING" as const,
    rightsStatus: "PENDING" as const,
    language: "en" as const,
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  };
  await repository.saveSource(initial);

  const [first, second] = await Promise.allSettled([
    repository.saveSource({ ...initial, status: "DISABLED", updatedAt: "2026-07-29T11:00:00.000Z", version: 2 }, 1),
    repository.saveSource({ ...initial, trustStatus: "APPROVED", updatedAt: "2026-07-29T12:00:00.000Z", version: 2 }, 1)
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.equal((rejected as PromiseRejectedResult).reason.code, "VERSION_CONFLICT");
  assert.equal((await repository.getSource("source-1")).version, 2);
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

  const reopened = await PGliteSourceRepository.open(dataDir);
  try {
    await assert.rejects(reopened.verifyEncryptionIntegrity(), /LOCAL_DATA_DECRYPT_FAILED/);
  } finally {
    await reopened.close();
  }
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

  const reopened = await PGliteSourceRepository.open(dataDir);
  try {
    await assert.rejects(reopened.verifyEncryptionIntegrity(), /LOCAL_DATA_ENVELOPE_INVALID/);
  } finally {
    await reopened.close();
  }
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

  const reopened = await PGliteSourceRepository.open(dataDir);
  try {
    await assert.rejects(reopened.verifyEncryptionIntegrity(), /LOCAL_DATA_ENVELOPE_INVALID/);
  } finally {
    await reopened.close();
  }
});

test("large source scan commits entries with a bounded number of database queries", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-scan-batched-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());
  await repository.saveSource({
    id: "source-batched",
    url: "https://news.example/batched.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    version: 1
  });
  const [scan] = await repository.prepareScanBatch(
    "engine:batched-scan",
    "batched scan request",
    [{ sourceId: "source-batched", expectedVersion: 1 }],
    "2026-08-15T00:01:00.000Z"
  );
  assert.ok(scan);
  await repository.markScanRunning(scan.id, "2026-08-15T00:01:01.000Z");
  const queryCount = countTransactionalQueries(repository);

  const completed = await repository.completeSourceScan(scan.id, {
    kind: "RSS",
    finalUrl: "https://news.example/batched.xml",
    contentType: "application/rss+xml",
    discoveredFeeds: [],
    completedAt: "2026-08-15T00:02:00.000Z",
    entries: Array.from({ length: 64 }, (_, index) => ({
      externalId: `story-${index}`,
      title: `Story ${index}`,
      summary: `Summary ${index}`,
      url: `https://news.example/stories/${index}`,
      publishedAt: "2026-08-15T00:00:00.000Z"
    }))
  });

  assert.equal(completed.entriesAdded, 64);
  assert.ok(queryCount() <= 16, `expected batched scan writes, received ${queryCount()} transaction queries`);
  assert.equal((await repository.listEntries("source-batched")).length, 64);
});

test("concurrent source scan workers atomically claim one queued scan", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-scan-claim-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());
  await repository.saveSource({
    id: "source-claim",
    url: "https://news.example/claim.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    version: 1
  });
  const [scan] = await repository.prepareScanBatch(
    "engine:claim-scan",
    "claim scan request",
    [{ sourceId: "source-claim", expectedVersion: 1 }],
    "2026-08-15T00:01:00.000Z"
  );
  assert.ok(scan);

  const results = await Promise.all([
    repository.markScanRunning(scan.id, "2026-08-15T00:01:01.000Z"),
    repository.markScanRunning(scan.id, "2026-08-15T00:01:02.000Z")
  ]);
  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => !result.claimed).length, 1);
  assert.equal(results.find((result) => result.claimed)?.scan.attempts, 1);
  assert.equal((await repository.listScanRuns("engine:claim-scan"))[0]?.attempts, 1);
});

test("retention keeps protected evidence reachable after a newer version expires", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-purge-latest-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());
  await repository.saveSource(activeSource("s1", "https://ex.test/feed.xml"));

  await repository.saveEntries("s1", [{
    externalId: "e1",
    title: "Old title",
    url: "https://ex.test/a",
    publishedAt: "2026-01-01T00:00:00.000Z"
  }]);
  const [versionA] = await repository.listEntryVersions("s1", "e1");
  assert.ok(versionA?.versionId);
  await repository.saveEntries("s1", [{
    externalId: "e1",
    title: "New title",
    url: "https://ex.test/a",
    publishedAt: "2026-01-01T00:00:00.000Z"
  }]);

  // Only the newer capture expires; an approved revision cites version A.
  const purged = await repository.purgeExpiredEntries("2030-01-01T00:00:00.000Z", [versionA.versionId!]);

  assert.equal(purged, 1);
  assert.deepEqual((await repository.listEntryVersions("s1", "e1")).map((entry) => entry.title), ["Old title"]);
  assert.deepEqual((await repository.listEntries("s1")).map((entry) => entry.title), ["Old title"]);
  assert.equal((await repository.findEntryByUrl("s1", "https://ex.test/a"))?.title, "Old title");
  assert.deepEqual((await repository.listRecentEntriesBounded(10)).map((entry) => entry.title), ["Old title"]);
});

test("retention finds expired versions without decrypting the ledger", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-purge-nodecrypt-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());
  await repository.saveSource(activeSource("s1", "https://ex.test/feed.xml"));

  await repository.saveEntries("s1", Array.from({ length: 5 }, (_, index) => ({
    externalId: `old-${index}`,
    title: `Old ${index}`,
    url: `https://ex.test/old-${index}`
  })));
  await repository.saveEntries("s1", Array.from({ length: 40 }, (_, index) => ({
    externalId: `fresh-${index}`,
    title: `Fresh ${index}`,
    url: `https://ex.test/fresh-${index}`
  })));
  // Only the first capture batch predates the cutoff.
  await rawDatabase(repository).query(
    "UPDATE blogbot_source_entry_versions SET captured_at = '2020-01-01T00:00:00.000Z' WHERE external_id LIKE 'old-%'"
  );

  const originalOpen = JsonProtector.prototype.open;
  let opened = 0;
  JsonProtector.prototype.open = function patched(this: JsonProtector, ...args: Parameters<typeof originalOpen>) {
    opened += 1;
    return originalOpen.apply(this, args);
  } as typeof originalOpen;
  try {
    assert.equal(await repository.purgeExpiredEntries("2026-01-01T00:00:00.000Z"), 5);
  } finally {
    JsonProtector.prototype.open = originalOpen;
  }

  assert.equal(opened, 0);
  assert.equal((await repository.listEntries("s1")).length, 40);
});

test("a non-retryable scan failure persists the completion it reports", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-fail-scan-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());
  await repository.saveSource(activeSource("s1", "https://ex.test/feed.xml"));
  const [queued] = await repository.prepareScanBatch(
    "engine:scan-fail",
    "scan request",
    [{ sourceId: "s1", expectedVersion: 1 }],
    "2026-08-19T09:00:00.000Z"
  );
  assert.ok(queued);
  await repository.markScanRunning(queued.id, "2026-08-19T09:30:00.000Z");

  const failed = await repository.failSourceScan(
    queued.id,
    { code: "RIGHTS_REJECTED", message: "rights review rejected the source", retryable: false },
    "2026-08-19T10:00:00.000Z"
  );

  assert.equal(failed.state, "FAILED");
  assert.equal(failed.completedAt, "2026-08-19T10:00:00.000Z");
  const [persisted] = await repository.listScanRuns("engine:scan-fail");
  assert.equal(persisted?.state, "FAILED");
  assert.equal(persisted?.completedAt, failed.completedAt);
});

test("a retryable scan failure never persists a stale completion", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-retry-scan-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());
  await repository.saveSource(activeSource("s1", "https://ex.test/feed.xml"));
  const [queued] = await repository.prepareScanBatch(
    "engine:scan-retry",
    "scan request",
    [{ sourceId: "s1", expectedVersion: 1 }],
    "2026-08-19T09:00:00.000Z"
  );
  assert.ok(queued);
  // A running scan that still carries a completion from an earlier attempt is
  // exactly the case where a re-queue must clear it.
  const stale = {
    ...queued,
    state: "RUNNING" as const,
    attempts: 1,
    startedAt: "2026-08-19T09:10:00.000Z",
    completedAt: "2026-08-19T09:20:00.000Z"
  };
  await rawDatabase(repository).query(
    "UPDATE blogbot_source_scans SET state = $2, value = $3::jsonb WHERE id = $1",
    [
      queued.id,
      stale.state,
      JSON.stringify(JsonProtector.fromEnvironment().seal(stale, {
        table: "blogbot_source_scans",
        key: queued.id,
        field: "value"
      }))
    ]
  );

  const retried = await repository.failSourceScan(
    queued.id,
    { code: "FETCH_FAILED", message: "network unavailable", retryable: true },
    "2026-08-19T09:30:00.000Z"
  );

  assert.equal(retried.state, "QUEUED");
  assert.equal(retried.completedAt, undefined);
  const [persisted] = await repository.listScanRuns("engine:scan-retry");
  assert.equal(persisted?.state, "QUEUED");
  assert.equal(persisted?.completedAt, undefined);
});
