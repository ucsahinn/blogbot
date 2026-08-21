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

test("RSS numeric surrogate entities are replaced without crashing the parser", () => {
  assert.doesNotThrow(() => analyzeSourceDocument({
    finalUrl: "https://news.example/feed.xml",
    contentType: "application/rss+xml",
    body: encoder.encode("<rss><channel><title>Safe &#xD800; title</title></channel></rss>")
  }));
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

test("leading comments and text/plain cannot bypass the XML declaration guard", () => {
  assert.throws(
    () => analyzeSourceDocument({
      finalUrl: "https://news.example/feed.xml",
      contentType: "text/plain",
      body: encoder.encode(
        `<!-- a leading comment must not bypass the XML declaration guard -->
         <!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]>
         <rss><channel><title>&xxe;</title></channel></rss>`
      )
    }),
    (error: unknown) => error instanceof SourceDocumentError && error.code === "UNSAFE_XML_DECLARATION"
  );
});

test("sitemap urlsets expose each safe location as a source entry", () => {
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/sitemap.xml",
    contentType: "application/xml",
    body: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://news.example/stories/first</loc></url>
        <url><loc>https://news.example/stories/second?lang=tr&amp;view=full</loc></url>
      </urlset>`)
  });

  assert.equal(result.kind, "SITEMAP");
  assert.deepEqual(result.entries, [
    {
      externalId: "https://news.example/stories/first",
      title: "https://news.example/stories/first",
      url: "https://news.example/stories/first"
    },
    {
      externalId: "https://news.example/stories/second?lang=tr&view=full",
      title: "https://news.example/stories/second?lang=tr&view=full",
      url: "https://news.example/stories/second?lang=tr&view=full"
    }
  ]);
  assert.deepEqual(result.discoveredFeeds, []);
});

test("sitemap indexes expose child sitemaps for bounded follow-up discovery", () => {
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/sitemap-index.xml",
    contentType: "application/xml",
    body: encoder.encode(`
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://news.example/sitemaps/news.xml</loc></sitemap>
        <sitemap><loc>https://news.example/sitemaps/archive.xml</loc></sitemap>
      </sitemapindex>`)
  });

  assert.equal(result.kind, "SITEMAP");
  assert.deepEqual(result.discoveredFeeds, [
    "https://news.example/sitemaps/news.xml",
    "https://news.example/sitemaps/archive.xml"
  ]);
  assert.deepEqual(result.entries, []);
});

test("sitemaps reject invalid, unsafe, relative, or duplicate locations", () => {
  const cases = [
    {
      name: "malformed URL",
      locations: ["not a URL"]
    },
    {
      name: "unsafe local URL",
      locations: ["https://localhost/internal"]
    },
    {
      name: "relative URL",
      locations: ["/relative/article"]
    },
    {
      name: "duplicate URL",
      locations: [
        "https://news.example/stories/one",
        "https://news.example/stories/one"
      ]
    }
  ] as const;

  for (const fixture of cases) {
    assert.throws(
      () => analyzeSourceDocument({
        finalUrl: "https://news.example/sitemap.xml",
        contentType: "application/xml",
        body: encoder.encode(
          `<urlset>${fixture.locations.map((location) => `<url><loc>${location}</loc></url>`).join("")}</urlset>`
        )
      }),
      (error: unknown) =>
        error instanceof SourceDocumentError && error.code === "INVALID_SITEMAP",
      fixture.name
    );
  }
});

test("sitemaps fail closed instead of silently truncating entries over the configured limit", () => {
  assert.throws(
    () => analyzeSourceDocument(
      {
        finalUrl: "https://news.example/sitemap.xml",
        contentType: "application/xml",
        body: encoder.encode(`<urlset>
          <url><loc>https://news.example/stories/one</loc></url>
          <url><loc>https://news.example/stories/two</loc></url>
          <url><loc>https://news.example/stories/three</loc></url>
        </urlset>`)
      },
      { maxEntries: 2 }
    ),
    (error: unknown) =>
      error instanceof SourceDocumentError &&
      error.code === "SITEMAP_ENTRY_LIMIT_EXCEEDED"
  );
});

test("sitemap parsing rejects documents larger than the bounded source limit", () => {
  assert.throws(
    () => analyzeSourceDocument({
      finalUrl: "https://news.example/sitemap.xml",
      contentType: "application/xml",
      body: encoder.encode(`<urlset>${" ".repeat(2_000_000)}</urlset>`)
    }),
    (error: unknown) =>
      error instanceof SourceDocumentError &&
      error.code === "SOURCE_DOCUMENT_TOO_LARGE"
  );
});

test("sitemap parsing rejects malformed XML instead of returning partial locations", () => {
  const malformedDocuments = [
    `<urlset><url><loc>https://news.example/stories/one</loc></url></sitemapindex>`,
    `<urlset><url><loc>https://news.example/stories/one</loc><loc>https://news.example/stories/two</loc></url></urlset>`,
    `<urlset><url><loc>https://news.example/stories/one?mode=&unknown;</loc></url></urlset>`,
    `<urlset xmlns="urn:first" xmlns="urn:second"></urlset>`
  ];

  for (const document of malformedDocuments) {
    assert.throws(
      () => analyzeSourceDocument({
        finalUrl: "https://news.example/sitemap.xml",
        contentType: "application/xml",
        body: encoder.encode(document)
      }),
      (error: unknown) =>
        error instanceof SourceDocumentError && error.code === "INVALID_SITEMAP"
    );
  }
});

test("a malformed feed cannot stall the engine through quadratic markup stripping", () => {
  // Feeds are untrusted input and the engine is single threaded. `<[^>]*>`
  // rescanned the remainder for every `<` that never reached a `>`: 256 KB of
  // bare `<` took about 43 s, past the desktop bridge's timeout.
  const hostile = "<".repeat(256 * 1024);
  const startedAt = Date.now();
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/feed.xml",
    contentType: "application/rss+xml",
    body: encoder.encode(
      `<rss><channel><item><guid>1</guid><title>Gerçek başlık</title><description>${hostile}</description><link>/e/1</link></item></channel></rss>`
    )
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 2_000, `malformed markup must stay linear, took ${elapsed} ms`);
  // The entry still parses; only its all-markup description collapses away.
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.title, "Gerçek başlık");
});

test("markup stripping keeps the surrounding text of a well-formed entry", () => {
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/feed.xml",
    contentType: "application/rss+xml",
    body: encoder.encode(
      "<rss><channel><item><guid>1</guid><title>Önce <b>vurgu</b> sonra</title><link>/e/1</link></item></channel></rss>"
    )
  });

  assert.equal(result.entries[0]?.title, "Önce vurgu sonra");
});
