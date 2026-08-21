import type { EngineCommandV1 } from "../../../packages/contracts/src/index.ts";
import {
  SourceRepositoryError,
  type LocalSourceScan,
  type SourceRepository,
  type SourceScanError
} from "../../../packages/database/src/source-repository.ts";
import { canonicalJson } from "../../../packages/editorial/src/revision.ts";
import {
  SourceDocumentError
} from "../../../packages/security/src/source-document.ts";
import {
  FetchBoundaryError,
  type FetchTransport
} from "../../fetcher/src/fetch-source.ts";
import type { LocalQueueRuntime } from "./local-queue.ts";
import {
  collectSourceDocument,
  SitemapCrawlError
} from "./sitemap-crawl.ts";

type SourceScanCommand = Extract<EngineCommandV1, { kind: "SOURCE.SCAN" }>;

interface SourceScanJobData {
  kind: "SOURCE.SCAN";
  scanId: string;
  sourceId: string;
  expectedVersion: number;
}

export interface SourceScanAccepted {
  batchKey: string;
  scans: Array<{
    scanId: string;
    sourceId: string;
    accepted: boolean;
  }>;
}

export class SourceScanCoordinator {
  constructor(
    private readonly repository: SourceRepository,
    private readonly queue: LocalQueueRuntime,
    private readonly now: () => Date = () => new Date()
  ) {}

  async enqueue(command: SourceScanCommand): Promise<SourceScanAccepted> {
    const batchKey = engineBatchKey(command.idempotencyKey);
    const runs = await this.repository.prepareScanBatch(
      batchKey,
      canonicalJson({
        kind: command.kind,
        payload: command.payload,
        expectedVersion: command.expectedVersion
      }),
      command.payload.targets,
      this.now().toISOString()
    );
    await this.enqueueRecoverable(runs);
    return {
      batchKey,
      scans: runs.map((scan) => ({
        scanId: scan.id,
        sourceId: scan.sourceId,
        accepted: scan.state !== "REJECTED"
      }))
    };
  }

  async recover(): Promise<void> {
    await this.enqueueRecoverable(
      await this.repository.listRecoverableScanRuns()
    );
  }

  async status(idempotencyKey: string): Promise<LocalSourceScan[]> {
    return this.repository.listScanRuns(engineBatchKey(idempotencyKey));
  }

  private async enqueueRecoverable(runs: LocalSourceScan[]): Promise<void> {
    for (const scan of runs) {
      if (scan.state !== "QUEUED" && scan.state !== "RUNNING") {
        continue;
      }
      const queueJobId = await this.queue.enqueue(
        "blogbot.source-scan",
        {
          kind: "SOURCE.SCAN",
          scanId: scan.id,
          sourceId: scan.sourceId,
          expectedVersion: scan.expectedVersion
        } satisfies SourceScanJobData,
        `source-scan:${scan.id}`
      );
      await this.repository.attachScanJob(
        scan.id,
        queueJobId,
        this.now().toISOString()
      );
    }
  }
}

export class SourceScanWorker {
  constructor(
    private readonly repository: SourceRepository,
    private readonly queue: LocalQueueRuntime,
    private readonly transport: FetchTransport,
    private readonly onSucceeded?: () => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  async start(): Promise<void> {
    await this.queue.work<SourceScanJobData>(
      "blogbot.source-scan",
      async (job) => {
        await this.process(job.data);
      }
    );
  }

  private async process(job: SourceScanJobData): Promise<void> {
    const claim = await this.repository.markScanRunning(
      job.scanId,
      this.now().toISOString()
    );
    if (!claim.claimed) return;
    const running = claim.scan;
    if (running.state === "SUCCEEDED" || running.state === "REJECTED") {
      return;
    }

    try {
      const source = await this.repository.getSource(job.sourceId);
      if (source.version !== job.expectedVersion) {
        throw new SourceRepositoryError(
          "VERSION_CONFLICT",
          `Source ${source.id} changed from version ${job.expectedVersion} to ${source.version}`
        );
      }
      if (source.status !== "ACTIVE") {
        throw new Error(`SOURCE_DISABLED: Source ${source.id} is disabled`);
      }
      const { fetched, analysis } = await collectSourceDocument(source.url, this.transport, {
        timeoutMs: 8_000,
        maxBytes: 2_000_000,
        maxRedirects: 5
      });
      await this.repository.completeSourceScan(job.scanId, {
        kind: analysis.kind,
        ...(analysis.title ? { title: analysis.title } : {}),
        discoveredFeeds: analysis.discoveredFeeds,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        entries: analysis.entries,
        completedAt: this.now().toISOString()
      });
      this.onSucceeded?.();
    } catch (error) {
      const classified = classifySourceScanError(error);
      await this.repository.failSourceScan(
        job.scanId,
        classified,
        this.now().toISOString()
      );
      if (classified.retryable) {
        throw error;
      }
    }
  }
}

function engineBatchKey(idempotencyKey: string): string {
  return `engine:${idempotencyKey}`;
}

function classifySourceScanError(error: unknown): SourceScanError {
  if (error instanceof SourceRepositoryError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false
    };
  }
  if (
    error instanceof Error &&
    error.message.startsWith("SOURCE_DISABLED:")
  ) {
    return {
      code: "SOURCE_DISABLED",
      message: error.message.slice("SOURCE_DISABLED: ".length),
      retryable: false
    };
  }
  if (error instanceof SourceDocumentError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false
    };
  }
  if (error instanceof SitemapCrawlError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false
    };
  }
  if (error instanceof FetchBoundaryError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "TIMEOUT" || error.code === "HTTP_STATUS"
    };
  }
  return {
    code: "SOURCE_FETCH_FAILED",
    message: error instanceof Error ? error.message : "Source fetch failed",
    retryable: true
  };
}
