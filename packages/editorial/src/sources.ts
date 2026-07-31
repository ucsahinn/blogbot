export type SourceKind = "RSS" | "ATOM" | "SITEMAP" | "SITE" | "ARTICLE";

export interface SourceDocumentProbe {
  url: string;
  contentType: string;
  bodySample: string;
}

export interface SourceClassification {
  kind: SourceKind;
  discoveredFeeds: string[];
}

export interface SourceRoutingPolicy {
  allowedSections: Array<"haberler" | "analiz" | "dosyalar" | "rehberler">;
  defaultArticleType: "news" | "analysis" | "deep_dive" | "guide";
  minimumAutomaticConfidence: number;
}

export type RouteResolution =
  | {
      status: "ROUTED";
      section: "haberler" | "analiz" | "dosyalar" | "rehberler";
    }
  | {
      status: "ROUTING_REQUIRED";
      reason: "SECTION_NOT_ALLOWED" | "LOW_CONFIDENCE";
    };

export interface InstantCreateRequest {
  instruction: string;
  sourceIds: string[];
  urls: string[];
  targetSection?: "haberler" | "analiz" | "dosyalar" | "rehberler";
  requestedPublishMode: "REVIEW" | "DIRECT";
}

export type InstantCreateValidation =
  | { valid: true; normalized: InstantCreateRequest & { requestedPublishMode: "REVIEW" } }
  | { valid: false; errors: string[] };

function discoverHtmlFeeds(baseUrl: string, html: string): string[] {
  const feeds = new Set<string>();
  const linkPattern = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*\balternate\b[^"']*["']/i.test(tag)) {
      continue;
    }
    if (!/\btype\s*=\s*["']application\/(?:rss|atom)\+xml["']/i.test(tag)) {
      continue;
    }
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) {
      continue;
    }
    try {
      feeds.add(new URL(href, baseUrl).toString());
    } catch {
      // A malformed discovery hint is ignored; the source test surface reports it separately.
    }
  }
  return [...feeds];
}

export function classifySourceDocument(probe: SourceDocumentProbe): SourceClassification {
  const body = probe.bodySample.trimStart();
  const contentType = probe.contentType.toLowerCase();

  if (/<rss(?:\s|>)/i.test(body) || contentType.includes("application/rss+xml")) {
    return { kind: "RSS", discoveredFeeds: [] };
  }
  if (/<feed(?:\s|>)/i.test(body) || contentType.includes("application/atom+xml")) {
    return { kind: "ATOM", discoveredFeeds: [] };
  }
  if (/<(?:urlset|sitemapindex)(?:\s|>)/i.test(body)) {
    return { kind: "SITEMAP", discoveredFeeds: [] };
  }
  if (contentType.includes("text/html") || /<html(?:\s|>)/i.test(body)) {
    const discoveredFeeds = discoverHtmlFeeds(probe.url, probe.bodySample);
    const likelyArticle =
      /<article(?:\s|>)/i.test(body) ||
      /property\s*=\s*["']og:type["'][^>]+content\s*=\s*["']article["']/i.test(body);
    return {
      kind: likelyArticle ? "ARTICLE" : "SITE",
      discoveredFeeds
    };
  }
  return { kind: "ARTICLE", discoveredFeeds: [] };
}

export function resolveEditorialRoute(
  policy: SourceRoutingPolicy,
  proposedSection: "haberler" | "analiz" | "dosyalar" | "rehberler",
  confidence: number
): RouteResolution {
  if (!policy.allowedSections.includes(proposedSection)) {
    return { status: "ROUTING_REQUIRED", reason: "SECTION_NOT_ALLOWED" };
  }
  if (
    !Number.isFinite(confidence) ||
    confidence < policy.minimumAutomaticConfidence
  ) {
    return { status: "ROUTING_REQUIRED", reason: "LOW_CONFIDENCE" };
  }
  return { status: "ROUTED", section: proposedSection };
}

export function validateInstantCreateRequest(
  request: InstantCreateRequest
): InstantCreateValidation {
  const errors: string[] = [];
  if (request.requestedPublishMode === "DIRECT") {
    errors.push("DIRECT_PUBLISH_FORBIDDEN");
  }
  if (request.instruction.trim().length < 10) {
    errors.push("INSTRUCTION_TOO_SHORT");
  }
  if (request.sourceIds.length === 0 && request.urls.length === 0) {
    errors.push("SOURCE_EVIDENCE_REQUIRED");
  }
  if (!request.targetSection) {
    errors.push("TARGET_SECTION_REQUIRED");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    normalized: {
      ...request,
      instruction: request.instruction.trim(),
      sourceIds: [...new Set(request.sourceIds)],
      urls: [...new Set(request.urls)],
      requestedPublishMode: "REVIEW"
    }
  };
}
