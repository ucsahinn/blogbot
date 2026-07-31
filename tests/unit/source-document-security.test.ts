import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeSourceDocument,
  SourceDocumentError
} from "../../packages/security/src/source-document.ts";
import { assertSafeSourceUrl } from "../../packages/security/src/url-policy.ts";

const encoder = new TextEncoder();

test("source URL policy rejects non-default HTTPS ports", () => {
  assert.throws(
    () => assertSafeSourceUrl("https://example.com:8443/feed.xml"),
    /port 443/i
  );
});

test("RSS analysis returns bounded entries with safe absolute links", () => {
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/feed.xml",
    contentType: "application/rss+xml",
    body: encoder.encode(`<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Security updates</title>
        <item>
          <title>Patch released</title>
          <link>/stories/patch</link>
          <guid>story-1</guid>
          <pubDate>Wed, 29 Jul 2026 08:00:00 GMT</pubDate>
          <description>Vendor published a security update.</description>
        </item>
      </channel></rss>`)
  });

  assert.equal(result.kind, "RSS");
  assert.equal(result.title, "Security updates");
  assert.deepEqual(result.entries, [
    {
      externalId: "story-1",
      title: "Patch released",
      url: "https://news.example/stories/patch",
      publishedAt: "2026-07-29T08:00:00.000Z",
      summary: "Vendor published a security update."
    }
  ]);
});

test("Atom analysis reads alternate link entries without treating markup as active HTML", () => {
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/atom",
    contentType: "application/atom+xml",
    body: encoder.encode(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Security feed</title>
        <entry>
          <id>tag:news.example,2026:42</id>
          <title>Incident report</title>
          <link rel="alternate" href="/incidents/42" />
          <updated>2026-07-29T09:30:00Z</updated>
          <summary type="text">A verified incident report.</summary>
        </entry>
      </feed>`)
  });

  assert.equal(result.kind, "ATOM");
  assert.deepEqual(result.entries, [
    {
      externalId: "tag:news.example,2026:42",
      title: "Incident report",
      url: "https://news.example/incidents/42",
      publishedAt: "2026-07-29T09:30:00.000Z",
      summary: "A verified incident report."
    }
  ]);
});

test("site analysis discovers only HTTPS feeds allowed by source URL policy", () => {
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/security",
    contentType: "text/html",
    body: encoder.encode(`<html><head>
      <title>Security desk</title>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="http://news.example/atom">
      <link rel="alternate" type="application/rss+xml" href="https://localhost/private">
    </head></html>`)
  });

  assert.equal(result.kind, "SITE");
  assert.deepEqual(result.discoveredFeeds, ["https://news.example/feed.xml"]);
});

test("XML documents with DTD or entity declarations are rejected", () => {
  assert.throws(
    () =>
      analyzeSourceDocument({
        finalUrl: "https://news.example/feed.xml",
        contentType: "application/rss+xml",
        body: encoder.encode(
          `<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]>
           <rss><channel><title>&xxe;</title></channel></rss>`
        )
      }),
    (error: unknown) =>
      error instanceof SourceDocumentError &&
      error.code === "UNSAFE_XML_DECLARATION"
  );
});

test("feed entry count is capped before entries leave the parser", () => {
  const items = Array.from(
    { length: 4 },
    (_, index) =>
      `<item><guid>${index}</guid><title>Entry ${index}</title><link>/e/${index}</link></item>`
  ).join("");

  const result = analyzeSourceDocument(
    {
      finalUrl: "https://news.example/feed.xml",
      contentType: "application/rss+xml",
      body: encoder.encode(`<rss><channel>${items}</channel></rss>`)
    },
    { maxEntries: 2 }
  );

  assert.equal(result.entries.length, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.externalId),
    ["0", "1"]
  );
});
