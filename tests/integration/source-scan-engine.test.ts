import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FetchBoundaryError, type FetchTransport } from "../../apps/fetcher/src/fetch-source.ts";
import { createPersistentEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import {
  PGliteSourceRepository,
  type LocalSource
} from "../../packages/database/src/source-repository.ts";

const encoder = new TextEncoder();

function source(
  id: string,
  url: string,
  review: "PENDING" | "APPROVED" = "PENDING"
): LocalSource {
  return {
    id,
    url,
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: review,
    rightsStatus: review,
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  };
}

async function seedSources(dataDir: string, sources: LocalSource[]) {
  const backend = await PGliteBackendRepository.open(dataDir);
  const repository = await PGliteSourceRepository.fromDatabase(
    backend.getDatabase()
  );
  for (const item of sources) {
    await repository.saveSource(item);
  }
  await backend.close();
}

async function waitForBatch(
  runtime: Awaited<ReturnType<typeof createPersistentEngineProtocol>>,
  batchKey: string,
  predicate: (runs: Array<{ state?: string }>) => boolean
) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const response = await runtime.handle({
      version: 1,
      id: `scan-status-${Date.now()}`,
      kind: "source.scan.status",
      idempotencyKey: batchKey
    });
    assert.equal(response.ok, true);
    const runs = response.runs as Array<{
      state?: string;
      sourceId?: string;
      entriesAdded?: number;
      error?: { code?: string; retryable?: boolean };
    }>;
    if (predicate(runs)) {
      return runs;
    }
    if (Date.now() >= deadline) {
      assert.fail(`scan batch did not settle: ${JSON.stringify(runs)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("SOURCE.SCAN persists successful feed entries and exposes partial batch failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-scan-batch-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedSources(dataDir, [
    source("source-a", "https://a.example/feed.xml"),
    source("source-b", "https://b.example/feed.xml", "APPROVED")
  ]);

  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => {
      if (plan.url.includes("b.example")) {
        throw new FetchBoundaryError("UNSUPPORTED_CONTENT_TYPE", "upstream returned an unsupported content type");
      }
      return {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
        body: encoder.encode(`<rss><channel><title>Security feed</title>
          <item><guid>story-1</guid><title>Patch released</title>
          <link>/stories/patch</link></item>
        </channel></rss>`)
      };
    }
  };
  const runtime = await createPersistentEngineProtocol(dataDir, {
    sourceTransport: transport
  });
  let runtimeClosed = false;
  t.after(async () => {
    if (!runtimeClosed) {
      await runtime.close();
    }
  });

  const command = {
    version: 1,
    requestId: "scan-batch-request-1",
    idempotencyKey: "scan-batch-key-1",
    expectedVersion: 0,
    kind: "SOURCE.SCAN",
    payload: {
      targets: [
        { sourceId: "source-a", expectedVersion: 1 },
        { sourceId: "source-missing", expectedVersion: 0 },
        { sourceId: "source-b", expectedVersion: 1 }
      ]
    }
  };
  const accepted = await runtime.handle({
    version: 1,
    id: "scan-batch-envelope-1",
    kind: "command",
    command
  });
  assert.equal(accepted.ok, true);

  const settled = await waitForBatch(
    runtime,
    "scan-batch-key-1",
    (runs) =>
      runs.some((run) => run.state === "SUCCEEDED") &&
      runs.some((run) => run.state === "FAILED") &&
      runs.some((run) => run.state === "REJECTED")
  );
  assert.deepEqual(
    settled.map(({ sourceId, state }) => ({ sourceId, state })),
    [
      { sourceId: "source-a", state: "SUCCEEDED" },
      { sourceId: "source-missing", state: "REJECTED" },
      { sourceId: "source-b", state: "FAILED" }
    ]
  );
  assert.equal(
    settled.find((run) => run.sourceId === "source-a")?.entriesAdded,
    1
  );
  assert.equal(
    settled.find((run) => run.sourceId === "source-b")?.error?.retryable,
    false
  );

  const replay = await runtime.handle({
    version: 1,
    id: "scan-batch-envelope-replay",
    kind: "command",
    command
  });
  assert.deepEqual(replay.result, accepted.result);
  await runtime.close();
  runtimeClosed = true;

  const backend = await PGliteBackendRepository.open(dataDir);
  const repository = await PGliteSourceRepository.fromDatabase(
    backend.getDatabase()
  );
  const scanned = await repository.getSource("source-a");
  const failed = await repository.getSource("source-b");
  assert.equal(scanned.version, 2);
  assert.equal(scanned.lastTest?.entryCount, 1);
  assert.equal(scanned.trustStatus, "PENDING");
  assert.equal(scanned.rightsStatus, "PENDING");
  const entries = await repository.listEntries("source-a");
  assert.deepEqual(entries.map(({ sourceId, externalId, title, url }) => ({ sourceId, externalId, title, url })), [
    { sourceId: "source-a", externalId: "story-1", title: "Patch released", url: "https://a.example/stories/patch" }
  ]);
  assert.match(entries[0]?.versionId ?? "", /^entry-[a-f0-9]{64}$/u);
  assert.match(entries[0]?.contentHash ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(failed.version, 1);
  assert.equal(failed.lastTest, undefined);
  assert.deepEqual(await repository.getSourceCapabilities("source-a"), {
    canScan: true,
    canPublish: false,
    blockers: ["TRUST_REVIEW_REQUIRED", "RIGHTS_REVIEW_REQUIRED"]
  });
  assert.deepEqual(await repository.getSourceCapabilities("source-b"), {
    canScan: true,
    canPublish: true,
    blockers: []
  });
  await backend.close();
});

test("queued SOURCE.SCAN survives engine restart and is recovered by the local worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-scan-recovery-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedSources(dataDir, [
    source("source-recovery", "https://recovery.example/feed.xml")
  ]);

  const responseBody = encoder.encode(`<rss><channel>
    <item><guid>recovered-1</guid><title>Recovered entry</title>
    <link>/recovered</link></item>
  </channel></rss>`);
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async () => ({
      status: 200,
      headers: { "content-type": "application/rss+xml" },
      body: responseBody
    })
  };
  const first = await createPersistentEngineProtocol(dataDir, {
    sourceTransport: transport,
    startSourceWorker: false
  });
  let firstClosed = false;
  t.after(async () => {
    if (!firstClosed) {
      await first.close();
    }
  });
  const enqueued = await first.handle({
    version: 1,
    id: "scan-recovery-envelope",
    kind: "command",
    command: {
      version: 1,
      requestId: "scan-recovery-request",
      idempotencyKey: "scan-recovery-key",
      expectedVersion: 0,
      kind: "SOURCE.SCAN",
      payload: {
        targets: [{ sourceId: "source-recovery", expectedVersion: 1 }]
      }
    }
  });
  assert.equal(enqueued.ok, true);
  const queued = await first.handle({
    version: 1,
    id: "scan-recovery-queued",
    kind: "source.scan.status",
    idempotencyKey: "scan-recovery-key"
  });
  assert.equal(
    (queued.runs as Array<{ state?: string }>)[0]?.state,
    "QUEUED"
  );
  await first.close();
  firstClosed = true;

  const second = await createPersistentEngineProtocol(dataDir, {
    sourceTransport: transport
  });
  let secondClosed = false;
  t.after(async () => {
    if (!secondClosed) {
      await second.close();
    }
  });
  const recovered = await waitForBatch(
    second,
    "scan-recovery-key",
    (runs) => runs[0]?.state === "SUCCEEDED"
  );
  assert.equal(recovered[0]?.entriesAdded, 1);
  await second.close();
  secondClosed = true;

  const backend = await PGliteBackendRepository.open(dataDir);
  const repository = await PGliteSourceRepository.fromDatabase(
    backend.getDatabase()

  );
  assert.equal((await repository.listEntries("source-recovery")).length, 1);
  assert.equal((await repository.getSource("source-recovery")).version, 2);
  await backend.close();
});

test("retryable source scan failures return to the durable queue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-scan-retry-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedSources(dataDir, [source("source-retry", "https://retry.example/feed.xml")]);
  const backend = await PGliteBackendRepository.open(dataDir);
  const repository = await PGliteSourceRepository.fromDatabase(backend.getDatabase());
  const [queued] = await repository.prepareScanBatch(
    "engine:retryable-scan",
    "fingerprint-retryable-scan",
    [{ sourceId: "source-retry", expectedVersion: 1 }],
    "2026-08-17T10:00:00.000Z"
  );
  assert.ok(queued);
  const claimed = await repository.markScanRunning(queued.id, "2026-08-17T10:00:01.000Z");
  assert.equal(claimed.claimed, true);
  const retryable = await repository.failSourceScan(
    queued.id,
    { code: "TIMEOUT", message: "temporary timeout", retryable: true },
    "2026-08-17T10:00:02.000Z"
  );
  assert.equal(retryable.state, "QUEUED");
  assert.equal(retryable.error?.retryable, true);
  assert.equal(retryable.completedAt, undefined);
  const reclaimed = await repository.markScanRunning(queued.id, "2026-08-17T10:00:03.000Z");
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.scan.attempts, 2);
  await backend.close();
});

test("SOURCE.SCAN follows a sitemap index and atomically persists its URL-set entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-scan-sitemap-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedSources(dataDir, [
    source("source-sitemap", "https://scan.example/sitemap.xml")
  ]);

  const documents = new Map<string, string>([
    ["https://scan.example/sitemap.xml", `<sitemapindex>
      <sitemap><loc>https://scan.example/news.xml</loc></sitemap>
    </sitemapindex>`],
    ["https://scan.example/news.xml", `<urlset>
      <url><loc>https://scan.example/stories/one</loc></url>
      <url><loc>https://scan.example/stories/two</loc></url>
    </urlset>`]
  ]);
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => ({
      status: 200,
      headers: { "content-type": "application/xml" },
      body: encoder.encode(documents.get(plan.url) ?? "")
    })
  };
  const runtime = await createPersistentEngineProtocol(dataDir, {
    sourceTransport: transport
  });
  let runtimeClosed = false;
  t.after(async () => {
    if (!runtimeClosed) await runtime.close();
  });

  const accepted = await runtime.handle({
    version: 1,
    id: "scan-sitemap-envelope",
    kind: "command",
    command: {
      version: 1,
      requestId: "scan-sitemap-request",
      idempotencyKey: "scan-sitemap-key",
      expectedVersion: 0,
      kind: "SOURCE.SCAN",
      payload: {
        targets: [{ sourceId: "source-sitemap", expectedVersion: 1 }]
      }
    }
  });
  assert.equal(accepted.ok, true);
  const settled = await waitForBatch(
    runtime,
    "scan-sitemap-key",
    (runs) => runs[0]?.state === "SUCCEEDED"
  );
  assert.equal(settled[0]?.entriesAdded, 2);
  await runtime.close();
  runtimeClosed = true;

  const backend = await PGliteBackendRepository.open(dataDir);
  const repository = await PGliteSourceRepository.fromDatabase(backend.getDatabase());
  const scanned = await repository.getSource("source-sitemap");
  assert.equal(scanned.kind, "SITEMAP");
  assert.equal(scanned.version, 2);
  assert.equal(scanned.lastTest?.entryCount, 2);
  assert.deepEqual(scanned.discoveredFeeds, ["https://scan.example/news.xml"]);
  assert.deepEqual(
    (await repository.listEntries("source-sitemap")).map((entry) => entry.url),
    [
      "https://scan.example/stories/one",
      "https://scan.example/stories/two"
    ]
  );
  await backend.close();
});

test("SOURCE.SCAN leaves the source untouched when a child sitemap is malformed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-scan-sitemap-fail-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedSources(dataDir, [
    source("source-sitemap-fail", "https://scan.example/sitemap.xml")
  ]);

  const documents = new Map<string, string>([
    ["https://scan.example/sitemap.xml", `<sitemapindex>
      <sitemap><loc>https://scan.example/good.xml</loc></sitemap>
      <sitemap><loc>https://scan.example/bad.xml</loc></sitemap>
    </sitemapindex>`],
    ["https://scan.example/good.xml", `<urlset>
      <url><loc>https://scan.example/stories/partial</loc></url>
    </urlset>`],
    ["https://scan.example/bad.xml", `<urlset><url><loc>https://scan.example/stories/broken</loc></url>`]
  ]);
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => ({
      status: 200,
      headers: { "content-type": "application/xml" },
      body: encoder.encode(documents.get(plan.url) ?? "")
    })
  };
  const runtime = await createPersistentEngineProtocol(dataDir, {
    sourceTransport: transport
  });
  let runtimeClosed = false;
  t.after(async () => {
    if (!runtimeClosed) await runtime.close();
  });
  await runtime.handle({
    version: 1,
    id: "scan-sitemap-fail-envelope",
    kind: "command",
    command: {
      version: 1,
      requestId: "scan-sitemap-fail-request",
      idempotencyKey: "scan-sitemap-fail-key",
      expectedVersion: 0,
      kind: "SOURCE.SCAN",
      payload: {
        targets: [{ sourceId: "source-sitemap-fail", expectedVersion: 1 }]
      }
    }
  });
  const settled = await waitForBatch(
    runtime,
    "scan-sitemap-fail-key",
    (runs) => runs[0]?.state === "FAILED"
  );
  assert.equal(settled[0]?.error?.code, "INVALID_SITEMAP");
  assert.equal(settled[0]?.error?.retryable, false);
  await runtime.close();
  runtimeClosed = true;

  const backend = await PGliteBackendRepository.open(dataDir);
  const repository = await PGliteSourceRepository.fromDatabase(backend.getDatabase());
  const untouched = await repository.getSource("source-sitemap-fail");
  assert.equal(untouched.version, 1);
  assert.equal(untouched.lastTest, undefined);
  assert.deepEqual(await repository.listEntries("source-sitemap-fail"), []);
  await backend.close();
});
