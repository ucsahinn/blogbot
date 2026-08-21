import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";

import { canonicalJson } from "../../editorial/src/revision.ts";
import {
  isEncryptedEnvelopeV2,
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
  /** Content-addressed immutable version of this source entry. */
  contentHash?: string;
  /** Stable opaque key for audit references to this exact captured version. */
  versionId?: string;
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
  /**
   * Return the newest durable entry timestamp for each source in one indexed
   * projection. The desktop catalog uses this as a freshness hint and must not
   * fan out one encrypted-feed read per source during bootstrap.
   */
  listLatestEntryDates?(): Promise<Map<string, string | null>>;
  /** Read the newest entries across the catalog for the desktop candidate projection. */
  listRecentEntriesBounded(limit: number): Promise<StoredSourceEntry[]>;
  /** Read immutable historical captures for an exact external source identity. */
  listEntryVersions(sourceId: string, externalId: string): Promise<StoredSourceEntry[]>;
  /** Indexed lookup for the one selected candidate URL used during drafting. */
  findEntryByUrl?(sourceId: string, url: string): Promise<StoredSourceEntry | undefined>;
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
  markScanRunning(scanId: string, startedAt: string): Promise<{ claimed: boolean; scan: LocalSourceScan }>;
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
  source_id?: string;
  external_id?: string;
  content_hash?: string;
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
  sort_at timestamptz NOT NULL DEFAULT now(),
  value jsonb NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

ALTER TABLE blogbot_source_entries
  ADD COLUMN IF NOT EXISTS sort_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS blogbot_source_entries_recent_idx
  ON blogbot_source_entries (source_id, sort_at DESC, external_id DESC);

CREATE TABLE IF NOT EXISTS blogbot_source_entry_versions (
  source_id text NOT NULL REFERENCES blogbot_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  content_hash text NOT NULL,
  entry_url text NOT NULL,
  sort_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (source_id, external_id, content_hash)
);

ALTER TABLE blogbot_source_entry_versions
  ADD COLUMN IF NOT EXISTS entry_url text;

CREATE INDEX IF NOT EXISTS blogbot_source_entry_versions_recent_idx
  ON blogbot_source_entry_versions (source_id, sort_at DESC, external_id DESC, content_hash DESC);

CREATE INDEX IF NOT EXISTS blogbot_source_entry_versions_global_recent_idx
  ON blogbot_source_entry_versions (sort_at DESC, source_id, external_id DESC, content_hash DESC);

CREATE INDEX IF NOT EXISTS blogbot_source_entry_versions_url_idx
  ON blogbot_source_entry_versions (source_id, entry_url, sort_at DESC, content_hash DESC);

CREATE TABLE IF NOT EXISTS blogbot_source_entry_latest (
  source_id text NOT NULL,
  external_id text NOT NULL,
  content_hash text NOT NULL,
  PRIMARY KEY (source_id, external_id),
  FOREIGN KEY (source_id, external_id, content_hash)
    REFERENCES blogbot_source_entry_versions (source_id, external_id, content_hash)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blogbot_source_schema_migrations (
  scope text PRIMARY KEY,
  version integer NOT NULL
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

CREATE TABLE IF NOT EXISTS blogbot_encryption_migration_progress (
  scope text NOT NULL,
  table_name text NOT NULL,
  last_key text NOT NULL,
  PRIMARY KEY (scope, table_name)
);

CREATE INDEX IF NOT EXISTS blogbot_source_entry_versions_expiry_idx
  ON blogbot_source_entry_versions (captured_at, source_id, external_id, content_hash);

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

// Keep an interactive PGlite read from waiting behind hundreds of individual
// source-entry statements in a single scan transaction.
const SOURCE_ENTRY_WRITE_BATCH_SIZE = 32;

// Retention and the legacy migrations walk the whole version ledger, which on a
// long-running workspace is far larger than anything that may sit in memory or
// in one transaction at once.
const SOURCE_ENTRY_PURGE_PAGE_SIZE = 200;
const SOURCE_MIGRATION_PAGE_SIZE = 200;

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
    await migrateSourceEntryVersions(database, protector);
    return new PGliteSourceRepository(database, protector);
  }

  static async fromDatabase(database: PGlite): Promise<PGliteSourceRepository> {
    await database.exec(SOURCE_SCHEMA_SQL);
    const protector = JsonProtector.fromEnvironment();
    await encryptLegacySourceRows(database, protector);
    await migrateSourceEntryVersions(database, protector);
    return new PGliteSourceRepository(database, protector);
  }

  /** Explicit, potentially expensive full encrypted-row integrity check. */
  async verifyEncryptionIntegrity(): Promise<void> {
    await encryptLegacySourceRows(this.database, this.protector, true);
    await verifySourceEntryVersions(this.database, this.protector);
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
      const updated = await this.database.query<{ id: string }>(
        `UPDATE blogbot_sources
            SET url = $2, version = $3, value = $4::jsonb
          WHERE id = $1 AND version = $5
          RETURNING id`,
        [
          source.id,
          source.url,
          source.version,
          JSON.stringify(this.protector.seal(source, sourceContext(source.id))),
          existing.version
        ]
      );
      if (updated.rows.length !== 1) {
        throw new SourceRepositoryError(
          "VERSION_CONFLICT",
          `Source ${source.id} changed before version ${existing.version} could be saved`
        );
      }
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
        const updated = await transaction.query<{ id: string }>(
          `UPDATE blogbot_sources
              SET url = $2, version = $3, value = $4::jsonb
            WHERE id = $1 AND version = $5
            RETURNING id`,
          [
            source.id,
            source.url,
            source.version,
            JSON.stringify(this.protector.seal(source, sourceContext(source.id))),
            current.version
          ]
        );
        if (updated.rows.length !== 1) {
          throw new SourceRepositoryError(
            "VERSION_CONFLICT",
            `Source ${source.id} changed before version ${current.version} could be saved`
          );
        }
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
      inserted = await this.writeSourceEntries(transaction, sourceId, entries, new Date().toISOString());
    });
    return inserted;
  }

  async listEntries(sourceId: string): Promise<StoredSourceEntry[]> {
    const result = await this.database.query<JsonRow>(
      `SELECT versions.external_id, versions.content_hash, versions.value
         FROM blogbot_source_entry_versions AS versions
         JOIN blogbot_source_entry_latest AS latest
           ON latest.source_id = versions.source_id
          AND latest.external_id = versions.external_id
          AND latest.content_hash = versions.content_hash
        WHERE versions.source_id = $1
        ORDER BY external_id`,
      [sourceId]
    );
    return result.rows.map(({ external_id, content_hash, value }) => this.openSourceEntryRow(sourceId, external_id, content_hash, value));
  }

  async listEntriesBounded(sourceId: string, limit: number): Promise<StoredSourceEntry[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.database.query<JsonRow>(
      `SELECT versions.external_id, versions.content_hash, versions.value
         FROM blogbot_source_entry_versions AS versions
         JOIN blogbot_source_entry_latest AS latest
           ON latest.source_id = versions.source_id
          AND latest.external_id = versions.external_id
          AND latest.content_hash = versions.content_hash
        WHERE versions.source_id = $1
        ORDER BY versions.sort_at DESC, versions.external_id DESC, versions.content_hash DESC
        LIMIT $2`,
      [sourceId, safeLimit]
    );
    return result.rows.map(({ external_id, content_hash, value }) => this.openSourceEntryRow(sourceId, external_id, content_hash, value));
  }

  async listLatestEntryDates(): Promise<Map<string, string | null>> {
    const result = await this.database.query<{
      source_id?: string;
      last_item_at?: string | Date | null;
    }>(
      `SELECT versions.source_id, MAX(versions.sort_at) AS last_item_at
         FROM blogbot_source_entry_versions AS versions
         JOIN blogbot_source_entry_latest AS latest
           ON latest.source_id = versions.source_id
          AND latest.external_id = versions.external_id
          AND latest.content_hash = versions.content_hash
        GROUP BY versions.source_id`
    );
    return new Map(
      result.rows.flatMap((row) => {
        if (!row.source_id) return [];
        const value = row.last_item_at;
        const parsed = value instanceof Date ? value.toISOString() : value ?? null;
        return [[row.source_id, parsed] as const];
      })
    );
  }

  async listRecentEntriesBounded(limit: number): Promise<StoredSourceEntry[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const result = await this.database.query<JsonRow>(
      `SELECT versions.source_id, versions.external_id, versions.content_hash, versions.value
         FROM blogbot_source_entry_versions AS versions
         JOIN blogbot_source_entry_latest AS latest
           ON latest.source_id = versions.source_id
          AND latest.external_id = versions.external_id
          AND latest.content_hash = versions.content_hash
        ORDER BY versions.sort_at DESC, versions.source_id, versions.external_id DESC, versions.content_hash DESC
        LIMIT $1`,
      [safeLimit]
    );
    return result.rows.map(({ source_id, external_id, content_hash, value }) => {
      if (!source_id) throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      return this.openSourceEntryRow(source_id, external_id, content_hash, value);
    });
  }

  async listEntryVersions(sourceId: string, externalId: string): Promise<StoredSourceEntry[]> {
    const result = await this.database.query<JsonRow>(
      `SELECT external_id, content_hash, value
         FROM blogbot_source_entry_versions
        WHERE source_id = $1 AND external_id = $2
        ORDER BY content_hash`,
      [sourceId, externalId]
    );
    return result.rows.map(({ external_id, content_hash, value }) =>
      this.openSourceEntryRow(sourceId, external_id, content_hash, value)
    );
  }

  async findEntryByUrl(sourceId: string, url: string): Promise<StoredSourceEntry | undefined> {
    const result = await this.database.query<JsonRow>(
      `SELECT versions.external_id, versions.content_hash, versions.value
         FROM blogbot_source_entry_versions AS versions
         JOIN blogbot_source_entry_latest AS latest
           ON latest.source_id = versions.source_id
          AND latest.external_id = versions.external_id
          AND latest.content_hash = versions.content_hash
        WHERE versions.source_id = $1 AND versions.entry_url = $2
        ORDER BY versions.sort_at DESC, versions.content_hash DESC
        LIMIT 1`,
      [sourceId, url]
    );
    const row = result.rows[0];
    return row ? this.openSourceEntryRow(sourceId, row.external_id, row.content_hash, row.value) : undefined;
  }

  private openSourceEntryRow(sourceId: string, external_id: string | undefined, content_hash: string | undefined, value: unknown): StoredSourceEntry {
      if (!external_id || !content_hash || !/^[a-f0-9]{64}$/u.test(content_hash)) {
        throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      }
      const entry = this.protector.open<StoredSourceEntry>(
        value,
        sourceEntryVersionContext(sourceId, external_id, content_hash)
      );
      if (
        entry.sourceId !== sourceId ||
        entry.externalId !== external_id ||
        entry.contentHash !== content_hash ||
        entry.versionId !== sourceEntryVersionId(sourceId, external_id, content_hash) ||
        sourceEntryVersionContentHash(sourceId, entry) !== content_hash
      ) {
        throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
      }
      return entry;
  }

  /**
   * Retention over the append-only version ledger. The expiry predicate runs in
   * SQL against the plaintext `captured_at` column and protection is derived
   * from the three key columns alone, so a purge never opens an envelope: the
   * previous shape loaded and decrypted every historical capture of every entry
   * at once, blocking the single PGlite gate for the whole sweep.
   */
  async purgeExpiredEntries(
    beforeIso: string,
    protectedSourceIds: readonly string[] = []
  ): Promise<number> {
    if (!Number.isFinite(Date.parse(beforeIso))) throw new Error("INVALID_RETENTION_CUTOFF");
    const protectedIds = new Set(protectedSourceIds);
    let purged = 0;
    let cursor = { capturedAt: "-infinity", sourceId: "", externalId: "", contentHash: "" };
    for (;;) {
      const page = await this.database.query<{
        source_id?: string;
        external_id?: string;
        content_hash?: string;
        captured_at?: string | Date;
      }>(
        `SELECT source_id, external_id, content_hash, captured_at
           FROM blogbot_source_entry_versions
          WHERE captured_at < $1::timestamptz
            AND (captured_at, source_id, external_id, content_hash)
                > ($2::timestamptz, $3, $4, $5)
          ORDER BY captured_at, source_id, external_id, content_hash
          LIMIT $6`,
        [
          beforeIso,
          cursor.capturedAt,
          cursor.sourceId,
          cursor.externalId,
          cursor.contentHash,
          SOURCE_ENTRY_PURGE_PAGE_SIZE
        ]
      );
      if (page.rows.length === 0) break;
      const last = page.rows[page.rows.length - 1]!;
      const expired = page.rows.flatMap((row) => {
        const { source_id: sourceId, external_id: externalId, content_hash: contentHash } = row;
        if (!sourceId || !externalId || !contentHash) return [];
        if (protectedIds.has(sourceId)) return [];
        // The version id is a pure function of the three key columns, so an
        // approved revision's cited evidence is recognised without decrypting.
        if (protectedIds.has(sourceEntryVersionId(sourceId, externalId, contentHash))) return [];
        return [[sourceId, externalId, contentHash] as const];
      });
      if (expired.length > 0) {
        await this.database.transaction(async (transaction) => {
          for (const [sourceId, externalId, contentHash] of expired) {
            await transaction.query(
              `DELETE FROM blogbot_source_entry_versions
                WHERE source_id = $1 AND external_id = $2 AND content_hash = $3`,
              [sourceId, externalId, contentHash]
            );
          }
          for (const [sourceId, externalId] of new Map(
            expired.map(([sourceId, externalId]) => [JSON.stringify([sourceId, externalId]), [sourceId, externalId] as const])
          ).values()) {
            await repointLatestSourceEntry(transaction, sourceId, externalId);
          }
        });
        purged += expired.length;
      }
      // The cursor advances past protected rows too, which still match the
      // expiry predicate and would otherwise be re-read forever.
      cursor = {
        capturedAt: last.captured_at instanceof Date
          ? last.captured_at.toISOString()
          : String(last.captured_at),
        sourceId: last.source_id ?? "",
        externalId: last.external_id ?? "",
        contentHash: last.content_hash ?? ""
      };
    }
    return purged;
  }

  async getSourceCapabilities(sourceId: string): Promise<SourceCapabilities> {
    return sourceCapabilitiesFor(await this.getSource(sourceId));
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
          ? sourceCapabilitiesFor(source)
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
  ): Promise<{ claimed: boolean; scan: LocalSourceScan }> {
    return this.database.transaction(async (transaction) => {
      const scan = await this.requireScan(transaction, scanId);
      if (scan.state === "SUCCEEDED" || scan.state === "REJECTED") {
        return { claimed: false, scan };
      }
      if (scan.state !== "QUEUED") return { claimed: false, scan };
      const running: LocalSourceScan = {
        ...scan,
        state: "RUNNING",
        attempts: scan.attempts + 1,
        startedAt,
        updatedAt: startedAt
      };
      delete running.completedAt;
      delete running.error;
      const updated = await transaction.query<{ id: string }>(
        `UPDATE blogbot_source_scans
            SET state = $2, value = $3::jsonb
          WHERE id = $1 AND state = 'QUEUED'
          RETURNING id`,
        [
          running.id,
          running.state,
          JSON.stringify(this.protector.seal(running, sourceScanContext(running.id)))
        ]
      );
      if (updated.rows.length === 1) return { claimed: true, scan: running };
      return { claimed: false, scan: await this.requireScan(transaction, scanId) };
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
      const saved = await transaction.query<{ id: string }>(
        `UPDATE blogbot_sources
            SET version = $2, value = $3::jsonb
          WHERE id = $1 AND version = $4
          RETURNING id`,
        [
          updated.id,
          updated.version,
          JSON.stringify(
            this.protector.seal(updated, sourceContext(updated.id))
          ),
          source.version
        ]
      );
      if (saved.rows.length !== 1) {
        throw new SourceRepositoryError(
          "VERSION_CONFLICT",
          `Source ${source.id} changed before scan ${scanId} could be completed`
        );
      }

      const entriesAdded = await this.writeSourceEntries(
        transaction,
        source.id,
        input.entries,
        input.completedAt
      );
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
      // completedAt has to be settled before the row is written: a retryable
      // failure re-queues the scan and must not inherit a completion stamp from
      // an earlier terminal attempt, and a terminal failure must persist the
      // same completion the caller is told about. Writing first left the durable
      // row disagreeing with the returned value forever.
      const failed: LocalSourceScan = {
        ...scan,
        state: error.retryable ? "QUEUED" : "FAILED",
        updatedAt: completedAt,
        error,
        ...(error.retryable ? {} : { completedAt })
      };
      if (error.retryable) {
        delete failed.completedAt;
      }
      await this.writeScan(transaction, failed);
      return failed;
    });
  }

  private async writeSourceEntries(
    client: Pick<PGlite, "query">,
    sourceId: string,
    entries: readonly SourceFeedEntry[],
    capturedAt: string
  ): Promise<number> {
    let inserted = 0;
    for (let offset = 0; offset < entries.length; offset += SOURCE_ENTRY_WRITE_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + SOURCE_ENTRY_WRITE_BATCH_SIZE).map((entry) => {
        const contentHash = sourceEntryVersionContentHash(sourceId, entry);
        const stored: StoredSourceEntry = {
          sourceId,
          capturedAt,
          contentHash,
          versionId: sourceEntryVersionId(sourceId, entry.externalId, contentHash),
          ...entry
        };
        return {
          externalId: entry.externalId,
          contentHash,
          url: entry.url,
          sortAt: normalizedEntrySortAt(entry.publishedAt, capturedAt),
          value: JSON.stringify(
            this.protector.seal(
              stored,
              sourceEntryVersionContext(sourceId, entry.externalId, contentHash)
            )
          )
        };
      });
      if (batch.length === 0) continue;
      const insertedRows = await client.query<{ external_id: string }>(
        `INSERT INTO blogbot_source_entry_versions (
           source_id, external_id, content_hash, entry_url, sort_at, captured_at, value
         ) VALUES ${sqlValuesPlaceholders(batch.length, 7)}
         ON CONFLICT (source_id, external_id, content_hash) DO NOTHING
         RETURNING external_id`,
        batch.flatMap((entry) => [
          sourceId,
          entry.externalId,
          entry.contentHash,
          entry.url,
          entry.sortAt,
          capturedAt,
          entry.value
        ])
      );
      inserted += insertedRows.rows.length;
      const latest = [...new Map(batch.map((entry) => [entry.externalId, entry])).values()];
      await client.query(
        `INSERT INTO blogbot_source_entry_latest (source_id, external_id, content_hash)
         VALUES ${sqlValuesPlaceholders(latest.length, 3)}
         ON CONFLICT (source_id, external_id)
         DO UPDATE SET content_hash = EXCLUDED.content_hash`,
        latest.flatMap((entry) => [sourceId, entry.externalId, entry.contentHash])
      );
    }
    return inserted;
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

/**
 * Rewrites pre-v2 rows into identity-bound envelopes, or re-opens every sealed
 * row for an operator-requested integrity pass.
 *
 * Each table is walked with a keyset cursor and committed page by page, and the
 * last completed key is recorded beside the scope so an interrupted upgrade
 * resumes instead of restarting: a workspace with months of captured feed
 * entries cannot hold its whole decrypted ledger in one transaction, and a
 * migration that dies at row zero on every launch never becomes ready.
 */
async function encryptLegacySourceRows(
  database: PGlite,
  protector: JsonProtector,
  verifyCompleted = false
): Promise<void> {
  const migration = await database.query<{ version: number }>(
    "SELECT version FROM blogbot_encryption_migrations WHERE scope = 'sources'"
  );
  const appliedVersion = migration.rows[0]?.version;
  if (appliedVersion !== undefined && appliedVersion !== 2) {
    throw new Error(
      `LOCAL_ENCRYPTION_MIGRATION_UNSUPPORTED: sources version ${appliedVersion}`
    );
  }
  // Normal startup trusts the completed migration sentinel. A full decrypt
  // sweep remains available through verifyEncryptionIntegrity() for an
  // operator-initiated diagnostics pass.
  if (appliedVersion === 2 && !verifyCompleted) return;
  const reseal = appliedVersion === undefined;

  for (
    let cursor = reseal ? await readSourceMigrationProgress(database, "blogbot_sources") : "";
    ;
  ) {
    const sources = await database.query<{ id: string; value: unknown }>(
      `SELECT id, value FROM blogbot_sources
        WHERE id > $1 ORDER BY id LIMIT $2`,
      [cursor, SOURCE_MIGRATION_PAGE_SIZE]
    );
    if (sources.rows.length === 0) break;
    const lastKey = sources.rows[sources.rows.length - 1]!.id;
    await database.transaction(async (transaction) => {
      for (const row of sources.rows) {
        // Verifying a row an earlier attempt already sealed is strictly stronger
        // than resealing it, and it stops a resumed migration from failing on
        // its own committed work.
        if (!reseal || isEncryptedEnvelopeV2(row.value)) {
          const source = protector.open<LocalSource>(row.value, sourceContext(row.id));
          if (source.id !== row.id) {
            throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
          }
          continue;
        }
        const plaintext = protector.openLegacy<LocalSource>(
          row.value,
          (candidate) =>
            isLegacySourceRecord(candidate) &&
            candidate.id === row.id &&
            typeof candidate.url === "string" &&
            typeof candidate.status === "string"
        );
        await transaction.query(
          "UPDATE blogbot_sources SET value = $2::jsonb WHERE id = $1",
          [
            row.id,
            JSON.stringify(protector.seal(plaintext, sourceContext(row.id)))
          ]
        );
      }
      if (reseal) {
        await writeSourceMigrationProgress(transaction, "blogbot_sources", lastKey);
      }
    });
    cursor = lastKey;
    if (reseal) reportSourceMigrationProgress("blogbot_sources", cursor);
  }

  for (
    let cursor = splitEntryKey(
      reseal ? await readSourceMigrationProgress(database, "blogbot_source_entries") : ""
    );
    ;
  ) {
    const entries = await database.query<{
      source_id: string;
      external_id: string;
      value: unknown;
    }>(
      `SELECT source_id, external_id, value FROM blogbot_source_entries
        WHERE (source_id, external_id) > ($1, $2)
        ORDER BY source_id, external_id
        LIMIT $3`,
      [cursor[0], cursor[1], SOURCE_MIGRATION_PAGE_SIZE]
    );
    if (entries.rows.length === 0) break;
    const last = entries.rows[entries.rows.length - 1]!;
    await database.transaction(async (transaction) => {
      for (const row of entries.rows) {
        if (!reseal || isEncryptedEnvelopeV2(row.value)) {
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
          continue;
        }
        const plaintext = protector.openLegacy<StoredSourceEntry>(
          row.value,
          (candidate) =>
            isLegacySourceRecord(candidate) &&
            candidate.sourceId === row.source_id &&
            candidate.externalId === row.external_id &&
            typeof candidate.url === "string"
        );
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
      if (reseal) {
        await writeSourceMigrationProgress(
          transaction,
          "blogbot_source_entries",
          JSON.stringify([last.source_id, last.external_id])
        );
      }
    });
    cursor = [last.source_id, last.external_id];
    if (reseal) reportSourceMigrationProgress("blogbot_source_entries", cursor.join("/"));
  }

  for (
    let cursor = reseal
      ? await readSourceMigrationProgress(database, "blogbot_source_idempotency")
      : "";
    ;
  ) {
    const idempotency = await database.query<{
      idempotency_key: string;
      request_fingerprint: string;
      response_json: unknown;
    }>(
      `SELECT idempotency_key, request_fingerprint, response_json
         FROM blogbot_source_idempotency
        WHERE idempotency_key > $1
        ORDER BY idempotency_key
        LIMIT $2`,
      [cursor, SOURCE_MIGRATION_PAGE_SIZE]
    );
    if (idempotency.rows.length === 0) break;
    const lastKey = idempotency.rows[idempotency.rows.length - 1]!.idempotency_key;
    await database.transaction(async (transaction) => {
      for (const row of idempotency.rows) {
        if (!reseal || isEncryptedEnvelopeV2(row.response_json)) {
          if (!/^[a-f0-9]{64}$/u.test(row.request_fingerprint)) {
            throw new Error("LOCAL_IDEMPOTENCY_FINGERPRINT_INVALID");
          }
          protector.open<LocalSource>(
            row.response_json,
            sourceIdempotencyContext(row.idempotency_key)
          );
          continue;
        }
        const fingerprint = /^[a-f0-9]{64}$/u.test(row.request_fingerprint)
          ? row.request_fingerprint
          : createHash("sha256").update(row.request_fingerprint).digest("hex");
        const plaintext = protector.openLegacy<LocalSource>(
          row.response_json,
          (candidate) =>
            isLegacySourceRecord(candidate) &&
            typeof candidate.id === "string" &&
            typeof candidate.url === "string" &&
            typeof candidate.version === "number"
        );
        await transaction.query(
          `UPDATE blogbot_source_idempotency
              SET request_fingerprint = $2,
                  response_json = $3::jsonb
            WHERE idempotency_key = $1`,
          [
            row.idempotency_key,
            fingerprint,
            JSON.stringify(
              protector.seal(
                plaintext,
                sourceIdempotencyContext(row.idempotency_key)
              )
            )
          ]
        );
      }
      if (reseal) {
        await writeSourceMigrationProgress(
          transaction,
          "blogbot_source_idempotency",
          lastKey
        );
      }
    });
    cursor = lastKey;
    if (reseal) reportSourceMigrationProgress("blogbot_source_idempotency", cursor);
  }

  // A malformed fingerprint is a set-membership question, so it is answered by
  // one aggregate instead of loading every scan request into memory.
  const malformedFingerprints = await database.query<{ malformed: string | number }>(
    `SELECT count(*) AS malformed FROM blogbot_source_scan_requests
      WHERE request_fingerprint !~ '^[a-f0-9]{64}$'`
  );
  if (Number(malformedFingerprints.rows[0]?.malformed ?? 0) > 0) {
    throw new Error("LOCAL_IDEMPOTENCY_FINGERPRINT_INVALID");
  }

  // Scan records were never written unsealed, so they are only ever verified.
  for (let cursor = ""; ;) {
    const scans = await database.query<{ id: string; value: unknown }>(
      `SELECT id, value FROM blogbot_source_scans
        WHERE id > $1 ORDER BY id LIMIT $2`,
      [cursor, SOURCE_MIGRATION_PAGE_SIZE]
    );
    if (scans.rows.length === 0) break;
    for (const row of scans.rows) {
      const scan = protector.open<LocalSourceScan>(row.value, sourceScanContext(row.id));
      if (scan.id !== row.id) {
        throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
      }
    }
    cursor = scans.rows[scans.rows.length - 1]!.id;
  }

  if (reseal) {
    await database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO blogbot_encryption_migrations (scope, version)
         VALUES ('sources', 2)`
      );
      await transaction.query(
        "DELETE FROM blogbot_encryption_migration_progress WHERE scope = 'sources'"
      );
    });
  }
}

/**
 * A legacy row carries no authentication tag over its identity, so the reseal
 * path has to decide on shape alone whether the value belongs to this row.
 * Without it the migration would turn whatever JSON happens to sit in the column
 * into data that passes every later authenticity check.
 */
function isLegacySourceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The composite entry cursor is stored as JSON because a text column cannot
 * hold a null separator and a feed-supplied external id may contain anything
 * else.
 */
function splitEntryKey(lastKey: string): [string, string] {
  if (lastKey === "") return ["", ""];
  try {
    const parsed: unknown = JSON.parse(lastKey);
    return Array.isArray(parsed)
      && typeof parsed[0] === "string"
      && typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : ["", ""];
  } catch {
    return ["", ""];
  }
}

async function readSourceMigrationProgress(
  database: Pick<PGlite, "query">,
  tableName: string
): Promise<string> {
  const result = await database.query<{ last_key: string }>(
    `SELECT last_key FROM blogbot_encryption_migration_progress
      WHERE scope = 'sources' AND table_name = $1`,
    [tableName]
  );
  return result.rows[0]?.last_key ?? "";
}

async function writeSourceMigrationProgress(
  client: Pick<PGlite, "query">,
  tableName: string,
  lastKey: string
): Promise<void> {
  await client.query(
    `INSERT INTO blogbot_encryption_migration_progress (scope, table_name, last_key)
     VALUES ('sources', $1, $2)
     ON CONFLICT (scope, table_name) DO UPDATE SET last_key = EXCLUDED.last_key`,
    [tableName, lastKey]
  );
}

/**
 * The desktop cannot tell a migrating engine from a hung one, because open() has
 * not resolved and no request is answered yet. The marker carries a table name
 * and a digest of the last key only, never row contents.
 */
function reportSourceMigrationProgress(tableName: string, lastKey: string): void {
  try {
    process.stderr.write(
      `[Blogbot] LOCAL_MIGRATION_PROGRESS ${tableName} ${createHash("sha256").update(lastKey).digest("hex").slice(0, 12)}\n`
    );
  } catch {
    // Progress reporting must never fail a migration page.
  }
}

/**
 * Converts the pre-v3 mutable `(source_id, external_id)` cache into an
 * append-only content-addressed ledger, and completes it by removing the
 * duplicate mutable cache so backup size does not silently double.
 *
 * Conversion runs one page per transaction, and every page is self-consuming:
 * the legacy rows it converted are deleted in the same transaction, so an
 * interrupted upgrade resumes from what is left rather than restarting from row
 * zero. The target insert is content-addressed and idempotent, so replaying a
 * page that was already committed is a no-op. A single transaction over the
 * whole ledger could never complete on a workspace with months of captures.
 */
async function migrateSourceEntryVersions(
  database: PGlite,
  protector: JsonProtector
): Promise<void> {
  const marker = await database.query<{ version: number }>(
    "SELECT version FROM blogbot_source_schema_migrations WHERE scope = 'source_entry_versions'"
  );
  const appliedVersion = marker.rows[0]?.version;
  if (appliedVersion !== undefined && appliedVersion !== 1 && appliedVersion !== 2) {
    throw new Error(`LOCAL_SOURCE_SCHEMA_MIGRATION_UNSUPPORTED: source_entry_versions version ${appliedVersion}`);
  }
  if (appliedVersion === 2) return;

  if (appliedVersion === 1) {
    // `entry_url IS NULL` is itself the resume marker: a converted row no
    // longer matches, so a page never has to be re-read.
    for (;;) {
      const versions = await database.query<{
        source_id: string;
        external_id: string;
        content_hash: string;
        value: unknown;
      }>(
        `SELECT source_id, external_id, content_hash, value
           FROM blogbot_source_entry_versions
          WHERE entry_url IS NULL
          ORDER BY source_id, external_id, content_hash
          LIMIT $1`,
        [SOURCE_MIGRATION_PAGE_SIZE]
      );
      if (versions.rows.length === 0) break;
      await database.transaction(async (transaction) => {
        for (const row of versions.rows) {
          const entry = protector.open<StoredSourceEntry>(
            row.value,
            sourceEntryVersionContext(row.source_id, row.external_id, row.content_hash)
          );
          if (entry.sourceId !== row.source_id || entry.externalId !== row.external_id || entry.contentHash !== row.content_hash) {
            throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
          }
          await transaction.query(
            `UPDATE blogbot_source_entry_versions
                SET entry_url = $4
              WHERE source_id = $1 AND external_id = $2 AND content_hash = $3`,
            [row.source_id, row.external_id, row.content_hash, entry.url]
          );
        }
      });
      reportSourceMigrationProgress("blogbot_source_entry_versions", versions.rows.at(-1)?.content_hash ?? "");
    }
    await database.query(
      "UPDATE blogbot_source_schema_migrations SET version = 2 WHERE scope = 'source_entry_versions'"
    );
    return;
  }

  for (;;) {
    const entries = await database.query<{
      source_id: string;
      external_id: string;
      sort_at?: string;
      value: unknown;
    }>(
      `SELECT source_id, external_id, sort_at, value FROM blogbot_source_entries
        ORDER BY source_id, external_id
        LIMIT $1`,
      [SOURCE_MIGRATION_PAGE_SIZE]
    );
    if (entries.rows.length === 0) break;
    await database.transaction(async (transaction) => {
      for (const row of entries.rows) {
        const legacy = protector.open<StoredSourceEntry>(
          row.value,
          sourceEntryContext(row.source_id, row.external_id)
        );
        if (legacy.sourceId !== row.source_id || legacy.externalId !== row.external_id) {
          throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
        }
        const contentHash = sourceEntryVersionContentHash(row.source_id, legacy);
        const capturedAt = legacy.capturedAt && Number.isFinite(Date.parse(legacy.capturedAt))
          ? legacy.capturedAt
          : row.sort_at && Number.isFinite(Date.parse(row.sort_at))
            ? row.sort_at
            : new Date(0).toISOString();
        const sortAt = normalizedEntrySortAt(legacy.publishedAt, capturedAt);
        const stored: StoredSourceEntry = {
          ...legacy,
          sourceId: row.source_id,
          capturedAt,
          contentHash,
          versionId: sourceEntryVersionId(row.source_id, row.external_id, contentHash)
        };
        await transaction.query(
          `INSERT INTO blogbot_source_entry_versions (
             source_id, external_id, content_hash, entry_url, sort_at, captured_at, value
           ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb)
           ON CONFLICT (source_id, external_id, content_hash) DO NOTHING`,
          [
            row.source_id,
            row.external_id,
            contentHash,
            legacy.url,
            sortAt,
            capturedAt,
            JSON.stringify(protector.seal(stored, sourceEntryVersionContext(row.source_id, row.external_id, contentHash)))
          ]
        );
        await transaction.query(
          `INSERT INTO blogbot_source_entry_latest (source_id, external_id, content_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (source_id, external_id)
           DO UPDATE SET content_hash = EXCLUDED.content_hash`,
          [row.source_id, row.external_id, contentHash]
        );
        await transaction.query(
          "DELETE FROM blogbot_source_entries WHERE source_id = $1 AND external_id = $2",
          [row.source_id, row.external_id]
        );
      }
    });
    reportSourceMigrationProgress("blogbot_source_entries", entries.rows.at(-1)?.external_id ?? "");
  }
  await database.query(
    "INSERT INTO blogbot_source_schema_migrations (scope, version) VALUES ('source_entry_versions', 2)"
  );
}

async function verifySourceEntryVersions(database: PGlite, protector: JsonProtector): Promise<void> {
  // The version ledger is the largest table in the workspace, so an explicit
  // integrity pass reads it in pages rather than materialising all of it.
  for (let cursor: [string, string, string] = ["", "", ""]; ;) {
    const entries = await database.query<{
      source_id: string;
      external_id: string;
      content_hash: string;
      value: unknown;
    }>(
      `SELECT source_id, external_id, content_hash, value
         FROM blogbot_source_entry_versions
        WHERE (source_id, external_id, content_hash) > ($1, $2, $3)
        ORDER BY source_id, external_id, content_hash
        LIMIT $4`,
      [cursor[0], cursor[1], cursor[2], SOURCE_MIGRATION_PAGE_SIZE]
    );
    if (entries.rows.length === 0) break;
    verifySourceEntryVersionPage(entries.rows, protector);
    const last = entries.rows[entries.rows.length - 1]!;
    cursor = [last.source_id, last.external_id, last.content_hash];
  }
}

function verifySourceEntryVersionPage(
  rows: ReadonlyArray<{
    source_id: string;
    external_id: string;
    content_hash: string;
    value: unknown;
  }>,
  protector: JsonProtector
): void {
  for (const row of rows) {
    const entry = protector.open<StoredSourceEntry>(
      row.value,
      sourceEntryVersionContext(row.source_id, row.external_id, row.content_hash)
    );
    if (
      entry.sourceId !== row.source_id ||
      entry.externalId !== row.external_id ||
      entry.contentHash !== row.content_hash ||
      entry.versionId !== sourceEntryVersionId(row.source_id, row.external_id, row.content_hash) ||
      sourceEntryVersionContentHash(row.source_id, entry) !== row.content_hash
    ) throw new Error("LOCAL_DATA_IDENTITY_MISMATCH");
  }
}

/**
 * The latest pointer has a composite foreign key onto the exact version triple
 * with ON DELETE CASCADE, so deleting a newer version of an entry also destroys
 * the (source_id, external_id) pointer — and every listing path is an inner join
 * on that pointer. A retained older version, including evidence an approved
 * revision cites, would survive in the ledger while being unreachable from
 * listEntries, findEntryByUrl and the candidate projection. Re-point at the
 * newest surviving version, and only when the pointer is actually gone: an
 * intact pointer already names the most recent capture.
 */
async function repointLatestSourceEntry(
  client: Pick<PGlite, "query">,
  sourceId: string,
  externalId: string
): Promise<void> {
  await client.query(
    `INSERT INTO blogbot_source_entry_latest (source_id, external_id, content_hash)
     SELECT versions.source_id, versions.external_id, versions.content_hash
       FROM blogbot_source_entry_versions AS versions
      WHERE versions.source_id = $1
        AND versions.external_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM blogbot_source_entry_latest AS latest
           WHERE latest.source_id = $1 AND latest.external_id = $2
        )
      ORDER BY versions.sort_at DESC, versions.content_hash DESC
      LIMIT 1
     ON CONFLICT (source_id, external_id) DO NOTHING`,
    [sourceId, externalId]
  );
}

function sqlValuesPlaceholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, row) => {
    const offset = row * columnCount;
    return `(${Array.from({ length: columnCount }, (_, column) => `$${offset + column + 1}`).join(", ")})`;
  }).join(", ");
}

function normalizedEntrySortAt(publishedAt: string | undefined, fallbackIso: string): string {
  if (publishedAt && Number.isFinite(Date.parse(publishedAt))) return new Date(publishedAt).toISOString();
  return fallbackIso;
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

function sourceEntryVersionContentHash(sourceId: string, entry: SourceFeedEntry): string {
  return createHash("sha256")
    .update(canonicalJson({
      sourceId,
      externalId: entry.externalId,
      title: entry.title,
      url: entry.url,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
      ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt })
    }), "utf8")
    .digest("hex");
}

function sourceEntryVersionId(sourceId: string, externalId: string, contentHash: string): string {
  return `entry-${createHash("sha256")
    .update(sourceId, "utf8")
    .update("\u0000", "utf8")
    .update(externalId, "utf8")
    .update("\u0000", "utf8")
    .update(contentHash, "utf8")
    .digest("hex")}`;
}

function sourceEntryVersionContext(sourceId: string, externalId: string, contentHash: string) {
  return {
    table: "blogbot_source_entry_versions",
    key: `${sourceId}\u0000${externalId}\u0000${contentHash}`,
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

export function sourceCapabilitiesFor(source: LocalSource): SourceCapabilities {
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
