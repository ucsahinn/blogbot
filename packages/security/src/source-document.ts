import { createHash } from "node:crypto";

import { assertSafeSourceUrl } from "./url-policy.ts";

export type SourceDocumentKind =
  | "RSS"
  | "ATOM"
  | "SITEMAP"
  | "SITE"
  | "ARTICLE";

export interface SourceFeedEntry {
  externalId: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
}

export interface SourceDocumentAnalysis {
  kind: SourceDocumentKind;
  title?: string;
  discoveredFeeds: string[];
  entries: SourceFeedEntry[];
}

export interface SourceDocumentInput {
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
}

export interface SourceDocumentOptions {
  maxEntries?: number;
}

export type SourceDocumentErrorCode =
  | "INVALID_ENCODING"
  | "UNSAFE_XML_DECLARATION"
  | "INVALID_ENTRY_LIMIT";

export class SourceDocumentError extends Error {
  constructor(
    readonly code: SourceDocumentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SourceDocumentError";
  }
}

const xmlMediaTypes = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml"
]);

function mediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function decodeBody(body: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SourceDocumentError(
      "INVALID_ENCODING",
      "Source document is not valid UTF-8"
    );
  }
}

function unwrapCdata(value: string): string {
  return value.replace(
    /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i,
    (_match, content: string) => content
  );
}

function decodeEntities(value: string): string {
  const codePoint = (digits: string, radix: number): string => {
    const value = Number.parseInt(digits, radix);
    return Number.isInteger(value)
      && value >= 0
      && value <= 0x10ffff
      && (value < 0xd800 || value > 0xdfff)
      ? String.fromCodePoint(value)
      : "\uFFFD";
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      codePoint(hex, 16)
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      codePoint(decimal, 10)
    )
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function plainText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = decodeEntities(unwrapCdata(value))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function elementValue(xml: string, tagName: string): string | undefined {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    "i"
  ).exec(xml)?.[1];
}

function elementBlocks(xml: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    "gi"
  );
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function attributeValue(tag: string, attribute: string): string | undefined {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i"
  ).exec(tag)?.slice(1).find((value) => value !== undefined);
}

function safeAbsoluteUrl(
  value: string | undefined,
  baseUrl: string
): string | undefined {
  const normalized = plainText(value);
  if (!normalized) {
    return undefined;
  }
  try {
    return assertSafeSourceUrl(new URL(normalized, baseUrl).toString());
  } catch {
    return undefined;
  }
}

function isoDate(value: string | undefined): string | undefined {
  const normalized = plainText(value);
  if (!normalized) {
    return undefined;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function fallbackExternalId(
  title: string,
  url: string,
  publishedAt?: string
): string {
  return createHash("sha256")
    .update(`${title}\n${url}\n${publishedAt ?? ""}`)
    .digest("hex");
}

function createEntry(input: {
  externalId?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
  publishedAt?: string | undefined;
  summary?: string | undefined;
}): SourceFeedEntry | undefined {
  if (!input.title || !input.url) {
    return undefined;
  }
  const entry: SourceFeedEntry = {
    externalId:
      input.externalId ??
      fallbackExternalId(input.title, input.url, input.publishedAt),
    title: input.title,
    url: input.url
  };
  if (input.publishedAt) {
    entry.publishedAt = input.publishedAt;
  }
  if (input.summary) {
    entry.summary = input.summary;
  }
  return entry;
}

function parseRssEntries(
  xml: string,
  baseUrl: string,
  maxEntries: number
): SourceFeedEntry[] {
  const entries = new Map<string, SourceFeedEntry>();
  for (const block of elementBlocks(xml, "item").slice(0, maxEntries)) {
    const title = plainText(elementValue(block, "title"));
    const url = safeAbsoluteUrl(elementValue(block, "link"), baseUrl);
    const publishedAt = isoDate(
      elementValue(block, "pubDate") ?? elementValue(block, "date")
    );
    const entry = createEntry({
      externalId: plainText(elementValue(block, "guid")) ?? url,
      title,
      url,
      publishedAt,
      summary: plainText(
        elementValue(block, "description") ??
          elementValue(block, "encoded")
      )
    });
    if (entry) {
      entries.set(entry.externalId, entry);
    }
  }
  return [...entries.values()];
}

function atomAlternateLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b[^>]*\/?>/gi)].map(
    (match) => match[0]
  );
  const alternate =
    links.find((tag) => {
      const rel = attributeValue(tag, "rel");
      return !rel || rel.toLowerCase() === "alternate";
    }) ?? links[0];
  return alternate ? attributeValue(alternate, "href") : undefined;
}

function parseAtomEntries(
  xml: string,
  baseUrl: string,
  maxEntries: number
): SourceFeedEntry[] {
  const entries = new Map<string, SourceFeedEntry>();
  for (const block of elementBlocks(xml, "entry").slice(0, maxEntries)) {
    const title = plainText(elementValue(block, "title"));
    const url = safeAbsoluteUrl(atomAlternateLink(block), baseUrl);
    const publishedAt = isoDate(
      elementValue(block, "published") ?? elementValue(block, "updated")
    );
    const entry = createEntry({
      externalId: plainText(elementValue(block, "id")) ?? url,
      title,
      url,
      publishedAt,
      summary: plainText(
        elementValue(block, "summary") ?? elementValue(block, "content")
      )
    });
    if (entry) {
      entries.set(entry.externalId, entry);
    }
  }
  return [...entries.values()];
}

function discoverHtmlFeeds(baseUrl: string, html: string): string[] {
  const feeds = new Set<string>();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attributeValue(tag, "rel")
      ?.toLowerCase()
      .split(/\s+/);
    const type = attributeValue(tag, "type")?.toLowerCase();
    const href = attributeValue(tag, "href");
    if (
      !rel?.includes("alternate") ||
      (type !== "application/rss+xml" && type !== "application/atom+xml") ||
      !href
    ) {
      continue;
    }
    const safeUrl = safeAbsoluteUrl(href, baseUrl);
    if (safeUrl) {
      feeds.add(safeUrl);
    }
  }
  return [...feeds];
}

function documentTitle(document: string): string | undefined {
  const beforeFirstEntry = document.split(/<(?:item|entry)\b/i, 1)[0] ?? "";
  return plainText(elementValue(beforeFirstEntry, "title"));
}

export function analyzeSourceDocument(
  input: SourceDocumentInput,
  options: SourceDocumentOptions = {}
): SourceDocumentAnalysis {
  const maxEntries = options.maxEntries ?? 100;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000) {
    throw new SourceDocumentError(
      "INVALID_ENTRY_LIMIT",
      "Feed entry limit must be between 1 and 1000"
    );
  }

  const finalUrl = assertSafeSourceUrl(input.finalUrl);
  const document = decodeBody(input.body).replace(/^\uFEFF/, "");
  const normalizedType = mediaType(input.contentType);
  const trimmed = document.trimStart();
  const looksLikeXml =
    xmlMediaTypes.has(normalizedType) ||
    /^<\?xml\b/i.test(trimmed) ||
    /^<(?:rss|feed|urlset|sitemapindex)\b/i.test(trimmed);
  if (
    looksLikeXml &&
    /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(document)
  ) {
    throw new SourceDocumentError(
      "UNSAFE_XML_DECLARATION",
      "DTD and entity declarations are not allowed in source XML"
    );
  }

  if (/<rss(?:\s|>)/i.test(document) || normalizedType === "application/rss+xml") {
    const title = documentTitle(document);
    return {
      kind: "RSS",
      ...(title ? { title } : {}),
      discoveredFeeds: [],
      entries: parseRssEntries(document, finalUrl, maxEntries)
    };
  }
  if (/<feed(?:\s|>)/i.test(document) || normalizedType === "application/atom+xml") {
    const title = documentTitle(document);
    return {
      kind: "ATOM",
      ...(title ? { title } : {}),
      discoveredFeeds: [],
      entries: parseAtomEntries(document, finalUrl, maxEntries)
    };
  }
  if (/<(?:urlset|sitemapindex)(?:\s|>)/i.test(document)) {
    return {
      kind: "SITEMAP",
      discoveredFeeds: [],
      entries: []
    };
  }

  const isHtml =
    normalizedType === "text/html" || /<html(?:\s|>)/i.test(document);
  if (isHtml) {
    const likelyArticle =
      /<article(?:\s|>)/i.test(document) ||
      /property\s*=\s*["']og:type["'][^>]+content\s*=\s*["']article["']/i.test(
        document
      );
    const title = plainText(elementValue(document, "title"));
    return {
      kind: likelyArticle ? "ARTICLE" : "SITE",
      ...(title ? { title } : {}),
      discoveredFeeds: discoverHtmlFeeds(finalUrl, document),
      entries: []
    };
  }

  return {
    kind: "ARTICLE",
    discoveredFeeds: [],
    entries: []
  };
}
