import { randomUUID } from "node:crypto";

import {
  fetchSource,
  type FetchSourceOptions,
  type FetchTransport
} from "../../fetcher/src/fetch-source.ts";
import type {
  LocalSource,
  SourceLanguage,
  SourceRepository
} from "../../../packages/database/src/source-repository.ts";
import { analyzeSourceDocument } from "../../../packages/security/src/source-document.ts";
import { assertSafeSourceUrl } from "../../../packages/security/src/url-policy.ts";

export interface SourceTestRequest {
  url: string;
  language?: SourceLanguage;
}

export interface SourceTestResult {
  source: LocalSource;
  entriesAdded: number;
}

export interface SourceIngestionDependencies {
  now?: () => Date;
  createId?: () => string;
}

export class SourceIngestionService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly repository: SourceRepository,
    private readonly transport: FetchTransport,
    dependencies: SourceIngestionDependencies = {},
    private readonly fetchOptions: FetchSourceOptions = {}
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async testAndSave(request: SourceTestRequest): Promise<SourceTestResult> {
    const normalizedUrl = assertSafeSourceUrl(request.url);
    const fetched = await fetchSource(
      normalizedUrl,
      this.transport,
      this.fetchOptions
    );
    const analysis = analyzeSourceDocument({
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
      body: fetched.body
    });
    const testedAt = this.now().toISOString();
    const existing = await this.repository.findSourceByUrl(normalizedUrl);
    const source: LocalSource = existing
      ? this.updatedSource(existing, analysis, fetched, testedAt)
      : this.newSource(
          normalizedUrl,
          request.language ?? "unknown",
          analysis,
          fetched,
          testedAt
        );
    const saved = await this.repository.saveSource(
      source,
      existing?.version ?? 0
    );
    const entriesAdded = await this.repository.saveEntries(
      saved.id,
      analysis.entries
    );
    return { source: saved, entriesAdded };
  }

  private newSource(
    url: string,
    language: SourceLanguage,
    analysis: ReturnType<typeof analyzeSourceDocument>,
    fetched: Awaited<ReturnType<typeof fetchSource>>,
    testedAt: string
  ): LocalSource {
    return {
      id: this.createId(),
      url,
      kind: analysis.kind,
      status: "ACTIVE",
      trustStatus: "PENDING",
      rightsStatus: "PENDING",
      language,
      discoveredFeeds: analysis.discoveredFeeds,
      createdAt: testedAt,
      updatedAt: testedAt,
      version: 1,
      ...(analysis.title ? { title: analysis.title } : {}),
      lastTest: {
        testedAt,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        entryCount: analysis.entries.length
      }
    };
  }

  private updatedSource(
    existing: LocalSource,
    analysis: ReturnType<typeof analyzeSourceDocument>,
    fetched: Awaited<ReturnType<typeof fetchSource>>,
    testedAt: string
  ): LocalSource {
    return {
      ...existing,
      kind: analysis.kind,
      discoveredFeeds: analysis.discoveredFeeds,
      updatedAt: testedAt,
      version: existing.version + 1,
      ...(analysis.title ? { title: analysis.title } : {}),
      lastTest: {
        testedAt,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        entryCount: analysis.entries.length
      }
    };
  }
}
