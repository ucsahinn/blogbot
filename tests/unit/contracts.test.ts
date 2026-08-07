import assert from "node:assert/strict";
import test from "node:test";

import {
  SITE_SECTIONS,
  normalizeSourceBatchInput,
  parseOpmlSourceUrls,
  validateEngineCommandV1
} from "../../packages/contracts/src/index.ts";

test("site routing contract keeps reciprocal TR and EN sections and schema types", () => {
  assert.deepEqual(SITE_SECTIONS.haberler, {
    trPath: "haberler",
    enPath: "news",
    articleType: "news",
    schemaType: "NewsArticle"
  });
  assert.equal(SITE_SECTIONS.rehberler.enPath, "guides");
  assert.equal(SITE_SECTIONS.dosyalar.enPath, "deep-dives");
});

test("general blog and news targets have clear, publishable section contracts", () => {
  assert.deepEqual(SITE_SECTIONS.teknoloji, {
    trPath: "teknoloji",
    enPath: "technology",
    articleType: "news",
    schemaType: "NewsArticle"
  });
  assert.deepEqual(SITE_SECTIONS.ekonomi, {
    trPath: "ekonomi",
    enPath: "business",
    articleType: "news",
    schemaType: "NewsArticle"
  });
  assert.equal(SITE_SECTIONS.kultur.articleType, "analysis");
  assert.equal(SITE_SECTIONS.yasam.articleType, "guide");
});

test("bulk source input has no artificial product cap and removes exact duplicates", () => {
  const urls = Array.from(
    { length: 500 },
    (_, index) => `https://source-${index}.example/feed`
  );
  const result = normalizeSourceBatchInput(`${urls.join("\n")}\n${urls[0]}`);

  assert.equal(result.urls.length, 500);
  assert.deepEqual(result.invalid, []);
});

test("OPML import reads xmlUrl and htmlUrl candidates without executing markup", () => {
  const result = parseOpmlSourceUrls(`
    <opml version="2.0">
      <body>
        <outline text="Feed" xmlUrl="https://example.com/rss.xml" />
        <outline text="Site" htmlUrl="https://another.example/news" />
        <script>alert(1)</script>
      </body>
    </opml>
  `);

  assert.deepEqual(result, [
    "https://example.com/rss.xml",
    "https://another.example/news"
  ]);
});

test("SOURCE.SCAN requires unique versioned targets and a batch expectedVersion of zero", () => {
  const valid = validateEngineCommandV1({
    version: 1,
    requestId: "scan-request-1",
    idempotencyKey: "scan-key-1",
    expectedVersion: 0,
    kind: "SOURCE.SCAN",
    payload: {
      targets: [
        { sourceId: "source-a", expectedVersion: 1 },
        { sourceId: "source-b", expectedVersion: 4 }
      ]
    }
  });
  assert.equal(valid.valid, true);

  for (const targets of [
    [],
    [
      { sourceId: "source-a", expectedVersion: 1 },
      { sourceId: "source-a", expectedVersion: 1 }
    ],
    [{ sourceId: "source-a", expectedVersion: -1 }]
  ]) {
    const result = validateEngineCommandV1({
      version: 1,
      requestId: "scan-request-invalid",
      idempotencyKey: "scan-key-invalid",
      expectedVersion: 0,
      kind: "SOURCE.SCAN",
      payload: { targets }
    });
    assert.equal(result.valid, false);
  }

  const nonZeroBatchVersion = validateEngineCommandV1({
    version: 1,
    requestId: "scan-request-version",
    idempotencyKey: "scan-key-version",
    expectedVersion: 1,
    kind: "SOURCE.SCAN",
    payload: {
      targets: [{ sourceId: "source-a", expectedVersion: 1 }]
    }
  });
  assert.equal(nonZeroBatchVersion.valid, false);
});

test("SOURCE.REVIEW records separate trust and usage-rights decisions with a version lock", () => {
  const valid = validateEngineCommandV1({
    version: 1,
    requestId: "source-review-request",
    idempotencyKey: "source-review-key",
    expectedVersion: 3,
    kind: "SOURCE.REVIEW",
    payload: {
      sourceId: "source-a",
      trustStatus: "APPROVED",
      rightsStatus: "REJECTED",
      rationale: "Yayıncının açık kullanım izni doğrulanamadı; kaynak yalnızca tarama için tutuluyor."
    }
  });
  assert.equal(valid.valid, true);

  for (const payload of [
    { sourceId: "source-a", trustStatus: "PENDING", rightsStatus: "APPROVED", rationale: "Yeterli gerekçe metni" },
    { sourceId: "source-a", trustStatus: "APPROVED", rightsStatus: "APPROVED", rationale: "kısa" },
    { sourceId: "", trustStatus: "APPROVED", rightsStatus: "APPROVED", rationale: "Kaynak sahipliği ve kullanım koşulları doğrulandı." }
  ]) {
    const result = validateEngineCommandV1({
      version: 1,
      requestId: "source-review-invalid",
      idempotencyKey: "source-review-invalid-key",
      expectedVersion: 3,
      kind: "SOURCE.REVIEW",
      payload
    });
    assert.equal(result.valid, false);
  }
});

test("APPROVAL.GRANT_HIGH_RISK requires exact hashes and a UTC reauthentication timestamp", () => {
  const valid = validateEngineCommandV1({
    version: 1,
    requestId: "high-risk-request",
    idempotencyKey: "high-risk-key",
    expectedVersion: 3,
    kind: "APPROVAL.GRANT_HIGH_RISK",
    payload: {
      revisionId: "revision-high-risk",
      revisionHash: "a".repeat(64),
      deviceId: "windows-local-device-v1",
      riskChecklistHash: "b".repeat(64),
      warningSetHash: "c".repeat(64),
      windowsReauthenticatedAt: "2026-07-30T12:00:00.000Z"
    }
  });
  assert.equal(valid.valid, true);

  const invalid = validateEngineCommandV1({
    version: 1,
    requestId: "high-risk-invalid",
    idempotencyKey: "high-risk-invalid-key",
    expectedVersion: 3,
    kind: "APPROVAL.GRANT_HIGH_RISK",
    payload: {
      revisionId: "revision-high-risk",
      revisionHash: "a".repeat(64),
      deviceId: "windows-local-device-v1",
      riskChecklistHash: "b".repeat(64),
      warningSetHash: "c".repeat(64),
      windowsReauthenticatedAt: "2026-07-30T12:00:00Z"
    }
  });
  assert.equal(invalid.valid, false);
});

test("REVISION.SAVE fails closed on incomplete or malformed nested claims", () => {
  for (const revision of [
    {},
    {
      editorialDesk: "SiberDergi",
      riskLevel: "STANDARD",
      translationParity: { status: "MATCHED", reportHash: "a".repeat(64) },
      editorialPolicyHash: "b".repeat(64),
      editorialReviewReportHash: "c".repeat(64),
      targetRepository: "ucsahinn/siberdergi.net",
      targetBaseBranch: "main",
      targetBaseSha: "d".repeat(40),
      generatedFiles: [
        { path: "src/content/article.md", sha256: "e".repeat(64), size: 10 }
      ],
      claims: [null]
    }
  ]) {
    assert.doesNotThrow(() => {
      const result = validateEngineCommandV1({
        version: 1,
        requestId: "revision-invalid",
        idempotencyKey: "revision-invalid-key",
        expectedVersion: 0,
        kind: "REVISION.SAVE",
        payload: { revision }
      });
      assert.equal(result.valid, false);
    });
  }
});
