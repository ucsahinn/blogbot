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
  | "INVALID_ENTRY_LIMIT"
  | "INVALID_SITEMAP"
  | "SITEMAP_ENTRY_LIMIT_EXCEEDED"
  | "SOURCE_DOCUMENT_TOO_LARGE";

export class SourceDocumentError extends Error {
  constructor(
    readonly code: SourceDocumentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SourceDocumentError";
  }
}

const MAX_SOURCE_DOCUMENT_BYTES = 2_000_000;

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

/**
 * Removes markup with a single linear scan.
 *
 * `/<[^>]*>/g` looks harmless but is quadratic on the untrusted feeds this
 * module exists to parse: every `<` that never reaches a `>` makes the engine
 * rescan the remainder. 256 KB of bare `<` took about 43 s on the engine's
 * single thread, well past the desktop bridge's timeout, so one malformed feed
 * stalled every other request.
 */
function stripMarkup(value: string): string {
  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    const open = value.indexOf("<", index);
    if (open < 0) {
      parts.push(value.slice(index));
      break;
    }
    if (open > index) parts.push(value.slice(index, open));
    const close = value.indexOf(">", open);
    // An unterminated tag leaves only markup behind, matching how the previous
    // expression consumed a complete `<...>` and nothing else.
    if (close < 0) break;
    parts.push(" ");
    index = close + 1;
  }
  return parts.join("");
}

function plainText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = stripMarkup(decodeEntities(unwrapCdata(value)))
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

function invalidSitemap(message: string): SourceDocumentError {
  return new SourceDocumentError("INVALID_SITEMAP", message);
}

type SitemapRootName = "urlset" | "sitemapindex";

interface SitemapXmlFrame {
  qualifiedName: string;
  localName: string;
  directLocations: string[];
  captureLocation: boolean;
  locationText: string[];
}

interface ParsedSitemap {
  discoveredFeeds: string[];
  entries: SourceFeedEntry[];
}

const MAX_SITEMAP_XML_DEPTH = 32;

function xmlLocalName(qualifiedName: string): string {
  const separator = qualifiedName.lastIndexOf(":");
  return separator < 0 ? qualifiedName : qualifiedName.slice(separator + 1);
}

function validateXmlCharacters(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd) {
      throw invalidSitemap("Sitemap XML contains forbidden control characters");
    }
  }
}

function validateXmlEntities(value: string): void {
  validateXmlCharacters(value);
  if (value.includes("]]>")) {
    throw invalidSitemap("Sitemap XML contains an invalid CDATA terminator");
  }
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("&", cursor);
    if (start < 0) return;
    const end = value.indexOf(";", start + 1);
    if (end < 0) {
      throw invalidSitemap("Sitemap XML contains an unterminated entity reference");
    }
    const token = value.slice(start + 1, end);
    const named = token === "amp" || token === "lt" || token === "gt"
      || token === "quot" || token === "apos";
    const numeric = /^#(?:[xX][0-9a-fA-F]+|[0-9]+)$/.exec(token);
    if (!named && !numeric) {
      throw invalidSitemap("Sitemap XML contains an unknown entity reference");
    }
    if (numeric) {
      const digits = token.startsWith("#x") || token.startsWith("#X")
        ? token.slice(2)
        : token.slice(1);
      const codePoint = Number.parseInt(digits, token[1]?.toLowerCase() === "x" ? 16 : 10);
      const validCodePoint = Number.isInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && (codePoint < 0xd800 || codePoint > 0xdfff)
        && (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd || codePoint >= 0x20);
      if (!validCodePoint) {
        throw invalidSitemap("Sitemap XML contains an invalid numeric entity");
      }
    }
    cursor = end + 1;
  }
}

function normalizeSitemapLocation(value: string): string {
  const location = value.trim();
  const forbiddenCharacter = [...location].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f
      || character === "<" || character === ">" || character === "\"";
  });
  if (!location || /\s/.test(location) || forbiddenCharacter) {
    throw invalidSitemap("Sitemap contains an invalid location");
  }
  try {
    return assertSafeSourceUrl(location);
  } catch {
    throw invalidSitemap("Sitemap contains an invalid or unsafe location");
  }
}

function readXmlTagEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "<") {
      throw invalidSitemap("Sitemap XML contains a nested tag opener");
    } else if (character === ">") {
      return index;
    }
  }
  throw invalidSitemap("Sitemap XML contains an unterminated tag");
}

function parseXmlStartTag(value: string): {
  qualifiedName: string;
  selfClosing: boolean;
} {
  let content = value.trim();
  const selfClosing = content.endsWith("/");
  if (selfClosing) content = content.slice(0, -1).trimEnd();
  const name = /^([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(content)?.[1];
  if (!name) throw invalidSitemap("Sitemap XML contains an invalid tag name");
  let rest = content.slice(name.length);
  const seenAttributes = new Set<string>();
  while (rest.length > 0) {
    const whitespace = /^\s+/.exec(rest)?.[0];
    if (!whitespace) throw invalidSitemap("Sitemap XML contains malformed attributes");
    rest = rest.slice(whitespace.length);
    if (rest.length === 0) break;
    const attribute = /^([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(rest)?.[1];
    if (!attribute) throw invalidSitemap("Sitemap XML contains an invalid attribute name");
    if (seenAttributes.has(attribute)) {
      throw invalidSitemap(`Sitemap XML contains duplicate attribute: ${attribute}`);
    }
    seenAttributes.add(attribute);
    rest = rest.slice(attribute.length).trimStart();
    if (!rest.startsWith("=")) throw invalidSitemap("Sitemap XML attribute is missing '='");
    rest = rest.slice(1).trimStart();
    const quote = rest[0];
    if (quote !== "\"" && quote !== "'") {
      throw invalidSitemap("Sitemap XML attribute values must be quoted");
    }
    const end = rest.indexOf(quote, 1);
    if (end < 0) throw invalidSitemap("Sitemap XML contains an unterminated attribute");
    const attributeValue = rest.slice(1, end);
    if (attributeValue.includes("<")) {
      throw invalidSitemap("Sitemap XML attribute contains an invalid character");
    }
    validateXmlEntities(attributeValue);
    rest = rest.slice(end + 1);
  }
  return { qualifiedName: name, selfClosing };
}

function parseSitemapDocument(xml: string, maxEntries: number): ParsedSitemap {
  const stack: SitemapXmlFrame[] = [];
  const seenLocations = new Set<string>();
  const entries: SourceFeedEntry[] = [];
  const discoveredFeeds: string[] = [];
  let rootName: SitemapRootName | undefined;
  let rootClosed = false;
  let entryCount = 0;

  const appendText = (value: string, cdata = false): void => {
    if (cdata) validateXmlCharacters(value);
    else validateXmlEntities(value);
    const frame = stack.at(-1);
    if (!frame) {
      if (value.trim()) throw invalidSitemap("Sitemap XML contains text outside its root");
      return;
    }
    if (frame.captureLocation) {
      frame.locationText.push(cdata ? value : decodeEntities(value));
    }
  };

  const finishFrame = (frame: SitemapXmlFrame): void => {
    const parent = stack.at(-1);
    if (frame.captureLocation) {
      if (!parent) throw invalidSitemap("Sitemap location has no parent entry");
      parent.directLocations.push(frame.locationText.join(""));
    }
    if (parent && stack.length === 1) {
      if (frame.directLocations.length !== 1) {
        throw invalidSitemap("Each sitemap entry must contain exactly one location");
      }
      const location = normalizeSitemapLocation(frame.directLocations[0] ?? "");
      if (seenLocations.has(location)) {
        throw invalidSitemap(`Sitemap contains duplicate location: ${location}`);
      }
      seenLocations.add(location);
      if (rootName === "urlset") {
        entries.push({ externalId: location, title: location, url: location });
      } else {
        discoveredFeeds.push(location);
      }
    }
    if (!parent) rootClosed = true;
  };

  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open < 0) {
      appendText(xml.slice(cursor));
      break;
    }
    appendText(xml.slice(cursor, open));
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0 || xml.slice(open + 4, end).includes("--")) {
        throw invalidSitemap("Sitemap XML contains a malformed comment");
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) throw invalidSitemap("Sitemap XML contains unterminated CDATA");
      appendText(xml.slice(open + 9, end), true);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) throw invalidSitemap("Sitemap XML contains an unterminated instruction");
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", open)) {
      throw invalidSitemap("Sitemap XML contains an unsupported declaration");
    }

    const end = readXmlTagEnd(xml, open);
    const tag = xml.slice(open + 1, end);
    if (tag.trimStart().startsWith("/")) {
      const closing = /^\s*\/\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/.exec(tag)?.[1];
      const frame = stack.pop();
      if (!closing || !frame || closing !== frame.qualifiedName) {
        throw invalidSitemap("Sitemap XML contains mismatched closing tags");
      }
      finishFrame(frame);
    } else {
      const parsed = parseXmlStartTag(tag);
      const localName = xmlLocalName(parsed.qualifiedName);
      const parent = stack.at(-1);
      if (!parent) {
        if (rootName || rootClosed || (localName !== "urlset" && localName !== "sitemapindex")) {
          throw invalidSitemap("Sitemap XML must contain exactly one supported root");
        }
        rootName = localName;
      } else {
        if (parent.captureLocation) {
          throw invalidSitemap("Sitemap locations cannot contain nested markup");
        }
        if (stack.length === 1) {
          const expected = rootName === "urlset" ? "url" : "sitemap";
          if (localName !== expected) {
            throw invalidSitemap(`Sitemap root may contain only ${expected} entries`);
          }
          entryCount += 1;
          if (entryCount > maxEntries) {
            throw new SourceDocumentError(
              "SITEMAP_ENTRY_LIMIT_EXCEEDED",
              `Sitemap contains more than ${maxEntries} entries`
            );
          }
        }
      }
      const expectedEntry = rootName === "urlset" ? "url" : "sitemap";
      const captureLocation = localName === "loc"
        && stack.length === 2
        && parent?.localName === expectedEntry;
      const frame: SitemapXmlFrame = {
        qualifiedName: parsed.qualifiedName,
        localName,
        directLocations: [],
        captureLocation,
        locationText: []
      };
      stack.push(frame);
      if (stack.length > MAX_SITEMAP_XML_DEPTH) {
        throw invalidSitemap(`Sitemap XML exceeds depth ${MAX_SITEMAP_XML_DEPTH}`);
      }
      if (parsed.selfClosing) {
        const completed = stack.pop();
        if (!completed) throw invalidSitemap("Sitemap XML parser lost its current tag");
        finishFrame(completed);
      }
    }
    cursor = end + 1;
  }

  if (stack.length !== 0 || !rootName || !rootClosed) {
    throw invalidSitemap("Sitemap XML is incomplete");
  }
  return { discoveredFeeds, entries };
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
  if (input.body.byteLength > MAX_SOURCE_DOCUMENT_BYTES) {
    throw new SourceDocumentError(
      "SOURCE_DOCUMENT_TOO_LARGE",
      `Source document exceeds ${MAX_SOURCE_DOCUMENT_BYTES} bytes`
    );
  }
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
  // Reject active XML declarations before format sniffing. Content-Type is
  // attacker-controlled and a leading comment can hide an RSS/Atom document
  // from the prefix heuristic while the later parser still accepts it.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(document)) {
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
  if (/<(?:[\w.-]+:)?(?:urlset|sitemapindex)\b/i.test(document)) {
    const parsed = parseSitemapDocument(document, maxEntries);
    return {
      kind: "SITEMAP",
      discoveredFeeds: parsed.discoveredFeeds,
      entries: parsed.entries
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
