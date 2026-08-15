import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import type { FetchTransport } from "../../apps/fetcher/src/fetch-source.ts";
import { createEngineProtocol, createPersistentEngineProtocol } from "../../apps/engine/src/stdio-entrypoint.ts";
import { PGliteBackendRepository } from "../../packages/database/src/pglite-backend-repository.ts";
import { PGliteSourceRepository, type SourceRepository } from "../../packages/database/src/source-repository.ts";

const encoder = new TextEncoder();

test("source.list derives capabilities from its already loaded source records", async () => {
  const sourceRepository = {
    async listSources() {
      return [{
        id: "source-catalog-1",
        url: "https://news.example/catalog.xml",
        kind: "RSS",
        status: "ACTIVE",
        trustStatus: "APPROVED",
        rightsStatus: "APPROVED",
        language: "en",
        discoveredFeeds: [],
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z",
        version: 1
      }];
    },
    async listEntriesBounded() {
      return [];
    },
    async getSourceCapabilities() {
      throw new Error("SOURCE_CAPABILITIES_MUST_NOT_RELOAD_THE_CATALOG_RECORD");
    }
  } as unknown as SourceRepository;
  const handle = createEngineProtocol(undefined, "memory", { sourceRepository });

  const response = await handle({ version: 1, id: "source-list-loaded-record", kind: "source.list" });

  assert.equal(response.ok, true);
  assert.equal(response.kind, "source.list");
  assert.deepEqual(response.sources, [{
    id: "source-catalog-1",
    url: "https://news.example/catalog.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:00:00.000Z",
    version: 1,
    lastItemAt: null,
    capabilities: { canScan: true, canPublish: true, blockers: [] }
  }]);
});

test("source.list uses one catalog freshness projection when the repository provides it", async () => {
  const sourceRepository = {
    async listSources() {
      return ["source-fast-1", "source-fast-2"].map((id) => ({
        id,
        url: `https://news.example/${id}.xml`,
        kind: "RSS" as const,
        status: "ACTIVE" as const,
        trustStatus: "APPROVED" as const,
        rightsStatus: "APPROVED" as const,
        language: "en",
        discoveredFeeds: [],
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z",
        version: 1
      }));
    },
    async listLatestEntryDates() {
      return new Map([
        ["source-fast-1", "2026-08-14T12:00:00.000Z"],
        ["source-fast-2", null]
      ]);
    },
    async listEntriesBounded() {
      throw new Error("SOURCE_LIST_MUST_NOT_FAN_OUT_PER_SOURCE_WHEN_BULK_FRESHNESS_EXISTS");
    }
  } as unknown as SourceRepository;
  const handle = createEngineProtocol(undefined, "memory", { sourceRepository });

  const response = await handle({ version: 1, id: "source-list-bulk-freshness", kind: "source.list" });

  assert.equal(response.ok, true);
  assert.equal(response.kind, "source.list");
  const catalog = response.sources as Array<{ id: string; lastItemAt: string | null }>;
  assert.deepEqual(
    catalog.map((source) => ({ id: source.id, lastItemAt: source.lastItemAt })),
    [
      { id: "source-fast-1", lastItemAt: "2026-08-14T12:00:00.000Z" },
      { id: "source-fast-2", lastItemAt: null }
    ]
  );
});

test("candidate.list reads one globally bounded recent-entry slice instead of traversing every source feed", async () => {
  const sourceRepository = {
    async listSources() {
      return [{
        id: "source-candidate-catalog",
        url: "https://news.example/catalog.xml",
        kind: "RSS",
        status: "ACTIVE",
        trustStatus: "APPROVED",
        rightsStatus: "APPROVED",
        language: "en",
        discoveredFeeds: [],
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z",
        version: 1
      }];
    },
    async listRecentEntriesBounded() {
      return [{
        sourceId: "source-candidate-catalog",
        externalId: "story-1",
        title: "Recent patch release",
        summary: "A recent vendor patch release.",
        url: "https://news.example/stories/patch",
        publishedAt: "2026-08-14T11:00:00.000Z"
      }];
    },
    async listEntriesBounded() {
      throw new Error("CANDIDATE_LIST_MUST_NOT_TRAVERSE_EACH_SOURCE_FEED");
    }
  } as unknown as SourceRepository;
  const handle = createEngineProtocol(undefined, "memory", { sourceRepository });

  const response = await handle({ version: 1, id: "candidate-list-recent-slice", kind: "candidate.list" });

  assert.equal(response.ok, true);
  assert.equal(response.kind, "candidate.list");
  assert.equal((response.candidates as Array<{ title?: string }>)[0]?.title, "Recent patch release");
});

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
  await sources.saveEntries("source-1", [{
    externalId: "source-list-freshness-1",
    title: "Catalog freshness projection",
    summary: "The desktop catalog should read this timestamp without a per-source feed decrypt.",
    url: "https://news.example/stories/catalog-freshness",
    publishedAt: "2026-07-30T08:00:00.000Z"
  }]);
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
      lastItemAt: "2026-07-30T08:00:00.000Z",
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

test("a persisted candidate can become a durable editorial draft without a Codex runner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-candidate-to-draft-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));

  const backend = await PGliteBackendRepository.open(dataDir);
  const sources = await PGliteSourceRepository.fromDatabase(backend.getDatabase());
  await sources.saveSource({
    id: "source-candidate-draft-1",
    url: "https://news.example/feed.xml",
    kind: "RSS",
    status: "ACTIVE",
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED",
    language: "en",
    discoveredFeeds: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    version: 1
  });
  await sources.saveEntries("source-candidate-draft-1", [{
    externalId: "candidate-draft-story-1",
    title: "Kalıcı aday taslak testi",
    summary: "Adayın taslak kuyruğuna geçtiğini doğrular.",
    url: "https://news.example/stories/candidate-draft",
    publishedAt: "2026-07-30T08:00:00.000Z"
  }]);
  await backend.close();

  const runtime = await createPersistentEngineProtocol(dataDir, { startSourceWorker: false });
  t.after(() => runtime.close());
  const candidates = await runtime.handle({ version: 1, id: "candidate-list-draft", kind: "candidate.list" });
  assert.equal(candidates.ok, true);
  const candidate = (candidates.candidates as Array<Record<string, unknown>>)[0];
  assert.equal(typeof candidate?.id, "string");
  assert.equal(candidate?.sourceId, "source-candidate-draft-1");

  const before = await runtime.handle({ version: 1, id: "state-before-draft", kind: "state", afterCursor: 0 });
  assert.equal(before.ok, true);
  const expectedVersion = (before.snapshot as { serverCursor: number }).serverCursor;
  const draftId = `draft-candidate-${candidate?.id}`;
  const created = await runtime.handle({
    version: 1,
    id: "candidate-draft-create",
    kind: "command",
    command: {
      version: 1,
      requestId: "candidate-draft-create",
      idempotencyKey: "candidate-draft-create",
      expectedVersion,
      kind: "DRAFT.CREATE",
      payload: {
        draftId,
        candidateId: candidate?.id,
        candidateTitle: candidate?.title,
        sourceIds: [candidate?.sourceId],
        urls: [],
        instruction: "Bu adayı kaynak kanıtlarıyla araştır ve insan incelemesine hazırla.",
        section: candidate?.section,
        articleType: candidate?.articleType
      }
    }
  });
  assert.equal(created.ok, true);
  const backendJob = (created.result as { value: { backendJob: { id: string } } }).value.backendJob;
  assert.equal(backendJob.id, draftId);

  const after = await runtime.handle({ version: 1, id: "state-after-draft", kind: "state", afterCursor: 0 });
  assert.equal(after.ok, true);
  const jobs = (after.snapshot as { jobs: Array<Record<string, unknown>> }).jobs;
  assert.deepEqual(jobs.map((job) => ({
    id: job.id,
    kind: job.kind,
    state: job.state,
    candidateId: (job.metadata as { candidateId?: string }).candidateId
  })), [{
    id: draftId,
    kind: "DRAFT",
    state: "WAITING_CODEX",
    candidateId: candidate?.id
  }]);
});

test("a persistent Codex draft reaches reviewed local completion through the durable queue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-persistent-codex-terminal-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const observedTasks: unknown[] = [];
  const sourceEvidence = "Güvenilir kanıt metni. ".repeat(1_000);
  const fullTrBody = "Türkçe ".repeat(700);
  const fullEnBody = "English ".repeat(700);
  const generatedImage = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: "#2456a6" }
  }).png().toBuffer();
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false,
    imageGenerator: {
      async generate() {
        return generatedImage;
      }
    },
    codexPort: {
      async *run(request) {
        observedTasks.push(request.input);
        const finalReview = Object.hasOwn((request.outputSchema.properties as Record<string, unknown> | undefined) ?? {}, "translationParity");
        yield { type: "output.completed", output: finalReview
          ? { translationParity: { status: "MATCHED", detail: "Test paritesi doğrulandı." }, riskLevel: "STANDARD", gates: [{ id: "claims", group: "editorial", state: "PASS", reasonCode: "CHECKED", detail: "Kanıt bağlı." }, { id: "contradictions", group: "editorial", state: "PASS", reasonCode: "CHECKED", detail: "Çelişki yok." }, { id: "bilingual-parity", group: "editorial", state: "PASS", reasonCode: "CHECKED", detail: "Parite eşleşti." }, { id: "markdown-safety", group: "security", state: "PASS", reasonCode: "CHECKED", detail: "Markdown güvenli." }, { id: "seo", group: "seo", state: "PASS", reasonCode: "CHECKED", detail: "SEO tamam." }, { id: "media", group: "media", state: "PASS", reasonCode: "CHECKED", detail: "Medya gerekmiyor." }] }
          : { translationKey: "terminal-test", author: "Test Editörü", tags: ["test"], tr: { title: "Terminal test haberi", slug: "terminal-test-haberi", description: "Test açıklaması.", bodyMarkdown: fullTrBody, heroImageAlt: "Test görseli" }, en: { title: "Terminal test story", slug: "terminal-test-story", description: "Test description.", bodyMarkdown: fullEnBody, heroImageAlt: "Test visual" }, claims: [{ claimKey: "claim-1", trText: "Doğrulanan test iddiası", enText: "Verified test claim", sourceIds: ["https://news.example/story"], status: "NEEDS_SOURCE", quoteHash: "" }] }
        };
      }
    },
    sourceTransport: {
      resolve: async () => ["93.184.216.34"],
      request: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: encoder.encode(`<article>${sourceEvidence}</article>`) })
    }
  });
  t.after(() => runtime.close());

  const initial = await runtime.handle({ version: 1, id: "terminal-before", kind: "state", afterCursor: 0 });
  const expectedVersion = (initial.snapshot as { serverCursor: number }).serverCursor;
  const created = await runtime.handle({
    version: 1,
    id: "terminal-draft",
    kind: "command",
    command: {
      version: 1,
      requestId: "terminal-draft",
      idempotencyKey: "terminal-draft",
      expectedVersion,
      kind: "DRAFT.CREATE",
      payload: { draftId: "draft-terminal", urls: ["https://news.example/story"], sourceIds: [], instruction: "Özgün test haberi hazırla.", section: "haberler", articleType: "news" }
    }
  });
  assert.equal(created.ok, true);

  let state = "QUEUED";
  for (let attempt = 0; attempt < 160 && state !== "SUCCEEDED"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 125));
    const snapshot = await runtime.handle({ version: 1, id: `terminal-state-${attempt}`, kind: "state", afterCursor: 0 });
    state = ((snapshot.snapshot as { jobs: Array<{ id: string; state: string }> }).jobs.find((job) => job.id === "draft-terminal")?.state ?? "MISSING");
  }
  assert.equal(state, "SUCCEEDED");
  const draftTask = observedTasks.find((task) => typeof task === "object" && task !== null && "task" in task) as { task?: { sources?: Array<{ excerpt?: string; evidenceText?: unknown }> } } | undefined;
  assert.ok(draftTask?.task);
  const revisionState = await runtime.handle({ version: 1, id: "terminal-revision-state", kind: "state", afterCursor: 0 });
  const revisionVersion = (revisionState.snapshot as { serverCursor: number }).serverCursor;
  const revisionResponse = await runtime.handle({
    version: 1,
    id: "terminal-revision-get",
    kind: "command",
    command: {
      version: 1,
      requestId: "terminal-revision-get",
      idempotencyKey: "terminal-revision-get",
      expectedVersion: revisionVersion,
      kind: "REVISION.GET",
      payload: { revisionId: "draft-terminal" }
    }
  });
  assert.equal(revisionResponse.ok, true);
  const revision = (revisionResponse.result as { value: { revision: { media: Array<{ path: string; contentBase64?: string; byteSize?: number; width: number; height: number }>; sources: Array<{ trustStatus?: string; rightsStatus?: string }> } } }).value.revision;
  assert.deepEqual(
    revision.media.map((item) => [item.path, item.width, item.height]),
    [
      ["media/draft-terminal/terminal-test-haberi-16x9.webp", 1600, 900],
      ["media/draft-terminal/terminal-test-haberi-4x3.webp", 1200, 900],
      ["media/draft-terminal/terminal-test-haberi-1x1.webp", 1200, 1200]
    ]
  );
  assert.ok(revision.media.every((item) => item.contentBase64 === undefined && Number.isSafeInteger(item.byteSize) && item.byteSize! > 0));
  assert.equal("evidenceText" in (draftTask.task.sources?.[0] ?? {}), false, "raw source evidence must not bypass the bounded draft contract");
  assert.ok(draftTask.task.sources?.[0]?.excerpt?.startsWith("Güvenilir kanıt metni."), "the bounded source evidence must reach the drafting task as an excerpt");
  assert.equal(revision.sources[0]?.trustStatus, "PENDING", "unreviewed direct URLs must not acquire implicit trust");
  assert.equal(revision.sources[0]?.rightsStatus, "PENDING", "unreviewed direct URLs must not acquire implicit rights approval");
  assert.equal(
    draftTask.task.sources?.[0]?.excerpt?.split(/\s+/u).filter(Boolean).length,
    sourceEvidence.slice(0, 12_000).split(/\s+/u).filter(Boolean).length
  );
});

test("a long-running Codex task does not block local workspace reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-codex-responsive-state-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseRunner: (() => void) | undefined;
  const runnerRelease = new Promise<void>((resolve) => { releaseRunner = resolve; });
  let signalRunnerStarted: (() => void) | undefined;
  const runnerStarted = new Promise<void>((resolve) => { signalRunnerStarted = resolve; });
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceWorker: false,
    codexPort: {
      async *run() {
        signalRunnerStarted?.();
        await runnerRelease;
        yield { type: "auth.required" };
      }
    },
    sourceTransport: {
      resolve: async () => ["93.184.216.34"],
      request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: encoder.encode("Test evidence.") })
    }
  });
  t.after(async () => {
    releaseRunner?.();
    await runtime.close();
  });
  const initial = await runtime.handle({ version: 1, id: "responsive-before", kind: "state", afterCursor: 0 });
  const expectedVersion = (initial.snapshot as { serverCursor: number }).serverCursor;
  const created = await runtime.handle({
    version: 1,
    id: "responsive-draft",
    kind: "command",
    command: {
      version: 1,
      requestId: "responsive-draft",
      idempotencyKey: "responsive-draft",
      expectedVersion,
      kind: "DRAFT.CREATE",
      payload: { draftId: "draft-responsive", urls: ["https://news.example/story"], sourceIds: [], instruction: "Create a local test draft.", section: "haberler", articleType: "news" }
    }
  });
  assert.equal(created.ok, true);
  await runnerStarted;

  const state = await Promise.race([
    runtime.handle({ version: 1, id: "responsive-during-runner", kind: "state", afterCursor: 0 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("STATE_READ_BLOCKED_BY_CODEX")), 1_000))
  ]);
  assert.equal(state.ok, true);
});

test("a draft command can retry once after a stale version conflict without changing its idempotency key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-draft-conflict-retry-"));
  const dataDir = join(root, "pgdata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createPersistentEngineProtocol(dataDir, { startSourceWorker: false });
  t.after(() => runtime.close());

  const before = await runtime.handle({ version: 1, id: "retry-before", kind: "state", afterCursor: 0 });
  assert.equal(before.ok, true);
  const staleVersion = (before.snapshot as { serverCursor: number }).serverCursor;
  const bumped = await runtime.handle({
    version: 1,
    id: "retry-bump",
    kind: "command",
    command: {
      version: 1,
      requestId: "retry-bump",
      idempotencyKey: "retry-bump",
      expectedVersion: staleVersion,
      kind: "LOCAL_STATE.SET",
      payload: { key: "desktop.testRetry", value: { touched: true } }
    }
  });
  assert.equal(bumped.ok, true);

  const draft = {
    version: 1 as const,
    requestId: "retry-draft",
    idempotencyKey: "retry-draft",
    kind: "DRAFT.CREATE" as const,
    payload: {
      draftId: "draft-version-conflict-retry",
      urls: ["https://news.example/story"],
      sourceIds: [],
      instruction: "Bu kanıtı insan incelemesine uygun özgün taslak için değerlendir.",
      section: "haberler",
      articleType: "news"
    }
  };
  const conflicted = await runtime.handle({
    version: 1,
    id: "retry-draft-stale",
    kind: "command",
    command: { ...draft, expectedVersion: staleVersion }
  });
  assert.equal(conflicted.ok, false);
  assert.equal((conflicted.result as { error?: { code?: string } }).error?.code, "VERSION_CONFLICT");

  const afterBump = await runtime.handle({ version: 1, id: "retry-after-bump", kind: "state", afterCursor: 0 });
  assert.equal(afterBump.ok, true);
  const freshVersion = (afterBump.snapshot as { serverCursor: number }).serverCursor;
  const retried = await runtime.handle({
    version: 1,
    id: "retry-draft-fresh",
    kind: "command",
    command: { ...draft, expectedVersion: freshVersion }
  });
  assert.equal(retried.ok, true);
  assert.equal((retried.result as { value: { backendJob: { id: string } } }).value.backendJob.id, "draft-version-conflict-retry");
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
