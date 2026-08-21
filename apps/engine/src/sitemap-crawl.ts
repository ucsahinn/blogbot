import {
  fetchSource,
  type FetchedSource,
  type FetchSourceOptions,
  type FetchTransport
} from "../../fetcher/src/fetch-source.ts";
import {
  analyzeSourceDocument,
  type SourceDocumentAnalysis,
  type SourceFeedEntry
} from "../../../packages/security/src/source-document.ts";
import { assertSafeSourceUrl } from "../../../packages/security/src/url-policy.ts";

export interface SitemapCrawlLimits {
  /** Includes the root sitemap document. */
  maxDocuments: number;
  /** Root is depth zero. */
  maxDepth: number;
  /** Maximum unique URL-set entries across the complete tree. */
  maxEntries: number;
}

export const DEFAULT_SITEMAP_CRAWL_LIMITS: SitemapCrawlLimits = {
  maxDocuments: 50,
  maxDepth: 4,
  maxEntries: 100
};

export type SitemapCrawlErrorCode =
  | "SITEMAP_DOCUMENT_LIMIT_EXCEEDED"
  | "SITEMAP_DEPTH_LIMIT_EXCEEDED"
  | "SITEMAP_TOTAL_ENTRY_LIMIT_EXCEEDED"
  | "SITEMAP_CHILD_NOT_SITEMAP";

export class SitemapCrawlError extends Error {
  constructor(
    readonly code: SitemapCrawlErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SitemapCrawlError";
  }
}

export interface CollectedSourceDocument {
  fetched: FetchedSource;
  analysis: SourceDocumentAnalysis;
}

interface PendingSitemap {
  url: string;
  depth: number;
}

function validateLimits(limits: SitemapCrawlLimits): void {
  if (!Number.isInteger(limits.maxDocuments) || limits.maxDocuments < 1 || limits.maxDocuments > 100) {
    throw new RangeError("Sitemap document limit must be between 1 and 100");
  }
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 0 || limits.maxDepth > 10) {
    throw new RangeError("Sitemap depth limit must be between 0 and 10");
  }
  if (!Number.isInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 1_000) {
    throw new RangeError("Sitemap entry limit must be between 1 and 1000");
  }
}

function appendEntries(
  target: Map<string, SourceFeedEntry>,
  entries: SourceFeedEntry[],
  maxEntries: number
): void {
  for (const entry of entries) {
    if (target.has(entry.externalId)) continue;
    if (target.size >= maxEntries) {
      throw new SitemapCrawlError(
        "SITEMAP_TOTAL_ENTRY_LIMIT_EXCEEDED",
        `Sitemap tree contains more than ${maxEntries} unique entries`
      );
    }
    target.set(entry.externalId, entry);
  }
}

/**
 * Fetches one source and, only when it is a sitemap, follows its sitemap-index
 * children sequentially. Everything is collected in memory so callers can
 * persist the complete result atomically after every child has passed policy,
 * fetch, parse, and global-bound checks.
 */
export async function collectSourceDocument(
  inputUrl: string,
  transport: FetchTransport,
  fetchOptions: FetchSourceOptions = {},
  limits: SitemapCrawlLimits = DEFAULT_SITEMAP_CRAWL_LIMITS
): Promise<CollectedSourceDocument> {
  validateLimits(limits);
  const normalizedInput = assertSafeSourceUrl(inputUrl);
  const fetched = await fetchSource(normalizedInput, transport, fetchOptions);
  const rootAnalysis = analyzeSourceDocument(
    {
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
      body: fetched.body
    },
    { maxEntries: limits.maxEntries }
  );
  if (rootAnalysis.kind !== "SITEMAP") {
    return { fetched, analysis: rootAnalysis };
  }

  const entries = new Map<string, SourceFeedEntry>();
  appendEntries(entries, rootAnalysis.entries, limits.maxEntries);
  const discoveredFeeds: string[] = [];
  const seenUrls = new Set<string>([normalizedInput, fetched.finalUrl]);
  const pending: PendingSitemap[] = [];
  let scheduledDocuments = 1;

  const scheduleChildren = (analysis: SourceDocumentAnalysis, depth: number): void => {
    if (analysis.discoveredFeeds.length > 0 && depth >= limits.maxDepth) {
      throw new SitemapCrawlError(
        "SITEMAP_DEPTH_LIMIT_EXCEEDED",
        `Sitemap tree exceeds depth ${limits.maxDepth}`
      );
    }
    for (const discoveredUrl of analysis.discoveredFeeds) {
      const safeUrl = assertSafeSourceUrl(discoveredUrl);
      if (seenUrls.has(safeUrl)) continue;
      if (scheduledDocuments >= limits.maxDocuments) {
        throw new SitemapCrawlError(
          "SITEMAP_DOCUMENT_LIMIT_EXCEEDED",
          `Sitemap tree contains more than ${limits.maxDocuments} documents`
        );
      }
      seenUrls.add(safeUrl);
      discoveredFeeds.push(safeUrl);
      pending.push({ url: safeUrl, depth: depth + 1 });
      scheduledDocuments += 1;
    }
  };

  scheduleChildren(rootAnalysis, 0);
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const child = pending[cursor];
    if (!child) continue;
    const childFetched = await fetchSource(child.url, transport, fetchOptions);
    seenUrls.add(childFetched.finalUrl);
    const childAnalysis = analyzeSourceDocument(
      {
        finalUrl: childFetched.finalUrl,
        contentType: childFetched.contentType,
        body: childFetched.body
      },
      { maxEntries: limits.maxEntries }
    );
    if (childAnalysis.kind !== "SITEMAP") {
      throw new SitemapCrawlError(
        "SITEMAP_CHILD_NOT_SITEMAP",
        `Sitemap child did not contain a sitemap document: ${child.url}`
      );
    }
    appendEntries(entries, childAnalysis.entries, limits.maxEntries);
    scheduleChildren(childAnalysis, child.depth);
  }

  return {
    fetched,
    analysis: {
      ...rootAnalysis,
      discoveredFeeds,
      entries: [...entries.values()]
    }
  };
}
