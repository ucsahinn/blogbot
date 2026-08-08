import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";

import { canonicalJson } from "../../editorial/src/revision.ts";
import {
  JsonProtector
} from "./encrypted-json.ts";
import type {
  SourceDocumentKind,
  SourceFeedEntry
} from "../../security/src/source-document.ts";
import type { ArticleType, SiteSection } from "../../contracts/src/index.ts";

export type SourceReviewStatus = "PENDING" | "APPROVED" | "REJECTED";
export type SourceStatus = "ACTIVE" | "DISABLED";
export type SourceLanguage = "tr" | "en" | "other" | "unknown";

export interface SourceReviewEvidence {
  reviewedAt: string;
  rationale: string;
}

export interface LocalSource {
  id: string;
  url: string;
  kind: SourceDocumentKind;
  status: SourceStatus;
  trustStatus: SourceReviewStatus;
  rightsStatus: SourceReviewStatus;
  trustReview?: SourceReviewEvidence;
  rightsReview?: SourceReviewEvidence;
  language: SourceLanguage;
  discoveredFeeds: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
  title?: string;
  defaultSection?: SiteSection;
  defaultArticleType?: ArticleType;
  lastTest?: {
    testedAt: string;
    finalUrl: string;
    contentType: string;
    entryCount: number;
  };
}

export interface StoredSourceEntry extends SourceFeedEntry {
  sourceId: string;
  /** Immutable capture time used by the local evidence retention policy. */
  capturedAt?: string;
}

export type SourceScanState =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "REJECTED";

export interface SourceScanError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface LocalSourceScan {
  id: string;
  batchKey: string;
  ordinal: number;
  sourceId: string;
  expectedVersion: number;
  state: SourceScanState;
  attempts: number;
  entriesAdded: number;
  publishEligible: boolean;
  publishBlockers: SourceCapabilities["blockers"];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  queueJobId?: string;
  error?: SourceScanError;
}

export interface SourceScanTarget {
  sourceId: string;
  expectedVersion: number;
}

export interface CompletedSourceScanInput {
  kind: SourceDocumentKind;
  title?: string;
  discoveredFeeds: string[];
  finalUrl: string;
  contentType: string;
  entries: SourceFeedEntry[];
  completedAt: string;
}

export interface SourceCapabilities {
  canScan: boolean;
  canPublish: boolean;
  blockers: Array<
    | "SOURCE_DISABLED"
    | "TRUST_REVIEW_REQUIRED"
    | "TRUST_REJECTED"
    | "RIGHTS_REVIEW_REQUIRED"
    | "RIGHTS_REJECTED"
  >;
}

export type SourceRepositoryErrorCode =
  | "SOURCE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "URL_ALREADY_EXISTS";

export class SourceRepositoryError extends Error {
  constructor(
    readonly code: SourceRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SourceRepositoryError";
  }
}

export interface SourceRepository {
  saveSource(source: LocalSource, expectedVersion?: number): Promise<LocalSource>;
  saveSourceIdempotent(
    source: LocalSource,
    expectedVersion: number,
    idempotencyKey: string,
    requestFingerprint?: string
  ): Promise<LocalSource>;
  getSource(sourceId: string): Promise<LocalSource>;
  findSourceByUrl(url: string): Promise<LocalSource | undefined>;
  listSources(): Promise<LocalSource[]>;
  saveEntries(sourceId: string, entries: SourceFeedEntry[]): Promise<number>;
  listEntries(sourceId: string): Promise<StoredSourceEntry[]>;
  /** Read only the newest bounded slice needed for candidate triage. */
  listEntriesBounded(sourceId: string, limit: number): Promise<StoredSourceEntry[]>;
  purgeExpiredEntries(beforeIso: string, protectedSourceIds?: readonly string[]): Promise<number>;
  getSourceCapabilities(sourceId: string): Promise<SourceCapabilities>;
  prepareScanBatch(
    batchKey: string,
    requestFingerprint: string,
    targets: SourceScanTarget[],
    createdAt: string
  ): Promise<LocalSourceScan[]>;
  listScanRuns(batchKey: string): Promise<LocalSourceScan[]>;
  listRecoverableScanRuns(): Promise<LocalSourceScan[]>;
  attachScanJob(scanId: string, queueJobId: string, updatedAt: string): Promise<void>;
  markScanRunning(scanId: string, startedAt: string): Promise<LocalSourceScan>;
  completeSourceScan(
    scanId: string,
    input: CompletedSourceScanInput
  ): Promise<LocalSourceScan>;
  failSourceScan(
    scanId: string,
    error: SourceScanError,
    completedAt: string
  ): Promise<LocalSourceScan>;
}

interface JsonRow {
  id?: string;
  external_id?: string;
  value: unknown;
}

const SOURCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS blogbot_sources (
  id text PRIMARY KEY,
  url text NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version > 0),
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_source_entries (
  source_id text NOT NULL REFERENCES blogbot_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS blogbot_source_idempotency (
  idempotency_key text PRIMARY KEY,
  request_fingerprint text NOT NULL,
  response_json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_encryption_migrations (
  scope text PRIMARY KEY,
  version integer NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_source_scan_requests (
  idempotency_key text PRIMARY KEY,
  request_fingerprint text NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_source_scans (
  id text PRIMARY KEY,
  batch_key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_id text NOT NULL,
  state text NOT NULL,
  value jsonb NOT NULL,
  UNIQUE (batch_key, ordinal)
);

CREATE INDEX IF NOT EXISTS blogbot_source_scans_batch_idx
  ON blogbot_source_scans (batch_key, ordinal);
`;

export class PGliteSourceRepository implements SourceRepository {
  private constructor(
    private readonly database: PGlite,
    private readonly protector: JsonProtector
  ) {}

  static async open(dataDir: string): Promise<PGliteSourceRepository> {
    await mkdir(dataDir, { recursive: true });
    const database = new PGlite(dataDir);
    await database.waitReady;
    await database.exec(SOURCE_SCHEMA_SQL);
    const protector = JsonProtector.fromEnvironment();
    await encryptLegacySourceRows(database, protector);
    return new PGliteSourceRepository(database, protector);
  }

  static async fromDatabase(database: PGlite): Promise<PGliteSourceRepository> {
    await database.exec(SOURCE_SCHEMA_SQL);
    const protector = JsonProtector.fromEnvironment();
    await encryptLegacySourceRows(database, protector);
    return new PGliteSourceRepository(database, protector);
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  async saveSource(
    source: LocalSource,
    expectedVersion?: number
  ): Promise<LocalSource> {
    const existing = await this.findSourceById(source.id);
    if (existing) {
      if (
        expectedVersion !== undefined &&
        existing.version !== expectedVersion
      ) {
        throw new SourceRepositoryError(
          "VERSION_CONFLICT",
          `Source ${source.id} changed from version ${expectedVersion} to ${existing.version}`
        );
      }
      if (source.version !== existing.version + 1) {
        throw new SourceRepositoryError(
          "VERSION_CONFLICT",
          `Source ${source.id} update must advance version ${existing.version} by one`
        );
      }
      await this.database.query(
        `UPDATE blogbot_sources
            SET url = $2, version = $3, value = $4::jsonb
          WHERE id = $1`,
        [
          source.id,
          source.url,
          source.version,
          JSON.stringify(this.protector.seal(source, sourceContext(source.id)))
        ]
      );
      return structuredClone(source);
    }

    if (expectedVersion !== undefined && expectedVersion !== 0) {
      throw new SourceRepositoryError(
        "VERSION_CONFLICT",
        `Source ${source.id} does not exist at version ${expectedVersion}`
      );
    }
    if (source.version !== 1) {
      throw new SourceRepositoryError(
        "VERSION_CONFLICT",
        `New source ${source.id} must start at version 1`
      );
    }
    const duplicate = await this.findSourceByUrl(source.url);
    if (duplicate) {
      throw new SourceRepositoryError(
        "URL_ALREADY_EXISTS",
        `Source URL already belongs to ${duplicate.id}`
      );
    }
    await this.database.query(
      `INSERT INTO blogbot_sources (id, url, version, value)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        source.id,
        source.url,
        source.version,
        JSON.stringify(this.protector.seal(source, sourceContext(source.id)))
      ]
    );
    return structuredClone(source);
  }

  async saveSourceIdempotent(
    source: LocalSource,
    expectedVersion: number,
    idempotencyKey: string,
    requestFingerprint?: string
  ): Promise<LocalSource> {
    const fingerprint = createHash("sha256")
      .update(requestFingerprint ?? canonicalJson({ source, expectedVersion }))
      .digest("hex");
    return this.database.transaction(async (transaction) => {
      const replay = await transaction.query<{
        request_fingerprint: string;
        response_json: unknown;
      }>(
        `SELECT request_fingerprint, response_json
           FROM blogbot_source_idempotency
          WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      const existingReplay = replay.rows[0];
      if (existingReplay) {
        if (existingReplay.request_fingerprint !== fingerprint) {
          throw new Error(
            "IDEMPOTENCY_KEY_REUSED: source key belongs to a different request"
          );
        }
        return this.openSource(
          existingReplay.response_json,
          source.id,
          sourceIdempotencyContext(idempotencyKey)
        );
      }

      const existing = await transaction.query<JsonRow>(
        "SELECT value FROM blogbot_sources WHERE id = $1",
        [source.id]
      );
      const currentValue = existing.rows[0]?.value;
      const current = currentValue
        ? this.openSource(currentValue, source.id)
        : undefined;
      if (current) {
        if (current.version !== expectedVersion) {
          throw new SourceRepositoryError(
            "VERSION_CONFLICT",
            `Source ${source.id} changed from version ${expectedVersion} to ${current.version}`
          );
        }
        if (source.version !== current.version + 1) {
          throw new SourceRepositoryError(
            "VERSION_CONFLICT",
            `Source ${source.id} update must advance version ${current.version} by one`
          );
        }
        await transaction.query(
          `UPDATE blogbot_sources
              SET url = $2, version = $3, value = $4::jsonb
            WHERE id = $1`,
          [
            source.id,
            source.url,
            source.version,
            JSON.stringify(this.protector.seal(source, sourceContext(source.id)))
          ]
        );
      } else {
        if (expectedVersion !== 0 || source.version !== 1) {
          throw new SourceRepositoryError(
            "VERSION_CONFLICT",
            `New source ${source.id} must start at expectedVersion 0 and version 1`
          );
        }
        const duplicate = await transaction.query<JsonRow>(
          "SELECT value FROM blogbot_sources WHERE url = $1",
          [source.url]
        );
        if (duplicate.rows[0]) {
          throw new SourceRepositoryError(
            "URL_ALREADY_EXISTS",
            `Source URL already exists`
          );
        }
        await transaction.query(
          `INSERT INTO blogbot_sources (id, url, version, value)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            source.id,
            source.url,
            source.version,
            JSON.stringify(this.protector.seal(source, sourceContext(source.id)))
          ]
        );
      }
      await transaction.query(
        `INSERT INTO blogbot_source_idempotency (
           idempotency_key, request_fingerprint, response_json
         ) VALUES ($1, $2, $3::jsonb)`,
        [
          idempotencyKey,
          fingerprint,
          JSON.stringify(
            this.protector.seal(
              source,
              sourceIdempotencyContext(idempotencyKey)
            )
          )
        ]
      );
      return structuredClone(source);
    });
  }

  async getSource(sourceId: string): Promise<LocalSource> {
    const source = await this.findSourceById(sourceId);
    if (!source) {
      throw new SourceRepositoryError(
        "SOURCE_NOT_FOUND",
        `Source ${sourceId} was not found`
      );
    }
    return source;
  }

  async findSourceByUrl(url: string): Promise<LocalSource | undefined> {
    const result = await this.database.query<JsonRow>(
      "SELECT id, value FROM blogbot_sources WHERE url = $1",
      [url]
    );
    const row = result.rows[0];
    return row?.value && row.id
      ? this.openSource(row.value, row.id)
      : undefined;
  }

  async listSources(): Promise<LocalSource[]> {
    const result = await this.database.query<JsonRow>(
      "SELECT id, value FROM blogbot_sources ORDER BY id"
    );
    return result.rows.map(({ id, value }) => {
      if (!id) {
        throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      }
      return this.openSource(value, id);
    });
  }

  async saveEntries(
    sourceId: string,
    entries: SourceFeedEntry[]
  ): Promise<number> {
    await this.getSource(sourceId);
    let inserted = 0;
    await this.database.transaction(async (transaction) => {
      for (const entry of entries) {
        const existing = await transaction.query<{ external_id: string }>(
          `SELECT external_id
             FROM blogbot_source_entries
            WHERE source_id = $1 AND external_id = $2`,
          [sourceId, entry.externalId]
        );
        if (!existing.rows[0]) {
          inserted += 1;
        }
        const stored: StoredSourceEntry = { sourceId, capturedAt: new Date().toISOString(), ...entry };
        await transaction.query(
          `INSERT INTO blogbot_source_entries (source_id, external_id, value)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (source_id, external_id)
           DO UPDATE SET value = EXCLUDED.value`,
          [
            sourceId,
            entry.externalId,
            JSON.stringify(
              this.protector.seal(
                stored,
                sourceEntryContext(sourceId, entry.externalId)
              )
            )
          ]
        );
      }
    });
    return inserted;
  }

  async listEntries(sourceId: string): Promise<StoredSourceEntry[]> {
    const result = await this.database.query<JsonRow>(
      `SELECT external_id, value
         FROM blogbot_source_entries
        WHERE source_id = $1
        ORDER BY external_id`,
      [sourceId]
    );
    return result.rows.map(({ external_id, value }) => this.openSourceEntryRow(sourceId, external_id, value));
  }

  async listEntriesBounded(sourceId: string, limit: number): Promise<StoredSourceEntry[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.database.query<JsonRow>(
      `SELECT external_id, value
         FROM blogbot_source_entries
        WHERE source_id = $1
        ORDER BY external_id DESC
        LIMIT $2`,
      [sourceId, safeLimit]
    );
    return result.rows.map(({ external_id, value }) => this.openSourceEntryRow(sourceId, external_id, value));
  }

  private openSourceEntryRow(sourceId: string, external_id: string | undefined, value: unknown): StoredSourceEntry {
      if (!external_id) {
        throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      }
      const entry = this.protector.open<StoredSourceEntry>(
        value,
        sourceEntryContext(sourceId, external_id)
      );
      if (entry.sourceId !== sourceId) {
        throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
      }
      // Capture timestamps are retention metadata, not editorial source data.
      // Keep the historical public shape stable while retaining the sealed value.
      const { capturedAt: _capturedAt, ...publicEntry } = entry;
      return publicEntry;
  }

  async purgeExpiredEntries(
    beforeIso: string,
    protectedSourceIds: readonly string[] = []
  ): Promise<number> {
    const cutoff = Date.parse(beforeIso);
    if (!Number.isFinite(cutoff)) throw new Error("INVALID_RETENTION_CUTOFF");
    const protectedIds = new Set(protectedSourceIds);
    const result = await this.database.query<{ source_id?: string; external_id?: string; value: unknown }>(
      `SELECT source_id, external_id, value FROM blogbot_source_entries`
    );
    const expired: Array<[string, string]> = [];
    for (const row of result.rows) {
      const sourceId = row.source_id;
      const externalId = row.external_id;
      if (!sourceId || !externalId || protectedIds.has(sourceId)) continue;
      const entry = this.protector.open<StoredSourceEntry>(
        row.value,
        sourceEntryContext(sourceId, externalId)
      );
      const captured = Date.parse(entry.capturedAt ?? "");
      if (Number.isFinite(captured) && captured < cutoff) expired.push([sourceId, externalId]);
    }
    if (expired.length === 0) return 0;
    await this.database.transaction(async (transaction) => {
      for (const [sourceId, externalId] of expired) {
        await transaction.query(
          `DELETE FROM blogbot_source_entries WHERE source_id = $1 AND external_id = $2`,
          [sourceId, externalId]
        );
      }
    });
    return expired.length;
  }

  async getSourceCapabilities(sourceId: string): Promise<SourceCapabilities> {
    return capabilitiesForSource(await this.getSource(sourceId));
  }

  async prepareScanBatch(
    batchKey: string,
    requestFingerprint: string,
    targets: SourceScanTarget[],
    createdAt: string
  ): Promise<LocalSourceScan[]> {
    const fingerprint = createHash("sha256")
      .update(requestFingerprint)
      .digest("hex");
    return this.database.transaction(async (transaction) => {
      const replay = await transaction.query<{
        request_fingerprint: string;
      }>(
        `SELECT request_fingerprint
           FROM blogbot_source_scan_requests
          WHERE idempotency_key = $1`,
        [batchKey]
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new Error(
            "IDEMPOTENCY_KEY_REUSED: scan batch key belongs to a different request"
          );
        }
        return this.readScanRuns(transaction, batchKey);
      }

      await transaction.query(
        `INSERT INTO blogbot_source_scan_requests (
           idempotency_key, request_fingerprint
         ) VALUES ($1, $2)`,
        [batchKey, fingerprint]
      );
      const scans: LocalSourceScan[] = [];
      for (const [ordinal, target] of targets.entries()) {
        const sourceResult = await transaction.query<JsonRow>(
          "SELECT id, value FROM blogbot_sources WHERE id = $1",
          [target.sourceId]
        );
        const sourceRow = sourceResult.rows[0];
        const source =
          sourceRow?.id && sourceRow.value
            ? this.openSource(sourceRow.value, sourceRow.id)
            : undefined;
        const capabilities = source
          ? capabilitiesForSource(source)
          : undefined;
        const rejection = !source
          ? {
              code: "SOURCE_NOT_FOUND",
              message: `Source ${target.sourceId} was not found`,
              retryable: false
            }
          : source.status !== "ACTIVE"
            ? {
                code: "SOURCE_DISABLED",
                message: `Source ${target.sourceId} is disabled`,
                retryable: false
              }
            : source.version !== target.expectedVersion
              ? {
                  code: "VERSION_CONFLICT",
                  message: `Source ${target.sourceId} changed from version ${target.expectedVersion} to ${source.version}`,
                  retryable: false
                }
              : undefined;
        const scan: LocalSourceScan = {
          id: sourceScanId(batchKey, target.sourceId),
          batchKey,
          ordinal,
          sourceId: target.sourceId,
          expectedVersion: target.expectedVersion,
          state: rejection ? "REJECTED" : "QUEUED",
          attempts: 0,
          entriesAdded: 0,
          publishEligible: capabilities?.canPublish ?? false,
          publishBlockers: capabilities?.blockers ?? [],
          createdAt,
          updatedAt: createdAt,
          ...(rejection
            ? { completedAt: createdAt, error: rejection }
            : {})
        };
        await transaction.query(
          `INSERT INTO blogbot_source_scans (
             id, batch_key, ordinal, source_id, state, value
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            scan.id,
            scan.batchKey,
            scan.ordinal,
            scan.sourceId,
            scan.state,
            JSON.stringify(
              this.protector.seal(scan, sourceScanContext(scan.id))
            )
          ]
        );
        scans.push(scan);
      }
      return scans;
    });
  }

  async listScanRuns(batchKey: string): Promise<LocalSourceScan[]> {
    return this.readScanRuns(this.database, batchKey);
  }

  async listRecoverableScanRuns(): Promise<LocalSourceScan[]> {
    const result = await this.database.query<JsonRow>(
      `SELECT id, value
         FROM blogbot_source_scans
        WHERE state IN ('QUEUED', 'RUNNING')
        ORDER BY batch_key, ordinal`
    );
    return result.rows.map(({ id, value }) => {
      if (!id) {
        throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      }
      return this.openScan(value, id);
    });
  }

  async attachScanJob(
    scanId: string,
    queueJobId: string,
    updatedAt: string
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const scan = await this.readScan(transaction, scanId);
      if (!scan || scan.state === "REJECTED" || scan.state === "SUCCEEDED") {
        return;
      }
      await this.writeScan(transaction, {
        ...scan,
        queueJobId,
        updatedAt
      });
    });
  }

  async markScanRunning(
    scanId: string,
    startedAt: string
  ): Promise<LocalSourceScan> {
    return this.database.transaction(async (transaction) => {
      const scan = await this.requireScan(transaction, scanId);
      if (scan.state === "SUCCEEDED" || scan.state === "REJECTED") {
        return scan;
      }
      const running: LocalSourceScan = {
        ...scan,
        state: "RUNNING",
        attempts: scan.attempts + 1,
        startedAt,
        updatedAt: startedAt
      };
      delete running.completedAt;
      delete running.error;
      await this.writeScan(transaction, running);
      return running;
    });
  }

  async completeSourceScan(
    scanId: string,
    input: CompletedSourceScanInput
  ): Promise<LocalSourceScan> {
    return this.database.transaction(async (transaction) => {
      const scan = await this.requireScan(transaction, scanId);
      if (scan.state === "SUCCEEDED") {
        return scan;
      }
      if (scan.state === "REJECTED") {
        throw new SourceRepositoryError(
          "VERSION_CONFLICT",
          `Rejected scan ${scanId} cannot be completed`
        );
      }
      const sourceRow = await transaction.query<JsonRow>(
        "SELECT id, value FROM blogbot_sources WHERE id = $1",
        [scan.sourceId]
      );
      const row = sourceRow.rows[0];
      if (!row?.id || !row.value) {
        throw new SourceRepositoryError(
          "SOURCE_NOT_FOUND",
          `Source ${scan.sourceId} was not found`
        );
      }
      const source = this.openSource(row.value, row.id);
      if (source.version !== scan.expectedVersion) {
        throw new SourceRepositoryError(
          "VERSION_CONFLICT",
          `Source ${source.id} changed from version ${scan.expectedVersion} to ${source.version}`
        );
      }
      const updated: LocalSource = {
        ...source,
        kind: input.kind,
        discoveredFeeds: input.discoveredFeeds,
        updatedAt: input.completedAt,
        version: source.version + 1,
        ...(input.title ? { title: input.title } : {}),
        lastTest: {
          testedAt: input.completedAt,
          finalUrl: input.finalUrl,
          contentType: input.contentType,
          entryCount: input.entries.length
        }
      };
      await transaction.query(
        `UPDATE blogbot_sources
            SET version = $2, value = $3::jsonb
          WHERE id = $1`,
        [
          updated.id,
          updated.version,
          JSON.stringify(
            this.protector.seal(updated, sourceContext(updated.id))
          )
        ]
      );

      let entriesAdded = 0;
      for (const entry of input.entries) {
        const existing = await transaction.query<{ external_id: string }>(
          `SELECT external_id
             FROM blogbot_source_entries
            WHERE source_id = $1 AND external_id = $2`,
          [source.id, entry.externalId]
        );
        if (!existing.rows[0]) {
          entriesAdded += 1;
        }
        const stored: StoredSourceEntry = { sourceId: source.id, capturedAt: input.completedAt, ...entry };
        await transaction.query(
          `INSERT INTO blogbot_source_entries (source_id, external_id, value)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (source_id, external_id)
           DO UPDATE SET value = EXCLUDED.value`,
          [
            source.id,
            entry.externalId,
            JSON.stringify(
              this.protector.seal(
                stored,
                sourceEntryContext(source.id, entry.externalId)
              )
            )
          ]
        );
      }
      const completed: LocalSourceScan = {
        ...scan,
        state: "SUCCEEDED",
        entriesAdded,
        updatedAt: input.completedAt,
        completedAt: input.completedAt
      };
      delete completed.error;
      await this.writeScan(transaction, completed);
      return completed;
    });
  }

  async failSourceScan(
    scanId: string,
    error: SourceScanError,
    completedAt: string
  ): Promise<LocalSourceScan> {
    return this.database.transaction(async (transaction) => {
      const scan = await this.requireScan(transaction, scanId);
      if (scan.state === "SUCCEEDED" || scan.state === "REJECTED") {
        return scan;
      }
      const failed: LocalSourceScan = {
        ...scan,
        state: "FAILED",
        updatedAt: completedAt,
        completedAt,
        error
      };
      await this.writeScan(transaction, failed);
      return failed;
    });
  }

  private async findSourceById(
    sourceId: string
  ): Promise<LocalSource | undefined> {
    const result = await this.database.query<JsonRow>(
      "SELECT id, value FROM blogbot_sources WHERE id = $1",
      [sourceId]
    );
    const value = result.rows[0]?.value;
    return value ? this.openSource(value, sourceId) : undefined;
  }

  private async readScanRuns(
    client: Pick<PGlite, "query">,
    batchKey: string
  ): Promise<LocalSourceScan[]> {
    const result = await client.query<JsonRow>(
      `SELECT id, value
         FROM blogbot_source_scans
        WHERE batch_key = $1
        ORDER BY ordinal`,
      [batchKey]
    );
    return result.rows.map(({ id, value }) => {
      if (!id) {
        throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      }
      return this.openScan(value, id);
    });
  }

  private async readScan(
    client: Pick<PGlite, "query">,
    scanId: string
  ): Promise<LocalSourceScan | undefined> {
    const result = await client.query<JsonRow>(
      "SELECT id, value FROM blogbot_source_scans WHERE id = $1",
      [scanId]
    );
    const row = result.rows[0];
    return row?.id && row.value ? this.openScan(row.value, row.id) : undefined;
  }

  private async requireScan(
    client: Pick<PGlite, "query">,
    scanId: string
  ): Promise<LocalSourceScan> {
    const scan = await this.readScan(client, scanId);
    if (!scan) {
      throw new Error(`SOURCE_SCAN_NOT_FOUND: ${scanId}`);
    }
    return scan;
  }

  private async writeScan(
    client: Pick<PGlite, "query">,
    scan: LocalSourceScan
  ): Promise<void> {
    await client.query(
      `UPDATE blogbot_source_scans
          SET state = $2, value = $3::jsonb
        WHERE id = $1`,
      [
        scan.id,
        scan.state,
        JSON.stringify(this.protector.seal(scan, sourceScanContext(scan.id)))
      ]
    );
  }

  private openSource(
    value: unknown,
    expectedId: string,
    context?: ReturnType<typeof sourceContext>
  ): LocalSource {
    const source = this.protector.open<LocalSource>(
      value,
      context ?? sourceContext(expectedId)
    );
    if (source.id !== expectedId) {
      throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
    }
    return source;
  }

  private openScan(value: unknown, expectedId: string): LocalSourceScan {
    const scan = this.protector.open<LocalSourceScan>(
      value,
      sourceScanContext(expectedId)
    );
    if (scan.id !== expectedId) {
      throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
    }
    return scan;
  }
}

async function encryptLegacySourceRows(
  database: PGlite,
  protector: JsonProtector
): Promise<void> {
  await database.transaction(async (transaction) => {
    const migration = await transaction.query<{ version: number }>(
      "SELECT version FROM blogbot_encryption_migrations WHERE scope = 'sources'"
    );
    const appliedVersion = migration.rows[0]?.version;
    if (appliedVersion !== undefined && appliedVersion !== 2) {
      throw new Error(
        `LOCAL_ENCRYPTION_MIGRATION_UNSUPPORTED: sources version ${appliedVersion}`
      );
    }
    const sources = await transaction.query<{ id: string; value: unknown }>(
      "SELECT id, value FROM blogbot_sources"
    );
    for (const row of sources.rows) {
      if (appliedVersion === 2) {
        const source = protector.open<LocalSource>(
          row.value,
          sourceContext(row.id)
        );
        if (source.id !== row.id) {
          throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
        }
      } else {
        const plaintext = protector.openLegacy<LocalSource>(row.value);
        await transaction.query(
          "UPDATE blogbot_sources SET value = $2::jsonb WHERE id = $1",
          [
            row.id,
            JSON.stringify(protector.seal(plaintext, sourceContext(row.id)))
          ]
        );
      }
    }

    const entries = await transaction.query<{
      source_id: string;
      external_id: string;
      value: unknown;
    }>(
      "SELECT source_id, external_id, value FROM blogbot_source_entries"
    );
    for (const row of entries.rows) {
      if (appliedVersion === 2) {
        const entry = protector.open<StoredSourceEntry>(
          row.value,
          sourceEntryContext(row.source_id, row.external_id)
        );
        if (
          entry.sourceId !== row.source_id ||
          entry.externalId !== row.external_id
        ) {
          throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
        }
      } else {
        const plaintext = protector.openLegacy<StoredSourceEntry>(row.value);
        await transaction.query(
          `UPDATE blogbot_source_entries
              SET value = $3::jsonb
            WHERE source_id = $1 AND external_id = $2`,
          [
            row.source_id,
            row.external_id,
            JSON.stringify(
              protector.seal(
                plaintext,
                sourceEntryContext(row.source_id, row.external_id)
              )
            )
          ]
        );
      }
    }

    const idempotency = await transaction.query<{
      idempotency_key: string;
      request_fingerprint: string;
      response_json: unknown;
    }>(
      "SELECT idempotency_key, request_fingerprint, response_json FROM blogbot_source_idempotency"
    );
    for (const row of idempotency.rows) {
      if (
        appliedVersion === 2 &&
        !/^[a-f0-9]{64}$/u.test(row.request_fingerprint)
      ) {
        throw new Error("LOCAL_IDEMPOTENCY_FINGERPRINT_INVALID");
      }
      const fingerprint = /^[a-f0-9]{64}$/u.test(row.request_fingerprint)
        ? row.request_fingerprint
        : createHash("sha256").update(row.request_fingerprint).digest("hex");
      const needsReseal = appliedVersion !== 2;
      if (appliedVersion === 2) {
        protector.open<LocalSource>(
          row.response_json,
          sourceIdempotencyContext(row.idempotency_key)
        );
      }
      if (needsReseal) {
        const responseJson = needsReseal
          ? protector.seal(
              protector.openLegacy<LocalSource>(row.response_json),
              sourceIdempotencyContext(row.idempotency_key)
            )
          : row.response_json;
        await transaction.query(
          `UPDATE blogbot_source_idempotency
              SET request_fingerprint = $2,
                  response_json = $3::jsonb
            WHERE idempotency_key = $1`,
          [
            row.idempotency_key,
            fingerprint,
            JSON.stringify(responseJson)
          ]
        );
      }
    }

    const scanRequests = await transaction.query<{
      request_fingerprint: string;
    }>(
      "SELECT request_fingerprint FROM blogbot_source_scan_requests"
    );
    for (const row of scanRequests.rows) {
      if (!/^[a-f0-9]{64}$/u.test(row.request_fingerprint)) {
        throw new Error("LOCAL_IDEMPOTENCY_FINGERPRINT_INVALID");
      }
    }

    const scans = await transaction.query<{
      id: string;
      value: unknown;
    }>("SELECT id, value FROM blogbot_source_scans");
    for (const row of scans.rows) {
      const scan = protector.open<LocalSourceScan>(
        row.value,
        sourceScanContext(row.id)
      );
      if (scan.id !== row.id) {
        throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
      }
    }

    if (appliedVersion === undefined) {
      await transaction.query(
        `INSERT INTO blogbot_encryption_migrations (scope, version)
         VALUES ('sources', 2)`
      );
    }
  });
}

function sourceContext(id: string) {
  return { table: "blogbot_sources", key: id, field: "value" };
}

function sourceEntryContext(sourceId: string, externalId: string) {
  return {
    table: "blogbot_source_entries",
    key: `${sourceId}\u0000${externalId}`,
    field: "value"
  };
}

function sourceIdempotencyContext(idempotencyKey: string) {
  return {
    table: "blogbot_source_idempotency",
    key: idempotencyKey,
    field: "response_json"
  };
}

function sourceScanContext(scanId: string) {
  return {
    table: "blogbot_source_scans",
    key: scanId,
    field: "value"
  };
}

function sourceScanId(batchKey: string, sourceId: string): string {
  return `scan-${createHash("sha256")
    .update(batchKey)
    .update("\u0000")
    .update(sourceId)
    .digest("hex")
    .slice(0, 32)}`;
}

function capabilitiesForSource(source: LocalSource): SourceCapabilities {
  const blockers: SourceCapabilities["blockers"] = [];
  if (source.status === "DISABLED") {
    blockers.push("SOURCE_DISABLED");
  }
  if (source.trustStatus === "PENDING") {
    blockers.push("TRUST_REVIEW_REQUIRED");
  } else if (source.trustStatus === "REJECTED") {
    blockers.push("TRUST_REJECTED");
  }
  if (source.rightsStatus === "PENDING") {
    blockers.push("RIGHTS_REVIEW_REQUIRED");
  } else if (source.rightsStatus === "REJECTED") {
    blockers.push("RIGHTS_REJECTED");
  }
  return {
    canScan: source.status === "ACTIVE",
    canPublish: source.status === "ACTIVE" && blockers.length === 0,
    blockers
  };
}
