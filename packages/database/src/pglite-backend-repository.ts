import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import type { AutomationSettings } from "../../editorial/src/automation.ts";
import {
  canonicalJson,
  type Approval,
  type ArticleRevision,
  type HighRiskApproval
} from "../../editorial/src/revision.ts";
import {
  BackendStoreError,
  type BackendChange,
  type BackendJob,
  type DashboardReadOptions,
  type DashboardSyncResult,
  type RevisionListReadOptions,
  type RevisionListSnapshot,
  type RevisionLineageIndexEntry,
  type BackendRepository,
  type BackendRepositoryTransaction,
  type OutboxEffect,
  type PublicationIntentBinding,
  type SyncResult
} from "./backend-repository.ts";
import { JsonProtector } from "./encrypted-json.ts";

interface QueryResult<Row> {
  rows: Row[];
}

interface PGliteQueryPort {
  query<Row>(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<unknown>;
}

interface PGliteDatabasePort extends PGliteQueryPort {
  transaction<T>(
    operation: (transaction: PGliteQueryPort) => Promise<T>
  ): Promise<T>;
  close(): Promise<void>;
}

interface JsonRow {
  key?: string;
  value: unknown;
}

interface IdempotencyRow {
  request_fingerprint: string;
  response_json: unknown;
}

interface ChangeRow {
  cursor: string | number;
  kind: BackendChange["kind"];
  entity_id: string;
}

const LOCAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS blogbot_automation (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  value jsonb NOT NULL
);

INSERT INTO blogbot_automation (singleton_id, value)
VALUES (
  1,
  '{
    "mode":"INGEST_ONLY",
    "onboardingComplete":false,
    "ingestionPaused":false,
    "publishingPaused":true,
    "timezone":"Europe/Istanbul",
    "scanIntervalMinutes":30
  }'::jsonb
)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS blogbot_revisions (
  id text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_approvals (
  revision_id text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_outbox (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_jobs (
  id text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_changes (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  entity_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_idempotency (
  idempotency_key text PRIMARY KEY,
  request_fingerprint text NOT NULL,
  response_json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS blogbot_encryption_migrations (
  scope text PRIMARY KEY,
  version integer NOT NULL
);
`;

const LOCAL_MIGRATIONS = [
  {
    version: 1,
    name: "local-engine-core",
    sql: LOCAL_SCHEMA_SQL
  },
  {
    version: 2,
    name: "high-risk-approvals",
    sql: `
CREATE TABLE IF NOT EXISTS blogbot_high_risk_approvals (
  revision_id text PRIMARY KEY,
  value jsonb NOT NULL
);
`
  },
  {
    version: 3,
    name: "codex-jobs",
    sql: `
CREATE TABLE IF NOT EXISTS blogbot_codex_jobs (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  value jsonb NOT NULL
);
`
  },
  {
    version: 4,
    name: "local-state",
    sql: `
CREATE TABLE IF NOT EXISTS blogbot_local_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
`
  },
  {
    version: 5,
    name: "revision-list-index",
    sql: `
CREATE TABLE IF NOT EXISTS blogbot_revision_list_index (
  revision_id text PRIMARY KEY,
  scheduled_at_unix_ms bigint NOT NULL,
  supersedes_revision_id text,
  value jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS blogbot_revision_list_due_idx
  ON blogbot_revision_list_index (scheduled_at_unix_ms, revision_id);
CREATE INDEX IF NOT EXISTS blogbot_revision_list_parent_idx
  ON blogbot_revision_list_index (supersedes_revision_id);
`
  }
] as const;

const MIGRATION_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS blogbot_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

class PGliteTransactionRepository implements BackendRepositoryTransaction {
  constructor(
    protected readonly client: PGliteQueryPort,
    protected readonly protector: JsonProtector
  ) {}

  async getVersion(): Promise<number> {
    const result = await this.client.query<{ cursor: string | number }>(
      "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM blogbot_changes"
    );
    return Number(result.rows[0]?.cursor ?? 0);
  }

  async setAutomation(settings: AutomationSettings): Promise<void> {
    await this.client.query(
      "UPDATE blogbot_automation SET value = $1::jsonb WHERE singleton_id = 1",
      [JSON.stringify(this.protector.seal(settings, backendContext("blogbot_automation", "1")))]
    );
    await this.recordChange("AUTOMATION_UPDATED", "automation");
  }

  async getAutomation(): Promise<AutomationSettings> {
    const result = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_automation WHERE singleton_id = 1"
    );
    return this.protector.open<AutomationSettings>(
      result.rows[0]?.value,
      backendContext("blogbot_automation", "1")
    );
  }

  async insertRevision(revision: ArticleRevision): Promise<ArticleRevision> {
    const existing = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_revisions WHERE id = $1",
      [revision.id]
    );
    if (existing.rows[0]) {
      const saved = this.protector.open<ArticleRevision>(
        existing.rows[0].value,
        backendContext("blogbot_revisions", revision.id)
      );
      if (canonicalJson(saved) !== canonicalJson(revision)) {
        throw new BackendStoreError(
          "IMMUTABLE_REVISION",
          `Revision ${revision.id} already exists with different content`
        );
      }
      return structuredClone(saved);
    }
    await this.client.query(
      "INSERT INTO blogbot_revisions (id, value) VALUES ($1, $2::jsonb)",
      [
        revision.id,
        JSON.stringify(
          this.protector.seal(
            revision,
            backendContext("blogbot_revisions", revision.id)
          )
        )
      ]
    );
    await writeRevisionListIndex(this.client, this.protector, revision);
    await this.recordChange("REVISION_SUBMITTED", revision.id);
    return structuredClone(revision);
  }

  async getRevision(revisionId: string): Promise<ArticleRevision> {
    const result = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_revisions WHERE id = $1",
      [revisionId]
    );
    if (!result.rows[0]) {
      throw new BackendStoreError(
        "REVISION_NOT_FOUND",
        `Revision ${revisionId} was not found`
      );
    }
    return this.protector.open<ArticleRevision>(
      result.rows[0].value,
      backendContext("blogbot_revisions", revisionId)
    );
  }

  async getApproval(revisionId: string): Promise<Approval | null> {
    const result = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_approvals WHERE revision_id = $1",
      [revisionId]
    );
    if (!result.rows[0]) return null;
    return this.protector.open<Approval>(
      result.rows[0].value,
      backendContext("blogbot_approvals", revisionId)
    );
  }

  async saveApproval(approval: Approval): Promise<Approval> {
    const existing = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_approvals WHERE revision_id = $1",
      [approval.revisionId]
    );
    if (existing.rows[0]) {
      const saved = this.protector.open<Approval>(
        existing.rows[0].value,
        backendContext("blogbot_approvals", approval.revisionId)
      );
      if (canonicalJson(saved) === canonicalJson(approval)) {
        return structuredClone(saved);
      }
      throw new BackendStoreError(
        "REVISION_ALREADY_APPROVED",
        `Revision ${approval.revisionId} already has an immutable approval`
      );
    }
    await this.client.query(
      "INSERT INTO blogbot_approvals (revision_id, value) VALUES ($1, $2::jsonb)",
      [
        approval.revisionId,
        JSON.stringify(
          this.protector.seal(
            approval,
            backendContext("blogbot_approvals", approval.revisionId)
          )
        )
      ]
    );
    await this.recordChange("REVISION_APPROVED", approval.revisionId);
    return structuredClone(approval);
  }

  async saveHighRiskApproval(
    approval: HighRiskApproval
  ): Promise<HighRiskApproval> {
    const existing = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_high_risk_approvals WHERE revision_id = $1",
      [approval.revisionId]
    );
    if (existing.rows[0]) {
      const saved = this.protector.open<HighRiskApproval>(
        existing.rows[0].value,
        backendContext("blogbot_high_risk_approvals", approval.revisionId)
      );
      if (canonicalJson(saved) === canonicalJson(approval)) {
        return structuredClone(saved);
      }
      throw new BackendStoreError(
        "REVISION_ALREADY_APPROVED",
        `Revision ${approval.revisionId} already has an immutable high-risk approval`
      );
    }
    await this.client.query(
      `INSERT INTO blogbot_high_risk_approvals (revision_id, value)
       VALUES ($1, $2::jsonb)`,
      [
        approval.revisionId,
        JSON.stringify(
          this.protector.seal(
            approval,
            backendContext("blogbot_high_risk_approvals", approval.revisionId)
          )
        )
      ]
    );
    await this.recordChange(
      "REVISION_APPROVED",
      `${approval.revisionId}:HIGH_RISK`
    );
    return structuredClone(approval);
  }

  async enqueuePublication(
    revisionId: string,
    revisionHash: string,
    binding: PublicationIntentBinding
  ): Promise<OutboxEffect> {
    const idempotencyKey = `publish:${revisionId}:${revisionHash}:${binding.previewHash}`;
    const existing = await this.client.query<JsonRow>(
      "SELECT id AS key, value FROM blogbot_outbox WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (!row.key) throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      return this.protector.open<OutboxEffect>(
        row.value,
        backendContext("blogbot_outbox", row.key)
      );
    }
    const effect: OutboxEffect = {
      id: randomUUID(),
      type: "PUBLISH_REVISION",
      aggregateId: revisionId,
      revisionHash,
      ...structuredClone(binding),
      idempotencyKey,
      state: "PENDING",
      attempts: 0
    };
    await this.client.query(
      `INSERT INTO blogbot_outbox (id, idempotency_key, value)
       VALUES ($1, $2, $3::jsonb)`,
      [
        effect.id,
        effect.idempotencyKey,
        JSON.stringify(
          this.protector.seal(
            effect,
            backendContext("blogbot_outbox", effect.id)
          )
        )
      ]
    );
    // Creation and later state transitions must be equally visible to the
    // incremental desktop sync feed; otherwise a freshly queued publication
    // can be invisible until an unrelated mutation happens.
    await this.recordChange("EFFECT_UPDATED", effect.id);
    return structuredClone(effect);
  }

  async listOutbox(): Promise<OutboxEffect[]> {
    const result = await this.client.query<JsonRow>(
      "SELECT id AS key, value FROM blogbot_outbox ORDER BY id"
    );
    return result.rows.map((row) => {
      if (!row.key) throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      return this.protector.open<OutboxEffect>(
        row.value,
        backendContext("blogbot_outbox", row.key)
      );
    });
  }

  async updateOutbox(effect: OutboxEffect): Promise<OutboxEffect> {
    const result = await this.client.query<{ id: string }>(
      `UPDATE blogbot_outbox
          SET value = $2::jsonb
        WHERE id = $1
      RETURNING id`,
      [
        effect.id,
        JSON.stringify(
          this.protector.seal(
            effect,
            backendContext("blogbot_outbox", effect.id)
          )
        )
      ]
    );
    if (!result.rows[0]) {
      throw new Error(`Outbox effect ${effect.id} was not found`);
    }
    await this.recordChange("EFFECT_UPDATED", effect.id);
    return structuredClone(effect);
  }

  async createJob(job: BackendJob): Promise<BackendJob> {
    try {
      await this.client.query(
        "INSERT INTO blogbot_jobs (id, value) VALUES ($1, $2::jsonb)",
        [
          job.id,
          JSON.stringify(
            this.protector.seal(job, backendContext("blogbot_jobs", job.id))
          )
        ]
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Job ${job.id} already exists`, { cause: error });
      }
      throw error;
    }
    await this.recordChange("JOB_UPDATED", job.id);
    return structuredClone(job);
  }

  async getJob(jobId: string): Promise<BackendJob> {
    const result = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_jobs WHERE id = $1",
      [jobId]
    );
    if (!result.rows[0]) {
      throw new Error(`Job ${jobId} was not found`);
    }
    return this.protector.open<BackendJob>(
      result.rows[0].value,
      backendContext("blogbot_jobs", jobId)
    );
  }

  async saveJob(job: BackendJob): Promise<BackendJob> {
    const result = await this.client.query<{ id: string }>(
      `UPDATE blogbot_jobs
          SET value = $2::jsonb
        WHERE id = $1
      RETURNING id`,
      [
        job.id,
        JSON.stringify(
          this.protector.seal(job, backendContext("blogbot_jobs", job.id))
        )
      ]
    );
    if (!result.rows[0]) {
      throw new Error(`Job ${job.id} was not found`);
    }
    await this.recordChange("JOB_UPDATED", job.id);
    return structuredClone(job);
  }

  async listJobs(): Promise<BackendJob[]> {
    const result = await this.client.query<JsonRow>(
      "SELECT id AS key, value FROM blogbot_jobs ORDER BY id"
    );
    return result.rows.map((row) => {
      if (!row.key) throw new Error("LOCAL_DATA_IDENTITY_MISSING");
      return this.protector.open<BackendJob>(
        row.value,
        backendContext("blogbot_jobs", row.key)
      );
    });
  }

  async getLocalState(key: string): Promise<unknown | undefined> {
    const result = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_local_state WHERE key = $1",
      [key]
    );
    const row = result.rows[0];
    return row ? this.protector.open(row.value, backendContext("blogbot_local_state", key)) : undefined;
  }

  async setLocalState(key: string, value: unknown): Promise<void> {
    await this.client.query(
      `INSERT INTO blogbot_local_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(this.protector.seal(value, backendContext("blogbot_local_state", key)))]
    );
    await this.recordChange("LOCAL_STATE_UPDATED", key);
  }

  async getHighRiskApproval(revisionId: string): Promise<HighRiskApproval | null> {
    const result = await this.client.query<JsonRow>(
      "SELECT value FROM blogbot_high_risk_approvals WHERE revision_id = $1",
      [revisionId]
    );
    return result.rows[0]
      ? this.protector.open<HighRiskApproval>(
        result.rows[0].value,
        backendContext("blogbot_high_risk_approvals", revisionId)
      )
      : null;
  }

  async setMaintenanceState(key: string, value: unknown): Promise<void> {
    if (!key.startsWith("maintenance.")) {
      throw new BackendStoreError("INVALID_MAINTENANCE_KEY", "Maintenance state keys must start with maintenance.");
    }
    await this.client.query(
      `INSERT INTO blogbot_local_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(this.protector.seal(value, backendContext("blogbot_local_state", key)))]
    );
  }

  protected async recordChange(
    kind: BackendChange["kind"],
    entityId: string
  ): Promise<void> {
    await this.client.query(
      "INSERT INTO blogbot_changes (kind, entity_id) VALUES ($1, $2)",
      [kind, entityId]
    );
  }
}

export class PGliteBackendRepository
  extends PGliteTransactionRepository
  implements BackendRepository
{
  readonly persistence = "pglite" as const;

  private constructor(
    private readonly database: PGliteDatabasePort,
    protector: JsonProtector
  ) {
    super(database, protector);
  }

  static async open(dataDir: string): Promise<PGliteBackendRepository> {
    await mkdir(dataDir, { recursive: true });
    const assetDirectory = process.env.BLOGBOT_PGLITE_ASSETS?.trim();
    const database = assetDirectory
      ? new PGlite({
          dataDir,
          pgliteWasmModule: await WebAssembly.compile(
            await readFile(join(assetDirectory, "pglite.wasm"))
          ),
          initdbWasmModule: await WebAssembly.compile(
            await readFile(join(assetDirectory, "initdb.wasm"))
          ),
          fsBundle: new Blob([
            await readFile(join(assetDirectory, "pglite.data"))
          ])
        })
      : new PGlite(dataDir);
    await database.waitReady;
    await applyLocalMigrations(database);
    const protector = JsonProtector.fromEnvironment();
    await encryptLegacyBackendRows(database, protector);
    await backfillRevisionListIndex(database, protector);
    return new PGliteBackendRepository(database, protector);
  }

  /** Explicit, potentially expensive full encrypted-row integrity check. */
  async verifyEncryptionIntegrity(): Promise<void> {
    await encryptLegacyBackendRows(this.database, this.protector, true);
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  getDatabase(): PGlite {
    return this.database as PGlite;
  }

  async sync(afterCursor: number): Promise<SyncResult> {
    return this.database.transaction((transaction) =>
      readSyncSnapshot(transaction, this.protector, afterCursor)
    );
  }

  async syncDashboard(afterCursor: number, options: DashboardReadOptions = {}): Promise<DashboardSyncResult> {
    return this.database.transaction((transaction) =>
      readDashboardSync(transaction, this.protector, afterCursor, options)
    );
  }

  async listRevisionSnapshot(): Promise<RevisionListSnapshot> {
    return this.database.transaction((transaction) => readRevisionListSnapshot(transaction, this.protector));
  }

  async listRevisionSummarySnapshot(options: RevisionListReadOptions = {}): Promise<RevisionListSnapshot> {
    return this.database.transaction((transaction) => readRevisionSummarySnapshot(transaction, this.protector, options));
  }

  async listDueRevisionIds(nowUnixMs: number, limit = 100): Promise<string[]> {
    const result = await this.database.query<{ revision_id: string }>(
      `SELECT revision_id FROM blogbot_revision_list_index
        WHERE scheduled_at_unix_ms <= $1
        ORDER BY scheduled_at_unix_ms, revision_id
        LIMIT $2`,
      [nowUnixMs, Math.min(Math.max(1, limit), 200)]
    );
    return result.rows.map((row) => row.revision_id);
  }

  async listRevisionLineage(): Promise<RevisionLineageIndexEntry[]> {
    const result = await this.database.query<{
      revision_id: string;
      supersedes_revision_id: string | null;
    }>("SELECT revision_id, supersedes_revision_id FROM blogbot_revision_list_index");
    return result.rows.map((row) => ({
      id: row.revision_id,
      ...(row.supersedes_revision_id ? { supersedesRevisionId: row.supersedes_revision_id } : {})
    }));
  }

  async runIdempotent<T>(
    idempotencyKey: string,
    requestFingerprint: string,
    operation: (
      transaction: BackendRepositoryTransaction
    ) => Promise<T> | T
  ): Promise<T> {
    return this.database.transaction(async (client) => {
      const fingerprintHash = createHash("sha256")
        .update(requestFingerprint)
        .digest("hex");
      const existing = await client.query<IdempotencyRow>(
        `SELECT request_fingerprint, response_json
           FROM blogbot_idempotency
          WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      const row = existing.rows[0];
      if (row) {
        if (row.request_fingerprint !== fingerprintHash) {
          throw new BackendStoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key was already used with a different request"
          );
        }
        return this.protector.open<T>(
          row.response_json,
          backendContext("blogbot_idempotency", idempotencyKey, "response_json")
        );
      }

      const result = await operation(
        new PGliteTransactionRepository(client, this.protector)
      );
      await client.query(
        `INSERT INTO blogbot_idempotency (
           idempotency_key,
           request_fingerprint,
           response_json
         ) VALUES ($1, $2, $3::jsonb)`,
        [
          idempotencyKey,
          fingerprintHash,
          JSON.stringify(
            this.protector.seal(
              result,
              backendContext(
                "blogbot_idempotency",
                idempotencyKey,
                "response_json"
              )
            )
          )
        ]
      );
      return structuredClone(result);
    });
  }
}

async function encryptLegacyBackendRows(
  database: PGliteDatabasePort,
  protector: JsonProtector,
  verifyCompleted = false
): Promise<void> {
  await database.transaction(async (transaction) => {
    const migration = await transaction.query<{ version: number }>(
      "SELECT version FROM blogbot_encryption_migrations WHERE scope = 'backend'"
    );
    const appliedVersion = migration.rows[0]?.version;
    if (appliedVersion !== undefined && appliedVersion !== 2) {
      throw new Error(
        `LOCAL_ENCRYPTION_MIGRATION_UNSUPPORTED: backend version ${appliedVersion}`
      );
    }
    // A completed migration is the startup sentinel. Re-opening every
    // encrypted row on every launch turns normal startup into an O(n)
    // corruption scan; operators can request that scan explicitly instead.
    if (appliedVersion === 2 && !verifyCompleted) return;
    const automation = await transaction.query<JsonRow>(
      "SELECT value FROM blogbot_automation WHERE singleton_id = 1"
    );
    const automationValue = automation.rows[0]?.value;
    if (automationValue !== undefined) {
      if (appliedVersion === 2) {
        protector.open<AutomationSettings>(
          automationValue,
          backendContext("blogbot_automation", "1")
        );
      } else {
        const plaintext =
          protector.openLegacy<AutomationSettings>(automationValue);
        await transaction.query(
          "UPDATE blogbot_automation SET value = $1::jsonb WHERE singleton_id = 1",
          [
            JSON.stringify(
              protector.seal(
                plaintext,
                backendContext("blogbot_automation", "1")
              )
            )
          ]
        );
      }
    }

    for (const table of [
      { name: "blogbot_revisions", key: "id" },
      { name: "blogbot_approvals", key: "revision_id" },
      { name: "blogbot_high_risk_approvals", key: "revision_id" },
      { name: "blogbot_revision_list_index", key: "revision_id" },
      { name: "blogbot_outbox", key: "id" },
      { name: "blogbot_jobs", key: "id" },
      { name: "blogbot_codex_jobs", key: "id" }
    ] as const) {
      const rows = await transaction.query<{ key: string; value: unknown }>(
        `SELECT ${table.key} AS key, value FROM ${table.name}`
      );
      for (const row of rows.rows) {
        if (appliedVersion === 2) {
          protector.open(row.value, backendContext(table.name, row.key));
        } else {
          const plaintext = protector.openLegacy(row.value);
          await transaction.query(
            `UPDATE ${table.name} SET value = $2::jsonb WHERE ${table.key} = $1`,
            [
              row.key,
              JSON.stringify(
                protector.seal(
                  plaintext,
                  backendContext(table.name, row.key)
                )
              )
            ]
          );
        }
      }
    }

    const idempotency = await transaction.query<{
      idempotency_key: string;
      request_fingerprint: string;
      response_json: unknown;
    }>(
      "SELECT idempotency_key, request_fingerprint, response_json FROM blogbot_idempotency"
    );
    for (const row of idempotency.rows) {
      if (appliedVersion === 2) {
        if (!/^[a-f0-9]{64}$/u.test(row.request_fingerprint)) {
          throw new Error("LOCAL_IDEMPOTENCY_FINGERPRINT_INVALID");
        }
        protector.open(
          row.response_json,
          backendContext(
            "blogbot_idempotency",
            row.idempotency_key,
            "response_json"
          )
        );
      } else {
        const plaintext = protector.openLegacy(row.response_json);
        const fingerprint = createHash("sha256")
          .update(row.request_fingerprint)
          .digest("hex");
        await transaction.query(
          `UPDATE blogbot_idempotency
              SET request_fingerprint = $2,
                  response_json = $3::jsonb
            WHERE idempotency_key = $1`,
          [
            row.idempotency_key,
            fingerprint,
            JSON.stringify(
              protector.seal(
                plaintext,
                backendContext(
                  "blogbot_idempotency",
                  row.idempotency_key,
                  "response_json"
                )
              )
            )
          ]
        );
      }
    }
    if (appliedVersion === undefined) {
      await transaction.query(
        `INSERT INTO blogbot_encryption_migrations (scope, version)
         VALUES ('backend', 2)`
      );
    }
  });
}

async function applyLocalMigrations(database: PGlite): Promise<void> {
  await database.exec(MIGRATION_LEDGER_SQL);
  const applied = await database.query<{
    version: number;
    name: string;
    sha256: string;
  }>(
    "SELECT version, name, sha256 FROM blogbot_schema_migrations ORDER BY version"
  );
  const byVersion = new Map(applied.rows.map((migration) => [migration.version, migration]));
  const supportedVersions = new Set<number>(
    LOCAL_MIGRATIONS.map((migration) => migration.version)
  );
  for (const migration of applied.rows) {
    if (!supportedVersions.has(migration.version)) {
      throw new Error(
        `LOCAL_MIGRATION_NEWER_THAN_BINARY: migration ${migration.version} is not supported`
      );
    }
  }

  for (const migration of LOCAL_MIGRATIONS) {
    const sha256 = createHash("sha256").update(migration.sql).digest("hex");
    const existing = byVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.sha256 !== sha256) {
        throw new Error(
          `LOCAL_MIGRATION_DRIFT: migration ${migration.version} does not match its recorded hash`
        );
      }
      continue;
    }
    await database.transaction(async (transaction) => {
      await transaction.exec(migration.sql);
      await transaction.query(
        `INSERT INTO blogbot_schema_migrations (version, name, sha256)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, sha256]
      );
    });
  }
}

async function readSyncSnapshot(
  client: PGliteQueryPort,
  protector: JsonProtector,
  afterCursor: number
): Promise<SyncResult> {
  const automation = await client.query<JsonRow>(
    "SELECT value FROM blogbot_automation WHERE singleton_id = 1"
  );
  const revisions = await client.query<JsonRow>(
    "SELECT id AS key, value FROM blogbot_revisions ORDER BY id"
  );
  const approvals = await client.query<JsonRow>(
    "SELECT revision_id AS key, value FROM blogbot_approvals ORDER BY revision_id"
  );
  const highRiskApprovals = await client.query<JsonRow>(
    `SELECT revision_id AS key, value
       FROM blogbot_high_risk_approvals
      ORDER BY revision_id`
  );
  const outbox = await client.query<JsonRow>(
    "SELECT id AS key, value FROM blogbot_outbox ORDER BY id"
  );
  const jobs = await client.query<JsonRow>(
    "SELECT id AS key, value FROM blogbot_jobs ORDER BY id"
  );
  const changes = await client.query<ChangeRow>(
    `SELECT cursor, kind, entity_id
       FROM blogbot_changes
      WHERE cursor > $1
      ORDER BY cursor`,
    [afterCursor]
  );
  const cursor = await client.query<{ cursor: string | number }>(
    "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM blogbot_changes"
  );

  return {
    serverCursor: Number(cursor.rows[0]?.cursor ?? 0),
    snapshot: {
      automation: protector.open<AutomationSettings>(
        automation.rows[0]?.value,
        backendContext("blogbot_automation", "1")
      ),
      revisions: revisions.rows.map(
        (row) => protector.open<ArticleRevision>(
          row.value,
          backendContext("blogbot_revisions", requiredKey(row))
        )
      ),
      approvals: approvals.rows.map(
        (row) => protector.open<Approval>(
          row.value,
          backendContext("blogbot_approvals", requiredKey(row))
        )
      ),
      highRiskApprovals: highRiskApprovals.rows.map(
        (row) => protector.open<HighRiskApproval>(
          row.value,
          backendContext(
            "blogbot_high_risk_approvals",
            requiredKey(row)
          )
        )
      ),
      outbox: outbox.rows.map(
        (row) => protector.open<OutboxEffect>(
          row.value,
          backendContext("blogbot_outbox", requiredKey(row))
        )
      ),
      jobs: jobs.rows.map((row) => protector.open<BackendJob>(
        row.value,
        backendContext("blogbot_jobs", requiredKey(row))
      ))
    },
    changes: changes.rows.map((row) => ({
      cursor: Number(row.cursor),
      kind: row.kind,
      entityId: row.entity_id
    }))
  };
}

async function readRevisionListSnapshot(
  client: PGliteQueryPort,
  protector: JsonProtector
): Promise<RevisionListSnapshot> {
  const [revisions, approvals, highRiskApprovals] = await Promise.all([
    client.query<JsonRow>("SELECT id AS key, value FROM blogbot_revisions ORDER BY id"),
    client.query<JsonRow>("SELECT revision_id AS key, value FROM blogbot_approvals ORDER BY revision_id"),
    client.query<JsonRow>("SELECT revision_id AS key, value FROM blogbot_high_risk_approvals ORDER BY revision_id")
  ]);
  return {
    revisions: revisions.rows.map((row) => protector.open<ArticleRevision>(row.value, backendContext("blogbot_revisions", requiredKey(row)))),
    approvals: approvals.rows.map((row) => protector.open<Approval>(row.value, backendContext("blogbot_approvals", requiredKey(row)))),
    highRiskApprovals: highRiskApprovals.rows.map((row) => protector.open<HighRiskApproval>(row.value, backendContext("blogbot_high_risk_approvals", requiredKey(row))))
  };
}

function revisionListSummary(revision: ArticleRevision): ArticleRevision {
  return {
    id: revision.id,
    ...(revision.supersedesRevisionId ? { supersedesRevisionId: revision.supersedesRevisionId } : {}),
    state: revision.state,
    tr: { title: revision.tr.title, slug: revision.tr.slug },
    section: revision.section,
    articleType: revision.articleType,
    ...(revision.riskLevel ? { riskLevel: revision.riskLevel } : {}),
    scheduledAt: revision.scheduledAt,
    // A summary needs claim/source policy state but never source excerpts,
    // translated bodies, generated files, or base64 media payloads.
    sources: revision.sources.map(({ evidenceExcerpt: _excerpt, ...source }) => structuredClone(source)),
    claims: structuredClone(revision.claims)
  } as unknown as ArticleRevision;
}

async function writeRevisionListIndex(
  client: PGliteQueryPort,
  protector: JsonProtector,
  revision: ArticleRevision
): Promise<void> {
  const scheduledAtUnixMs = Date.parse(revision.scheduledAt);
  if (!Number.isFinite(scheduledAtUnixMs)) {
    throw new Error("REVISION_SCHEDULE_INVALID");
  }
  await client.query(
    `INSERT INTO blogbot_revision_list_index
      (revision_id, scheduled_at_unix_ms, supersedes_revision_id, value)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (revision_id) DO UPDATE SET
       scheduled_at_unix_ms = EXCLUDED.scheduled_at_unix_ms,
       supersedes_revision_id = EXCLUDED.supersedes_revision_id,
       value = EXCLUDED.value`,
    [
      revision.id,
      scheduledAtUnixMs,
      revision.supersedesRevisionId ?? null,
      JSON.stringify(protector.seal(
        revisionListSummary(revision),
        backendContext("blogbot_revision_list_index", revision.id)
      ))
    ]
  );
}

async function backfillRevisionListIndex(
  database: PGliteDatabasePort,
  protector: JsonProtector
): Promise<void> {
  const missing = await database.query<JsonRow>(
    `SELECT id AS key, value FROM blogbot_revisions revision
      WHERE NOT EXISTS (
        SELECT 1 FROM blogbot_revision_list_index idx WHERE idx.revision_id = revision.id
      )`
  );
  if (missing.rows.length === 0) return;
  await database.transaction(async (transaction) => {
    for (const row of missing.rows) {
      const id = requiredKey(row);
      const revision = protector.open<ArticleRevision>(
        row.value,
        backendContext("blogbot_revisions", id)
      );
      await writeRevisionListIndex(transaction, protector, revision);
    }
  });
}

async function readRevisionSummarySnapshot(
  client: PGliteQueryPort,
  protector: JsonProtector,
  options: RevisionListReadOptions
): Promise<RevisionListSnapshot> {
  const limit = Math.min(Math.max(1, options.limit ?? 100), 200);
  const rows = await client.query<{ revision_id: string; value: unknown }>(
    `SELECT revision_id, value FROM blogbot_revision_list_index
      ORDER BY scheduled_at_unix_ms DESC, revision_id DESC
      LIMIT $1`,
    [limit]
  );
  const revisions = rows.rows.map((row) => protector.open<ArticleRevision>(
    row.value,
    backendContext("blogbot_revision_list_index", row.revision_id)
  ));
  const approvals = await Promise.all(revisions.map(async (revision) => {
    const result = await client.query<JsonRow>(
      "SELECT value FROM blogbot_approvals WHERE revision_id = $1",
      [revision.id]
    );
    return result.rows[0]
      ? protector.open<Approval>(result.rows[0].value, backendContext("blogbot_approvals", revision.id))
      : null;
  }));
  const highRiskApprovals = await Promise.all(revisions.map(async (revision) => {
    const result = await client.query<JsonRow>(
      "SELECT value FROM blogbot_high_risk_approvals WHERE revision_id = $1",
      [revision.id]
    );
    return result.rows[0]
      ? protector.open<HighRiskApproval>(result.rows[0].value, backendContext("blogbot_high_risk_approvals", revision.id))
      : null;
  }));
  return {
    revisions,
    approvals: approvals.filter((value): value is Approval => value !== null),
    highRiskApprovals: highRiskApprovals.filter((value): value is HighRiskApproval => value !== null)
  };
}

async function readDashboardSync(
  client: PGliteQueryPort,
  protector: JsonProtector,
  afterCursor: number,
  options: DashboardReadOptions = {}
): Promise<DashboardSyncResult> {
  const automation = await client.query<JsonRow>(
    "SELECT value FROM blogbot_automation WHERE singleton_id = 1"
  );
  const outbox = options.outboxLimit === undefined
    ? await client.query<JsonRow>("SELECT id AS key, value FROM blogbot_outbox ORDER BY id")
    : await client.query<JsonRow>(
      "SELECT key, value FROM (SELECT id AS key, value FROM blogbot_outbox ORDER BY id DESC LIMIT $1) recent ORDER BY key",
      [options.outboxLimit]
    );
  const jobs = options.jobLimit === undefined
    ? await client.query<JsonRow>("SELECT id AS key, value FROM blogbot_jobs ORDER BY id")
    : await client.query<JsonRow>(
      "SELECT key, value FROM (SELECT id AS key, value FROM blogbot_jobs ORDER BY id DESC LIMIT $1) recent ORDER BY key",
      [options.jobLimit]
    );
  const changes = options.changeLimit === undefined
    ? await client.query<ChangeRow>(
      "SELECT cursor, kind, entity_id FROM blogbot_changes WHERE cursor > $1 ORDER BY cursor",
      [afterCursor]
    )
    : await client.query<ChangeRow>(
      `SELECT cursor, kind, entity_id
         FROM blogbot_changes
        WHERE cursor > $1
        ORDER BY cursor
        LIMIT $2`,
      [afterCursor, options.changeLimit]
    );
  const mappedChanges = changes.rows.map((row) => ({
    cursor: Number(row.cursor),
    kind: row.kind,
    entityId: row.entity_id
  }));
  return {
    serverCursor: mappedChanges.at(-1)?.cursor ?? afterCursor,
    automation: protector.open<AutomationSettings>(
      automation.rows[0]?.value,
      backendContext("blogbot_automation", "1")
    ),
    outbox: outbox.rows.map((row) => protector.open<OutboxEffect>(
      row.value,
      backendContext("blogbot_outbox", requiredKey(row))
    )),
    jobs: jobs.rows.map((row) => protector.open<BackendJob>(
      row.value,
      backendContext("blogbot_jobs", requiredKey(row))
    )),
    changes: mappedChanges
  };
}

function backendContext(table: string, key: string, field = "value") {
  return { table, key, field };
}

function requiredKey(row: JsonRow): string {
  if (!row.key) {
    throw new Error("LOCAL_DATA_IDENTITY_MISSING");
  }
  return row.key;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
