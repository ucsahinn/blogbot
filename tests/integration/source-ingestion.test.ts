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
