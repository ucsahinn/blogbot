import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback
} from "node:crypto";

import { BackupError } from "./errors.ts";

/**
 * Logical application backup.
 *
 * The portable file backup in `portable-backup.ts` archives a directory. It
 * cannot be pointed at a live PGlite data directory: a real workspace holds
 * roughly a thousand relation and WAL files totalling hundreds of megabytes,
 * where a single relation file already exceeds the per-file restore bound, and
 * the archive format base64-encodes every file into one JSON string. Raising the
 * bounds does not help — the encoded payload would be a single ~500 MB string.
 *
 * Recovery does not need Postgres internals. It needs the rows Blogbot owns, so
 * this module archives those instead: it is orders of magnitude smaller, it does
 * not race PGlite's on-disk layout, and it survives a PGlite version change.
 *
 * Rows are archived exactly as the database stores them. Record values are
 * already sealed by the repository's own AES-256-GCM envelope, which is bound to
 * the Windows profile's DPAPI-wrapped data key, so this archive does not widen
 * the recovery boundary described in ADR 0003: it stays a same-profile restore.
 * The archive is additionally encrypted under the user's recovery key so the file
 * itself is protected at rest.
 */

const ARCHIVE_FORMAT = "blogbot-logical-backup";
const ARCHIVE_VERSION = 1;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MINIMUM_RECOVERY_KEY_LENGTH = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * One set of bounds, enforced on both create and restore. Enforcing them only on
 * restore is how the file backup came to report archives it could never read
 * back as successfully created.
 */
export const LOGICAL_BACKUP_LIMITS = {
  maxTables: 64,
  maxRowsPerTable: 500_000,
  maxTableNameLength: 63,
  /** Serialized payload bound. AES-GCM plaintext and the JSON envelope co-exist transiently. */
  maxPayloadBytes: 192 * 1024 * 1024,
  maxArchiveBytes: 256 * 1024 * 1024
} as const;

const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/u;

export interface LogicalTableDump {
  name: string;
  /** Column names in the order the rows provide them. */
  columns: readonly string[];
  /** Each row is a positional tuple matching `columns`. */
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  /**
   * Identity columns, if any. A GENERATED ALWAYS column rejects a plain INSERT,
   * so restore has to override it and then move its sequence past the restored
   * maximum.
   */
  generatedColumns?: readonly string[];
}

export interface LogicalBackupTableManifest {
  name: string;
  columns: readonly string[];
  rowCount: number;
  sha256: string;
}

export interface LogicalBackupManifest {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  createdAt: string;
  tables: LogicalBackupTableManifest[];
}

interface LogicalBackupPayloadV1 {
  manifest: LogicalBackupManifest;
  tables: LogicalTableDump[];
}

interface LogicalArchiveEnvelopeV1 {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  kdf: {
    name: "scrypt";
    salt: string;
    N: typeof SCRYPT_N;
    r: typeof SCRYPT_R;
    p: typeof SCRYPT_P;
    maxmem: typeof SCRYPT_MAXMEM;
  };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
}

const restoreTables = Symbol("logicalRestoreTables");

export interface CreateLogicalBackupInput {
  tables: readonly LogicalTableDump[];
  recoveryKey: string;
  createdAt?: string;
}

export interface LogicalRestorePlan {
  createdAt: string;
  tables: ReadonlyArray<{ name: string; columns: readonly string[]; rowCount: number }>;
  totalRows: number;
  [restoreTables]: LogicalTableDump[];
}

export interface PlanLogicalRestoreInput {
  archive: Buffer;
  recoveryKey: string;
}

/** Preview-first restore: the plan alone never mutates anything. */
export function logicalRestoreTables(plan: LogicalRestorePlan): readonly LogicalTableDump[] {
  return plan[restoreTables];
}

/**
 * Deterministic serialization used only for integrity hashes. Object keys are
 * sorted so an unrelated key order cannot change a table digest.
 */
function stableStringify(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BackupError(
        "BACKUP_SOURCE_INVALID",
        "Backup rows may only contain finite JSON numbers."
      );
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  throw new BackupError(
    "BACKUP_SOURCE_INVALID",
    "Backup rows may only contain JSON values."
  );
}

function tableDigest(table: LogicalTableDump): string {
  const hash = createHash("sha256");
  hash.update(`${table.name}\0${stableStringify(table.columns)}\0`);
  for (const row of table.rows) hash.update(`${stableStringify(row)}\0`);
  return hash.digest("hex");
}

function assertRecoveryKey(recoveryKey: string): void {
  if (typeof recoveryKey !== "string" || recoveryKey.trim().length < MINIMUM_RECOVERY_KEY_LENGTH) {
    throw new BackupError(
      "BACKUP_RECOVERY_KEY_WEAK",
      `Recovery key must be at least ${String(MINIMUM_RECOVERY_KEY_LENGTH)} characters.`
    );
  }
}

function assertIsoTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new BackupError("BACKUP_SOURCE_INVALID", "Backup timestamp must be an ISO-8601 UTC instant.");
  }
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= LOGICAL_BACKUP_LIMITS.maxTableNameLength
    && TABLE_NAME_PATTERN.test(value);
}

function assertBoundedTables(tables: readonly LogicalTableDump[]): void {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new BackupError("BACKUP_SOURCE_INVALID", "A logical backup needs at least one table.");
  }
  if (tables.length > LOGICAL_BACKUP_LIMITS.maxTables) {
    throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup holds more tables than this build can restore.");
  }
  const seen = new Set<string>();
  for (const table of tables) {
    if (!isSafeIdentifier(table?.name)) {
      throw new BackupError("BACKUP_SOURCE_INVALID", "Backup table names must be plain identifiers.");
    }
    if (seen.has(table.name)) {
      throw new BackupError("BACKUP_SOURCE_INVALID", `Backup table ${table.name} appears twice.`);
    }
    seen.add(table.name);
    if (!Array.isArray(table.columns) || table.columns.length === 0
      || !table.columns.every(isSafeIdentifier)
      || new Set(table.columns).size !== table.columns.length) {
      throw new BackupError("BACKUP_SOURCE_INVALID", `Backup table ${table.name} has invalid columns.`);
    }
    if (table.generatedColumns !== undefined) {
      if (!Array.isArray(table.generatedColumns)
        || !table.generatedColumns.every(isSafeIdentifier)
        || new Set(table.generatedColumns).size !== table.generatedColumns.length
        || !table.generatedColumns.every(
          (column: unknown) => typeof column === "string" && table.columns.includes(column)
        )) {
        throw new BackupError("BACKUP_SOURCE_INVALID", `Backup table ${table.name} has invalid generated columns.`);
      }
    }
    if (!Array.isArray(table.rows)) {
      throw new BackupError("BACKUP_SOURCE_INVALID", `Backup table ${table.name} has invalid rows.`);
    }
    if (table.rows.length > LOGICAL_BACKUP_LIMITS.maxRowsPerTable) {
      throw new BackupError("BACKUP_LIMIT_EXCEEDED", `Backup table ${table.name} holds more rows than this build can restore.`);
    }
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== table.columns.length) {
        throw new BackupError("BACKUP_SOURCE_INVALID", `Backup table ${table.name} has a row that does not match its columns.`);
      }
    }
  }
}

function deriveKey(recoveryKey: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scryptCallback(
      recoveryKey.normalize("NFKC"),
      salt,
      32,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error) {
          reject(new BackupError("BACKUP_DECRYPT_FAILED", "Recovery key could not be derived.", { cause: error }));
          return;
        }
        resolvePromise(Buffer.from(key));
      }
    );
  });
}

function decodeBase64(value: unknown, exactBytes?: number): Buffer {
  if (typeof value !== "string" || !value) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup archive field is not base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup archive field is not base64.");
  }
  if (exactBytes !== undefined && decoded.byteLength !== exactBytes) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup archive field has an invalid byte length.");
  }
  return decoded;
}

export async function createLogicalBackup(input: CreateLogicalBackupInput): Promise<Buffer> {
  assertRecoveryKey(input.recoveryKey);
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertIsoTimestamp(createdAt);
  assertBoundedTables(input.tables);

  const tables = input.tables.map((table) => ({
    name: table.name,
    columns: [...table.columns],
    rows: table.rows.map((row) => [...row]),
    // Restore needs this to override a GENERATED ALWAYS column; dropping it
    // here made every archive unrestorable for tables that have one.
    ...(table.generatedColumns && table.generatedColumns.length > 0
      ? { generatedColumns: [...table.generatedColumns] }
      : {})
  }));
  const manifest: LogicalBackupManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt,
    tables: tables.map((table) => ({
      name: table.name,
      columns: table.columns,
      rowCount: table.rows.length,
      sha256: tableDigest(table)
    }))
  };

  const serialized = Buffer.from(JSON.stringify({ manifest, tables } satisfies LogicalBackupPayloadV1), "utf8");
  if (serialized.byteLength > LOGICAL_BACKUP_LIMITS.maxPayloadBytes) {
    throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup holds more data than this build can restore.");
  }

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(input.recoveryKey, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(serialized), cipher.final()]);
    const envelope: LogicalArchiveEnvelopeV1 = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      kdf: { name: "scrypt", salt: salt.toString("base64"), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
      ciphertext: ciphertext.toString("base64")
    };
    const archive = Buffer.from(JSON.stringify(envelope), "utf8");
    if (archive.byteLength > LOGICAL_BACKUP_LIMITS.maxArchiveBytes) {
      throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup archive exceeds the restorable size.");
    }
    return archive;
  } finally {
    key.fill(0);
    serialized.fill(0);
  }
}

function parseEnvelope(archive: Buffer): LogicalArchiveEnvelopeV1 {
  if (!Buffer.isBuffer(archive) || archive.byteLength === 0) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup archive is empty.");
  }
  if (archive.byteLength > LOGICAL_BACKUP_LIMITS.maxArchiveBytes) {
    throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup archive exceeds the restorable size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(archive.toString("utf8")) as unknown;
  } catch (error) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup archive is not valid JSON.", { cause: error });
  }
  const envelope = parsed as LogicalArchiveEnvelopeV1;
  if (envelope?.format !== ARCHIVE_FORMAT || envelope.version !== ARCHIVE_VERSION
    || envelope.kdf?.name !== "scrypt" || envelope.cipher?.name !== "aes-256-gcm") {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup archive is not a supported logical backup.");
  }
  // Reject caller-supplied KDF parameters: an archive must not be able to talk
  // this build into a cheap derivation.
  if (envelope.kdf.N !== SCRYPT_N || envelope.kdf.r !== SCRYPT_R
    || envelope.kdf.p !== SCRYPT_P || envelope.kdf.maxmem !== SCRYPT_MAXMEM) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup archive declares unsupported key-derivation parameters.");
  }
  return envelope;
}

export async function planLogicalRestore(input: PlanLogicalRestoreInput): Promise<LogicalRestorePlan> {
  assertRecoveryKey(input.recoveryKey);
  const envelope = parseEnvelope(input.archive);
  const salt = decodeBase64(envelope.kdf.salt, SALT_BYTES);
  const iv = decodeBase64(envelope.cipher.iv, IV_BYTES);
  const tag = decodeBase64(envelope.cipher.tag, AUTH_TAG_BYTES);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (ciphertext.byteLength > LOGICAL_BACKUP_LIMITS.maxPayloadBytes) {
    throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup payload exceeds the restorable size.");
  }
  const key = await deriveKey(input.recoveryKey, salt);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new BackupError(
      "BACKUP_DECRYPT_FAILED",
      "Backup archive could not be decrypted with this recovery key.",
      { cause: error }
    );
  } finally {
    key.fill(0);
  }

  let payload: LogicalBackupPayloadV1;
  try {
    payload = JSON.parse(plaintext.toString("utf8")) as LogicalBackupPayloadV1;
  } catch (error) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Decrypted backup payload is not valid JSON.", { cause: error });
  } finally {
    plaintext.fill(0);
  }

  const manifest = payload?.manifest;
  if (manifest?.format !== ARCHIVE_FORMAT || manifest.version !== ARCHIVE_VERSION
    || typeof manifest.createdAt !== "string" || !Array.isArray(manifest.tables)) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup manifest is missing or unsupported.");
  }
  assertIsoTimestamp(manifest.createdAt);
  assertBoundedTables(payload.tables ?? []);
  if (manifest.tables.length !== payload.tables.length) {
    throw new BackupError("BACKUP_FILE_INTEGRITY_INVALID", "Backup manifest does not describe every archived table.");
  }

  const byName = new Map(payload.tables.map((table) => [table.name, table]));
  for (const entry of manifest.tables) {
    const table = byName.get(entry.name);
    if (!table) {
      throw new BackupError("BACKUP_FILE_INTEGRITY_INVALID", `Backup is missing table ${String(entry.name)}.`);
    }
    if (entry.rowCount !== table.rows.length
      || stableStringify(entry.columns) !== stableStringify(table.columns)
      || entry.sha256 !== tableDigest(table)) {
      throw new BackupError("BACKUP_FILE_INTEGRITY_INVALID", `Backup table ${table.name} failed its integrity check.`);
    }
  }

  return {
    createdAt: manifest.createdAt,
    tables: payload.tables.map((table) => ({
      name: table.name,
      columns: table.columns,
      rowCount: table.rows.length
    })),
    totalRows: payload.tables.reduce((total, table) => total + table.rows.length, 0),
    [restoreTables]: payload.tables
  };
}
