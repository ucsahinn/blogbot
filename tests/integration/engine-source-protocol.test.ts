import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FetchTransport } from "../../apps/fetcher/src/fetch-source.ts";
import { createPersistentEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import { PGliteSourceRepository } from "../../packages/database/src/source-repository.ts";

const encoder = new TextEncoder();

test("persistent engine lists local sources with trust and rights blockers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-protocol-list-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));

  const backend = await PGliteBackendRepository.open(dataDir);
  const sources = await PGliteSourceRepository.fromDatabase(
    backend.getDatabase()
  );
  await sources.saveSource({
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
  await backend.close();

  const runtime = await createPersistentEngineProtocol(dataDir);
  t.after(() => runtime.close());
  const response = await runtime.handle({
    version: 1,
    id: "source-list-1",
    kind: "source.list"
  });

  assert.equal(response.ok, true);
  assert.equal(response.kind, "source.list");
  assert.deepEqual(response.sources, [
    {
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
      version: 1,
      lastItemAt: null,
      capabilities: {
        canScan: true,
        canPublish: false,
        blockers: ["TRUST_REVIEW_REQUIRED", "RIGHTS_REVIEW_REQUIRED"]
      }
    }
  ]);
});

test("candidate.list materializes persisted feed entries with source policy context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-candidate-protocol-list-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = await PGliteBackendRepository.open(dataDir);
  const sources = await PGliteSourceRepository.fromDatabase(backend.getDatabase());
  await sources.saveSource({
    id: "source-candidate-1",
    url: "https://news.example/feed.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1,
    title: "News example",
    defaultSection: "haberler",
    defaultArticleType: "news"
  });
  await sources.saveEntries("source-candidate-1", [{
    externalId: "story-1",
    title: "Patch released",
    summary: "A security patch was released.",
    url: "https://news.example/stories/patch",
    publishedAt: "2026-07-30T08:00:00.000Z"
  }]);
  await backend.close();
  const runtime = await createPersistentEngineProtocol(dataDir, { startSourceWorker: false });
  t.after(() => runtime.close());
  const response = await runtime.handle({ version: 1, id: "candidate-list-1", kind: "candidate.list" });
  assert.equal(response.ok, true);
  assert.equal(response.kind, "candidate.list");
  assert.equal((response.candidates as Array<Record<string, unknown>>)[0]?.title, "Patch released");
  assert.equal((response.candidates as Array<Record<string, unknown>>)[0]?.confidence, 85);
});

test("source.test uses guarded fetch and parsing without changing the source catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-protocol-test-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const plans: Parameters<FetchTransport["request"]>[0][] = [];
  const responseBody = encoder.encode(
    `<rss><channel><title>Security updates</title>
      <item><guid>story-1</guid><title>Patch released</title>
      <link>/stories/patch</link></item>
    </channel></rss>`
  );
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => {
      plans.push(plan);
      return {
        status: 200,
        headers: { "content-type": "application/rss+xml; charset=utf-8" },
        body: responseBody
      };
    }
  };
  const runtime = await createPersistentEngineProtocol(dataDir, {
    sourceTransport: transport
  });
  t.after(() => runtime.close());

  const tested = await runtime.handle({
    version: 1,
    id: "source-test-1",
    kind: "source.test",
    url: "https://news.example/feed.xml"
  });
  const listed = await runtime.handle({
    version: 1,
    id: "source-list-after-test",
    kind: "source.list"
  });

  assert.equal(tested.ok, true);
  assert.equal(tested.kind, "source.test");
  assert.deepEqual(tested.probe, {
    requestedUrl: "https://news.example/feed.xml",
    finalUrl: "https://news.example/feed.xml",
    contentType: "application/rss+xml",
    byteLength: responseBody.byteLength,
    kind: "RSS",
    title: "Security updates",
    discoveredFeeds: [],
    entries: [
      {
        externalId: "story-1",
        title: "Patch released",
        url: "https://news.example/stories/patch"
      }
    ]
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.redirect, "manual");
  assert.deepEqual(listed.sources, []);
});

test("source.test rejects unsafe URLs before DNS or transport access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-protocol-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"), {
    sourceTransport: {
      resolve: async () => {
        calls += 1;
        return ["93.184.216.34"];
      },
      request: async () => {
        calls += 1;
        throw new Error("transport must not run");
      }
    }
  });
  t.after(() => runtime.close());

  const response = await runtime.handle({
    version: 1,
    id: "source-test-unsafe",
    kind: "source.test",
    url: "https://127.0.0.1/private"
  });

  assert.equal(response.ok, false);
  assert.equal(response.kind, "source.test");
  assert.equal(response.code, "SOURCE_TEST_REJECTED");
  assert.equal(calls, 0);
});

test("source.save is versioned, idempotent, and durable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-protocol-save-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = {
    version: 1,
    requestId: "source-save-request-1",
    idempotencyKey: "source-save-key-1",
    expectedVersion: 0,
    kind: "SOURCE.SAVE",
    payload: {
      source: {
        url: "https://news.example/feed.xml",
        section: "haberler",
        articleType: "news",
        kind: "RSS",
        language: "en",
        title: "Security updates"
      }
    }
  };

  const firstRuntime = await createPersistentEngineProtocol(dataDir);
  const first = await firstRuntime.handle({
    version: 1,
    id: "save-envelope-1",
    kind: "command",
    command
  });
  const replay = await firstRuntime.handle({
    version: 1,
    id: "save-envelope-2",
    kind: "command",
    command
  });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.result, first.result);
  await firstRuntime.close();

  const secondRuntime = await createPersistentEngineProtocol(dataDir);
  t.after(() => secondRuntime.close());
  const replayAfterRestart = await secondRuntime.handle({
    version: 1,
    id: "save-envelope-replay-after-restart",
    kind: "command",
    command
  });
  assert.equal(replayAfterRestart.ok, true);
  assert.deepEqual(replayAfterRestart.result, first.result);

  const listed = await secondRuntime.handle({
    version: 1,
    id: "list-after-save",
    kind: "source.list"
  });
  assert.equal(listed.ok, true);
  assert.equal((listed.sources as unknown[]).length, 1);
  assert.equal(
    (listed.sources as Array<{ defaultArticleType?: string }>)[0]
      ?.defaultArticleType,
    "news"
  );

  const updated = await secondRuntime.handle({
    version: 1,
    id: "save-envelope-update",
    kind: "command",
    command: {
      ...command,
      requestId: "source-save-request-2",
      idempotencyKey: "source-save-key-2",
      expectedVersion: 1,
      payload: {
        source: {
          ...command.payload.source,
          section: "analiz",
          articleType: "analysis",
          title: "Security analysis"
        }
      }
    }
  });
  assert.equal(updated.ok, true);
  assert.equal(
    (updated.result as { sequence?: number }).sequence,
    2
  );

  const reused = await secondRuntime.handle({
    version: 1,
    id: "save-envelope-reused",
    kind: "command",
    command: {
      ...command,
      payload: {
        source: {
          ...command.payload.source,
          url: "https://news.example/other.xml"
        }
      }
    }
  });
  assert.equal(reused.ok, false);
  assert.equal(
    (reused.result as { error?: { code?: string } }).error?.code,
    "IDEMPOTENCY_KEY_REUSED"
  );
});

test("source.save rejects a section and article type mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-source-protocol-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(join(root, "pgdata"));
  t.after(() => runtime.close());

  const response = await runtime.handle({
    version: 1,
    id: "save-invalid-route",
    kind: "command",
    command: {
      version: 1,
      requestId: "source-save-invalid-route",
      idempotencyKey: "source-save-invalid-route",
      expectedVersion: 0,
      kind: "SOURCE.SAVE",
      payload: {
        source: {
          url: "https://news.example/feed.xml",
          section: "haberler",
          articleType: "guide",
          kind: "RSS",
          language: "en"
        }
      }
    }
  });

  assert.equal(response.ok, false);
  assert.equal(
    (response.result as { error?: { code?: string } }).error?.code,
    "INVALID_COMMAND"
  );
});

test("local state commands persist desktop editorial state across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-local-state-protocol-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await createPersistentEngineProtocol(dataDir, { startSourceWorker: false });
  const saved = await first.handle({
    version: 1,
    id: "local-state-set-1",
    kind: "command",
    command: {
      version: 1,
      requestId: "local-state-set-1",
      idempotencyKey: "local-state-set-1",
      expectedVersion: 0,
      kind: "LOCAL_STATE.SET",
      payload: { key: "desktop.editorial", value: { schedule: { slotId: "slot-mon", time: "09:30" } } }
    }
  });
  assert.equal(saved.ok, true);
  await first.close();
  const second = await createPersistentEngineProtocol(dataDir, { startSourceWorker: false });
  t.after(() => second.close());
  const restored = await second.handle({ version: 1, id: "local-state-get-1", kind: "local.state.get", key: "desktop.editorial" });
  assert.deepEqual(restored.value, { schedule: { slotId: "slot-mon", time: "09:30" } });
  const oversized = await second.handle({
    version: 1,
    id: "local-state-set-large",
    kind: "command",
    command: {
      version: 1,
      requestId: "local-state-set-large",
      idempotencyKey: "local-state-set-large",
      expectedVersion: 1,
      kind: "LOCAL_STATE.SET",
      payload: { key: "desktop.editorial", value: { text: "x".repeat(256_001) } }
    }
  });
  assert.equal(oversized.ok, false);
});
