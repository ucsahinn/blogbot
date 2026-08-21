import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FetchTransport } from "../../apps/fetcher/src/fetch-source.ts";
import { SourceIngestionService } from "../../apps/engine/src/source-ingestion.ts";
import { PGliteSourceRepository } from "../../packages/database/src/source-repository.ts";

const encoder = new TextEncoder();

test("source test fetches through the guarded boundary and persists detected feed entries", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-ingest-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  const plans: Parameters<FetchTransport["request"]>[0][] = [];
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => {
      plans.push(plan);
      return {
        status: 200,
        headers: { "content-type": "application/rss+xml; charset=utf-8" },
        body: encoder.encode(`<rss><channel><title>Security updates</title>
          <item><guid>story-1</guid><title>Patch released</title>
          <link>/stories/patch</link></item>
        </channel></rss>`)
      };
    }
  };
  const service = new SourceIngestionService(repository, transport, {
    now: () => new Date("2026-07-29T10:00:00.000Z"),
    createId: () => "source-1"
  });

  const result = await service.testAndSave({
    url: "https://news.example/feed.xml",
    language: "en"
  });

  assert.equal(result.source.kind, "RSS");
  assert.equal(result.source.trustStatus, "PENDING");
  assert.equal(result.source.rightsStatus, "PENDING");
  assert.equal(result.entriesAdded, 1);
  assert.equal(plans[0]?.redirect, "manual");
  const entries = await repository.listEntries("source-1");
  assert.deepEqual(entries.map(({ sourceId, externalId, title, url }) => ({ sourceId, externalId, title, url })), [
    { sourceId: "source-1", externalId: "story-1", title: "Patch released", url: "https://news.example/stories/patch" }
  ]);
  assert.match(entries[0]?.versionId ?? "", /^entry-[a-f0-9]{64}$/u);
  assert.match(entries[0]?.contentHash ?? "", /^[a-f0-9]{64}$/u);
});

test("site test persists only policy-safe discovered feed URLs", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-site-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: encoder.encode(`<html><head><title>Security desk</title>
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
        <link rel="alternate" type="application/rss+xml" href="http://news.example/feed">
      </head></html>`)
    })
  };
  const service = new SourceIngestionService(repository, transport, {
    now: () => new Date("2026-07-29T10:00:00.000Z"),
    createId: () => "source-site"
  });

  const result = await service.testAndSave({
    url: "https://news.example/security",
    language: "en"
  });

  assert.deepEqual(result.source.discoveredFeeds, [
    "https://news.example/feed.xml"
  ]);
  assert.equal(result.entriesAdded, 0);
});

test("source test recursively persists unique URL-set entries from a bounded sitemap tree", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-sitemap-tree-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  const requested: string[] = [];
  const documents = new Map<string, string>([
    ["https://news.example/sitemap.xml", `<sitemapindex>
      <sitemap><loc>https://news.example/nested.xml</loc></sitemap>
      <sitemap><loc>https://news.example/news-a.xml</loc></sitemap>
    </sitemapindex>`],
    ["https://news.example/nested.xml", `<sitemapindex>
      <sitemap><loc>https://news.example/news-a.xml</loc></sitemap>
      <sitemap><loc>https://news.example/news-b.xml</loc></sitemap>
    </sitemapindex>`],
    ["https://news.example/news-a.xml", `<urlset>
      <url><loc>https://news.example/stories/shared</loc></url>
      <url><loc>https://news.example/stories/first</loc></url>
    </urlset>`],
    ["https://news.example/news-b.xml", `<urlset>
      <url><loc>https://news.example/stories/shared</loc></url>
      <url><loc>https://news.example/stories/second</loc></url>
    </urlset>`]
  ]);
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => {
      requested.push(plan.url);
      const body = documents.get(plan.url);
      assert.ok(body, `unexpected sitemap request: ${plan.url}`);
      return {
        status: 200,
        headers: { "content-type": "application/xml" },
        body: encoder.encode(body)
      };
    }
  };
  const service = new SourceIngestionService(repository, transport, {
    now: () => new Date("2026-08-20T10:00:00.000Z"),
    createId: () => "source-sitemap-tree"
  });

  const result = await service.testAndSave({
    url: "https://news.example/sitemap.xml",
    language: "en"
  });

  assert.equal(result.source.kind, "SITEMAP");
  assert.equal(result.source.lastTest?.entryCount, 3);
  assert.equal(result.entriesAdded, 3);
  assert.deepEqual(requested, [
    "https://news.example/sitemap.xml",
    "https://news.example/nested.xml",
    "https://news.example/news-a.xml",
    "https://news.example/news-b.xml"
  ]);
  assert.deepEqual(result.source.discoveredFeeds, [
    "https://news.example/nested.xml",
    "https://news.example/news-a.xml",
    "https://news.example/news-b.xml"
  ]);
  assert.deepEqual(
    (await repository.listEntries("source-sitemap-tree")).map((entry) => entry.url),
    [
      "https://news.example/stories/first",
      "https://news.example/stories/second",
      "https://news.example/stories/shared"
    ]
  );
});

test("source test rejects a malformed child sitemap without partially saving its earlier entries", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-sitemap-invalid-child-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  const documents = new Map<string, string>([
    ["https://news.example/sitemap.xml", `<sitemapindex>
      <sitemap><loc>https://news.example/good.xml</loc></sitemap>
      <sitemap><loc>https://news.example/bad.xml</loc></sitemap>
    </sitemapindex>`],
    ["https://news.example/good.xml", `<urlset>
      <url><loc>https://news.example/stories/would-be-partial</loc></url>
    </urlset>`],
    ["https://news.example/bad.xml", `<urlset>
      <url><loc>https://news.example/stories/broken</loc></sitemapindex>`]
  ]);
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => ({
      status: 200,
      headers: { "content-type": "application/xml" },
      body: encoder.encode(documents.get(plan.url) ?? "")
    })
  };
  const service = new SourceIngestionService(repository, transport, {
    createId: () => "source-invalid-child"
  });

  await assert.rejects(
    service.testAndSave({ url: "https://news.example/sitemap.xml" }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_SITEMAP"
  );
  assert.equal(
    await repository.findSourceByUrl("https://news.example/sitemap.xml"),
    undefined
  );
  assert.deepEqual(await repository.listSources(), []);
});

test("source test fails closed when a sitemap tree exceeds its document bound", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-sitemap-limit-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (plan) => ({
      status: 200,
      headers: { "content-type": "application/xml" },
      body: encoder.encode(
        plan.url.endsWith("sitemap.xml")
          ? `<sitemapindex>
              <sitemap><loc>https://news.example/one.xml</loc></sitemap>
              <sitemap><loc>https://news.example/two.xml</loc></sitemap>
            </sitemapindex>`
          : "<urlset></urlset>"
      )
    })
  };
  const service = new SourceIngestionService(repository, transport, {
    createId: () => "source-over-limit",
    sitemapLimits: { maxDocuments: 2, maxDepth: 3, maxEntries: 10 }
  });

  await assert.rejects(
    service.testAndSave({ url: "https://news.example/sitemap.xml" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SITEMAP_DOCUMENT_LIMIT_EXCEEDED"
  );
  assert.deepEqual(await repository.listSources(), []);
});

test("source test applies the configured global entry bound to the root URL-set", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogbot-source-sitemap-root-limit-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = await PGliteSourceRepository.open(dataDir);
  t.after(() => repository.close());

  const locations = Array.from(
    { length: 101 },
    (_, index) => `<url><loc>https://news.example/stories/${index}</loc></url>`
  ).join("");
  const transport: FetchTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async () => ({
      status: 200,
      headers: { "content-type": "application/xml" },
      body: encoder.encode(`<urlset>${locations}</urlset>`)
    })
  };
  const service = new SourceIngestionService(repository, transport, {
    createId: () => "source-root-limit",
    sitemapLimits: { maxDocuments: 1, maxDepth: 0, maxEntries: 101 }
  });

  const result = await service.testAndSave({
    url: "https://news.example/sitemap.xml"
  });

  assert.equal(result.entriesAdded, 101);
  assert.equal(result.source.lastTest?.entryCount, 101);
  assert.equal((await repository.listEntries("source-root-limit")).length, 101);
});
