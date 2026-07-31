import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySourceDocument,
  resolveEditorialRoute,
  validateInstantCreateRequest,
  type SourceRoutingPolicy
} from "../../packages/editorial/src/sources.ts";

test("detects RSS and Atom documents from content instead of URL suffixes", () => {
  assert.equal(
    classifySourceDocument({
      url: "https://example.com/latest",
      contentType: "application/xml",
      bodySample: "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel /></rss>"
    }).kind,
    "RSS"
  );
  assert.equal(
    classifySourceDocument({
      url: "https://example.com/feed",
      contentType: "application/atom+xml",
      bodySample: "<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>"
    }).kind,
    "ATOM"
  );
});

test("discovers alternate feeds from a normal site page", () => {
  const result = classifySourceDocument({
    url: "https://example.com/security",
    contentType: "text/html",
    bodySample:
      '<html><head><link rel="alternate" type="application/rss+xml" href="/security.xml"></head></html>'
  });

  assert.equal(result.kind, "SITE");
  assert.deepEqual(result.discoveredFeeds, ["https://example.com/security.xml"]);
});

test("low-confidence or out-of-policy routing always requires a human", () => {
  const policy: SourceRoutingPolicy = {
    allowedSections: ["haberler", "analiz"],
    defaultArticleType: "news",
    minimumAutomaticConfidence: 0.8
  };

  assert.deepEqual(resolveEditorialRoute(policy, "rehberler", 0.95), {
    status: "ROUTING_REQUIRED",
    reason: "SECTION_NOT_ALLOWED"
  });
  assert.deepEqual(resolveEditorialRoute(policy, "haberler", 0.6), {
    status: "ROUTING_REQUIRED",
    reason: "LOW_CONFIDENCE"
  });
});

test("instant create is review-only and needs source evidence plus target section", () => {
  assert.deepEqual(
    validateInstantCreateRequest({
      instruction: "Son güvenlik duyurularından kısa bir haber hazırla",
      sourceIds: ["source-1"],
      urls: [],
      targetSection: "haberler",
      requestedPublishMode: "DIRECT"
    }),
    {
      valid: false,
      errors: ["DIRECT_PUBLISH_FORBIDDEN"]
    }
  );
});
