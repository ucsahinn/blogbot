import assert from "node:assert/strict";
import test from "node:test";

import { fetchSource } from "../../apps/fetcher/src/fetch-source.ts";
import { analyzeSourceDocument } from "../../packages/security/src/source-document.ts";
import {
  assertSafeSourceUrl,
  validateResolvedAddresses
} from "../../packages/security/src/url-policy.ts";

const encoder = new TextEncoder();

test("accepts public HTTPS source URLs", () => {
  assert.equal(assertSafeSourceUrl("https://www.cisa.gov/news-events"), "https://www.cisa.gov/news-events");
});

test("rejects public HTTP source URLs", () => {
  assert.throws(() => assertSafeSourceUrl("http://example.com/feed"), /HTTPS/);
});

for (const rootAnchoredHost of [
  "https://localhost./",
  "https://metadata.google.internal./",
  "https://example.com../"
]) {
  test(`rejects root-anchored local or malformed hostname ${rootAnchoredHost}`, () => {
    assert.throws(() => assertSafeSourceUrl(rootAnchoredHost), /hostname|forbidden/i);
  });
}

test("normalizes one public root-anchored hostname dot", () => {
  assert.equal(assertSafeSourceUrl("https://www.cisa.gov./news"), "https://www.cisa.gov/news");
});

for (const [credentialClass, queryName] of [
  ["access_token", "ACCESS_TOKEN"],
  ["api_key", "Api_Key"],
  ["apikey", "APIKEY"],
  ["auth", "AUTH"],
  ["authorization", "Authorization"],
  ["credential", "CREDENTIAL"],
  ["jwt", "Jwt"],
  ["password", "PASSWORD"],
  ["passwd", "Passwd"],
  ["secret", "SECRET"],
  ["signature", "Signature"],
  ["sig", "SIG"],
  ["token", "Token"],
  ["x-amz-*", "X-Amz-Credential"],
  ["x-goog-*", "X-Goog-Signature"]
] as const) {
  test(`rejects the ${credentialClass} query credential class case-insensitively`, () => {
    assert.throws(
      () => assertSafeSourceUrl(`https://news.example/feed?${queryName}=redacted`),
      /credential-bearing query parameters are forbidden/i
    );
  });
}

for (const encodedName of [
  "%61ccess%5Ftoken",
  "%61pi%5Fkey",
  "x%2Damz%2Dcredential",
  "x%2Dgoog%2Dsignature"
]) {
  test(`rejects the decoded ${encodedName} query credential name`, () => {
    assert.throws(
      () => assertSafeSourceUrl(`https://news.example/feed?${encodedName}=redacted`),
      /credential-bearing query parameters are forbidden/i
    );
  });
}

test("preserves ordinary public source query parameters", () => {
  assert.equal(
    assertSafeSourceUrl("https://news.example/feed?page=2&lang=tr&category=security"),
    "https://news.example/feed?page=2&lang=tr&category=security"
  );
});

test("rejects a credential-bearing redirect before resolving the redirected host", async () => {
  const resolvedHosts: string[] = [];

  await assert.rejects(
    fetchSource("https://feed.example/start", {
      async resolve(hostname) {
        resolvedHosts.push(hostname);
        return ["93.184.216.34"];
      },
      async request() {
        return {
          status: 302,
          headers: {
            location: "https://news.example/feed?%61ccess%5Ftoken=redacted"
          },
          body: new Uint8Array()
        };
      }
    }),
    /credential-bearing query parameters are forbidden/i
  );

  assert.deepEqual(resolvedHosts, ["feed.example"]);
});

test("excludes credential-bearing feed URLs discovered in HTML", () => {
  const result = analyzeSourceDocument({
    finalUrl: "https://news.example/security",
    contentType: "text/html",
    body: encoder.encode(`<html><head>
      <link rel="alternate" type="application/rss+xml" href="/public.xml?lang=tr">
      <link rel="alternate" type="application/rss+xml" href="/private.xml?x%2Dgoog%2Dsignature=redacted">
    </head></html>`)
  });

  assert.deepEqual(result.discoveredFeeds, ["https://news.example/public.xml?lang=tr"]);
});

for (const unsafeUrl of [
  "http://localhost/admin",
  "http://127.0.0.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://169.254.169.254/latest/meta-data/",
  "ftp://example.com/file",
  "https://user:pass@example.com/"
]) {
  test(`rejects unsafe source URL ${unsafeUrl}`, () => {
    assert.throws(() => assertSafeSourceUrl(unsafeUrl));
  });
}

test("rejects a DNS answer set if any address reaches a private network", () => {
  assert.throws(() => validateResolvedAddresses(["93.184.216.34", "10.0.0.4"]));
  assert.throws(
    () => validateResolvedAddresses(["2002:a9fe:a9fe::"]),
    /forbidden address/i
  );
  assert.throws(
    () => validateResolvedAddresses(["2001:0000:4136:e378:8000:63bf:3fff:fdd2"]),
    /forbidden address/i
  );
  assert.deepEqual(validateResolvedAddresses(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]), [
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946"
  ]);
});
