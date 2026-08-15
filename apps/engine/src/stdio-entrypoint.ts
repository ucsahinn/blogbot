import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { lstat, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  fetchSource,
  type FetchTransport
} from "../../fetcher/src/fetch-source.ts";
import { createNodeFetchTransport } from "../../fetcher/src/node-transport.ts";
import { createFetcherSidecarTransport } from "./fetcher-sidecar-transport.ts";
import { validateEngineCommandV1 } from "../../../packages/contracts/src/index.ts";
import type { BackendJob, BackendRepository, BackendRepositoryTransaction } from "../../../packages/database/src/backend-repository.ts";
import { InMemoryBackendStore } from "../../../packages/database/src/in-memory-backend-store.ts";
import { PGliteBackendRepository } from "../../../packages/database/src/pglite-backend-repository.ts";
import {
  PGliteSourceRepository,
  SourceRepositoryError,
  sourceCapabilitiesFor,
  type SourceRepository
} from "../../../packages/database/src/source-repository.ts";
import {
  canonicalJson,
  computeRevisionHash,
  evaluatePublishEligibility,
  validateApprovalGates,
  validateClaimEvidence,
  validateRevisionPackageV2,
  type Approval,
  type ArticleRevision,
  type HighRiskApproval
} from "../../../packages/editorial/src/revision.ts";
import { createEditedRevision } from "../../../packages/editorial/src/workflow.ts";
import {
  analyzeSourceDocument,
  SourceDocumentError
} from "../../../packages/security/src/source-document.ts";
import { assertSafeSourceUrl } from "../../../packages/security/src/url-policy.ts";
import { createPortableBackup, nativeRestoreEntries, planPortableRestore } from "../../../packages/backup/src/portable-backup.ts";
import { planBackupRetention } from "../../../packages/backup/src/retention.ts";
import { LocalEngine } from "./local-engine.ts";
import { LocalQueueRuntime } from "./local-queue.ts";
import {
  SourceScanCoordinator,
  SourceScanWorker
} from "./source-scan.ts";
import { SourceScanScheduler } from "./source-scheduler.ts";
import { createCodexCliPort } from "../../codex-runner/src/cli-port.ts";
import type { StructuredCodexPort } from "../../codex-runner/src/structured-runner.ts";
import { createBobyGuideTask, type BobyGuideInput, type BobyGuideOutput } from "../../codex-runner/src/boby-guide-task.ts";
import { createCodexWorkerCoordinator, type CodexWorkSubmission, type CodexWorkerCoordinator } from "./codex-worker.ts";
import {
  createDraftCodexTaskResolver,
  finalizeReviewedRevision,
  generatedPackageFiles,
  isDraftCodexOutput,
  isFinalReviewCodexOutput,
  materializeDraftRevision
} from "./codex-draft.ts";
import { buildPublicationPreview } from "./publication-preview.ts";
import { PGliteCodexJobStore, PGliteCodexQueueAdapter, registerCodexQueueWorker } from "./pglite-codex-job-store.ts";
import { startPublicationOutboxWorker, type PublicationEffectProcessor, type PublicationOutboxWorker } from "./publication-outbox-worker.ts";
import { PublicationScheduler } from "./publication-scheduler.ts";
import { publicationIntentBinding } from "./publication-intent.ts";
import { renderCoverVariants, renderGeneratedImageVariants, type ArtDirection } from "../../../packages/visuals/src/index.ts";
import { imageGeneratorFromEnvironment, type ImageGeneratorPort } from "./imagegen-provider.ts";
import { isEngineMediaReference, type ApprovedPublicationCommand, type PublicationBundlePolicy, type PublicationEffectsPort, type PublicationFile } from "../../publisher/src/publication.ts";
import { createConnectorAwarePublicationProcessor, type PublicationRuntimeConnector } from "../../publisher/src/runtime.ts";
import type { DashboardSyncResult } from "../../../packages/database/src/backend-repository.ts";

const MAX_LINE_BYTES = 1_000_000;
// Keep restore verification bounded even when a compromised/local renderer
// points the engine at an unexpectedly large file.  Portable archives are
// intended for local application state, not unbounded disk imaging.
const MAX_BACKUP_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_AUTOMATIC_BACKUP_FILES = 256;
const PUBLICATION_PREVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
// Backup data is JSON/base64 encoded and then authenticated/encrypted. Keep
// raw input under half the archive limit so every successfully created backup
// remains readable by this build's verify/restore path.
const MAX_BACKUP_INPUT_BYTES = 128 * 1024 * 1024;
// Candidate triage is a projection, not a full archive browser. Reading and
// decrypting an unbounded feed catalog on every desktop refresh was the main
// source of multi-second freezes on large local workspaces.
const MAX_CANDIDATE_ENTRIES = 500;

async function applyRestoreThroughNativeWriter(plan: Awaited<ReturnType<typeof planPortableRestore>>): Promise<void> {
  const executable = process.env.BLOGBOT_SECURE_RESTORE_BIN?.trim();
  if (!executable) throw new Error("SECURE_RESTORE_SIDECAR_UNAVAILABLE");
  const payload = JSON.stringify({
    parentDirectory: dirname(plan.targetDirectory),
    targetName: basename(plan.targetDirectory),
    files: nativeRestoreEntries(plan).map((entry) => ({
      path: entry.path,
      base64: entry.data.toString("base64")
    }))
  });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.once("error", () => reject(new Error("SECURE_RESTORE_SIDECAR_UNAVAILABLE")));
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error("SECURE_RESTORE_WRITE_FAILED")));
    child.stdin.end(payload, "utf8");
  });
}

function trustedHighRiskChecklistHash(revision: ArticleRevision): string {
  const checklist = (revision.qualityGates ?? [])
    .filter((gate) => gate.group === "security")
    .map((gate) => ({ id: gate.id, state: gate.state, detail: gate.detail }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (checklist.length === 0) throw new Error("RISK_CHECKLIST_UNAVAILABLE");
  return createHash("sha256").update(canonicalJson(checklist), "utf8").digest("hex");
}

/** Exact bundles are only restart-recovery state, never permanent media storage. */
export function isPublicationPreviewCurrent(value: unknown, nowUnixMs = Date.now()): boolean {
  return typeof value === "object" && value !== null
    && Number.isSafeInteger((value as Record<string, unknown>).expiresAtUnixMs)
    && Number((value as Record<string, unknown>).expiresAtUnixMs) > nowUnixMs;
}

async function readDashboardSync(
  repository: BackendRepository,
  afterCursor: number,
  changeLimit?: number,
  outboxLimit?: number,
  jobLimit?: number
): Promise<DashboardSyncResult> {
  if (repository.syncDashboard) {
    return changeLimit === undefined
      ? repository.syncDashboard(afterCursor)
      : repository.syncDashboard(afterCursor, {
        changeLimit,
        ...(outboxLimit === undefined ? {} : { outboxLimit }),
        ...(jobLimit === undefined ? {} : { jobLimit })
      });
  }
  const sync = await repository.sync(afterCursor);
  return {
    serverCursor: sync.serverCursor,
    automation: sync.snapshot.automation,
    outbox: sync.snapshot.outbox,
    jobs: sync.snapshot.jobs,
    changes: sync.changes
  };
}

function dashboardJobSummary(job: BackendJob): Record<string, unknown> {
  const metadata = job.metadata ?? {};
  const boundedMetadata: Record<string, unknown> = {};
  for (const key of ["candidateId", "candidateTitle", "instruction", "section", "progressStage", "codexWaitReason", "scheduledAt"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) boundedMetadata[key] = value.trim().slice(0, 500);
  }
  for (const key of ["recoveryCount", "completedAtUnixMs", "lastQueuedAtUnixMs", "createdAtUnixMs"] as const) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) boundedMetadata[key] = value;
  }
  const errorCode = typeof job.lastError === "string"
    ? job.lastError.match(/[A-Z][A-Z0-9_]{2,}/u)?.[0]
    : undefined;
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    attempts: job.attempts,
    ...(errorCode ? { lastError: errorCode } : {}),
    ...(Object.keys(boundedMetadata).length > 0 ? { metadata: boundedMetadata } : {})
  };
}

/**
 * Background maintenance has no request/response caller to surface failures
 * to. Keep stdout reserved for NDJSON and emit only stable, secret-safe codes
 * to the engine diagnostics channel.
 */
export function reportBackgroundTaskFault(
  code: "SOURCE_RETENTION_UNAVAILABLE" | "AUTOMATIC_BACKUP_UNAVAILABLE" | "SOURCE_SCHEDULER_UNAVAILABLE" | "LOCAL_QUEUE_UNAVAILABLE",
  write: (line: string) => void = (line) => process.stderr.write(line),
  detail?: string
): void {
  try {
    const safeDetail = detail?.replace(/[^a-z]+/giu, "_").replace(/^_+|_+$/gu, "").slice(0, 32);
    write(`[Blogbot] ${code}${safeDetail ? ` phase=${safeDetail}` : ""}\n`);
  } catch {
    // Diagnostics are best-effort and must not crash the local engine.
  }
}

/**
 * Durable runner lifecycle telemetry intentionally contains no title, URL,
 * account identity, prompt, output, or error detail. It makes a stuck local
 * queue diagnosable without turning the diagnostic bundle into user data.
 */
export function reportCodexLifecycle(
  code: "CODEX_JOB_STARTED" | "CODEX_JOB_WAITING" | "CODEX_JOB_RETRYING" | "CODEX_JOB_COMPLETED" | "CODEX_PROTOCOL_REJECTED" | "CODEX_OUTPUT_INVALID" | "CODEX_OUTPUT_MISSING" | "CODEX_CLI_INVALID_EVENT" | "CODEX_CLI_INVALID_FINAL_OUTPUT" | "CODEX_PROCESS_FAILED" | "CODEX_UNKNOWN_FAILURE" | "IMAGEGEN_FALLBACK_LOCAL" | "IMAGEGEN_REQUIRED_FAILED" | "IMAGEGEN_REQUIRED_UNAVAILABLE",
  writeOrDetail: ((line: string) => void) | string = (line) => process.stderr.write(line),
  detail?: string
): void {
  try {
    const write = typeof writeOrDetail === "function" ? writeOrDetail : (line: string) => process.stderr.write(line);
    const safeDetail = detail
      ?.replace(/[A-Za-z]:\\[^\r\n ]+/gu, "[path]")
      .replace(/https?:\/\/[^\s]+/gu, "[url]")
      .replace(/\s+/gu, " ")
      .slice(0, 240);
    write(`[Blogbot] ${code}${safeDetail ? ` detail=${safeDetail}` : ""}\n`);
  } catch {
    // Diagnostics must never alter the durable job outcome.
  }
}

function publicationContentBytes(content: unknown): Buffer {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (Array.isArray(content) && content.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return Buffer.from(content);
  }
  throw new Error("APPROVAL_BOUND_FILE_CONTENT_INVALID");
}

function approvalBoundFilesDigest(files: readonly PublicationFile[]): string {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const content = publicationContentBytes(file.content);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(content.byteLength));
    digest.update(file.path, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(size);
    digest.update(content);
  }
  return digest.digest("hex");
}

/** A media reference is immutable only when it points to this exact revision. */
function engineMediaReference(content: unknown, revisionId: string): { sha256: string; size: number } | null {
  if (!isRecord(content) || content.kind !== "engine-media-ref" || content.revisionId !== revisionId) return null;
  const sha256 = typeof content.sha256 === "string" ? content.sha256 : "";
  const size = content.byteSize;
  return /^[a-f0-9]{64}$/iu.test(sha256) && Number.isSafeInteger(size) && Number(size) > 0
    ? { sha256: sha256.toLowerCase(), size: Number(size) }
    : null;
}

export function assertRevisionGeneratedFilesMatch(
  revision: Pick<ArticleRevision, "id" | "adapterVersion" | "generatedFiles">,
  payload: unknown
): void {
  if (!Array.isArray(revision.generatedFiles) || revision.generatedFiles.length === 0 || !isRecord(payload)) {
    throw new Error("APPROVAL_BOUND_FILE_SET_MISSING");
  }
  const { manifestPath } = revisionBundlePolicy(revision);
  if (!Array.isArray(payload.files)) {
    throw new Error("APPROVAL_BOUND_FILE_SET_MISSING");
  }
  const actual = new Map<string, { sha256: string; size: number }>();
  let manifestCount = 0;
  for (const candidate of payload.files) {
    if (!isRecord(candidate) || typeof candidate.path !== "string") {
      throw new Error("APPROVAL_BOUND_FILE_CONTENT_INVALID");
    }
    if (candidate.path === manifestPath) {
      manifestCount += 1;
      continue;
    }
    if (actual.has(candidate.path)) throw new Error("APPROVAL_BOUND_FILE_SET_MISMATCH");
    const reference = engineMediaReference(candidate.content, revision.id);
    if (reference) {
      actual.set(candidate.path, reference);
    } else {
      const bytes = publicationContentBytes(candidate.content);
      actual.set(candidate.path, {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength
      });
    }
  }
  if (manifestCount !== 1 || actual.size !== revision.generatedFiles.length) {
    throw new Error("APPROVAL_BOUND_FILE_SET_MISMATCH");
  }
  for (const expected of revision.generatedFiles) {
    const observed = actual.get(expected.path);
    if (!observed) throw new Error("APPROVAL_BOUND_FILE_SET_MISMATCH");
    if (observed.sha256 !== expected.sha256 || observed.size !== expected.size) {
      throw new Error("APPROVAL_BOUND_FILE_MISMATCH");
    }
  }
}

export function revisionBundlePolicy(
  revision: Pick<ArticleRevision, "id" | "adapterVersion" | "generatedFiles">
): PublicationBundlePolicy {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/iu.test(revision.id)) {
    throw new Error("APPROVAL_BOUND_MANIFEST_PATH_INVALID");
  }
  const generatedFiles = revision.generatedFiles ?? [];
  const identity = revision.adapterVersion?.trim() ?? "";
  const separator = identity.indexOf("@");
  const adapterId = separator > 0
    ? identity.slice(0, separator)
    : generatedFiles.some((file) => file.path.startsWith("src/content/articles/"))
      ? "astro-generic"
      : "local-folder-v1";
  const manifestPath = `.blogbot/manifests/${revision.id}.json`;
  return {
    adapterId,
    manifestPath,
    // Every non-manifest path is already immutable and hash-bound on the
    // approved revision. Exact paths avoid granting a renderer-selected
    // directory prefix while retaining adapter-neutral publication.
    allowedPathPrefixes: [...generatedFiles.map((file) => file.path), manifestPath]
  };
}

async function collectAutomaticBackupPaths(root: string): Promise<string[]> {
  const output: string[] = [];
  let totalBytes = 0;
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "backups" || entry.name.startsWith(".")) continue;
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const next = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(next, nextRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(next);
      totalBytes += info.size;
      if (output.length >= MAX_AUTOMATIC_BACKUP_FILES || totalBytes > MAX_BACKUP_INPUT_BYTES) {
        throw new Error("AUTOMATIC_BACKUP_LIMIT_EXCEEDED");
      }
      output.push(nextRelative);
    }
  }
  await walk(root, "");
  return output;
}

type MaintenanceCode = "SOURCE_RETENTION_UNAVAILABLE" | "AUTOMATIC_BACKUP_UNAVAILABLE";

async function runBackgroundMaintenance(
  repository: BackendRepository,
  key: "maintenance.source-retention" | "maintenance.automatic-backup",
  code: MaintenanceCode,
  work: () => Promise<unknown>
): Promise<void> {
  const attemptedAt = new Date().toISOString();
  try {
    await repository.setMaintenanceState(key, { attemptedAt, state: "RUNNING" });
  } catch {
    // Runtime shutdown may close PGlite while a fire-and-forget maintenance
    // probe is starting. Health bookkeeping must never revive that failure.
    reportBackgroundTaskFault(code);
    return;
  }
  try {
    const result = await work();
    if (isRecord(result) && result.ok === false) throw new Error(code);
    try {
      await repository.setMaintenanceState(key, { attemptedAt, succeededAt: new Date().toISOString(), state: "SUCCEEDED" });
    } catch {
      // The completed result is not changed by a concurrent engine shutdown.
    }
  } catch {
    try {
      await repository.setMaintenanceState(key, { attemptedAt, state: "FAILED", code });
    } catch {
      // PGlite may already be closed. Do not leak an unhandled rejection.
    }
    reportBackgroundTaskFault(code);
  }
}

async function assertBoundedBackupInput(root: string, relativePaths: readonly string[]): Promise<void> {
  let totalBytes = 0;
  const canonicalRoot = await realpath(root);
  const rootInfo = await lstat(resolve(root));
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("BACKUP_INPUT_ROOT_INVALID");
  for (const relativePath of relativePaths) {
    if (!relativePath || relativePath.includes("..") || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
      throw new Error("BACKUP_INPUT_PATH_INVALID");
    }
    let current = resolve(root);
    const components = relativePath.replaceAll("\\", "/").split("/");
    for (const component of components.slice(0, -1)) {
      current = join(current, component);
      const ancestor = await lstat(current);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw new Error("BACKUP_INPUT_PATH_INVALID");
    }
    const sourcePath = join(root, relativePath);
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("BACKUP_INPUT_FILE_INVALID");
    const canonicalPath = await realpath(sourcePath);
    const relation = relative(canonicalRoot, canonicalPath);
    if (relation === "" || relation === ".." || relation.startsWith(`..\\`) || isAbsolute(relation)) {
      throw new Error("BACKUP_INPUT_PATH_INVALID");
    }
    totalBytes += info.size;
    if (totalBytes > MAX_BACKUP_INPUT_BYTES) throw new Error("BACKUP_INPUT_LIMIT_EXCEEDED");
  }
}

function automaticBackupRecoveryKey(): string {
  const dataKey = process.env.BLOGBOT_DATA_KEY_HEX;
  if (!dataKey || !/^[a-f0-9]{64}$/iu.test(dataKey)) throw new Error("LOCAL_DATA_KEY_MISSING");
  return createHash("sha256").update(`${dataKey}\0blogbot-automatic-backup`, "utf8").digest("hex");
}

async function applyAutomaticBackupRetention(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const records = [] as Array<{ id: string; createdAt: string }>;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".backup")) continue;
    const file = join(directory, entry.name);
    const info = await stat(file);
    records.push({ id: entry.name, createdAt: info.mtime.toISOString() });
  }
  const plan = planBackupRetention(records, { daily: 14, weekly: 8 });
  for (const item of plan.remove) await unlink(join(directory, item.id));
}

interface AutomaticBackupRecord {
  name: string;
  bytes: number;
  createdAt: string;
}

async function listAutomaticBackups(directory: string): Promise<AutomaticBackupRecord[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    const records: AutomaticBackupRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^automatic-[A-Za-z0-9-]+\.backup$/u.test(entry.name)) continue;
      const info = await stat(join(directory, entry.name));
      records.push({ name: entry.name, bytes: info.size, createdAt: info.mtime.toISOString() });
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function resolveAutomaticBackupPath(directory: string, name: unknown): Promise<string> {
  if (typeof name !== "string" || !/^automatic-[A-Za-z0-9-]+\.backup$/u.test(name)) {
    throw new Error("AUTOMATIC_BACKUP_NAME_INVALID");
  }
  const record = (await listAutomaticBackups(directory)).find((entry) => entry.name === name);
  if (!record) throw new Error("AUTOMATIC_BACKUP_NOT_FOUND");
  return join(directory, record.name);
}

function createCandidateKey(sourceId: string, externalId: string): string {
  return createHash("sha256").update(`${sourceId}\0${externalId}`).digest("hex").slice(0, 24);
}

export interface EngineDoctorRequest {
  version: 1;
  id: string;
  kind: "doctor";
}

export interface EngineResponse {
  version: 1;
  id: string;
  ok: boolean;
  kind: string;
  [key: string]: unknown;
}

export interface EngineProtocolRuntime {
  handle(input: unknown): Promise<EngineResponse>;
  close(): Promise<void>;
}

export interface AutomaticBackupConsistencyGate {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  exec(query: string): Promise<unknown>;
}

/**
 * PGlite owns a live multi-file data directory.  A filesystem walk must never
 * race its writes: hold PGlite's query gate, force a checkpoint, then archive
 * the stable on-disk state before allowing another query to proceed.
 */
export async function createConsistentAutomaticBackup(
  database: AutomaticBackupConsistencyGate,
  dataDir: string
): Promise<EngineResponse> {
  return database.runExclusive(async () => {
    await database.exec("CHECKPOINT");
    return handleBackupRequest({
      version: 1,
      id: `automatic-backup-${Date.now()}`,
      kind: "backup.auto",
      payload: {}
    }, dataDir);
  });
}

export async function handleBackupRequest(
  input: Record<string, unknown>,
  dataDir: string
): Promise<EngineResponse> {
  const id = typeof input.id === "string" ? input.id : "unknown";
  const kind = input.kind === "backup.create" || input.kind === "backup.auto" || input.kind === "backup.auto.list" || input.kind === "backup.auto.verify" || input.kind === "backup.auto.restore.preview" || input.kind === "backup.auto.restore" || input.kind === "backup.verify" || input.kind === "backup.restore.preview" || input.kind === "backup.restore"
    ? input.kind
    : null;
  if (!kind) return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "backup request kind is not supported" };
  const payload = isRecord(input.payload) ? input.payload : {};
  const automatic = kind === "backup.auto";
  const automaticAccess = kind === "backup.auto.list" || kind === "backup.auto.verify" || kind === "backup.auto.restore.preview" || kind === "backup.auto.restore";
  const automaticDirectory = join(dataDir, "backups");
  if (kind === "backup.auto.list") {
    try {
      return { version: 1, id, ok: true, kind, snapshots: await listAutomaticBackups(automaticDirectory) };
    } catch (error) {
      return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: error instanceof Error ? error.message : "automatic backup discovery failed" };
    }
  }
  let archivePath = typeof payload.archivePath === "string" ? payload.archivePath : "";
  if (automaticAccess) {
    try {
      archivePath = await resolveAutomaticBackupPath(automaticDirectory, payload.backupName);
    } catch (error) {
      return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: error instanceof Error ? error.message : "automatic backup selection failed" };
    }
  }
  const outputPath = automatic
    ? join(automaticDirectory, `automatic-${new Date().toISOString().replace(/[:.]/gu, "-")}.backup`)
    : typeof payload.outputPath === "string" ? payload.outputPath : "";
  const sourceDirectory = typeof payload.sourceDirectory === "string" ? payload.sourceDirectory : dataDir;
  let relativePaths: string[];
  try {
    relativePaths = automatic
      ? await collectAutomaticBackupPaths(sourceDirectory)
      : Array.isArray(payload.relativePaths)
        ? payload.relativePaths.filter((value): value is string => typeof value === "string")
        : [];
  } catch (error) {
    return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: error instanceof Error ? error.message : "automatic backup file discovery failed" };
  }
  let recoveryKey = typeof payload.recoveryKey === "string" ? payload.recoveryKey : "";
  if (automatic || automaticAccess) {
    try { recoveryKey = automaticBackupRecoveryKey(); }
    catch (error) { return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: error instanceof Error ? error.message : "automatic backup key unavailable" }; }
  }
  const targetDirectory = typeof payload.targetDirectory === "string"
    ? payload.targetDirectory
    : join(dataDir, ".backup-verify-preview");
  if ((kind === "backup.create" || automatic) && (!outputPath || !sourceDirectory || relativePaths.length === 0 || relativePaths.length > MAX_AUTOMATIC_BACKUP_FILES)) {
    return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "backup output, source directory, recovery key, and bounded file allowlist are required" };
  }
  if (kind !== "backup.create" && !automatic && (!archivePath || !recoveryKey || ((kind === "backup.restore.preview" || kind === "backup.restore" || kind === "backup.auto.restore.preview" || kind === "backup.auto.restore") && !payload.targetDirectory))) {
    return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "archive path, recovery key, and restore target are required" };
  }
  try {
    if (kind === "backup.create" || automatic) {
      await assertBoundedBackupInput(sourceDirectory, relativePaths);
      const archive = await createPortableBackup({
        sourceDirectory,
        relativePaths,
        recoveryKey,
        createdAt: new Date().toISOString()
      });
      const outputDirectory = outputPath.replace(/[\\/][^\\/]*$/u, "");
      if (!outputDirectory || outputDirectory === outputPath) {
        return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: "backup output path must include a parent directory" };
      }
      try {
        const existingOutput = await lstat(outputPath);
        if (existingOutput.isSymbolicLink() || !existingOutput.isFile()) {
          return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: "backup output must be a new regular file" };
        }
        return { version: 1, id, ok: false, kind: "error", code: "BACKUP_OUTPUT_EXISTS", message: "backup output already exists; choose a new file name" };
      } catch {
        // A missing output is the expected path; the atomic rename below owns creation.
      }
      await mkdir(outputDirectory, { recursive: true });
      if (archive.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
        return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: "backup archive exceeds the local verification size limit" };
      }
      const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporaryPath, archive, { flag: "wx" });
      await rename(temporaryPath, outputPath);
      if (automatic) await applyAutomaticBackupRetention(automaticDirectory);
      return {
        version: 1,
        id,
        ok: true,
        kind,
        outputPath,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
        bytes: archive.byteLength,
        entries: relativePaths.length
      };
    }
    const archiveStat = await lstat(archivePath);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
      return {
        version: 1,
        id,
        ok: false,
        kind: "error",
        code: "BACKUP_INVALID",
        message: "backup archive must be a regular local file"
      };
    }
    if (archiveStat.size > MAX_BACKUP_ARCHIVE_BYTES) {
      return {
        version: 1,
        id,
        ok: false,
        kind: "error",
        code: "BACKUP_INVALID",
        message: "backup archive exceeds the local verification size limit"
      };
    }
    const plan = await planPortableRestore({
      archive: await readFile(archivePath),
      recoveryKey,
      targetDirectory
    });
    if (kind === "backup.restore" || kind === "backup.auto.restore") {
      await applyRestoreThroughNativeWriter(plan);
      return {
        version: 1,
        id,
        ok: true,
        kind,
        archivePath,
        archiveSha256: plan.archiveSha256,
        restored: true,
        targetDirectory: plan.targetDirectory,
        entries: plan.entries.length
      };
    }
    return {
      version: 1,
      id,
      ok: true,
      kind,
      archivePath,
      archiveSha256: plan.archiveSha256,
      sha256: plan.archiveSha256,
      createdAt: plan.createdAt,
      verified: true,
      entries: plan.entries.map((entry) => ({
        relativePath: entry.relativePath,
        targetPath: entry.targetPath,
        size: entry.size,
        sha256: entry.sha256,
        status: entry.status
      }))
    };
  } catch (error) {
    return {
      version: 1,
      id,
      ok: false,
      kind: "error",
      code: "BACKUP_INVALID",
      message: error instanceof Error ? error.message : "backup verification failed"
    };
  }
}

export interface EngineProtocolOptions {
  sourceRepository?: SourceRepository;
  sourceTransport?: FetchTransport;
  sourceScanCoordinator?: SourceScanCoordinator;
  codexCoordinator?: CodexWorkerCoordinator;
  /** Persistent runtimes provide an application-owned media directory. */
  mediaDataDir?: string;
  /** Optional ImageGen provider; local artwork remains the safe fallback. */
  imageGenerator?: ImageGeneratorPort;
  /** True only when the host injected a processor that can reconcile the durable outbox. */
  publicationReady?: boolean;
  /** Native host drains credential-free broker commands. */
  nativePublicationBroker?: boolean;
  /**
   * Test-fixture seam only. Production protocol callers must persist revisions
   * through the internal draft/final-review materializer, never a caller
   * supplied REVISION.SAVE package.
   */
  allowUnsafeRevisionSaveForTests?: boolean;
  /** Explicit full encrypted-row verifier; intentionally absent from cheap reads. */
  verifyEncryptionIntegrity?: () => Promise<void>;
}

export interface PersistentEngineProtocolOptions {
  sourceTransport?: FetchTransport;
  startSourceWorker?: boolean;
  /** Start periodic source scans only for the packaged application runtime. */
  startSourceScheduler?: boolean;
  codexCommand?: string;
  codexHome?: string;
  /** Test-only host seam; production always supplies the isolated CLI port. */
  codexPort?: StructuredCodexPort;
  /** Test-only seam; production reads an explicitly configured local ImageGen key. */
  imageGenerator?: ImageGeneratorPort;
  /** Native/host-owned publication boundary; credentials never cross the renderer protocol. */
  publicationBroker?: ProductionPublicationBroker;
  /** Native desktop owns all credentialed GitHub effects and drains through broker protocol calls. */
  nativePublicationBroker?: boolean;
  publicationProcessor?: PublicationEffectProcessor;
  /** Enabled by default so due approved work is recovered after restart. */
  startPublicationScheduler?: boolean;
  publicationSchedulerPollMs?: number;
  /** Test-fixture seam; never enabled by the stdio production host. */
  allowUnsafeRevisionSaveForTests?: boolean;
}

export interface ProductionPublicationEffects extends PublicationEffectsPort {
  getBaseBranchSha(): Promise<string>;
}

export interface ProductionPublicationBroker {
  connector: PublicationRuntimeConnector;
  effects: ProductionPublicationEffects;
}

function publicationFiles(value: unknown): readonly PublicationFile[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((file) => isRecord(file) && typeof file.path === "string" && (
    typeof file.content === "string" || file.content instanceof Uint8Array || isRecord(file.content)
  )) ? value as PublicationFile[] : null;
}

async function materializeEngineMediaFiles(
  files: readonly PublicationFile[],
  revision: ArticleRevision,
  dataDir: string
): Promise<readonly PublicationFile[]> {
  return Promise.all(files.map(async (file) => {
    if (!isEngineMediaReference(file.content)) return file;
    const reference = engineMediaReference(file.content, revision.id);
    if (!reference) throw new Error("APPROVAL_BOUND_MEDIA_REFERENCE_INVALID");
    const candidates = revision.media.filter((media) => media.sha256.toLowerCase() === reference.sha256);
    if (candidates.length !== 1) throw new Error("APPROVAL_BOUND_MEDIA_REFERENCE_INVALID");
    const media = candidates[0]!;
    const normalizedPath = media.path.replaceAll("\\", "/");
    const expectedPrefix = `media/${revision.id}/`;
    if (
      normalizedPath !== media.path ||
      !normalizedPath.startsWith(expectedPrefix) ||
      normalizedPath.slice(expectedPrefix.length).length === 0 ||
      normalizedPath.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))
    ) {
      throw new Error("APPROVAL_BOUND_MEDIA_PATH_INVALID");
    }

    const mediaRoot = resolve(dataDir, "media", revision.id);
    const sourcePath = resolve(dataDir, normalizedPath);
    const relation = relative(mediaRoot, sourcePath);
    if (!relation || relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) {
      throw new Error("APPROVAL_BOUND_MEDIA_PATH_INVALID");
    }
    const canonicalRoot = await realpath(mediaRoot);
    const canonicalSource = await realpath(sourcePath);
    const canonicalRelation = relative(canonicalRoot, canonicalSource);
    if (!canonicalRelation || canonicalRelation === ".." || canonicalRelation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(canonicalRelation)) {
      throw new Error("APPROVAL_BOUND_MEDIA_PATH_INVALID");
    }
    let current = resolve(dataDir);
    for (const segment of normalizedPath.split("/").slice(0, -1)) {
      current = join(current, segment);
      const ancestor = await lstat(current);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw new Error("APPROVAL_BOUND_MEDIA_PATH_INVALID");
    }

    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("APPROVAL_BOUND_MEDIA_PATH_INVALID");
    const handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink() || before.size !== reference.size) {
        throw new Error("APPROVAL_BOUND_MEDIA_MISMATCH");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        await realpath(sourcePath) !== canonicalSource ||
        createHash("sha256").update(bytes).digest("hex") !== reference.sha256
      ) {
        throw new Error("APPROVAL_BOUND_MEDIA_MISMATCH");
      }
      return { ...file, content: bytes };
    } finally {
      await handle.close();
    }
  }));
}

function createProductionPublicationProcessor(
  repository: BackendRepository,
  broker: ProductionPublicationBroker,
  dataDir: string
): PublicationEffectProcessor {
  return createConnectorAwarePublicationProcessor({
    connector: broker.connector,
    effects: broker.effects,
    resolver: {
      async resolve(effect): Promise<ApprovedPublicationCommand | null> {
        const revision = await repository.getRevision(effect.aggregateId);
        const preview = await repository.getLocalState(`publication.preview:${effect.aggregateId}`);
        if (!isRecord(preview) || preview.revisionHash !== effect.revisionHash || preview.previewHash !== effect.previewHash || !isPublicationPreviewCurrent(preview)) return null;
        const payload = isRecord(preview.payload) ? preview.payload : null;
        const files = publicationFiles(payload?.files);
        const currentRevisionHash = computeRevisionHash(revision);
        if (!payload || !files || currentRevisionHash !== effect.revisionHash) return null;
        return {
          articleId: revision.translationKey,
          revisionId: revision.id,
          approvedRevisionHash: effect.revisionHash,
          currentRevisionHash,
          targetRepository: effect.targetRepository,
          baseBranch: effect.baseBranch,
          approvedBaseSha: effect.targetBaseSha,
          currentBaseSha: await broker.effects.getBaseBranchSha(),
          approvedHeadSha: "",
          currentHeadSha: "",
          files: await materializeEngineMediaFiles(files, revision, dataDir),
          bundlePolicy: revisionBundlePolicy(revision)
        };
      }
    }
  });
}


export function createEngineProtocol(
  repository: BackendRepository = new InMemoryBackendStore(),
  queueStatus: "memory" | "ready" = "memory",
  options: EngineProtocolOptions = {}
) {
  const engine = new LocalEngine({ repository });
  // The desktop asks for the same candidate projection from bootstrap,
  // workspace and the active-draft poll. Keep that read cheap and stable for
  // a short window; mutations still become visible on the next refresh.
  let candidateCache: { expiresAt: number; candidates: Record<string, unknown>[] } | undefined;
  // Serializes native claims inside this engine process. The durable outbox
  // state prevents later reclaims; this guard closes the pre-update await gap.
  const activeNativePublicationClaims = new Set<string>();

  return async (input: unknown): Promise<EngineResponse> => {
    if (!isRecord(input) || input.version !== 1 || typeof input.id !== "string") {
      return {
        version: 1,
        id: "unknown",
        ok: false,
        kind: "error",
        code: "INVALID_REQUEST",
        message: "version 1 request with a string id is required"
      };
    }

    if (typeof input.kind === "string" && input.kind.startsWith("github.auth.")) {
      return {
        version: 1,
        id: input.id,
        ok: false,
        kind: "error",
        code: "GITHUB_AUTH_NATIVE_ONLY",
        message: "GitHub credentials are handled only by the native credential broker."
      };
    }

    if (input.kind === "doctor") {
      const maintenance = {
        sourceRetention: (await repository.getLocalState("maintenance.source-retention")) ?? null,
        automaticBackup: (await repository.getLocalState("maintenance.automatic-backup")) ?? null
      };
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "doctor",
        status: repository.persistence === "pglite" && queueStatus === "ready"
          ? "READY"
          : "DEGRADED",
        persistence: repository.persistence,
        queue: queueStatus,
        maintenance,
        capabilities: [
          "AUTOMATION.SET",
          ...(options.sourceRepository ? ["SOURCE.LIST"] : []),
          ...(options.sourceTransport ? ["SOURCE.TEST"] : []),
          ...(options.sourceRepository ? ["SOURCE.SAVE"] : []),
          ...(options.sourceRepository ? ["SOURCE.REVIEW"] : []),
          ...(options.sourceScanCoordinator ? ["SOURCE.SCAN"] : []),
          ...(options.sourceRepository ? ["CANDIDATE.LIST"] : []),
          ...(options.allowUnsafeRevisionSaveForTests ? ["REVISION.SAVE"] : []),
          "REVISION.LIST",
          "REVISION.GET",
          ...(options.mediaDataDir ? ["REVISION.REPAIR_MEDIA"] : []),
          "APPROVAL.GRANT",
          "APPROVAL.GRANT_HIGH_RISK",
          "PUBLICATION.PREVIEW",
          ...(options.publicationReady ? ["PUBLICATION.ENQUEUE"] : []),
          "BACKUP.CREATE",
          "BACKUP.VERIFY",
          "DRAFT.CREATE",
          "JOB.RETRY",
          ...(options.codexCoordinator ? ["CODEX.RUNNER"] : []),
          ...(options.verifyEncryptionIntegrity ? ["MAINTENANCE.INTEGRITY_VERIFY"] : [])
        ],
        detail: repository.persistence === "pglite" && queueStatus === "ready"
          ? "Local engine storage and durable queue are ready."
          : "Engine protocol is available; durable local storage is not configured."
      };
    }

    if (input.kind === "maintenance.integrity.verify") {
      if (!options.verifyEncryptionIntegrity) {
        return sourceProtocolError(input.id, "command", "INTEGRITY_VERIFY_UNAVAILABLE", "Local integrity verifier is not configured");
      }
      const attemptedAt = new Date().toISOString();
      try {
        await repository.setMaintenanceState("maintenance.integrity-verify", { attemptedAt, state: "RUNNING" });
        await options.verifyEncryptionIntegrity();
        const completedAt = new Date().toISOString();
        await repository.setMaintenanceState("maintenance.integrity-verify", { attemptedAt, completedAt, state: "SUCCEEDED" });
        return { version: 1, id: input.id, ok: true, kind: "maintenance.integrity.verify", verified: true, completedAt };
      } catch (error) {
        try {
          await repository.setMaintenanceState("maintenance.integrity-verify", { attemptedAt, state: "FAILED", code: "LOCAL_INTEGRITY_VERIFY_FAILED" });
        } catch {
          // Reporting a completed failure must not create an unhandled rejection.
        }
        return sourceProtocolError(
          input.id,
          "command",
          "LOCAL_INTEGRITY_VERIFY_FAILED",
          error instanceof Error ? error.message : "Local encrypted data could not be verified"
        );
      }
    }

    if (input.kind === "source.list") {
      if (!options.sourceRepository) {
        return sourceProtocolError(
          input.id,
          "source.list",
          "SOURCE_CATALOG_UNAVAILABLE",
          "Local source catalog is not configured"
        );
      }
      const sources = await options.sourceRepository.listSources();
      const latestEntryDates = options.sourceRepository.listLatestEntryDates
        ? await options.sourceRepository.listLatestEntryDates()
        : undefined;
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "source.list",
        sources: await Promise.all(
          sources.map(async (source) => {
            // The catalog view only needs a recent freshness hint. Reading the
            // complete encrypted feed for every source made bootstrap scale
            // with the user's entire history and blocked the serialized bridge.
            const entries = latestEntryDates
              ? undefined
              : await options.sourceRepository!.listEntriesBounded(source.id, 25);
            const lastItemAt = latestEntryDates?.get(source.id)
              ?? entries
                ?.map((entry) => entry.publishedAt)
                .filter((value): value is string => typeof value === "string" && value.length > 0)
                .sort()
                .at(-1)
              ?? null;
            return {
              ...source,
              lastItemAt,
              // `source` is already the decrypted catalog record. Re-loading it
              // per row doubles PGlite work during a desktop refresh and can
              // stall the sidecar on a large local workspace.
              capabilities: sourceCapabilitiesFor(source)
            };
          })
        )
      };
    }

    if (input.kind === "candidate.list") {
      if (!options.sourceRepository) {
        return sourceProtocolError(
          input.id,
          "candidate.list",
          "CANDIDATE_CATALOG_UNAVAILABLE",
          "Local source catalog is not configured"
        );
      }
      const now = Date.now();
      if (candidateCache && candidateCache.expiresAt > now) {
        return {
          version: 1,
          id: input.id,
          ok: true,
          kind: "candidate.list",
          candidates: structuredClone(candidateCache.candidates)
        };
      }
      const sources = await options.sourceRepository.listSources();
      const candidateByStory = new Map<string, Record<string, unknown>>();
      const storyTokens = new Map<string, Set<string>>();
      const storyIndex = new Map<string, Set<string>>();
      const activeSources = new Map(
        sources.filter((source) => source.status === "ACTIVE").map((source) => [source.id, source])
      );
      const entries = await options.sourceRepository.listRecentEntriesBounded(MAX_CANDIDATE_ENTRIES);
      for (const entry of entries) {
        const source = activeSources.get(entry.sourceId);
        if (!source) continue;
          const candidateId = `candidate-${createCandidateKey(source.id, entry.externalId)}`;
          const title = String(entry.title);
          const titleTokens = candidateTokens(title);
          const possibleStories = new Set<string>();
          for (const token of titleTokens) {
            for (const story of storyIndex.get(token) ?? []) possibleStories.add(story);
          }
          const storyKey = [...possibleStories].find((key) => candidateSimilarityTokens(storyTokens.get(key) ?? new Set(), titleTokens) >= 0.72)
            ?? (title.toLocaleLowerCase("tr-TR").replace(/[^\p{L}\p{N}]+/gu, " ").trim() || entry.externalId);
          const existing = candidateByStory.get(storyKey);
          if (existing) {
            existing.sourceCount = Number(existing.sourceCount ?? 1) + 1;
            const sourceIds = Array.isArray(existing.sourceIds) ? existing.sourceIds : [];
            if (!sourceIds.includes(source.id) && sourceIds.length < 12) sourceIds.push(source.id);
            existing.sourceIds = sourceIds;
            const sourceUrls = Array.isArray(existing.sourceUrls) ? existing.sourceUrls : [];
            const sourceUrl = String(entry.url).slice(0, 320);
            if (sourceUrl && !sourceUrls.includes(sourceUrl) && sourceUrls.length < 12) sourceUrls.push(sourceUrl);
            existing.sourceUrls = sourceUrls;
            existing.duplicateScore = Math.min(100, Number(existing.duplicateScore ?? 0) + 35);
            existing.confidence = Math.max(Number(existing.confidence ?? 0), source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED" ? 85 : 60);
            continue;
          }
          candidateByStory.set(storyKey, {
            id: candidateId,
            title: String(entry.title).slice(0, 240),
            summary: String(entry.summary ?? entry.title).slice(0, 240),
            primarySource: String(source.title ?? source.url).slice(0, 240),
            sourceCount: 1,
            section: source.defaultSection ?? "haberler",
            articleType: source.defaultArticleType ?? "news",
            confidence: source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED" ? 85 : 60,
            duplicateScore: 0,
            discoveredAt: entry.publishedAt ?? new Date(0).toISOString(),
            sourceId: source.id,
            sourceUrl: String(entry.url).slice(0, 320),
            // Preserve bounded corroborating provenance instead of turning a
            // multi-source story into a misleading counter plus one source.
            sourceIds: [source.id],
            sourceUrls: [String(entry.url).slice(0, 320)],
            scoreReasons: [
              source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED" ? "Güven ve kullanım hakkı doğrulandı" : "Kaynak incelemesi bekliyor",
              entry.publishedAt ? "Güncel yayın zamanı bulundu" : "Yayın zamanı yok"
            ]
          });
          storyTokens.set(storyKey, titleTokens);
          for (const token of titleTokens) {
            const stories = storyIndex.get(token) ?? new Set<string>();
            stories.add(storyKey);
            storyIndex.set(token, stories);
          }
      }
      // Candidate inventory is polled by the desktop shell. Keep this a
      // bounded triage projection so a large feed catalog never freezes the
      // bridge; the selected candidate is re-read when research starts.
      const candidates = [...candidateByStory.values()]
        .sort((left, right) => String(right.discoveredAt).localeCompare(String(left.discoveredAt)))
        .slice(0, 50);
      candidateCache = { expiresAt: Date.now() + 2_000, candidates };
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "candidate.list",
        candidates: structuredClone(candidates)
      };
    }

    if (input.kind === "local.state.get") {
      const key = typeof input.key === "string" ? input.key : "";
      if (!key || key.length > 128) {
        return sourceProtocolError(input.id, "command", "INVALID_LOCAL_STATE_KEY", "Local state key is invalid");
      }
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "local.state.get",
        key,
        value: (await repository.getLocalState(key)) ?? null
      };
    }

    if (input.kind === "publication.preview") {
      const revisionId = typeof input.revisionId === "string" ? input.revisionId : "";
      const revisionHash = typeof input.revisionHash === "string" ? input.revisionHash : "";
      const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
      const expectedVersion = Number.isSafeInteger(input.expectedVersion) ? Number(input.expectedVersion) : -1;
      const payload = isRecord(input.payload) ? input.payload : null;
      if (!revisionId || !/^[a-f0-9]{64}$/u.test(revisionHash) || !idempotencyKey || expectedVersion < 0 || !payload) {
        return sourceProtocolError(input.id, "command", "INVALID_PUBLICATION_PREVIEW_REQUEST", "Publication preview metadata is invalid");
      }
      try {
        // Approval and revision records are immutable. Read the approval
        // snapshot before entering the PGlite idempotent transaction; opening
        // repository.sync() from inside that transaction deadlocks on the
        // same database lock.
        const approvalSnapshot = await repository.sync(0);
        // Connector state is configuration for the immutable preview. Read it
        // before the idempotent transaction for the same reason: PGlite does
        // not permit a second repository transaction while this one is open.
        const desktopConnectorState = await repository.getLocalState("desktop.connectors");
        const desktopConnectorChecks = await repository.getLocalState("desktop.connectorChecks");
        const githubState = (await repository.getLocalState("connector.github")) ??
          (isRecord(desktopConnectorState) ? desktopConnectorState.github : undefined);
        const siteState = (await repository.getLocalState("connector.site")) ??
          (isRecord(desktopConnectorState) ? desktopConnectorState.site : undefined);
        const result = await repository.runIdempotent(
          `publication-preview:${idempotencyKey}`,
          canonicalJson({ revisionId, revisionHash, expectedVersion, payload }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
            const revision = await transaction.getRevision(revisionId);
            if (computeRevisionHash(revision) !== revisionHash) throw new Error("APPROVAL_HASH_MISMATCH");
            const approval = approvalSnapshot.snapshot.approvals.find((item) => item.revisionId === revisionId);
            if (!approval || approval.revisionHash !== revisionHash) throw new Error("NO_VALID_APPROVAL");
            if (!validateRevisionPackageV2(revision)) throw new Error("REVISION_PACKAGE_INCOMPLETE");
            const gateStatus = validateApprovalGates(revision, approval.warningSetHash);
            if (gateStatus !== "READY") throw new Error(gateStatus);
            if (revision.riskLevel === "HIGH") {
              const highRisk = approvalSnapshot.snapshot.highRiskApprovals.find((item) =>
                item.revisionId === revisionId && item.revisionHash === revisionHash
              );
              if (!highRisk) throw new Error("HIGH_RISK_APPROVAL_REQUIRED");
            }
            assertRevisionGeneratedFilesMatch(revision, payload);
            // Setup stores the generic site connector in the encrypted
            // desktop catalog. Keep the old standalone key as a migration
            // fallback, but never require it for the local-only/local-dev
            // targets. Those modes still need the selected folder as the
            // content root for preview validation and materialization.
            const githubObject = isRecord(githubState) ? githubState : {};
            const siteObject = isRecord(siteState) ? siteState : {};
            const deployObject = isRecord(desktopConnectorState) && isRecord(desktopConnectorState.deploy)
              ? desktopConnectorState.deploy
              : {};
            const checkObject = isRecord(desktopConnectorChecks) ? desktopConnectorChecks : {};
            const siteCheck = isRecord(checkObject.site) ? checkObject.site : {};
            const adapterDryRun = isRecord(siteCheck.adapterDryRun) ? siteCheck.adapterDryRun : {};
            const publishMode = siteObject.mode === "PUBLISH";
            const requiredChecks = Array.isArray(deployObject.requiredChecks)
              && deployObject.requiredChecks.length > 0
              && deployObject.requiredChecks.length <= 32
              && deployObject.requiredChecks.every((value) => typeof value === "string" && value.trim() && value.length <= 200)
              && new Set(deployObject.requiredChecks).size === deployObject.requiredChecks.length
                ? deployObject.requiredChecks as string[]
                : null;
            const deployWorkflow = typeof deployObject.workflowName === "string"
              && /^[A-Za-z0-9_.-]+\.ya?ml$/u.test(deployObject.workflowName)
                ? deployObject.workflowName
                : null;
            if (publishMode && (!requiredChecks || !deployWorkflow)) throw new Error("PUBLICATION_POLICY_UNAVAILABLE");
            const configuredTargetRepository = publishMode &&
              typeof githubObject.owner === "string" && typeof githubObject.repository === "string"
                ? `${githubObject.owner.trim()}/${githubObject.repository.trim()}`
                : "";
            const approvedTargetRepository = String(revision.targetRepository ?? "");
            const approvedBaseBranch = String(revision.targetBaseBranch ?? "");
            const approvedTargetBaseSha = String(revision.targetBaseSha ?? "");
            const approvedAdapterIdentity = String(revision.adapterVersion ?? "");
            const bundlePolicy = revisionBundlePolicy(revision);
            const targetRepository = String(payload.targetRepository ?? "") || configuredTargetRepository || approvedTargetRepository;
            const baseBranch = String(payload.baseBranch ?? "") || (publishMode && typeof githubObject.branch === "string" ? githubObject.branch.trim() : "") || approvedBaseBranch;
            const configuredBaseSha = publishMode && typeof githubObject.baseSha === "string" ? githubObject.baseSha.trim() : "";
            const approvedBaseSha = String(payload.approvedBaseSha ?? "") || configuredBaseSha || approvedTargetBaseSha;
            const configuredAdapterId = typeof adapterDryRun.adapterId === "string" ? adapterDryRun.adapterId.trim() : "";
            const configuredAdapterVersion = typeof adapterDryRun.adapterVersion === "string" ? adapterDryRun.adapterVersion.trim() : "";
            const configuredAdapterIdentity = configuredAdapterId && configuredAdapterVersion ? `${configuredAdapterId}@${configuredAdapterVersion}` : "";
            const requestedAdapterIdentity = String(payload.adapterVersion ?? "") || configuredAdapterIdentity || approvedAdapterIdentity;
            const approvedAdapterSeparator = approvedAdapterIdentity.indexOf("@");
            const approvedAdapterId = approvedAdapterSeparator > 0 ? approvedAdapterIdentity.slice(0, approvedAdapterSeparator) : "";
            if (
              targetRepository !== approvedTargetRepository ||
              baseBranch !== approvedBaseBranch ||
              approvedBaseSha !== approvedTargetBaseSha ||
              requestedAdapterIdentity !== approvedAdapterIdentity ||
              (approvedAdapterId && bundlePolicy.adapterId !== approvedAdapterId)
            ) {
              throw new Error("APPROVAL_TARGET_MISMATCH");
            }
            const siteOrigin = String(payload.siteOrigin ?? "") || (typeof siteObject.publicSiteUrl === "string" ? siteObject.publicSiteUrl.trim() : "");
            const contentRoot = String(payload.contentRoot ?? "") || (typeof siteObject.repositoryPath === "string" ? siteObject.repositoryPath.trim() : "");
            const previewPayload = {
              ...payload,
              targetRepository,
              baseBranch,
              adapterVersion: approvedAdapterIdentity,
              adapterId: bundlePolicy.adapterId,
              bundlePolicy,
              requiredChecks: requiredChecks ?? [],
              deployWorkflow: deployWorkflow ?? "",
              siteOrigin,
              contentRoot,
              ...(approvedBaseSha ? { approvedBaseSha, currentBaseSha: approvedBaseSha } : {})
            };
            const previewInput = {
              revisionId,
              approvedRevisionHash: revisionHash,
              currentRevisionHash: revisionHash,
              targetRepository,
              baseBranch,
              ...(approvedBaseSha ? { approvedBaseSha, currentBaseSha: approvedBaseSha } : {}),
              files: Array.isArray(payload.files) ? payload.files as never : [],
              bundlePolicy,
              requiredChecks: requiredChecks ?? [],
              deployWorkflow: deployWorkflow ?? "",
              siteOrigin,
              contentRoot,
              now: String(payload.now ?? new Date().toISOString())
            } as Parameters<typeof buildPublicationPreview>[0];
            previewInput.adapterId = bundlePolicy.adapterId;
            const preview = buildPublicationPreview(previewInput);
            await transaction.setLocalState(`publication.preview:${revisionId}`, {
              previewHash: preview.previewHash,
              revisionHash,
              adapterId: preview.adapterId,
              plan: preview.plan,
              // Keep the exact reviewed bundle available for restart recovery.
              // This state is encrypted by the backend repository and contains
              // no credentials; enqueue still requires the matching hash.
              payload: previewPayload,
              createdAt: preview.plan.generatedAt,
              expiresAtUnixMs: Date.now() + PUBLICATION_PREVIEW_TTL_MS
            });
            return preview;
          }
        );
        return { version: 1, id: input.id, ok: true, kind: "publication.preview", value: result };
      } catch (error) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_PREVIEW_FAILED", error instanceof Error ? error.message : "Publication preview failed");
      }
    }

    if (input.kind === "publication.enqueue") {
      const revisionId = typeof input.revisionId === "string" ? input.revisionId : "";
      const revisionHash = typeof input.revisionHash === "string" ? input.revisionHash : "";
      const previewHash = typeof input.previewHash === "string" ? input.previewHash : "";
      const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
      const expectedVersion = Number.isSafeInteger(input.expectedVersion) ? Number(input.expectedVersion) : -1;
      if (!revisionId || !/^[a-f0-9]{64}$/u.test(revisionHash) || !/^[a-f0-9]{64}$/u.test(previewHash) || !idempotencyKey || expectedVersion < 0) {
        return sourceProtocolError(input.id, "command", "INVALID_PUBLICATION_REQUEST", "Publication request metadata is invalid");
      }
      try {
        // Like publication.preview, read immutable approval records before
        // entering the PGlite idempotent transaction. Calling repository.sync
        // from inside that transaction opens a second PGlite transaction and
        // blocks the durable enqueue path.
        const approvalSnapshot = await repository.sync(0);
        const result = await repository.runIdempotent(
          `publication:${idempotencyKey}`,
          canonicalJson({ revisionId, revisionHash, previewHash, expectedVersion }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
            const revision = await transaction.getRevision(revisionId);
            if (computeRevisionHash(revision) !== revisionHash) throw new Error("APPROVAL_HASH_MISMATCH");
            const approval = approvalSnapshot.snapshot.approvals.find((item) => item.revisionId === revisionId);
            if (!approval || approval.revisionHash !== revisionHash) throw new Error("NO_VALID_APPROVAL");
            const highRisk = approvalSnapshot.snapshot.highRiskApprovals.find((item) => item.revisionId === revisionId) ?? null;
            const eligibility = evaluatePublishEligibility(revision, { editorial: approval, highRisk }, {
              now: new Date(),
              publishingPaused: false,
              revisionLineage: approvalSnapshot.snapshot.revisions
            });
            if (!eligibility.eligible) throw new Error(eligibility.reason);
            if (revision.translationParity?.status === "MISMATCHED" || revision.translationParity?.status === "PENDING") {
              throw new Error("TRANSLATION_PARITY_NOT_READY");
            }
            if (!validateClaimEvidence(revision) || revision.claims.some((claim) => claim.status !== "VERIFIED")) {
              throw new Error("CLAIM_EVIDENCE_NOT_READY");
            }
            const gateStatus = validateApprovalGates(revision, approval.warningSetHash);
            if (gateStatus !== "READY") throw new Error(gateStatus);
            const preview = await transaction.getLocalState(`publication.preview:${revisionId}`);
            if (!isRecord(preview) || preview.revisionHash !== revisionHash || preview.previewHash !== previewHash || !isPublicationPreviewCurrent(preview)) {
              throw new Error("NO_VALID_PUBLICATION_PREVIEW");
            }
            const binding = publicationIntentBinding(revision, preview);
            return transaction.enqueuePublication(revisionId, revisionHash, binding);
          }
        );
        return { version: 1, id: input.id, ok: true, kind: "publication.enqueue", value: result };
      } catch (error) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_ENQUEUE_FAILED", error instanceof Error ? error.message : "Publication enqueue failed");
      }
    }

    if (input.kind === "publication.broker.pending") {
      if (!options.nativePublicationBroker) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_BROKER_UNAVAILABLE", "Native publication broker is not configured");
      }
      const now = Date.now();
      const effectIds = (await repository.listOutbox())
        .filter((effect) => ["PENDING", "UNKNOWN"].includes(effect.state))
        .filter((effect) => !effect.nextAttemptAt || Date.parse(effect.nextAttemptAt) <= now)
        .slice(0, 16)
        .map((effect) => effect.id);
      return { version: 1, id: input.id, ok: true, kind: input.kind, value: { effectIds } };
    }

    if (input.kind === "publication.broker.claim") {
      if (!options.nativePublicationBroker) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_BROKER_UNAVAILABLE", "Native publication broker is not configured");
      }
      const effectId = typeof input.effectId === "string" ? input.effectId : "";
      if (!effectId || activeNativePublicationClaims.has(effectId)) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_EFFECT_NOT_CLAIMABLE", "Publication effect is not claimable");
      }
      activeNativePublicationClaims.add(effectId);
      try {
        const effect = (await repository.listOutbox()).find((item) => item.id === effectId);
        // An active native effect is owned by its first claimant. Reclaiming is
        // permitted only after restart, when the worker recovery path resets the
        // durable state; concurrent claims must never duplicate remote effects.
        if (!effect || !["PENDING", "UNKNOWN"].includes(effect.state)) {
          return sourceProtocolError(input.id, "command", "PUBLICATION_EFFECT_NOT_CLAIMABLE", "Publication effect is not claimable");
        }
        const revision = await repository.getRevision(effect.aggregateId);
        const preview = await repository.getLocalState(`publication.preview:${effect.aggregateId}`);
        const payload = isRecord(preview) && isRecord(preview.payload) ? preview.payload : null;
        const files = publicationFiles(payload?.files);
        if (
          !payload ||
          !files ||
          !isRecord(preview) ||
          !isPublicationPreviewCurrent(preview) ||
          computeRevisionHash(revision) !== effect.revisionHash ||
          preview.revisionHash !== effect.revisionHash ||
          preview.previewHash !== effect.previewHash
        ) {
          return sourceProtocolError(input.id, "command", "PUBLICATION_EFFECT_STALE", "Publication effect no longer matches its approved preview");
        }
        const materializedFiles = options.mediaDataDir
          ? await materializeEngineMediaFiles(files, revision, options.mediaDataDir)
          : files.some((file) => isEngineMediaReference(file.content))
            ? null
            : files;
        if (!materializedFiles) {
          return sourceProtocolError(input.id, "command", "PUBLICATION_MEDIA_UNAVAILABLE", "Approved publication media cannot be resolved at this boundary");
        }
        const bundlePolicy = revisionBundlePolicy(revision);
        const requiredChecks = Array.isArray(payload.requiredChecks)
          && payload.requiredChecks.length > 0
          && payload.requiredChecks.length <= 32
          && payload.requiredChecks.every((value) => typeof value === "string" && value.trim() && value.length <= 200)
          && new Set(payload.requiredChecks).size === payload.requiredChecks.length
            ? payload.requiredChecks as string[]
            : null;
        const deployWorkflow = typeof payload.deployWorkflow === "string"
          && /^[A-Za-z0-9_.-]+\.ya?ml$/u.test(payload.deployWorkflow)
            ? payload.deployWorkflow
            : null;
        if (!requiredChecks || !deployWorkflow) {
          return sourceProtocolError(input.id, "command", "PUBLICATION_POLICY_UNAVAILABLE", "Approved publication policy is not configured");
        }
        const nativeFiles = materializedFiles.map((file) => ({
          path: file.path,
          content: typeof file.content === "string"
            ? file.content
            : { base64: publicationContentBytes(file.content).toString("base64") }
        }));
        const claimAttempt = (effect.claimAttempt ?? 0) + 1;
        const claimValue = {
          effectId: effect.id,
          claimAttempt,
          idempotencyKey: effect.idempotencyKey,
          revisionId: effect.aggregateId,
          revisionHash: effect.revisionHash,
          targetRepository: effect.targetRepository,
          baseBranch: effect.baseBranch,
          expectedBaseSha: effect.targetBaseSha,
          ...(effect.resultRef ? { priorResultRef: effect.resultRef.slice(0, 512) } : {}),
          approvedFilesSha: approvalBoundFilesDigest(materializedFiles),
          requiredChecks,
          deployWorkflow,
          adapterVersion: revision.adapterVersion,
          bundlePolicy,
          files: nativeFiles
        };
        if (Buffer.byteLength(JSON.stringify(claimValue), "utf8") > 70 * 1024 * 1024) {
          return sourceProtocolError(input.id, "command", "PUBLICATION_CLAIM_TOO_LARGE", "Approved publication claim exceeds the native boundary");
        }
        await repository.updateOutbox({
          ...effect,
          state: "IN_PROGRESS",
          attempts: effect.attempts + 1,
          claimAttempt
        });
        return { version: 1, id: input.id, ok: true, kind: input.kind, value: claimValue };
      } catch (error) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_MEDIA_INVALID", error instanceof Error ? error.message : "Approved publication media is invalid");
      } finally {
        activeNativePublicationClaims.delete(effectId);
      }
    }

    if (input.kind === "publication.broker.complete") {
      if (!options.nativePublicationBroker) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_BROKER_UNAVAILABLE", "Native publication broker is not configured");
      }
      const effectId = typeof input.effectId === "string" ? input.effectId : "";
      const claimAttempt = Number.isSafeInteger(input.claimAttempt)
        && Number(input.claimAttempt) > 0
        ? Number(input.claimAttempt)
        : 0;
      const state = input.state === "SUCCEEDED" || input.state === "FAILED" || input.state === "UNKNOWN" ? input.state : null;
      const effect = (await repository.listOutbox()).find((item) => item.id === effectId);
      if (!effect || effect.state !== "IN_PROGRESS" || effect.claimAttempt !== claimAttempt || !state) {
        return sourceProtocolError(input.id, "command", "INVALID_PUBLICATION_BROKER_RESULT", "Publication broker result is invalid");
      }
      const resultRef = typeof input.resultRef === "string" ? input.resultRef.slice(0, 512) : undefined;
      const lastError = typeof input.lastError === "string" ? input.lastError.slice(0, 512) : undefined;
      const retryAfterMs = Number.isSafeInteger(input.retryAfterMs)
        && Number(input.retryAfterMs) >= 0
        && Number(input.retryAfterMs) <= 86_400_000
        ? Number(input.retryAfterMs)
        : undefined;
      const { nextAttemptAt: _previousRetryDeadline, ...withoutPreviousRetryDeadline } = effect;
      const nextAttemptAt = state === "UNKNOWN" && retryAfterMs !== undefined
        ? new Date(Date.now() + retryAfterMs).toISOString()
        : undefined;
      const saved = await repository.updateOutbox({
        ...withoutPreviousRetryDeadline,
        state,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        ...(resultRef ? { resultRef } : {}),
        ...(lastError ? { lastError } : {}),
        ...(state === "SUCCEEDED" ? { completedAt: new Date().toISOString() } : {})
      });
      return { version: 1, id: input.id, ok: true, kind: input.kind, value: saved };
    }

    if (input.kind === "source.test") {
      if (!options.sourceTransport) {
        return sourceProtocolError(
          input.id,
          "source.test",
          "SOURCE_TEST_UNAVAILABLE",
          "Source test transport is not configured"
        );
      }
      if (typeof input.url !== "string" || input.url.length > 4_096) {
        return sourceProtocolError(
          input.id,
          "source.test",
          "INVALID_SOURCE_URL",
          "Source test requires a URL no longer than 4096 characters"
        );
      }

      let requestedUrl: string;
      try {
        requestedUrl = assertSafeSourceUrl(input.url);
      } catch (error) {
        return sourceProtocolError(
          input.id,
          "source.test",
          "SOURCE_TEST_REJECTED",
          safeErrorMessage(error, "Source URL was rejected")
        );
      }

      try {
        const fetched = await fetchSource(
          requestedUrl,
          options.sourceTransport,
          {
            timeoutMs: 8_000,
            maxBytes: 1_000_000,
            maxRedirects: 5
          }
        );
        const analysis = analyzeSourceDocument({
          finalUrl: fetched.finalUrl,
          contentType: fetched.contentType,
          body: fetched.body
        });
        return {
          version: 1,
          id: input.id,
          ok: true,
          kind: "source.test",
          probe: {
            requestedUrl,
            finalUrl: fetched.finalUrl,
            contentType: fetched.contentType,
            byteLength: fetched.body.byteLength,
            kind: analysis.kind,
            ...(analysis.title ? { title: analysis.title } : {}),
            discoveredFeeds: analysis.discoveredFeeds,
            entries: analysis.entries
          }
        };
      } catch (error) {
        return sourceProtocolError(
          input.id,
          "source.test",
          error instanceof SourceDocumentError
            ? "SOURCE_TEST_REJECTED"
            : "SOURCE_TEST_FAILED",
          safeErrorMessage(error, "Source test failed")
        );
      }
    }

    if (input.kind === "source.scan.status") {
      if (!options.sourceScanCoordinator) {
        return sourceProtocolError(
          input.id,
          "source.scan.status",
          "SOURCE_SCAN_UNAVAILABLE",
          "Local source scan worker is not configured"
        );
      }
      if (
        typeof input.idempotencyKey !== "string" ||
        !isProtocolIdentifier(input.idempotencyKey)
      ) {
        return sourceProtocolError(
          input.id,
          "source.scan.status",
          "INVALID_IDEMPOTENCY_KEY",
          "Source scan status requires a valid idempotency key"
        );
      }
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "source.scan.status",
        runs: await options.sourceScanCoordinator.status(input.idempotencyKey)
      };
    }

    if (
      input.kind === "state" &&
      typeof input.afterCursor === "number" &&
      Number.isSafeInteger(input.afterCursor) &&
      input.afterCursor >= 0
    ) {
      // A desktop refresh needs a current projection, not the full durable
      // audit history.  Keeping the optional tail bounded prevents a long
      // lived local workspace from exceeding the NDJSON bridge limit and
      // restarting the engine while the UI is polling it.
      const requestedChangeLimit =
        typeof input.changeLimit === "number" &&
        Number.isSafeInteger(input.changeLimit) &&
        input.changeLimit >= 0
          ? input.changeLimit
          : undefined;
      const changeLimit = requestedChangeLimit === undefined
        ? undefined
        : Math.min(requestedChangeLimit, 200);
      const sync = await readDashboardSync(repository, input.afterCursor, changeLimit, 100, 100);
      const changes = changeLimit === 0 ? [] : sync.changes;
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "state",
        snapshot: {
          serverCursor: sync.serverCursor,
          automation: sync.automation,
          // The state envelope is polled by the desktop shell. Keep it a
          // dashboard projection: completed Codex records can contain large
          // prompts/outputs and must be fetched only by an explicit detail
          // command, never on every workspace refresh.
          jobs: sync.jobs.map(dashboardJobSummary),
          outbox: sync.outbox,
          changes
        }
      };
    }

    if (input.kind !== "command" || !isRecord(input.command)) {
      return {
        version: 1,
        id: input.id,
        ok: false,
        kind: "error",
        code: "INVALID_REQUEST",
        message: "request kind is not supported"
      };
    }

    const workflow = await handleLocalWorkflowCommand(
      input.id,
      input.command,
      repository,
      options
    );
    if (workflow) return workflow;

    const validation = validateEngineCommandV1(input.command);
    if (
      validation.valid &&
      (validation.command.kind === "APPROVAL.GRANT" ||
        validation.command.kind === "APPROVAL.GRANT_HIGH_RISK")
    ) {
      const command = validation.command;
      try {
        const result = await repository.runIdempotent(
          `engine:${command.idempotencyKey}`,
          canonicalJson({
            kind: command.kind,
            payload: command.payload,
            expectedVersion: command.expectedVersion
          }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== command.expectedVersion) {
              throw new Error(
                `VERSION_CONFLICT:${command.expectedVersion}:${currentVersion}`
              );
            }
            const revision = await transaction.getRevision(
              command.payload.revisionId
            );
            if (revision.state !== "REVIEW_REQUIRED") {
              throw new Error("REVISION_NOT_REVIEWABLE");
            }
            const actualHash = computeRevisionHash(revision);
            if (actualHash !== command.payload.revisionHash) {
              throw new Error("APPROVAL_HASH_MISMATCH");
            }
            if (revision.translationParity?.status === "MISMATCHED" || revision.translationParity?.status === "PENDING") {
              throw new Error("TRANSLATION_PARITY_NOT_READY");
            }
            if (!validateClaimEvidence(revision) || revision.claims.some((claim) => claim.status !== "VERIFIED")) {
              throw new Error("CLAIM_EVIDENCE_NOT_READY");
            }
            const gateStatus = validateApprovalGates(revision, command.payload.warningSetHash);
            if (gateStatus !== "READY") {
              throw new Error(gateStatus);
            }
            if (command.kind === "APPROVAL.GRANT_HIGH_RISK") {
              if (revision.riskLevel !== "HIGH") {
                throw new Error("HIGH_RISK_APPROVAL_NOT_REQUIRED");
              }
              const editorialApproval = await transaction.getApproval(revision.id);
              if (
                !editorialApproval ||
                editorialApproval.revisionHash !== actualHash ||
                editorialApproval.warningSetHash !== command.payload.warningSetHash
              ) {
                throw new Error("EDITORIAL_APPROVAL_REQUIRED");
              }
              // The renderer may display this checklist, but it is never the
              // authority for its approval binding. Persist only a digest
              // reconstructed from the immutable revision held by the engine.
              const riskChecklistHash = trustedHighRiskChecklistHash(revision);
              return transaction.saveHighRiskApproval({
                revisionId: revision.id,
                revisionHash: actualHash,
                deviceId: command.payload.deviceId,
                approvedAt: new Date().toISOString(),
                warningSetHash: command.payload.warningSetHash,
                approvalType: "HIGH_RISK",
                riskChecklistHash,
                windowsReauthenticatedAt: command.payload.windowsReauthenticatedAt
              });
            }
            return transaction.saveApproval({
              revisionId: revision.id,
              revisionHash: actualHash,
              deviceId: command.payload.deviceId,
              approvedAt: new Date().toISOString(),
              warningSetHash: command.payload.warningSetHash,
              approvalType: "EDITORIAL"
            });
          }
        );
        return revisionCommandSuccess(
          input.id,
          command,
          result,
          await repository.getVersion()
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Approval command failed";
        const code = message.startsWith("VERSION_CONFLICT:")
          ? "VERSION_CONFLICT"
          : message.includes("IDEMPOTENCY_KEY_REUSED")
            ? "IDEMPOTENCY_KEY_REUSED"
            : message === "APPROVAL_HASH_MISMATCH"
              ? "APPROVAL_HASH_MISMATCH"
              : message === "REVISION_NOT_REVIEWABLE"
                ? "REVISION_NOT_REVIEWABLE"
                : message === "HIGH_RISK_APPROVAL_NOT_REQUIRED"
                  ? "REVISION_NOT_REVIEWABLE"
                  : [
                      "TRANSLATION_PARITY_NOT_READY",
                      "CLAIM_EVIDENCE_NOT_READY",
                      "QUALITY_GATES_NOT_READY",
                      "WARNING_NOT_ALLOWLISTED",
                      "WARNING_ACCEPTANCE_MISMATCH",
                      "EDITORIAL_APPROVAL_REQUIRED"
                    ].includes(message)
                    ? message
                    : "ENGINE_OPERATION_FAILED";
        return revisionCommandFailure(
          input.id,
          code,
          message,
          code === "VERSION_CONFLICT"
        );
      }
    }
    if (
      validation.valid &&
      (validation.command.kind === "REVISION.SAVE" ||
        validation.command.kind === "REVISION.LIST" ||
        validation.command.kind === "REVISION.GET" ||
        validation.command.kind === "REVISION.REPAIR_MEDIA")
    ) {
      const command = validation.command;
      try {
        if (command.kind === "REVISION.SAVE" && !options.allowUnsafeRevisionSaveForTests) {
          return revisionCommandFailure(
            input.id,
            "REVISION_SAVE_INTERNAL_ONLY",
            "REVISION.SAVE is disabled for external callers; revisions are persisted only by the internal draft and final-review materializer.",
            false
          );
        }
        const currentVersion = await repository.getVersion();
        if (currentVersion !== command.expectedVersion) {
          return revisionCommandFailure(
            input.id,
            "VERSION_CONFLICT",
            `Expected engine version ${command.expectedVersion}, but current version is ${currentVersion}`,
            true
          );
        }

        if (command.kind === "REVISION.SAVE") {
          const result = await repository.runIdempotent(
            `engine:${command.idempotencyKey}`,
            canonicalJson({
              kind: command.kind,
              payload: command.payload,
              expectedVersion: command.expectedVersion
            }),
            async (transaction) => {
              const version = await transaction.getVersion();
              if (version !== command.expectedVersion) {
                throw new Error(
                  `VERSION_CONFLICT:${command.expectedVersion}:${version}`
                );
              }
              const revision = await transaction.insertRevision(
                command.payload.revision
              );
              return {
                revision,
                revisionHash: computeRevisionHash(revision)
              };
            }
          );
          return revisionCommandSuccess(input.id, command, result, await repository.getVersion());
        }

        if (command.kind === "REVISION.REPAIR_MEDIA") {
          const result = await repository.runIdempotent(
            `engine:${command.idempotencyKey}`,
            canonicalJson({
              kind: command.kind,
              payload: command.payload,
              expectedVersion: command.expectedVersion
            }),
            async (transaction) => {
              const version = await transaction.getVersion();
              if (version !== command.expectedVersion) {
                throw new Error(
                  `VERSION_CONFLICT:${command.expectedVersion}:${version}`
                );
              }
              const revision = await transaction.getRevision(command.payload.revisionId);
              if (await transaction.getApproval(revision.id)) {
                throw new Error("REVISION_ALREADY_APPROVED");
              }
              if (!options.mediaDataDir) {
                throw new Error("MEDIA_REPAIR_UNAVAILABLE");
              }
              const successor = await createMediaRepairSuccessor(
                revision,
                options.mediaDataDir,
                options.imageGenerator
              );
              const saved = await transaction.insertRevision(successor);
              return {
                revision: saved,
                revisionHash: computeRevisionHash(saved)
              };
            }
          );
          return revisionCommandSuccess(input.id, command, result, await repository.getVersion());
        }

        const summaryOnly = command.kind === "REVISION.LIST" &&
          isRecord(command.payload) && command.payload.summaryOnly === true;
        const snapshot = summaryOnly && repository.listRevisionSummarySnapshot
          ? await repository.listRevisionSummarySnapshot({ limit: 100 })
          : summaryOnly && repository.listRevisionSnapshot
            ? await repository.listRevisionSnapshot()
          : (await repository.sync(0)).snapshot;
        const materialize = (revision: ArticleRevision) => ({
          revision: summaryOnly ? {
            id: revision.id,
            tr: {
              title: revision.tr.title,
              slug: revision.tr.slug
            },
            section: revision.section,
            articleType: revision.articleType,
            riskLevel: revision.riskLevel,
            scheduledAt: revision.scheduledAt,
            sources: revision.sources,
            claims: revision.claims
          } : revision,
          revisionHash: computeRevisionHash(revision),
          editorialApproval:
            snapshot.approvals.find(
              (approval: Approval) => approval.revisionId === revision.id
            ) ?? null,
          highRiskApproval:
            snapshot.highRiskApprovals.find(
              (approval: HighRiskApproval) => approval.revisionId === revision.id
            ) ?? null
        });
        const value =
          command.kind === "REVISION.LIST"
            ? snapshot.revisions.map(materialize)
            : materialize(await repository.getRevision(command.payload.revisionId));
        return revisionCommandSuccess(input.id, command, value, currentVersion);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Editorial command failed";
        const code = message.startsWith("VERSION_CONFLICT:")
          ? "VERSION_CONFLICT"
          : message.includes("IDEMPOTENCY_KEY_REUSED")
            ? "IDEMPOTENCY_KEY_REUSED"
            : "ENGINE_OPERATION_FAILED";
        return revisionCommandFailure(
          input.id,
          code,
          message,
          code === "VERSION_CONFLICT"
        );
      }
    }
    if (
      validation.valid &&
      validation.command.kind === "SOURCE.SCAN"
    ) {
      if (!options.sourceScanCoordinator) {
        return sourceProtocolError(
          input.id,
          "command",
          "SOURCE_SCAN_UNAVAILABLE",
          "Local source scan worker is not configured"
        );
      }
      const command = validation.command;
      try {
        const accepted = await options.sourceScanCoordinator.enqueue(command);
        return {
          version: 1,
          id: input.id,
          ok: true,
          kind: "command",
          result: {
            ok: true,
            version: 1,
            requestId: command.requestId,
            idempotencyKey: command.idempotencyKey,
            kind: command.kind,
            sequence: 0,
            value: accepted
          }
        };
      } catch (error) {
        const code =
          error instanceof Error &&
          error.message.startsWith("IDEMPOTENCY_KEY_REUSED")
            ? "IDEMPOTENCY_KEY_REUSED"
            : "ENGINE_OPERATION_FAILED";
        return {
          version: 1,
          id: input.id,
          ok: false,
          kind: "command",
          result: {
            ok: false,
            version: 1,
            error: {
              code,
              message:
                error instanceof Error ? error.message : "Source scan failed",
              retryable: code === "ENGINE_OPERATION_FAILED"
            }
          }
        };
      }
    }
    if (
      validation.valid &&
      validation.command.kind === "SOURCE.REVIEW"
    ) {
      if (!options.sourceRepository) {
        return sourceProtocolError(
          input.id,
          "command",
          "SOURCE_CATALOG_UNAVAILABLE",
          "Local source catalog is not configured"
        );
      }
      const command = validation.command;
      try {
        const current = await options.sourceRepository.getSource(command.payload.sourceId);
        const reviewedAt = new Date().toISOString();
        const review = { reviewedAt, rationale: command.payload.rationale };
        const saved = await options.sourceRepository.saveSourceIdempotent(
          {
            ...current,
            trustStatus: command.payload.trustStatus,
            rightsStatus: command.payload.rightsStatus,
            trustReview: review,
            rightsReview: review,
            updatedAt: reviewedAt,
            version: current.version + 1
          },
          command.expectedVersion,
          `engine:${command.idempotencyKey}`,
          canonicalJson({
            kind: command.kind,
            payload: command.payload,
            expectedVersion: command.expectedVersion
          })
        );
        return {
          version: 1,
          id: input.id,
          ok: true,
          kind: "command",
          result: {
            ok: true,
            version: 1,
            requestId: command.requestId,
            idempotencyKey: command.idempotencyKey,
            kind: command.kind,
            sequence: saved.version,
            value: saved
          }
        };
      } catch (error) {
        const code = error instanceof SourceRepositoryError
          ? error.code
          : error instanceof Error && error.message.startsWith("IDEMPOTENCY_KEY_REUSED")
            ? "IDEMPOTENCY_KEY_REUSED"
            : "ENGINE_OPERATION_FAILED";
        return {
          version: 1,
          id: input.id,
          ok: false,
          kind: "command",
          result: {
            ok: false,
            version: 1,
            error: {
              code,
              message: error instanceof Error ? error.message : "Source review failed",
              retryable: code === "ENGINE_OPERATION_FAILED"
            }
          }
        };
      }
    }
    if (
      validation.valid &&
      validation.command.kind === "SOURCE.SAVE"
    ) {
      if (!options.sourceRepository) {
        return sourceProtocolError(
          input.id,
          "command",
          "SOURCE_CATALOG_UNAVAILABLE",
          "Local source catalog is not configured"
        );
      }
      const command = validation.command;
      try {
        const normalizedUrl = assertSafeSourceUrl(command.payload.source.url);
        const now = new Date().toISOString();
        const existing =
          await options.sourceRepository.findSourceByUrl(normalizedUrl);
        const sourceId =
          existing?.id ??
          `source-${createHash("sha256")
            .update(normalizedUrl)
            .digest("hex")
            .slice(0, 24)}`;
        const saved = await options.sourceRepository.saveSourceIdempotent(
          {
            id: sourceId,
            url: normalizedUrl,
            kind: command.payload.source.kind,
            status: existing?.status ?? "ACTIVE",
            trustStatus: existing?.trustStatus ?? "PENDING",
            rightsStatus: existing?.rightsStatus ?? "PENDING",
            ...(existing?.trustReview ? { trustReview: existing.trustReview } : {}),
            ...(existing?.rightsReview ? { rightsReview: existing.rightsReview } : {}),
            language: command.payload.source.language,
            discoveredFeeds: existing?.discoveredFeeds ?? [],
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            version: existing ? existing.version + 1 : 1,
            ...(command.payload.source.title
              ? { title: command.payload.source.title }
              : existing?.title
                ? { title: existing.title }
                : {}),
            defaultSection: command.payload.source.section,
            defaultArticleType: command.payload.source.articleType,
            ...(existing?.lastTest ? { lastTest: existing.lastTest } : {})
          },
          command.expectedVersion,
          `engine:${command.idempotencyKey}`,
          canonicalJson({
            kind: command.kind,
            payload: command.payload,
            expectedVersion: command.expectedVersion
          })
        );
        return {
          version: 1,
          id: input.id,
          ok: true,
          kind: "command",
          result: {
            ok: true,
            version: 1,
            requestId: command.requestId,
            idempotencyKey: command.idempotencyKey,
            kind: command.kind,
            sequence: saved.version,
            value: saved
          }
        };
      } catch (error) {
        const code =
          error instanceof SourceRepositoryError
            ? error.code
            : error instanceof Error &&
                error.message.startsWith("IDEMPOTENCY_KEY_REUSED")
              ? "IDEMPOTENCY_KEY_REUSED"
              : "ENGINE_OPERATION_FAILED";
        return {
          version: 1,
          id: input.id,
          ok: false,
          kind: "command",
          result: {
            ok: false,
            version: 1,
            error: {
              code,
              message:
                error instanceof Error ? error.message : "Source save failed",
              retryable: code === "VERSION_CONFLICT"
            }
          }
        };
      }
    }

    const result = await engine.execute(input.command);
    return {
      version: 1,
      id: input.id,
      ok: result.ok,
      kind: "command",
      result
    };
  };
}

/** Local workflow mutations. Codex is invoked only when an isolated coordinator
 * was provisioned by the packaged runtime; otherwise the durable job remains
 * explicitly WAITING_CODEX. */
async function handleLocalWorkflowCommand(
  envelopeId: string,
  value: Record<string, unknown>,
  repository: BackendRepository,
  options: EngineProtocolOptions
): Promise<EngineResponse | null> {
  const kind = typeof value.kind === "string" ? value.kind : "";
  if (!["DRAFT.CREATE", "BOBY.GUIDE", "JOB.RETRY", "LOCAL_STATE.SET"].includes(kind)) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const idempotencyKey = typeof value.idempotencyKey === "string" ? value.idempotencyKey : "";
  const expectedVersion = typeof value.expectedVersion === "number" ? value.expectedVersion : -1;
  const payload = isRecord(value.payload) ? value.payload : {};
  if (!requestId || !idempotencyKey || !Number.isSafeInteger(expectedVersion)) {
    return revisionCommandFailure(envelopeId, "INVALID_COMMAND", "Workflow command metadata is invalid", false);
  }
  try {
    const result = await repository.runIdempotent(
      `engine:${idempotencyKey}`,
      canonicalJson({ kind, payload, expectedVersion }),
      async (transaction) => {
        const current = await transaction.getVersion();
        if (current !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${current}`);
        if (kind === "DRAFT.CREATE") {
          // Slot selection belongs inside the idempotent write. Replays return
          // the already-created job metadata rather than resolving a new time.
          const resolvedSchedule = await resolveNextSlot(transaction, payload);
          const draftId = typeof payload.draftId === "string" ? payload.draftId : "";
          if (!draftId) throw new Error("INVALID_DRAFT_ID");
          const urls = Array.isArray(payload.urls)
            ? payload.urls.filter((url): url is string => typeof url === "string")
            : [];
          const sourceIds = Array.isArray(payload.sourceIds)
            ? payload.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
            : [];
          if (urls.length === 0 && sourceIds.length === 0) throw new Error("DRAFT_SOURCE_REQUIRED");
          return transaction.createJob({
            id: draftId,
            kind: "DRAFT",
            state: options.codexCoordinator ? "QUEUED" : "WAITING_CODEX",
            attempts: 0,
            ...(options.codexCoordinator ? {} : { lastError: "CODEX_RUNNER_UNAVAILABLE" }),
            metadata: {
              createdAtUnixMs: Date.now(),
              ...(typeof payload.candidateId === "string" ? { candidateId: payload.candidateId } : {}),
              ...(typeof payload.candidateTitle === "string" ? { candidateTitle: payload.candidateTitle.slice(0, 240) } : {}),
              instruction: typeof payload.instruction === "string" ? payload.instruction : "",
              sourceIds,
              urls,
              ...(validCandidateUrl(payload.candidateUrl) ? { candidateUrl: payload.candidateUrl.trim() } : {}),
              section: typeof payload.section === "string" ? payload.section : "haberler",
              articleType: typeof payload.articleType === "string" ? payload.articleType : "news",
              urgency: typeof payload.urgency === "string" ? payload.urgency : "normal",
              tone: typeof payload.tone === "string" ? payload.tone : "neutral",
              length: typeof payload.length === "string" ? payload.length : "standard",
              visualPolicy: typeof payload.visualPolicy === "string" ? payload.visualPolicy : "GENERATE",
              scheduleIntent: typeof payload.scheduleIntent === "string" ? payload.scheduleIntent : "UNSCHEDULED",
              ...(typeof payload.revisionId === "string" ? { revisionId: payload.revisionId } : {}),
              ...(payload.baseRevision !== undefined ? { baseRevision: payload.baseRevision } : {})
              ,...(typeof payload.preferredAuthor === "string" ? { preferredAuthor: payload.preferredAuthor } : {})
              ,...(typeof payload.preferredReviewer === "string" ? { preferredReviewer: payload.preferredReviewer } : {})
              ,...(resolvedSchedule ? { scheduledAt: resolvedSchedule } : {})
            }
          });
        }
        if (kind === "BOBY.GUIDE") {
          const guidanceId = typeof payload.guidanceId === "string" ? payload.guidanceId.trim() : "";
          const question = typeof payload.question === "string" ? payload.question.trim().slice(0, 600) : "";
          const activePage = typeof payload.activePage === "string" ? payload.activePage.trim().slice(0, 64) : "";
          const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim().slice(0, 128) : "";
          const runtimeState = payload.runtimeState === "ONLINE" || payload.runtimeState === "DEGRADED" || payload.runtimeState === "OFFLINE"
            ? payload.runtimeState
            : "";
          const summary = isRecord(payload.safeWorkspaceSummary) ? payload.safeWorkspaceSummary : {};
          const boundedCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
          if (!guidanceId || !question || !activePage || !runtimeState) throw new Error("INVALID_BOBY_GUIDANCE");
          return transaction.createJob({
            id: guidanceId,
            kind: "CODEX",
            state: options.codexCoordinator ? "QUEUED" : "WAITING_CODEX",
            attempts: 0,
            ...(options.codexCoordinator ? {} : { lastError: "CODEX_RUNNER_UNAVAILABLE" }),
            metadata: {
              createdAtUnixMs: Date.now(),
              purpose: "BOBY_GUIDANCE",
              question,
              activePage,
              runtimeState,
              ...(sessionId ? { bobySessionId: sessionId } : {}),
              safeWorkspaceSummary: {
                draftCount: boundedCount(summary.draftCount),
                reviewCount: boundedCount(summary.reviewCount),
                sourceCount: boundedCount(summary.sourceCount)
              }
            }
          });
        }
        if (kind === "LOCAL_STATE.SET") {
          const key = typeof payload.key === "string" ? payload.key : "";
          if (!key || key.length > 128) throw new Error("INVALID_LOCAL_STATE_KEY");
          const value = payload.value ?? null;
          if (canonicalJson(value).length > 256_000) throw new Error("LOCAL_STATE_TOO_LARGE");
          await transaction.setLocalState(key, value);
          return { key, value };
        }
        const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
        if (!jobId) throw new Error("INVALID_JOB_ID");
        const job = await transaction.getJob(jobId);
        if (job.state !== "FAILED" && job.state !== "DEAD_LETTER" && job.state !== "RETRY_SCHEDULED" && job.state !== "WAITING_CODEX") {
          throw new Error("JOB_NOT_RETRYABLE");
        }
        const { lastError: _lastError, ...retryableJob } = job;
        return transaction.saveJob({ ...retryableJob, state: "QUEUED", attempts: job.attempts + 1 });
      }
    );
    const createdDraft = kind === "DRAFT.CREATE" ? result as BackendJob : undefined;
    const persistedSchedule = isRecord(createdDraft?.metadata) && typeof createdDraft.metadata.scheduledAt === "string"
      ? createdDraft.metadata.scheduledAt
      : undefined;
    const effectivePayload = persistedSchedule ? { ...payload, scheduledAt: persistedSchedule } : payload;
    let codex: unknown = null;
    if (kind === "DRAFT.CREATE" && options.codexCoordinator) {
      const draftId = typeof payload.draftId === "string" ? payload.draftId : "";
      const sourceIds = Array.isArray(payload.sourceIds)
        ? payload.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
        : [];
      const urls = Array.isArray(payload.urls)
        ? payload.urls.filter((url): url is string => typeof url === "string")
        : [];
      const candidateUrl = validCandidateUrl(payload.candidateUrl) ? payload.candidateUrl.trim() : undefined;
      const sourceEvidence = options.sourceRepository
        ? await collectDraftSourceEvidence(options.sourceRepository, sourceIds, urls, options.sourceTransport, candidateUrl)
        : options.sourceTransport
          ? await collectDraftSourceEvidence(undefined, [], urls, options.sourceTransport)
          : [];
      const retainedEvidence = fallbackDraftSourceEvidence(payload.sources);
      codex = await options.codexCoordinator.submit({
        jobId: draftId,
        idempotencyKey: `draft:${idempotencyKey}`,
        definitionId: "DRAFT.CREATE",
        payload: { ...effectivePayload, sources: sourceEvidence.length > 0 ? sourceEvidence : retainedEvidence }
      });
    }
    if (kind === "BOBY.GUIDE" && options.codexCoordinator) {
      const metadata: Record<string, unknown> = isRecord((result as BackendJob).metadata)
        ? (result as BackendJob).metadata as Record<string, unknown>
        : {};
      codex = await options.codexCoordinator.submit({
        jobId: (result as BackendJob).id,
        idempotencyKey: `boby:${idempotencyKey}`,
        definitionId: "BOBY.GUIDE",
        payload: {
          question: metadata.question,
          activePage: metadata.activePage,
          runtimeState: metadata.runtimeState,
          ...(typeof metadata.bobySessionId === "string" && metadata.bobySessionId.length <= 128
            ? { sessionId: metadata.bobySessionId }
            : {}),
          safeWorkspaceSummary: metadata.safeWorkspaceSummary
        }
      });
    }
    if (kind === "JOB.RETRY" && options.codexCoordinator) {
      const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
      // The workflow row and the Codex coordinator record share the draft ID,
      // but have separate durable state. Requeue both sides so the Operations
      // button is a real recovery action rather than a misleading success.
      codex = await options.codexCoordinator.recoverInterrupted(codexRecoveryJobId(await repository.getJob(jobId)));
    }
    return revisionCommandSuccess(envelopeId, { requestId, idempotencyKey, kind: kind as "LOCAL_STATE.SET" }, { backendJob: result, codex }, await repository.getVersion());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow command failed";
    const code = message.startsWith("VERSION_CONFLICT:") ? "VERSION_CONFLICT" : message.includes("IDEMPOTENCY_KEY_REUSED") ? "IDEMPOTENCY_KEY_REUSED" : "ENGINE_OPERATION_FAILED";
    return revisionCommandFailure(envelopeId, code, message, code === "VERSION_CONFLICT");
  }
}


async function resolveNextSlot(
  repository: Pick<BackendRepositoryTransaction, "getLocalState" | "listJobs">,
  payload: Record<string, unknown>
): Promise<string | undefined> {
  if (payload.scheduleIntent !== "NEXT_SLOT" || typeof payload.scheduledAt === "string") return undefined;
  const state = await repository.getLocalState("desktop.editorial");
  const schedule = isRecord(state) && isRecord(state.schedule) && isRecord(state.schedule.slots)
    ? state.schedule.slots
    : {};
  const dayBySlot: Record<string, number> = {
    "slot-mon": 1, "slot-tue": 2, "slot-wed": 3, "slot-thu": 4,
    "slot-fri": 5, "slot-sat": 6, "slot-sun": 0
  };
  const now = new Date();
  const reserved = new Set(
    (await repository.listJobs()).flatMap((job) => {
      const scheduledAt = job.metadata?.scheduledAt;
      return typeof scheduledAt === "string" && Number.isFinite(Date.parse(scheduledAt)) ? [scheduledAt] : [];
    })
  );
  const candidates: Date[] = [];
  for (const [slotId, raw] of Object.entries(schedule)) {
    if (!isRecord(raw) || raw.enabled === false) continue;
    const time = typeof raw.time === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(raw.time);
    const weekday = dayBySlot[slotId] ?? (() => {
      const match = /^slot-(mon|tue|wed|thu|fri|sat|sun)-[1-5]$/u.exec(slotId);
      return match ? dayBySlot[`slot-${match[1]}`] : undefined;
    })();
    if (!time || weekday === undefined) continue;
    const [, hours, minutes] = time;
    const localNow = new Date(now.getTime() + 3 * 60 * 60 * 1_000);
    const candidate = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), Number(hours), Number(minutes)) - 3 * 60 * 60 * 1_000);
    const delta = (weekday - localNow.getUTCDay() + 7) % 7;
    candidate.setUTCDate(candidate.getUTCDate() + delta);
    if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 7);
    candidates.push(candidate);
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  const next = candidates.map((candidate) => candidate.toISOString()).find((candidate) => !reserved.has(candidate));
  if (!next && candidates.length > 0) throw new Error("SCHEDULE_SLOT_UNAVAILABLE");
  return next;
}

function revisionCommandSuccess(
  envelopeId: string,
  command: {
    requestId: string;
    idempotencyKey: string;
    kind: string;
  },
  value: unknown,
  sequence: number
): EngineResponse {
  return {
    version: 1,
    id: envelopeId,
    ok: true,
    kind: "command",
    result: {
      ok: true,
      version: 1,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      kind: command.kind as "REVISION.SAVE" | "REVISION.REPAIR_MEDIA" | "DRAFT.CREATE" | "JOB.RETRY" | "LOCAL_STATE.SET" | "APPROVAL.GRANT" | "APPROVAL.GRANT_HIGH_RISK",
      sequence,
      value
    }
  };
}

function revisionCommandFailure(
  envelopeId: string,
  code: string,
  message: string,
  retryable: boolean
): EngineResponse {
  return {
    version: 1,
    id: envelopeId,
    ok: false,
    kind: "command",
    result: {
      ok: false,
      version: 1,
      error: { code, message, retryable }
    }
  };
}

// Keep one selected source article sufficiently intact for an original,
// evidence-led draft.  This remains bounded so a hostile or malformed page
// cannot dominate the local Codex task.
const MAX_EVIDENCE_TEXT = 12_000;
// A desktop editor must never leave an apparent live task running for a
// quarter-hour without a user-visible decision. Longer work can be retried
// explicitly from Operations after the runner explains its stop condition.
export const CODEX_RUNNER_TIMEOUT_MS = 5 * 60 * 1_000;

function boundedEvidenceText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replaceAll("\u0000", "").slice(0, MAX_EVIDENCE_TEXT);
}

/**
 * A repair must not lose a revision's already captured evidence merely because
 * the original publisher URL is temporarily unavailable. This is a strict
 * structural copy of immutable local snapshots, not a network-derived claim.
 */
export function fallbackDraftSourceEvidence(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : "";
    const url = typeof raw.url === "string" && validCandidateUrl(raw.url) ? raw.url : "";
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : "";
    const fetchedAt = typeof raw.fetchedAt === "string" && Number.isFinite(Date.parse(raw.fetchedAt)) ? raw.fetchedAt : "";
    const contentHash = typeof raw.contentHash === "string" && /^[a-f0-9]{64}$/iu.test(raw.contentHash) ? raw.contentHash : "";
    const evidenceExcerpt = typeof raw.evidenceExcerpt === "string" && raw.evidenceExcerpt.trim()
      ? raw.evidenceExcerpt.slice(0, 12_000)
      : typeof raw.evidenceText === "string" && raw.evidenceText.trim()
        ? raw.evidenceText.slice(0, 12_000)
        : "";
    const evidenceExcerptHash = typeof raw.evidenceExcerptHash === "string" && /^[a-f0-9]{64}$/iu.test(raw.evidenceExcerptHash)
      ? raw.evidenceExcerptHash
      : evidenceExcerpt
        ? createHash("sha256").update(evidenceExcerpt, "utf8").digest("hex")
        : "";
    const evidenceVersionId = typeof raw.evidenceVersionId === "string" && /^entry-[a-f0-9]{64}$/iu.test(raw.evidenceVersionId)
      ? raw.evidenceVersionId
      : "";
    const evidenceAnchors = Array.isArray(raw.evidenceAnchors)
      ? raw.evidenceAnchors.flatMap((anchor) => {
        if (!isRecord(anchor) || anchor.sourceId !== id || typeof anchor.quoteHash !== "string" || !/^[a-f0-9]{64}$/iu.test(anchor.quoteHash)) return [];
        const start = typeof anchor.start === "number" && Number.isInteger(anchor.start) && anchor.start >= 0 ? anchor.start : undefined;
        const end = typeof anchor.end === "number" && Number.isInteger(anchor.end) && anchor.end >= (start ?? 0) ? anchor.end : undefined;
        return [{ sourceId: id, quoteHash: anchor.quoteHash, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }];
      })
      : [];
    return id && url && title && fetchedAt && contentHash && evidenceAnchors.length > 0
      ? [{ id, url, title, fetchedAt, contentHash, ...(evidenceExcerpt ? { evidenceText: evidenceExcerpt } : {}), ...(evidenceExcerptHash ? { evidenceExcerptHash } : {}), ...(evidenceVersionId ? { evidenceVersionId } : {}), evidenceAnchors }]
      : [];
  }).slice(0, 20);
}

/**
 * The source parser intentionally does not retain arbitrary page bodies in
 * the catalog. At drafting time we may use the already bounded fetched bytes
 * as untrusted evidence, after stripping executable and presentational HTML.
 */
function sourceEvidenceText(body: Uint8Array): string {
  try {
    return boundedEvidenceText(
      new TextDecoder("utf-8", { fatal: true })
        .decode(body)
        .replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)\s*>/giu, " ")
        .replace(/<[^>]*>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
    );
  } catch {
    return "";
  }
}

function mediaRepairRevisionId(revision: ArticleRevision): string {
  return `media-${createHash("sha256")
    .update(`${revision.id}:${computeRevisionHash(revision)}`, "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

function mediaRepairTarget(revision: ArticleRevision) {
  if (revision.generatedFiles?.some((file) => file.path.startsWith(".blogbot/generated/"))) {
    return { mode: "LOCAL_ONLY" as const };
  }
  if (revision.targetRepository === "local/blogbot-preview") {
    return { mode: "LOCAL_DEV" as const };
  }
  return { mode: "PUBLISH" as const };
}

function repairMediaGates(revision: ArticleRevision) {
  const ready = {
    id: "media",
    group: "media" as const,
    state: "PASS" as const,
    detail: "Hero medya paketi üç yayın oranında yerel olarak doğrulandı.",
    policyVersion: "2",
    reasonCode: "CHECKED"
  };
  const existing = revision.qualityGates ?? [];
  const replacesMediaGate = existing.some((gate) => gate.id === "media");
  return [
    ...existing.map((gate) => gate.id === "media" ? ready : gate),
    ...(replacesMediaGate ? [] : [ready])
  ];
}

async function createMediaRepairSuccessor(
  revision: ArticleRevision,
  dataDir: string,
  imageGenerator: ImageGeneratorPort | undefined
): Promise<ArticleRevision> {
  if (revision.state !== "REVIEW_REQUIRED") {
    throw new Error("REVISION_NOT_REVIEWABLE");
  }
  if (!validateRevisionPackageV2(revision)) {
    throw new Error("REVISION_PACKAGE_INCOMPLETE");
  }
  if (revision.media.some((asset) => asset.role === "hero" &&
    /^[a-f0-9]{64}$/iu.test(asset.sha256) &&
    Number.isSafeInteger(asset.byteSize) && asset.byteSize! > 0)) {
    throw new Error("REVISION_MEDIA_ALREADY_READY");
  }

  const direction: ArtDirection = {
    title: revision.tr.title,
    palette: ["#08131f", "#32d3a6"],
    motifs: ["network", "shield"],
    externalAssets: [],
    depictsRealPerson: false,
    depictsBrandLogo: false
  };
  const successorId = mediaRepairRevisionId(revision);
  let artifacts;
  if (imageGenerator) {
    try {
      const generated = await imageGenerator.generate({
        title: revision.tr.title,
        articleType: revision.articleType,
        section: revision.section,
        sourceTitles: revision.sources.map((source) => source.title)
      });
      artifacts = await renderGeneratedImageVariants(
        generated,
        join(dataDir, "media", successorId),
        revision.tr.slug
      );
    } catch {
      reportCodexLifecycle("IMAGEGEN_FALLBACK_LOCAL");
    }

  }
  artifacts ??= await renderCoverVariants(
    direction,
    join(dataDir, "media", successorId),
    revision.tr.slug
  );
  const media = await Promise.all(artifacts.map(async (artifact) => ({
    role: "hero" as const,
    path: `media/${successorId}/${artifact.path}`,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    byteSize: (await stat(artifact.absolutePath)).size,
  })));
  const qualityGates = repairMediaGates(revision);
  const successor = createEditedRevision(revision, successorId, {
    media,
    qualityGates,
    editorialReviewReportHash: createHash("sha256")
      .update(canonicalJson({
        kind: "MEDIA_REPAIR_SUCCESSOR",
        supersedesRevisionId: revision.id,
        qualityGates
      }), "utf8")
      .digest("hex")
  });
  successor.generatedFiles = generatedPackageFiles(successor, mediaRepairTarget(revision));
  return successor;
}

function validCandidateUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function candidateTokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("tr-TR").normalize("NFKC").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function candidateSimilarityTokens(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function evidenceFields(text: unknown, sourceId: string): Record<string, unknown> {
  const evidenceText = boundedEvidenceText(text);
  const quoteHash = createHash("sha256").update(evidenceText).digest("hex");
  return {
    evidenceText,
    evidenceAnchors: evidenceText
      ? [{ sourceId, start: 0, end: evidenceText.length, quoteHash }]
      : [],
    // Source material is data only. Codex must never treat it as instructions.
    untrusted: true
  };
}

export async function collectDraftSourceEvidence(
  repository: SourceRepository | undefined,
  sourceIds: string[],
  urls: string[],
  transport?: FetchTransport,
  candidateUrl?: string
): Promise<Array<Record<string, unknown>>> {
  const evidence: Array<Record<string, unknown>> = [];
  for (const sourceId of [...new Set(sourceIds)].slice(0, 50)) {
    if (!repository) break;
    try {
      const source = await repository.getSource(sourceId);
      const selected = candidateUrl && repository.findEntryByUrl
        ? await repository.findEntryByUrl(sourceId, candidateUrl)
        : undefined;
      const selectedEntries = selected
        ? [selected]
        : candidateUrl
          ? (await repository.listEntriesBounded(sourceId, 20))
            .filter((entry) => entry.url === candidateUrl)
            .slice(0, 1)
          : await repository.listEntriesBounded(sourceId, 20);
      for (const entry of selectedEntries) {
        const id = `${sourceId}:${entry.externalId}`;
        let evidenceText = entry.summary?.trim() || entry.title;
        // A selected story deserves its article context rather than just the
        // feed teaser. Never fan out across an entire feed at draft time.
        if (transport && candidateUrl && entry.url === candidateUrl) {
          try {
            const fetched = await fetchSource(entry.url, transport, { timeoutMs: 8_000, maxBytes: 2_000_000 });
            evidenceText = sourceEvidenceText(fetched.body) || evidenceText;
          } catch {
            // Retain the reviewed local feed excerpt if the article page is
            // unavailable; the final evidence gate can still block weak work.
          }
        }
        evidence.push({
          id,
          sourceId,
          url: entry.url || source.url,
          title: entry.title,
          summary: entry.summary ?? "",
          publishedAt: entry.publishedAt ?? null,
          fetchedAt: source.updatedAt,
          // The review decisions belong to the immutable evidence handed to
          // the draft runner. A later edit to the mutable source catalog must
          // not silently change what this revision can publish.
          trustStatus: source.trustStatus,
          rightsStatus: source.rightsStatus,
          // Feed entries do not retain full publisher bodies. Bind the
          // evidence snapshot to the normalized text we actually pass to the
          // runner instead of using an unverifiable zero hash.
          contentHash: createHash("sha256").update(boundedEvidenceText(evidenceText), "utf8").digest("hex"),
          ...(entry.versionId ? { evidenceVersionId: entry.versionId } : {}),
          ...evidenceFields(evidenceText, id)
        });
      }
    } catch {
      // Source evidence is intentionally best-effort; missing evidence must
      // remain visible to the editorial gate rather than becoming a reason to
      // read arbitrary local files.
    }
  }
  if (transport) {
    for (const url of [...new Set(urls)].slice(0, 20)) {
      try {
        const fetched = await fetchSource(url, transport, { timeoutMs: 8_000, maxBytes: 2_000_000 });
        const analysis = analyzeSourceDocument({ finalUrl: fetched.finalUrl, contentType: fetched.contentType, body: fetched.body }, { maxEntries: 20 });
        const bodyHash = createHash("sha256").update(fetched.body).digest("hex");
        const entries = analysis.entries.length > 0 ? analysis.entries : [{ externalId: fetched.finalUrl, title: analysis.title ?? fetched.finalUrl, url: fetched.finalUrl, summary: "" }];
        for (const entry of entries) {
          const id = `url:${bodyHash}:${entry.externalId}`;
          const evidenceText = entry.summary?.trim() || sourceEvidenceText(fetched.body) || entry.title;
          evidence.push({
            id,
            sourceId: `url:${bodyHash}`,
            url: entry.url,
            title: entry.title,
            summary: entry.summary ?? "",
            publishedAt: entry.publishedAt ?? null,
            fetchedAt: new Date().toISOString(),
            contentHash: bodyHash,
            // Direct URLs have no reviewed local source record. Preserve that
            // fact so a generated revision remains review-required instead of
            // inheriting an implicit approval.
            trustStatus: "PENDING",
            rightsStatus: "PENDING",
            ...evidenceFields(evidenceText, id)
          });
        }
      } catch {
        // Failed direct URLs stay absent from evidence, so the revision remains
        // NEEDS_SOURCE instead of silently trusting an unavailable page.
      }
    }
  }
  return evidence;
}

/**
 * Feed entries are mutable retention data, while revision snapshots are not.
 * Keep every catalog feed that contributed immutable evidence until no saved
 * revision refers to one of its captured entries.
 */
export function protectedCatalogSourceIds(
  revisions: readonly { sources: readonly { id: string; evidenceVersionId?: string }[] }[],
  catalogSourceIds: readonly string[]
): string[] {
  const snapshotSourceIds = revisions.flatMap((revision) => revision.sources.map((source) => source.id));
  return catalogSourceIds.filter((catalogSourceId) =>
    snapshotSourceIds.some((snapshotSourceId) =>
      snapshotSourceId === catalogSourceId || snapshotSourceId.startsWith(`${catalogSourceId}:`)
    )
  );
}

/**
 * New revisions name the exact immutable source-entry version that supported
 * them. Legacy revisions have no such identity, so their whole catalog source
 * remains protected rather than risking evidence loss during migration.
 */
export function protectedCatalogEvidenceReferences(
  revisions: readonly { sources: readonly { id: string; evidenceVersionId?: string }[] }[],
  catalogSourceIds: readonly string[]
): string[] {
  const exactVersionIds = revisions.flatMap((revision) =>
    revision.sources.flatMap((source) =>
      typeof source.evidenceVersionId === "string" && /^entry-[a-f0-9]{64}$/u.test(source.evidenceVersionId)
        ? [source.evidenceVersionId]
        : []
    )
  );
  const legacySourceIds = protectedCatalogSourceIds(
    revisions.map((revision) => ({
      ...revision,
      sources: revision.sources.filter((source) => !source.evidenceVersionId)
    })),
    catalogSourceIds
  );
  return [...new Set([...exactVersionIds, ...legacySourceIds])];
}

async function purgeExpiredSourceEvidence(
  repository: BackendRepository,
  sourceRepository: SourceRepository,
  beforeIso: string
): Promise<number> {
  const [references, sources] = await Promise.all([
    repository.listRevisionEvidenceReferences
      ? repository.listRevisionEvidenceReferences()
      : repository.sync(0).then((snapshot) => snapshot.snapshot.revisions),
    sourceRepository.listSources()
  ]);
  return sourceRepository.purgeExpiredEntries(
    beforeIso,
    protectedCatalogEvidenceReferences(references, sources.map((source) => source.id))
  );
}

/**
 * Automatic archive creation holds PGlite's exclusive query gate while it
 * snapshots the live data directory. Keep it outside the interactive startup
 * window; users can still create a manual backup immediately when needed.
 */
export function automaticBackupInitialDelayMs(): number {
  return 24 * 60 * 60 * 1_000;
}

/** Resolves legacy candidate jobs to the one feed entry the editor selected.
 * Older queue records predate `candidateUrl`; keep their durable identity but
 * never send an entire feed to the Codex runner when the selected entry can
 * still be derived from the local source catalog. */
export async function resolveCandidateSourceUrl(
  repository: SourceRepository | undefined,
  sourceIds: readonly string[],
  candidateId: unknown
): Promise<string | undefined> {
  if (!repository || typeof candidateId !== "string" || !candidateId.startsWith("candidate-")) return undefined;
  for (const sourceId of [...new Set(sourceIds)].slice(0, 50)) {
    try {
      const entries = await repository.listEntries(sourceId);
      const selected = entries.find((entry) => `candidate-${createCandidateKey(sourceId, entry.externalId)}` === candidateId);
      if (selected && validCandidateUrl(selected.url)) return selected.url;
    } catch {
      // A missing local catalog row leaves the existing evidence untouched.
    }
  }
  return undefined;
}

/**
 * A local process can stop after a Codex job is claimed but before it writes
 * a result. On the next engine start, requeue the persisted Codex record with
 * its original idempotency identity; do not ask the editor to recreate work.
 */
export async function recoverWaitingDraftJobs(
  repository: BackendRepository,
  coordinator: CodexWorkerCoordinator,
  sourceRepository?: SourceRepository,
  sourceTransport?: FetchTransport
): Promise<number> {
  let recovered = 0;
  const jobs = await repository.listJobs();
  for (const job of jobs) {
    if (job.kind !== "DRAFT" || !["QUEUED", "RUNNING", "WAITING_CODEX", "RETRY_SCHEDULED"].includes(job.state)) continue;
    const metadata = isRecord(job.metadata) ? job.metadata : {};
    const finalReviewJobId = typeof metadata.finalReviewJobId === "string" && metadata.finalReviewJobId.trim()
      ? metadata.finalReviewJobId
      : undefined;
    if (finalReviewJobId && typeof metadata.progressStage === "string" && metadata.progressStage.startsWith("FINAL_REVIEW")) {
      const persisted = await coordinator.recoverInterrupted(finalReviewJobId);
      if (persisted.recovered) {
        const { lastError: _lastError, ...queued } = job;
        await repository.saveJob({
          ...queued,
          state: "QUEUED",
          metadata: {
            ...metadata,
            progressStage: "FINAL_REVIEW_RETRYING",
            lastQueuedAtUnixMs: Date.now(),
            recoveryReason: "ENGINE_RESTART"
          }
        });
        recovered += 1;
      } else if (job.state === "RUNNING") {
        await repository.saveJob({
          ...job,
          state: "WAITING_CODEX",
          lastError: "FINAL_REVIEW_RECOVERY_REQUIRED",
          metadata: { ...metadata, progressStage: "FINAL_REVIEW_RECOVERY_REQUIRED", finalReviewJobId }
        });
      }
      continue;
    }
    // A bounded runner timeout is a completed, user-visible stop condition,
    // not an interrupted process. Replaying it on every application start
    // would hide the failure and make the promised manual retry ineffective.
    if (job.state === "WAITING_CODEX" && metadata.codexWaitReason === "RUNNER_TIMEOUT") continue;
    const persisted = await coordinator.recoverInterrupted(job.id);
    if (persisted.recovered) {
      const { lastError: _lastError, ...queued } = job;
      const recoveryCount = typeof metadata.recoveryCount === "number" && Number.isSafeInteger(metadata.recoveryCount)
        ? Math.max(0, metadata.recoveryCount) + 1
        : 1;
      await repository.saveJob({
        ...queued,
        state: "QUEUED",
        metadata: {
          ...metadata,
          recoveryCount,
          lastQueuedAtUnixMs: Date.now(),
          recoveryReason: "ENGINE_RESTART"
        }
      });
      recovered += 1;
      continue;
    }
    // Older local workspaces can contain a draft created before the Codex job
    // store existed. Only those records need a new, deterministic reservation.
    if (persisted.snapshot || job.state === "RUNNING") continue;
    const sourceIds = Array.isArray(metadata.sourceIds)
      ? metadata.sourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const urls = Array.isArray(metadata.urls)
      ? metadata.urls.filter((value): value is string => typeof value === "string")
      : [];
    if (sourceIds.length === 0 && urls.length === 0) continue;
    const candidateUrl = validCandidateUrl(metadata.candidateUrl) ? metadata.candidateUrl.trim() : undefined;
    const sources = await collectDraftSourceEvidence(sourceRepository, sourceIds, urls, sourceTransport, candidateUrl);
    const payload = {
      draftId: job.id,
      instruction: typeof metadata.instruction === "string" ? metadata.instruction : "",
      sourceIds,
      urls,
      ...(candidateUrl ? { candidateUrl } : {}),
      section: typeof metadata.section === "string" ? metadata.section : "haberler",
      articleType: typeof metadata.articleType === "string" ? metadata.articleType : "news",
      urgency: typeof metadata.urgency === "string" ? metadata.urgency : "normal",
      tone: typeof metadata.tone === "string" ? metadata.tone : "neutral",
      length: typeof metadata.length === "string" ? metadata.length : "standard",
      visualPolicy: typeof metadata.visualPolicy === "string" ? metadata.visualPolicy : "GENERATE",
      scheduleIntent: typeof metadata.scheduleIntent === "string" ? metadata.scheduleIntent : "UNSCHEDULED",
      ...(typeof metadata.revisionId === "string" ? { revisionId: metadata.revisionId } : {}),
      ...(metadata.baseRevision !== undefined ? { baseRevision: metadata.baseRevision } : {}),
      ...(typeof metadata.preferredAuthor === "string" ? { preferredAuthor: metadata.preferredAuthor } : {}),
      ...(typeof metadata.preferredReviewer === "string" ? { preferredReviewer: metadata.preferredReviewer } : {}),
      ...(typeof metadata.scheduledAt === "string" ? { scheduledAt: metadata.scheduledAt } : {}),
      sources
    };
    await coordinator.submit({
      jobId: job.id,
      idempotencyKey: `recovered:${job.id}`,
      definitionId: "DRAFT.CREATE",
      payload
    });
    const { lastError: _lastError, ...queued } = job;
    const recoveryMetadata = isRecord(job.metadata) ? job.metadata : {};
    const recoveryCount = typeof recoveryMetadata.recoveryCount === "number" && Number.isSafeInteger(recoveryMetadata.recoveryCount)
      ? Math.max(0, recoveryMetadata.recoveryCount) + 1
      : 1;
    await repository.saveJob({
      ...queued,
      state: "QUEUED",
      metadata: {
        ...recoveryMetadata,
        recoveryCount,
        lastQueuedAtUnixMs: Date.now(),
        recoveryReason: "ENGINE_RESTART"
      }
    });
    recovered += 1;
  }
  return recovered;
}

async function recoverInterruptedNativePublications(repository: BackendRepository): Promise<number> {
  let recovered = 0;
  for (const effect of await repository.listOutbox()) {
    if (effect.state !== "IN_PROGRESS") continue;
    await repository.updateOutbox({
      ...effect,
      state: "UNKNOWN",
      nextAttemptAt: new Date().toISOString(),
      lastError: "NATIVE_PUBLICATION_INTERRUPTED"
    });
    recovered += 1;
  }
  return recovered;
}

export async function createPersistentEngineProtocol(
  dataDir: string,
  options: PersistentEngineProtocolOptions = {}
): Promise<EngineProtocolRuntime> {
  const repository = await PGliteBackendRepository.open(dataDir);
  if (options.nativePublicationBroker) {
    await recoverInterruptedNativePublications(repository);
  }
  const sourceRepository = await PGliteSourceRepository.fromDatabase(
    repository.getDatabase()
  );
  const queue = new LocalQueueRuntime(repository.getDatabase(), {
    onFault: () => reportBackgroundTaskFault("LOCAL_QUEUE_UNAVAILABLE")
  });
  const fetcherBinary = process.env.BLOGBOT_FETCHER_BIN;
  const sourceTransport = options.sourceTransport ?? (
    fetcherBinary
      ? createFetcherSidecarTransport(fetcherBinary)
      : createNodeFetchTransport()
  );
  const imageGenerator = options.imageGenerator ?? imageGeneratorFromEnvironment();
  const sourceScanCoordinator = new SourceScanCoordinator(
    sourceRepository,
    queue
  );
  const sourceScanScheduler = new SourceScanScheduler(
    repository,
    sourceRepository,
    sourceScanCoordinator,
    undefined,
    undefined,
    {
      onFault: (_error, phase) => reportBackgroundTaskFault("SOURCE_SCHEDULER_UNAVAILABLE", undefined, phase)
    }
  );
  let codexCoordinator: CodexWorkerCoordinator | undefined;
  let publicationOutboxWorker: PublicationOutboxWorker | undefined;
  let publicationScheduler: PublicationScheduler | undefined;
  const publicationProcessor = options.publicationProcessor ?? (options.publicationBroker
    ? createProductionPublicationProcessor(repository, options.publicationBroker, dataDir)
    : undefined);
  // Keep the advertised capability independent from worker startup scope so
  // every later doctor request reports the same injected host capability.
  const publicationReady = Boolean(publicationProcessor) || options.nativePublicationBroker === true;
  const runSourceRetention = () => runBackgroundMaintenance(
    repository,
    "maintenance.source-retention",
    "SOURCE_RETENTION_UNAVAILABLE",
    () => purgeExpiredSourceEvidence(repository, sourceRepository, new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString())
  );
  let sourceRetentionTimer: ReturnType<typeof setInterval> | undefined;
  const runAutomaticBackup = () => runBackgroundMaintenance(
    repository,
    "maintenance.automatic-backup",
    "AUTOMATIC_BACKUP_UNAVAILABLE",
    () => createConsistentAutomaticBackup(repository.getDatabase(), dataDir)
  );
  let automaticBackupTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await queue.start();
    await sourceScanCoordinator.recover();
    if (options.startSourceWorker !== false) {
      await new SourceScanWorker(
        sourceRepository,
        queue,
        sourceTransport
      ).start();
    }
    if (options.startSourceScheduler === true) {
      sourceScanScheduler.start();
    }
    const codexCommand = options.codexCommand ?? process.env.BLOGBOT_CODEX_COMMAND;
    const codexHome = options.codexHome ?? process.env.BLOGBOT_CODEX_HOME ?? join(dataDir, "codex-home");
    const codexPort = options.codexPort ?? (codexCommand
      ? (await mkdir(codexHome, { recursive: true }), createCodexCliPort({ command: codexCommand, codexHome, timeoutMs: CODEX_RUNNER_TIMEOUT_MS }))
      : undefined);
    if (codexPort) {
      const codexStore = new PGliteCodexJobStore(repository.getDatabase());
      codexCoordinator = createCodexWorkerCoordinator({
        persistence: codexStore,
        queue: new PGliteCodexQueueAdapter(queue),
        codex: codexPort,
        taskResolver: {
          async resolve(snapshot) {
            if (snapshot.definitionId === "BOBY.GUIDE" && isRecord(snapshot.payload)) {
              const payload = snapshot.payload;
              return createBobyGuideTask({
                question: typeof payload.question === "string" ? payload.question : "",
                activePage: typeof payload.activePage === "string" ? payload.activePage : "dashboard",
                ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
                runtimeState: payload.runtimeState === "ONLINE" || payload.runtimeState === "DEGRADED" || payload.runtimeState === "OFFLINE"
                  ? payload.runtimeState
                  : "DEGRADED",
                safeWorkspaceSummary: isRecord(payload.safeWorkspaceSummary)
                  ? {
                      draftCount: typeof payload.safeWorkspaceSummary.draftCount === "number" ? payload.safeWorkspaceSummary.draftCount : 0,
                      reviewCount: typeof payload.safeWorkspaceSummary.reviewCount === "number" ? payload.safeWorkspaceSummary.reviewCount : 0,
                      sourceCount: typeof payload.safeWorkspaceSummary.sourceCount === "number" ? payload.safeWorkspaceSummary.sourceCount : 0
                    }
                  : { draftCount: 0, reviewCount: 0, sourceCount: 0 }
              } satisfies BobyGuideInput);
            }
            if (snapshot.definitionId !== "DRAFT.CREATE" || !isRecord(snapshot.payload)) {
              return createDraftCodexTaskResolver().resolve(snapshot);
            }
            const payload = snapshot.payload;
            const sourceIds = Array.isArray(payload.sourceIds)
              ? payload.sourceIds.filter((value): value is string => typeof value === "string")
              : [];
            const candidateUrl = validCandidateUrl(payload.candidateUrl)
              ? payload.candidateUrl.trim()
              : await resolveCandidateSourceUrl(sourceRepository, sourceIds, payload.candidateId);
            if (!candidateUrl) return createDraftCodexTaskResolver().resolve(snapshot);
            // Re-resolve from the enriched snapshot instead of replacing the
            // resolver's contract with raw job metadata. The draft resolver
            // deliberately bounds untrusted source evidence before it reaches
            // Codex; bypassing it makes real candidate work behave differently
            // from the verified structured task contract.
            return createDraftCodexTaskResolver().resolve({
              ...snapshot,
              payload: {
                ...payload,
                candidateUrl,
                sources: await collectDraftSourceEvidence(sourceRepository, sourceIds, [], sourceTransport, candidateUrl)
              }
            });
          }
        },
        onStarted: async ({ submission }) => {
          reportCodexLifecycle("CODEX_JOB_STARTED");
          await syncCodexParentJobState(repository, submission, { kind: "STARTED" });
        },
        onTaskReady: async ({ submission }) => {
          await syncCodexParentJobState(repository, submission, { kind: "TASK_READY" });
        },
        onWaiting: async ({ submission, reason, diagnosticCode, diagnosticDetail }) => {
          reportCodexLifecycle("CODEX_JOB_WAITING");
          if (diagnosticCode) reportCodexLifecycle(diagnosticCode, (line) => process.stderr.write(line), diagnosticDetail);
          await syncCodexParentJobState(repository, submission, { kind: "WAITING", reason, ...(diagnosticDetail ? { diagnosticDetail } : {}) });
        },
        onRetrying: async ({ submission, failure, transientFailureCount, retryAt }) => {
          reportCodexLifecycle("CODEX_JOB_RETRYING");
          await syncCodexParentJobState(repository, submission, { kind: "RETRYING", failure, transientFailureCount, retryAt });
        },
        onCompleted: async ({ submission, output, conversationSessionId }) => {
          reportCodexLifecycle("CODEX_JOB_COMPLETED");
          if (submission.definitionId === "BOBY.GUIDE" && createBobyGuideTask({
            question: "Boby",
            activePage: "dashboard",
            runtimeState: "ONLINE",
            safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 }
          }).validateOutput(output)) {
            const job = await repository.getJob(submission.jobId);
            await repository.saveJob({
              ...job,
              state: "SUCCEEDED",
              metadata: {
                ...(job.metadata ?? {}),
                completedAtUnixMs: Date.now(),
                bobyReply: (output as BobyGuideOutput).reply,
                bobyActions: (output as BobyGuideOutput).suggestedActions,
                ...(conversationSessionId ? { bobySessionId: conversationSessionId } : {})
              }
            });
            return;
          }
          if (submission.definitionId === "DRAFT.CREATE" && isDraftCodexOutput(output)) {
            const revision = materializeDraftRevision(submission.jobId, submission.payload, output);
            const draftPayload = isRecord(submission.payload) ? submission.payload : {};
            const visualPolicy = typeof draftPayload.visualPolicy === "string"
              ? draftPayload.visualPolicy
              : "GENERATE";
            if (visualPolicy !== "NONE") {
              let artifacts;
              if (visualPolicy === "GENERATE" && imageGenerator) {
                try {
                  const sourceTitles = Array.isArray(draftPayload.sources)
                    ? draftPayload.sources.flatMap((value) => isRecord(value) && typeof value.title === "string" ? [value.title] : [])
                    : [];
                  const generated = await imageGenerator.generate({
                    title: output.tr.title,
                    articleType: typeof draftPayload.articleType === "string" ? draftPayload.articleType : "news",
                    section: typeof draftPayload.section === "string" ? draftPayload.section : "haberler",
                    sourceTitles,
                    summary: output.tr.description,
                    keyClaims: output.claims.map((claim) => claim.trText),
                    visualIntent: `Makalenin ana konusu olan ${output.tr.title} için, ${typeof draftPayload.articleType === "string" ? draftPayload.articleType : "editoryal"} türüne uygun özgün ve metinsiz bir editoryal kompozisyon oluştur.`
                  });
                  artifacts = await renderGeneratedImageVariants(generated, join(dataDir, "media", revision.id), revision.tr.slug);
                } catch {
                  // ImageGen is an explicit editorial requirement. Do not
                  // replace a failed article-specific visual with a generic
                  // local cover and accidentally make it approval-eligible.
                  reportCodexLifecycle("IMAGEGEN_REQUIRED_FAILED");
                }
              }
              if (visualPolicy === "GENERATE" && !imageGenerator) {
                reportCodexLifecycle("IMAGEGEN_REQUIRED_UNAVAILABLE");
              }
              if (visualPolicy === "LOCAL_RENDERER") {
                const direction: ArtDirection = {
                  title: output.tr.title,
                  palette: ["#08131f", "#32d3a6"],
                  motifs: ["network", "shield"],
                  externalAssets: [],
                  depictsRealPerson: false,
                  depictsBrandLogo: false
                };
                artifacts = await renderCoverVariants(direction, join(dataDir, "media", revision.id), revision.tr.slug);
              }
              revision.media = await Promise.all((artifacts ?? []).map(async (artifact) => ({
                role: "hero",
                path: `media/${revision.id}/${artifact.path}`,
                sha256: artifact.sha256,
                width: artifact.width,
                height: artifact.height,
                byteSize: (await stat(artifact.absolutePath)).size,
              })));
            }
            const job = await repository.getJob(submission.jobId);
            await repository.saveJob({
              ...job,
              state: "RUNNING",
              metadata: { ...(job.metadata ?? {}), progressStage: "FINAL_REVIEW_QUEUED", finalReviewJobId: `${submission.jobId}:final-review`, qualityReviewQueuedAtUnixMs: Date.now() }
            });
            await codexCoordinator!.submit({
              jobId: `${submission.jobId}:final-review`,
              idempotencyKey: `final-review:${submission.idempotencyKey}`,
              definitionId: "REVISION.FINAL_REVIEW",
              payload: { originalJobId: submission.jobId, revision }
            });
            return;
          }
          if (submission.definitionId !== "REVISION.FINAL_REVIEW" || !isFinalReviewCodexOutput(output) || !isRecord(submission.payload)) {
            throw new Error("CODEX_OUTPUT_CONTRACT_MISMATCH");
          }
          const originalJobId = typeof submission.payload.originalJobId === "string" ? submission.payload.originalJobId : "";
          const rawRevision = submission.payload.revision;
          if (!originalJobId || !isRecord(rawRevision)) throw new Error("FINAL_REVIEW_REVISION_MISSING");
          const connectorState = await repository.getLocalState("desktop.connectors");
          const connectorChecks = await repository.getLocalState("desktop.connectorChecks");
          const connectors = isRecord(connectorState) ? connectorState : {};
          const checks = isRecord(connectorChecks) ? connectorChecks : {};
          const site = isRecord(connectors.site) ? connectors.site : {};
          const github = isRecord(connectors.github) ? connectors.github : {};
          const siteCheck = isRecord(checks.site) ? checks.site : {};
          const adapterDryRun = isRecord(siteCheck.adapterDryRun) ? siteCheck.adapterDryRun : {};
          const revision = finalizeReviewedRevision(rawRevision as unknown as ArticleRevision, output, {
            mode: site.mode === "PUBLISH" || site.mode === "LOCAL_DEV" ? site.mode : "LOCAL_ONLY",
            owner: typeof github.owner === "string" ? github.owner : undefined,
            repository: typeof github.repository === "string" ? github.repository : undefined,
            branch: typeof github.branch === "string" ? github.branch : undefined,
            baseSha: typeof github.baseSha === "string" ? github.baseSha : undefined,
            adapterId: typeof adapterDryRun.adapterId === "string" ? adapterDryRun.adapterId : undefined,
            adapterVersion: typeof adapterDryRun.adapterVersion === "string" ? adapterDryRun.adapterVersion : undefined
          });
          await repository.runIdempotent(
            `codex-materialize:${originalJobId}`,
            canonicalJson(revision),
            (transaction) => transaction.insertRevision(revision)
          );
          const job = await repository.getJob(originalJobId);
          const completedJob: BackendJob = {
            ...job,
            state: "SUCCEEDED",
            metadata: { ...(job.metadata ?? {}), revisionId: revision.id, completedAtUnixMs: Date.now() }
          };
          delete completedJob.lastError;
          await repository.saveJob(completedJob);
        }
      });
      await recoverWaitingDraftJobs(
        repository,
        codexCoordinator,
        sourceRepository,
        sourceTransport
      );
      await registerCodexQueueWorker(queue, codexCoordinator);
    }
    const effectivePublicationProcessor = publicationProcessor;
    if (effectivePublicationProcessor) {
      publicationOutboxWorker = startPublicationOutboxWorker(repository, effectivePublicationProcessor);
    }
    // A scheduler without a processor can only create durable effects that no
    // bundled runtime is able to reconcile. Keep recovery fail-closed: due
    // work remains scheduled until the host supplies the same processor that
    // drains the outbox.
    if (options.startPublicationScheduler === true && effectivePublicationProcessor) {
      publicationScheduler = new PublicationScheduler(
        repository,
        () => new Date(),
        options.publicationSchedulerPollMs ?? 60_000
      );
      publicationScheduler.start();
    }
    // Do not let maintenance race PGlite migrations, queue setup, or worker
    // registration. The old eager fire-and-forget startup could leave source
    // scans waiting behind retention/backup work before the engine became
    // ready. Bootstrap first; maintenance remains best-effort and unref'd.
    sourceRetentionTimer = setInterval(() => { void runSourceRetention(); }, 24 * 60 * 60 * 1_000);
    sourceRetentionTimer.unref?.();
    automaticBackupTimer = setInterval(() => { void runAutomaticBackup(); }, automaticBackupInitialDelayMs());
    automaticBackupTimer.unref?.();
  } catch (error) {
    if (automaticBackupTimer) clearInterval(automaticBackupTimer);
    if (sourceRetentionTimer) clearInterval(sourceRetentionTimer);
    publicationOutboxWorker?.stop();
    publicationScheduler?.stop();
    await queue.stop();
    await repository.close();
    throw error;
  }
  const protocolOptions: EngineProtocolOptions = {
    sourceRepository,
    sourceTransport,
    sourceScanCoordinator,
    publicationReady,
    nativePublicationBroker: options.nativePublicationBroker === true,
    allowUnsafeRevisionSaveForTests: options.allowUnsafeRevisionSaveForTests === true,
    verifyEncryptionIntegrity: async () => {
      await repository.verifyEncryptionIntegrity();
      await sourceRepository.verifyEncryptionIntegrity();
    },
    mediaDataDir: dataDir,
    ...(imageGenerator ? { imageGenerator } : {}),
    ...(codexCoordinator ? { codexCoordinator } : {})
  };
  const protocol = createEngineProtocol(repository, "ready", protocolOptions);
  return {
    handle: async (input: unknown) => {
      if (isRecord(input) && input.kind === "media.read") {
        const id = typeof input.id === "string" ? input.id : "media-read";
        const revisionId = typeof input.revisionId === "string" ? input.revisionId : "";
        const sha256 = typeof input.sha256 === "string" ? input.sha256.toLowerCase() : "";
        const offset = Number.isSafeInteger(input.offset) ? Number(input.offset) : -1;
        const length = Number.isSafeInteger(input.length) ? Number(input.length) : -1;
        if (!/^[A-Za-z0-9-]{1,128}$/u.test(revisionId) || !/^[a-f0-9]{64}$/u.test(sha256) || offset < 0 || length < 1 || length > 64 * 1024) {
          return sourceProtocolError(id, "command", "INVALID_MEDIA_READ", "Media read metadata is invalid");
        }
        try {
          const revision = await repository.getRevision(revisionId);
          const asset = revision.media.find((item) => item.sha256.toLowerCase() === sha256);
          if (!asset || !asset.path.startsWith(`media/${revisionId}/`) || asset.path.split(/[\\/]/u).some((segment) => !segment || segment === "." || segment === "..")) {
            throw new Error("MEDIA_ASSET_NOT_FOUND");
          }
          const bytes = await readFile(join(dataDir, asset.path));
          if (createHash("sha256").update(bytes).digest("hex") !== sha256 || (typeof asset.byteSize === "number" && asset.byteSize !== bytes.byteLength)) {
            throw new Error("MEDIA_ASSET_INTEGRITY_FAILURE");
          }
          const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
          return { version: 1, id, ok: true, kind: "media.read", value: { offset, totalBytes: bytes.byteLength, contentBase64: chunk.toString("base64"), eof: offset + chunk.byteLength >= bytes.byteLength } };
        } catch (error) {
          return sourceProtocolError(id, "command", error instanceof Error ? error.message : "MEDIA_READ_FAILED", "Media asset could not be read");
        }
      }
      if (isRecord(input) && input.kind === "backup.auto") {
        return createConsistentAutomaticBackup(repository.getDatabase(), dataDir);
      }
      if (isRecord(input) && (input.kind === "backup.create" || input.kind === "backup.auto.list" || input.kind === "backup.auto.verify" || input.kind === "backup.auto.restore.preview" || input.kind === "backup.auto.restore" || input.kind === "backup.verify" || input.kind === "backup.restore.preview" || input.kind === "backup.restore")) {
        return handleBackupRequest(input, dataDir);
      }
      return protocol(input);
    },
    close: async () => {
      try {
        if (automaticBackupTimer) clearInterval(automaticBackupTimer);
        if (sourceRetentionTimer) clearInterval(sourceRetentionTimer);
        publicationOutboxWorker?.stop();
        publicationScheduler?.stop();
      sourceScanScheduler.stop();
        await queue.stop();
      } finally {
        await repository.close();
      }
    }
  };
}

export async function syncCodexParentJobState(
  repository: BackendRepository,
  submission: CodexWorkSubmission,
  update:
    | { kind: "STARTED" }
    | { kind: "TASK_READY" }
    | { kind: "WAITING"; reason: string; diagnosticDetail?: string }
    | { kind: "RETRYING"; failure: string; transientFailureCount: number; retryAt: string }
): Promise<void> {
  const finalReview = submission.definitionId === "REVISION.FINAL_REVIEW";
  const originalJobId = finalReview && isRecord(submission.payload) && typeof submission.payload.originalJobId === "string"
    ? submission.payload.originalJobId
    : submission.jobId;
  if (!originalJobId) return;
  const job = await repository.getJob(originalJobId);
  if (finalReview) {
    if (update.kind === "STARTED") {
      if (!["QUEUED", "RUNNING", "RETRY_SCHEDULED"].includes(job.state)) return;
      await repository.saveJob({
        ...job,
        state: "RUNNING",
        metadata: { ...(job.metadata ?? {}), progressStage: "FINAL_REVIEW", finalReviewJobId: submission.jobId, finalReviewStartedAtUnixMs: Date.now() }
      });
      return;
    }
    if (update.kind === "WAITING") {
      if (!["QUEUED", "RUNNING", "RETRY_SCHEDULED"].includes(job.state)) return;
      await repository.saveJob({
        ...job,
        state: "WAITING_CODEX",
        metadata: {
          ...(job.metadata ?? {}),
          progressStage: "FINAL_REVIEW_WAITING_CODEX",
          finalReviewJobId: submission.jobId,
          finalReviewWaitReason: update.reason,
          ...(update.diagnosticDetail ? { codexDiagnosticDetail: update.diagnosticDetail.slice(0, 240) } : {}),
          waitingAtUnixMs: Date.now()
        }
      });
      return;
    }
    if (update.kind === "RETRYING") {
      if (!["QUEUED", "RUNNING", "RETRY_SCHEDULED"].includes(job.state)) return;
      await repository.saveJob({
        ...job,
        state: "RETRY_SCHEDULED",
        metadata: {
          ...(job.metadata ?? {}),
          progressStage: "FINAL_REVIEW_RETRYING",
          finalReviewJobId: submission.jobId,
          finalReviewRetryReason: update.failure,
          finalReviewRetryAttempt: update.transientFailureCount,
          finalReviewRetryAtUnixMs: Date.parse(update.retryAt)
        }
      });
    }
    return;
  }
  if (update.kind === "STARTED") {
    if (job.state !== "QUEUED") return;
    await repository.saveJob({
      ...job,
      state: "RUNNING",
      metadata: { ...(job.metadata ?? {}), startedAtUnixMs: Date.now(), progressStage: "PREPARING_SOURCES" }
    });
    return;
  }
  if (update.kind === "TASK_READY") {
    if (job.state !== "RUNNING") return;
    await repository.saveJob({ ...job, metadata: { ...(job.metadata ?? {}), progressStage: "RUNNING_CODEX", codexStartedAtUnixMs: Date.now() } });
    return;
  }
  if (update.kind === "WAITING") {
    if (job.state !== "RUNNING" && job.state !== "QUEUED") return;
    await repository.saveJob({
      ...job,
      state: "WAITING_CODEX",
      metadata: { ...(job.metadata ?? {}), codexWaitReason: update.reason, ...(update.diagnosticDetail ? { codexDiagnosticDetail: update.diagnosticDetail.slice(0, 240) } : {}), waitingAtUnixMs: Date.now() }
    });
    return;
  }
  if (update.kind === "RETRYING" && (job.state === "RUNNING" || job.state === "QUEUED")) {
    await repository.saveJob({
      ...job,
      state: "QUEUED",
      metadata: { ...(job.metadata ?? {}), progressStage: "RETRYING_CODEX", codexRetryReason: update.failure, codexRetryAttempt: update.transientFailureCount, codexRetryAtUnixMs: Date.parse(update.retryAt) }
    });
  }
}

export function codexRecoveryJobId(job: BackendJob): string {
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const finalReviewJobId = typeof metadata.finalReviewJobId === "string" ? metadata.finalReviewJobId.trim() : "";
  return finalReviewJobId && typeof metadata.progressStage === "string" && metadata.progressStage.startsWith("FINAL_REVIEW")
    ? finalReviewJobId
    : job.id;
}

/**
 * Requests in this allowlist have no durable side effect. They may pass a
 * long-running mutation in the stdio dispatcher so the desktop can keep
 * rendering status while publication, backup, or Codex work is underway.
 */
export function isParallelReadRequest(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if ([
    "doctor",
    "state",
    "source.list",
    "source.test",
    "source.scan.status",
    "candidate.list",
    "backup.auto.list",
    "backup.auto.verify",
    "backup.verify",
    "backup.restore.preview",
    "backup.auto.restore.preview"
  ].includes(typeof input.kind === "string" ? input.kind : "")) {
    return true;
  }
  return input.kind === "command" && isRecord(input.command) && [
    "REVISION.LIST",
    "REVISION.GET",
    "CANDIDATE.LIST"
  ].includes(typeof input.command.kind === "string" ? input.command.kind : "");
}

export async function runStdioEngine(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  dataDir: string = defaultDataDir()
): Promise<void> {
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceScheduler: true,
    startPublicationScheduler: true,
    nativePublicationBroker: true
  });
  let outputBroken = false;
  output.on("error", () => {
    // The desktop can restart the sidecar while an async response is still
    // being flushed. Treat that as a normal transport shutdown; never let an
    // unhandled EPIPE bring down Node with a visible console traceback.
    outputBroken = true;
  });
  let mutationTail = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  const writeEngineResult = async (parsed: unknown): Promise<void> => {
    try {
      if (!writeResponse(output, await runtime.handle(parsed))) outputBroken = true;
    } catch (error) {
      if (!writeResponse(output, {
        version: 1,
        id: isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : "unknown",
        ok: false,
        kind: "error",
        code: "ENGINE_FAILURE",
        message: error instanceof Error ? error.message : "engine failure"
      })) outputBroken = true;
    }
  };
  const dispatch = (parsed: unknown): void => {
    const execution = isParallelReadRequest(parsed)
      ? writeEngineResult(parsed)
      : mutationTail.then(() => writeEngineResult(parsed));
    if (!isParallelReadRequest(parsed)) {
      mutationTail = execution.catch(() => undefined);
    }
    const tracked = execution.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  };
  try {
    for await (const line of readBoundedLines(input)) {
      if (outputBroken) break;
      if (line === null) {
        if (!writeResponse(output, {
          version: 1,
          id: "unknown",
          ok: false,
          kind: "error",
          code: "REQUEST_TOO_LARGE",
          message: "request exceeds the 1 MiB protocol limit"
        })) break;
        continue;
      }
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (!writeResponse(output, {
          version: 1,
          id: "unknown",
          ok: false,
          kind: "error",
          code: "INVALID_JSON",
          message: "request must be a JSON object"
        })) break;
        continue;
      }

      dispatch(parsed);
    }
  } finally {
    await Promise.allSettled(inFlight);
    await runtime.close();
  }
}

export async function* readBoundedLines(
  input: NodeJS.ReadableStream
): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let length = 0;
  let oversized = false;

  const append = (segment: Buffer) => {
    if (oversized || segment.length === 0) return;
    if (length + segment.length > MAX_LINE_BYTES) {
      oversized = true;
      parts = [];
      length = 0;
      return;
    }
    parts.push(Buffer.from(segment));
    length += segment.length;
  };

  for await (const rawChunk of input as AsyncIterable<Buffer | Uint8Array | string>) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        append(chunk.subarray(start));
        break;
      }
      append(chunk.subarray(start, newline));
      if (oversized) {
        yield null;
      } else {
        const line = Buffer.concat(parts, length).toString("utf8");
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
      }
      parts = [];
      length = 0;
      oversized = false;
      start = newline + 1;
    }
  }

  if (oversized) {
    yield null;
  } else if (length > 0) {
    yield Buffer.concat(parts, length).toString("utf8");
  }
}

function writeResponse(output: NodeJS.WritableStream, response: EngineResponse): boolean {
  try {
    return output.write(`${JSON.stringify(response)}\n`);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceProtocolError(
  id: string,
  kind: "source.list" | "source.test" | "source.scan.status" | "candidate.list" | "command",
  code: string,
  message: string
): EngineResponse {
  return {
    version: 1,
    id,
    ok: false,
    kind,
    code,
    message
  };
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isProtocolIdentifier(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function defaultDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  return join(localAppData || join(homedir(), "AppData", "Local"), "Blogbot", "data", "pgdata");
}

if (process.argv[1]?.endsWith("stdio-entrypoint.ts")) {
  void runStdioEngine().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "engine failure"}\n`);
    process.exitCode = 1;
  });
}
