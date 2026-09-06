import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import {
  backupScryptPolicy,
  CURRENT_BACKUP_ARCHIVE_VERSION,
  LEGACY_BACKUP_ARCHIVE_VERSION,
  type BackupArchiveVersion,
  type BackupScryptParameters
} from "./crypto-policy.ts";
import { BackupError } from "./errors.ts";

const ARCHIVE_FORMAT = "blogbot-portable-backup";
const ARCHIVE_VERSION = CURRENT_BACKUP_ARCHIVE_VERSION;
const RESTORE_PLAN_VERSION = 1;
const MINIMUM_RECOVERY_KEY_LENGTH = 16;
// Restore is intentionally bounded below the protocol's raw archive ceiling.
// AES-GCM decryption and the JSON/base64 envelope transiently co-exist, so a
// bounded decoded payload prevents a user-triggered restore from freezing the
// single local engine through unbounded heap amplification.
const MAX_RESTORE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_RESTORE_FILES = 256;
const MAX_RESTORE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESTORE_DECODED_BYTES = 128 * 1024 * 1024;
const restorePayload = Symbol("restorePayload");

interface PortableArchiveEnvelope {
  format: typeof ARCHIVE_FORMAT;
  version: BackupArchiveVersion;
  kdf: BackupScryptParameters & {
    name: "scrypt";
    salt: string;
  };
  cipher: {
    name: "aes-256-gcm";
    iv: string;
    tag: string;
  };
  ciphertext: string;
}

interface PortableBackupPayload {
  manifest: {
    format: typeof ARCHIVE_FORMAT;
    version: BackupArchiveVersion;
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

/** Internal trusted material from a validated restore plan for a native writer. */
export function nativeRestoreEntries(plan: PortableRestorePlan): ReadonlyArray<{ path: string; data: Buffer }> {
  assertRestorePlan(plan);
  return plan[restorePayload].map((entry) => ({ path: entry.relativePath, data: entry.data }));
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

  // The restore path enforces these same three bounds. Enforcing them only there
  // let this function report a successful backup that no verify or restore in
  // this build can ever read back — a false success in the one path a user
  // depends on for recovery.
  if (paths.length > MAX_RESTORE_FILES) {
    throw new BackupError(
      "BACKUP_LIMIT_EXCEEDED",
      "Backup holds more files than this build can restore"
    );
  }

  const manifestFiles: PortableBackupFileManifest[] = [];
  const payloadFiles: PortableBackupPayload["files"] = [];
  let decodedBytes = 0;
  for (const relativePath of paths) {
    const data = readBackupSourceFile(sourceDirectory, relativePath);
    if (data.byteLength > MAX_RESTORE_FILE_BYTES) {
      throw new BackupError(
        "BACKUP_LIMIT_EXCEEDED",
        "Backup holds a file larger than this build can restore"
      );
    }
    decodedBytes += data.byteLength;
    if (decodedBytes > MAX_RESTORE_DECODED_BYTES) {
      throw new BackupError(
        "BACKUP_LIMIT_EXCEEDED",
        "Backup holds more data than this build can restore"
      );
    }
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

  const payload: PortableBackupPayload = {
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
  if (input.archive.byteLength > MAX_RESTORE_ARCHIVE_BYTES) {
    throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup archive exceeds the supported restore limit.");
  }
  const envelope = parseEnvelope(input.archive);
  const payload = await decryptPayload(envelope, input.recoveryKey);
  const verified = verifyPayload(payload, envelope.version);
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
  // `verifyPayload` has already allocated and authenticated these buffers.
  // Keep the immutable plan bound to that trusted payload instead of taking a
  // second complete copy of a potentially large backup in the Node heap.
  const internalEntries = verified.entries;

  return Object.freeze({
    kind: "blogbot-portable-restore-plan" as const,
    version: RESTORE_PLAN_VERSION,
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
  payload: PortableBackupPayload,
  recoveryKey: string
): Promise<Buffer> {
  const kdf = backupScryptPolicy(ARCHIVE_VERSION);
  if (!kdf) {
    throw new BackupError("BACKUP_ARCHIVE_INVALID", "Backup cryptographic policy is unavailable.");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(recoveryKey, salt, kdf, true);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
      cipher.final()
    ]);
    const envelope: PortableArchiveEnvelope = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      kdf: {
        name: "scrypt",
        salt: salt.toString("base64"),
        ...kdf
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
  envelope: PortableArchiveEnvelope,
  recoveryKey: string
): Promise<unknown> {
  const salt = decodeBase64(envelope.kdf.salt);
  const iv = decodeBase64(envelope.cipher.iv);
  const tag = decodeBase64(envelope.cipher.tag);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = await deriveKey(
    recoveryKey,
    salt,
    envelope.kdf,
    envelope.version !== LEGACY_BACKUP_ARCHIVE_VERSION
  );
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

function parseEnvelope(archive: Buffer): PortableArchiveEnvelope {
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
  const policy = isRecord(value) ? backupScryptPolicy(value.version) : undefined;
  if (
    !isRecord(value) ||
    value.format !== ARCHIVE_FORMAT ||
    !policy ||
    !isRecord(value.kdf) ||
    value.kdf.name !== "scrypt" ||
    value.kdf.N !== policy.N ||
    value.kdf.r !== policy.r ||
    value.kdf.p !== policy.p ||
    value.kdf.maxmem !== policy.maxmem ||
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
  const envelope = value as unknown as PortableArchiveEnvelope;
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

function verifyPayload(
  value: unknown,
  archiveVersion: BackupArchiveVersion
): {
  createdAt: string;
  entries: RestorePayloadEntry[];
} {
  if (
    !isRecord(value) ||
    !isRecord(value.manifest) ||
    value.manifest.format !== ARCHIVE_FORMAT ||
    value.manifest.version !== archiveVersion ||
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
  if (manifestFiles.length > MAX_RESTORE_FILES) {
    throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup contains too many files to restore safely.");
  }

  const seen = new Set<string>();
  let decodedBytes = 0;
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
    if (manifestValue.size > MAX_RESTORE_FILE_BYTES) {
      throw new BackupError("BACKUP_LIMIT_EXCEEDED", `Backup file exceeds the restore size limit: ${relativePath}`);
    }
    decodedBytes += manifestValue.size;
    if (decodedBytes > MAX_RESTORE_DECODED_BYTES) {
      throw new BackupError("BACKUP_LIMIT_EXCEEDED", "Backup decoded content exceeds the restore size limit.");
    }
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
    plan.version !== RESTORE_PLAN_VERSION ||
    !Array.isArray(plan.entries) ||
    !Array.isArray(plan[restorePayload]) ||
    plan.entries.length !== plan[restorePayload].length
  ) {
    throw new BackupError("RESTORE_PLAN_INVALID", "Restore plan is invalid.");
  }
}

function readBackupSourceFile(sourceDirectory: string, relativePath: string): Buffer {
  const sourcePath = safeTargetPath(sourceDirectory, relativePath);
  let descriptor: number | undefined;
  try {
    const canonicalRoot = realpathSync.native(sourceDirectory);
    assertNoReparsePointTraversal(sourceDirectory, relativePath);
    assertCanonicalPathWithinRoot(canonicalRoot, realpathSync.native(sourcePath), relativePath);

    // O_NOFOLLOW protects the final component where the platform supports it.
    // The repeated ancestor and identity checks fail closed if a component is
    // exchanged while the file is being opened or read.
    descriptor = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedBeforeRead = fstatSync(descriptor);
    if (!openedBeforeRead.isFile() || openedBeforeRead.isSymbolicLink()) {
      throw new BackupError(
        "BACKUP_SOURCE_INVALID",
        `Backup source must be a regular file: ${relativePath}`
      );
    }
    const data = readFileSync(descriptor);
    const openedAfterRead = fstatSync(descriptor);
    assertSameFile(openedBeforeRead, openedAfterRead, relativePath);

    assertNoReparsePointTraversal(sourceDirectory, relativePath);
    assertCanonicalPathWithinRoot(canonicalRoot, realpathSync.native(sourcePath), relativePath);
    const current = lstatSync(sourcePath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new BackupError(
        "BACKUP_SOURCE_INVALID",
        `Backup source must remain a regular file: ${relativePath}`
      );
    }
    assertSameFile(openedAfterRead, current, relativePath);
    return data;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "BACKUP_SOURCE_INVALID",
      `Backup source file is unavailable or unsafe: ${relativePath}`,
      { cause: error }
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertNoReparsePointTraversal(root: string, relativePath: string): void {
  const components = normalizeBackupPath(relativePath).split("/");
  let current = resolve(root);
  const rootInfo = lstatSync(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new BackupError("BACKUP_SOURCE_INVALID", "Backup source root must be a regular directory.");
  }
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new BackupError(
        "BACKUP_SOURCE_INVALID",
        `Backup source path traverses a link or non-directory: ${relativePath}`
      );
    }
  }
}

function assertCanonicalPathWithinRoot(
  canonicalRoot: string,
  canonicalPath: string,
  relativePath: string
): void {
  const relation = relative(canonicalRoot, canonicalPath);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith("../") ||
    relation.startsWith("..\\") ||
    isAbsolute(relation)
  ) {
    throw new BackupError(
      "BACKUP_SOURCE_INVALID",
      `Backup source resolves outside its root: ${relativePath}`
    );
  }
}

function assertSameFile(
  before: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number },
  after: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number },
  relativePath: string
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new BackupError(
      "BACKUP_SOURCE_INVALID",
      `Backup source changed while it was being read: ${relativePath}`
    );
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

const windowsReservedBackupSegment =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;

function isUnsafeWindowsBackupSegment(value: string): boolean {
  return value === "." ||
    value === ".." ||
    /[<>:"|?*]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f) ||
    /[ .]$/u.test(value) ||
    windowsReservedBackupSegment.test(value);
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
    normalized.startsWith("/") ||
    normalized.split("/").some(isUnsafeWindowsBackupSegment)
  ) {
    throw new BackupError("BACKUP_PATH_UNSAFE", `Unsafe backup path: ${value}`);
  }
  return normalized;
}

function safeTargetPath(root: string, relativePath: string): string {
  const normalized = normalizeBackupPath(relativePath);
  const target = resolve(root, ...normalized.split("/"));
  const relation = relative(resolve(root), target);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith("../") ||
    relation.startsWith("..\\") ||
    isAbsolute(relation)
  ) {
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

function deriveKey(
  recoveryKey: string,
  salt: Buffer,
  parameters: Readonly<BackupScryptParameters>,
  normalize: boolean
): Promise<Buffer> {
  return new Promise((resolveKey, rejectKey) => {
    scryptCallback(
      normalize ? recoveryKey.normalize("NFKC") : recoveryKey,
      salt,
      32,
      parameters,
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
