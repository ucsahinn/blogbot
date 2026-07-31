import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { BackupError } from "./errors.ts";

const ARCHIVE_FORMAT = "blogbot-portable-backup";
const ARCHIVE_VERSION = 1;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MINIMUM_RECOVERY_KEY_LENGTH = 16;
const restorePayload = Symbol("restorePayload");

interface PortableArchiveEnvelopeV1 {
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
  cipher: {
    name: "aes-256-gcm";
    iv: string;
    tag: string;
  };
  ciphertext: string;
}

interface PortableBackupPayloadV1 {
  manifest: {
    format: typeof ARCHIVE_FORMAT;
    version: typeof ARCHIVE_VERSION;
    createdAt: string;
    files: PortableBackupFileManifest[];
  };
  files: Array<{
    path: string;
    data: string;
  }>;
}

interface PortableBackupFileManifest {
  path: string;
  size: number;
  sha256: string;
}

interface RestorePayloadEntry {
  relativePath: string;
  data: Buffer;
  size: number;
  sha256: string;
}

export interface CreatePortableBackupInput {
  sourceDirectory: string;
  relativePaths: readonly string[];
  recoveryKey: string;
  createdAt?: string;
}

export interface PortableRestorePlan {
  kind: "blogbot-portable-restore-plan";
  version: 1;
  archiveSha256: string;
  createdAt: string;
  targetDirectory: string;
  entries: ReadonlyArray<{
    relativePath: string;
    targetPath: string;
    size: number;
    sha256: string;
    status: "create" | "conflict";
  }>;
  [restorePayload]: readonly RestorePayloadEntry[];
}

export interface PlanPortableRestoreInput {
  archive: Buffer;
  recoveryKey: string;
  targetDirectory: string;
}

export async function createPortableBackup(
  input: CreatePortableBackupInput
): Promise<Buffer> {
  assertRecoveryKey(input.recoveryKey);
  const sourceDirectory = resolve(input.sourceDirectory);
  const paths = normalizeUniquePaths(input.relativePaths);
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertIsoTimestamp(createdAt);

  const manifestFiles: PortableBackupFileManifest[] = [];
  const payloadFiles: PortableBackupPayloadV1["files"] = [];
  for (const relativePath of paths) {
    const sourcePath = safeTargetPath(sourceDirectory, relativePath);
    let stat;
    try {
      stat = lstatSync(sourcePath);
    } catch (error) {
      throw new BackupError(
        "BACKUP_SOURCE_INVALID",
        `Backup source file is unavailable: ${relativePath}`,
        { cause: error }
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new BackupError(
        "BACKUP_SOURCE_INVALID",
        `Backup source must be a regular file: ${relativePath}`
      );
    }
    const data = readFileSync(sourcePath);
    manifestFiles.push({
      path: relativePath,
      size: data.byteLength,
      sha256: sha256(data)
    });
    payloadFiles.push({
      path: relativePath,
      data: data.toString("base64")
    });
  }

  const payload: PortableBackupPayloadV1 = {
    manifest: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      createdAt,
      files: manifestFiles
    },
    files: payloadFiles
  };
  return encryptPayload(payload, input.recoveryKey);
}

export async function planPortableRestore(
  input: PlanPortableRestoreInput
): Promise<PortableRestorePlan> {
  assertRecoveryKey(input.recoveryKey);
  const envelope = parseEnvelope(input.archive);
  const payload = await decryptPayload(envelope, input.recoveryKey);
  const verified = verifyPayload(payload);
  const targetDirectory = resolve(input.targetDirectory);
  const rootExists = existsSync(targetDirectory);
  const entries = verified.entries.map((entry) =>
    Object.freeze({
      relativePath: entry.relativePath,
      targetPath: safeTargetPath(targetDirectory, entry.relativePath),
      size: entry.size,
      sha256: entry.sha256,
      status: rootExists ? ("conflict" as const) : ("create" as const)
    })
  );
  const internalEntries = verified.entries.map((entry) => ({
    ...entry,
    data: Buffer.from(entry.data)
  }));

  return Object.freeze({
    kind: "blogbot-portable-restore-plan" as const,
    version: ARCHIVE_VERSION,
    archiveSha256: sha256(input.archive),
    createdAt: verified.createdAt,
    targetDirectory,
    entries: Object.freeze(entries),
    [restorePayload]: Object.freeze(internalEntries)
  });
}

export async function applyPortableRestorePlan(
  plan: PortableRestorePlan
): Promise<void> {
  assertRestorePlan(plan);
  if (existsSync(plan.targetDirectory)) {
    throw new BackupError(
      "RESTORE_TARGET_EXISTS",
      "Restore target already exists; choose an empty new target."
    );
  }

  for (const entry of plan[restorePayload]) {
    verifyFile(entry.relativePath, entry.data, entry.size, entry.sha256);
    const expectedTarget = safeTargetPath(
      plan.targetDirectory,
      entry.relativePath
    );
    const publicEntry = plan.entries.find(
      (candidate) => candidate.relativePath === entry.relativePath
    );
    if (publicEntry?.targetPath !== expectedTarget) {
      throw new BackupError(
        "RESTORE_PLAN_INVALID",
        `Restore plan target changed: ${entry.relativePath}`
      );
    }
  }

  const parentDirectory = dirname(plan.targetDirectory);
  mkdirSync(parentDirectory, { recursive: true });
  const stagingDirectory = mkdtempSync(
    join(parentDirectory, `.${basename(plan.targetDirectory)}.restore-`)
  );
  try {
    for (const entry of plan[restorePayload]) {
      const outputPath = safeTargetPath(stagingDirectory, entry.relativePath);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, entry.data, { flag: "wx" });
    }
    if (existsSync(plan.targetDirectory)) {
      throw new BackupError(
        "RESTORE_TARGET_EXISTS",
        "Restore target appeared while restore was being prepared."
      );
    }
    renameSync(stagingDirectory, plan.targetDirectory);
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function encryptPayload(
  payload: PortableBackupPayloadV1,
  recoveryKey: string
): Promise<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(recoveryKey, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
      cipher.final()
    ]);
    const envelope: PortableArchiveEnvelopeV1 = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      kdf: {
        name: "scrypt",
        salt: salt.toString("base64"),
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM
      },
      cipher: {
        name: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64")
      },
      ciphertext: ciphertext.toString("base64")
    };
    return Buffer.from(JSON.stringify(envelope), "utf8");
  } finally {
    key.fill(0);
  }
}

async function decryptPayload(
  envelope: PortableArchiveEnvelopeV1,
  recoveryKey: string
): Promise<unknown> {
  const salt = decodeBase64(envelope.kdf.salt);
  const iv = decodeBase64(envelope.cipher.iv);
  const tag = decodeBase64(envelope.cipher.tag);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = await deriveKey(recoveryKey, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    try {
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch (error) {
      throw new BackupError(
        "BACKUP_ARCHIVE_INVALID",
        "Decrypted backup payload is not valid JSON.",
        { cause: error }
      );
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(
      "BACKUP_DECRYPT_FAILED",
      "Backup could not be decrypted with this recovery key.",
      { cause: error }
    );
  } finally {
    key.fill(0);
  }
}

function parseEnvelope(archive: Buffer): PortableArchiveEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(archive.toString("utf8")) as unknown;
  } catch (error) {
    throw new BackupError(
      "BACKUP_ARCHIVE_INVALID",
      "Backup archive is not valid JSON.",
      { cause: error }
    );
  }
  if (
    !isRecord(value) ||
    value.format !== ARCHIVE_FORMAT ||
    value.version !== ARCHIVE_VERSION ||
    !isRecord(value.kdf) ||
    value.kdf.name !== "scrypt" ||
    value.kdf.N !== SCRYPT_N ||
    value.kdf.r !== SCRYPT_R ||
    value.kdf.p !== SCRYPT_P ||
    value.kdf.maxmem !== SCRYPT_MAXMEM ||
    typeof value.kdf.salt !== "string" ||
    !isRecord(value.cipher) ||
    value.cipher.name !== "aes-256-gcm" ||
    typeof value.cipher.iv !== "string" ||
    typeof value.cipher.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new BackupError(
      "BACKUP_ARCHIVE_INVALID",
      "Backup archive format or cryptographic parameters are unsupported."
    );
  }
  const envelope = value as unknown as PortableArchiveEnvelopeV1;
  if (
    decodeBase64(envelope.kdf.salt).byteLength !== 16 ||
    decodeBase64(envelope.cipher.iv).byteLength !== 12 ||
    decodeBase64(envelope.cipher.tag).byteLength !== 16
  ) {
    throw new BackupError(
      "BACKUP_ARCHIVE_INVALID",
      "Backup archive cryptographic fields are malformed."
    );
  }
  return envelope;
}

function verifyPayload(value: unknown): {
  createdAt: string;
  entries: RestorePayloadEntry[];
} {
  if (
    !isRecord(value) ||
    !isRecord(value.manifest) ||
    value.manifest.format !== ARCHIVE_FORMAT ||
    value.manifest.version !== ARCHIVE_VERSION ||
    typeof value.manifest.createdAt !== "string" ||
    !Array.isArray(value.manifest.files) ||
    !Array.isArray(value.files)
  ) {
    throw new BackupError(
      "BACKUP_ARCHIVE_INVALID",
      "Backup manifest is missing or unsupported."
    );
  }
  const createdAt = value.manifest.createdAt;
  const manifestFiles = value.manifest.files;
  const payloadFiles = value.files;
  assertIsoTimestamp(createdAt);
  if (manifestFiles.length !== payloadFiles.length) {
    throw new BackupError(
      "BACKUP_FILE_INTEGRITY_INVALID",
      "Backup manifest and payload file counts differ."
    );
  }

  const seen = new Set<string>();
  const entries = manifestFiles.map((manifestValue, index) => {
    const payloadValue = payloadFiles[index];
    if (
      !isRecord(manifestValue) ||
      typeof manifestValue.path !== "string" ||
      typeof manifestValue.size !== "number" ||
      !Number.isSafeInteger(manifestValue.size) ||
      manifestValue.size < 0 ||
      typeof manifestValue.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifestValue.sha256) ||
      !isRecord(payloadValue) ||
      payloadValue.path !== manifestValue.path ||
      typeof payloadValue.data !== "string"
    ) {
      throw new BackupError(
        "BACKUP_FILE_INTEGRITY_INVALID",
        `Backup file record ${index} is malformed.`
      );
    }
    const relativePath = normalizeBackupPath(manifestValue.path);
    const caseFolded = relativePath.toLocaleLowerCase("en-US");
    if (seen.has(caseFolded)) {
      throw new BackupError(
        "BACKUP_FILE_INTEGRITY_INVALID",
        `Backup contains a duplicate path: ${relativePath}`
      );
    }
    seen.add(caseFolded);
    const data = decodeBase64(payloadValue.data);
    verifyFile(relativePath, data, manifestValue.size, manifestValue.sha256);
    return {
      relativePath,
      data,
      size: manifestValue.size,
      sha256: manifestValue.sha256
    };
  });
  return { createdAt, entries };
}

function verifyFile(
  relativePath: string,
  data: Buffer,
  expectedSize: number,
  expectedHash: string
): void {
  if (data.byteLength !== expectedSize || sha256(data) !== expectedHash) {
    throw new BackupError(
      "BACKUP_FILE_INTEGRITY_INVALID",
      `Backup file integrity check failed: ${relativePath}`
    );
  }
}

function assertRestorePlan(plan: PortableRestorePlan): void {
  if (
    plan.kind !== "blogbot-portable-restore-plan" ||
    plan.version !== ARCHIVE_VERSION ||
    !Array.isArray(plan.entries) ||
    !Array.isArray(plan[restorePayload]) ||
    plan.entries.length !== plan[restorePayload].length
  ) {
    throw new BackupError("RESTORE_PLAN_INVALID", "Restore plan is invalid.");
  }
}

function normalizeUniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.map((path) => {
    const normalized = normalizeBackupPath(path);
    const caseFolded = normalized.toLocaleLowerCase("en-US");
    if (seen.has(caseFolded)) {
      throw new BackupError(
        "BACKUP_PATH_UNSAFE",
        `Duplicate backup path: ${normalized}`
      );
    }
    seen.add(caseFolded);
    return normalized;
  });
}

function normalizeBackupPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new BackupError("BACKUP_PATH_UNSAFE", `Unsafe backup path: ${value}`);
  }
  const slashPath = value.replaceAll("\\", "/");
  const normalized = posix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new BackupError("BACKUP_PATH_UNSAFE", `Unsafe backup path: ${value}`);
  }
  return normalized;
}

function safeTargetPath(root: string, relativePath: string): string {
  const normalized = normalizeBackupPath(relativePath);
  const target = resolve(root, ...normalized.split("/"));
  const relation = relative(resolve(root), target);
  if (relation === "" || relation === ".." || relation.startsWith(`..\\`) || isAbsolute(relation)) {
    throw new BackupError(
      "BACKUP_PATH_UNSAFE",
      `Backup path escapes its root: ${relativePath}`
    );
  }
  return target;
}

function assertRecoveryKey(recoveryKey: string): void {
  if (recoveryKey.trim().length < MINIMUM_RECOVERY_KEY_LENGTH) {
    throw new BackupError(
      "BACKUP_RECOVERY_KEY_WEAK",
      "Recovery key must contain at least 16 non-whitespace characters."
    );
  }
}

function assertIsoTimestamp(value: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new BackupError(
      "BACKUP_ARCHIVE_INVALID",
      "Backup timestamp must be a canonical ISO-8601 UTC timestamp."
    );
  }
}

function deriveKey(recoveryKey: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, rejectKey) => {
    scryptCallback(
      recoveryKey,
      salt,
      32,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM
      },
      (error, derivedKey) => {
        if (error) {
          rejectKey(error);
          return;
        }
        resolveKey(Buffer.from(derivedKey));
      }
    );
  });
}

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new BackupError(
      "BACKUP_ARCHIVE_INVALID",
      "Backup archive contains malformed base64 data."
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new BackupError(
      "BACKUP_ARCHIVE_INVALID",
      "Backup archive contains non-canonical base64 data."
    );
  }
  return decoded;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
