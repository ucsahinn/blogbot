import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { link, lstat, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { mkdir, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  fetchSource,
  type FetchTransport
} from "../../fetcher/src/fetch-source.ts";
import { createNodeFetchTransport } from "../../fetcher/src/node-transport.ts";
import { createFetcherSidecarTransport } from "./fetcher-sidecar-transport.ts";
import { validateEngineCommandV1, type EngineCommandV1 } from "../../../packages/contracts/src/index.ts";
import { BackendStoreError, type BackendJob, type BackendRepository, type BackendRepositoryTransaction } from "../../../packages/database/src/backend-repository.ts";
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
  computeEditorialAttestationHash,
  computeRevisionHash,
  evaluatePublishEligibility,
  isRevisionSuperseded,
  validateApprovalGates,
  validateClaimEvidence,
  validateRevisionPackageV2,
  validateRevisionPackageV3,
  type Approval,
  type ArticleRevision,
  type HighRiskApproval,
  type RevisionPackageV3
} from "../../../packages/editorial/src/revision.ts";
import { evaluateEditorialQualityV3 } from "../../../packages/editorial/src/quality-gates.ts";
import { createEditedRevision } from "../../../packages/editorial/src/workflow.ts";
import {
  analyzeSourceDocument,
  SourceDocumentError
} from "../../../packages/security/src/source-document.ts";
import { assertSafeSourceUrl } from "../../../packages/security/src/url-policy.ts";
import { createPortableBackup, nativeRestoreEntries, planPortableRestore } from "../../../packages/backup/src/portable-backup.ts";
import {
  createLogicalBackup,
  logicalRestoreTables,
  planLogicalRestore,
  type LogicalTableDump
} from "../../../packages/backup/src/logical-backup.ts";
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
import {
  rankCandidateStories,
  type CandidateRankingEvidence
} from "./candidate-ranking.ts";
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
const PUBLICATION_PREVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
// The native host verifies Windows consent immediately before it builds the
// high-risk approval command, so a valid timestamp is seconds old. Allow a
// short window for that hand-off plus a small allowance for clock skew.
const WINDOWS_REAUTH_MAX_AGE_MS = 5 * 60 * 1_000;
const WINDOWS_REAUTH_MAX_SKEW_MS = 60 * 1_000;
// Backup data is JSON/base64 encoded and then authenticated/encrypted. Keep
// raw input under half the archive limit so every successfully created backup
// remains readable by this build's verify/restore path.
const MAX_BACKUP_INPUT_BYTES = 128 * 1024 * 1024;
// Candidate triage is a projection, not a full archive browser. Reading and
// decrypting an unbounded feed catalog on every desktop refresh was the main
// source of multi-second freezes on large local workspaces.
const MAX_CANDIDATE_ENTRIES = 80;
// Cache the bounded projection across ordinary navigation. Successful scans bump
// the epoch below, so source changes still become visible immediately.
const CANDIDATE_CACHE_TTL_MS = 30_000;
// `backup.restore` runs on the serialized mutation chain, so a restore writer
// that never exits would freeze every later mutation and the graceful shutdown
// that awaits them. Stay well inside the host's 5 minute maintenance budget so
// the engine still answers with a reason instead of being killed mid-write.
const SECURE_RESTORE_DEADLINE_MS = 3 * 60 * 1_000;

/**
 * The native restore writer receives its entire write plan over stdin and has
 * no reason to inherit the engine data key, provider credentials, Codex home,
 * or user profile. Keep only the Windows process-bootstrap variables needed
 * to start the packaged helper.
 */
export function scrubbedRestoreEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"] as const) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

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
    const child = spawn(executable, [], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      env: scrubbedRestoreEnvironment()
    });
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolvePromise();
    };
    // A writer blocked inside the filesystem (a stalled cloud-sync or network
    // parent) must be stopped rather than left holding directory handles on a
    // half-written restore root.
    const deadline = setTimeout(() => {
      child.kill();
      settle(new Error("SECURE_RESTORE_TIMEOUT"));
    }, SECURE_RESTORE_DEADLINE_MS);
    deadline.unref?.();
    // Only a fully written payload plus a clean exit is a real restore. A large
    // archive is far bigger than the OS pipe buffer, so the write completes long
    // after `end()` returns and the exit code alone would have reported an
    // unwritten restore as done.
    let writeFinished = false;
    let cleanExit = false;
    const finishWhenWritten = (): void => {
      if (writeFinished && cleanExit) settle();
    };
    child.once("error", () => settle(new Error("SECURE_RESTORE_SIDECAR_UNAVAILABLE")));
    child.once("exit", (code) => {
      if (code !== 0) {
        settle(new Error("SECURE_RESTORE_WRITE_FAILED"));
        return;
      }
      cleanExit = true;
      finishWhenWritten();
    });
    // A writer that stops reading makes this pipe emit EPIPE. Without a listener
    // that unhandled 'error' takes down the whole engine sidecar mid-restore.
    child.stdin.on("error", () => settle(new Error("SECURE_RESTORE_WRITE_FAILED")));
    child.stdin.end(payload, "utf8", () => {
      writeFinished = true;
      finishWhenWritten();
    });
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
  for (const key of ["candidateId", "candidateTitle", "instruction", "section", "progressStage", "codexWaitReason", "scheduledAt", "purpose", "bobySessionId"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) boundedMetadata[key] = value.trim().slice(0, 500);
  }
  // The desktop resolves a Boby answer out of this projection. Dropping these
  // fields left `BOBY.GUIDE` advertised and persisted while every read reported
  // "guidance request not found". The Boby schema bounds the reply to 900
  // characters and the actions to two short labels, so they stay small enough
  // for an envelope the shell polls.
  if (typeof metadata.bobyReply === "string" && metadata.bobyReply.trim()) {
    boundedMetadata.bobyReply = metadata.bobyReply.trim().slice(0, 900);
  }
  if (Array.isArray(metadata.bobyActions)) {
    const actions = metadata.bobyActions
      .filter(isRecord)
      .slice(0, 2)
      .flatMap((action) => {
        const id = typeof action.id === "string" ? action.id.slice(0, 64) : undefined;
        const label = typeof action.label === "string" ? action.label.trim().slice(0, 80) : undefined;
        return id && label ? [{ id, label }] : [];
      });
    if (actions.length > 0) boundedMetadata.bobyActions = actions;
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
  code: "CODEX_JOB_STARTED" | "CODEX_JOB_WAITING" | "CODEX_JOB_RETRYING" | "CODEX_JOB_COMPLETED" | "CODEX_PROTOCOL_REJECTED" | "CODEX_OUTPUT_INVALID" | "CODEX_OUTPUT_MISSING" | "CODEX_CLI_INVALID_EVENT" | "CODEX_CLI_INVALID_FINAL_OUTPUT" | "CODEX_CLI_UNSUPPORTED" | "CODEX_SESSION_RETENTION_FAILED" | "CODEX_PROCESS_FAILED" | "CODEX_UNKNOWN_FAILURE" | "IMAGEGEN_FALLBACK_LOCAL" | "IMAGEGEN_REQUIRED_FAILED" | "IMAGEGEN_REQUIRED_UNAVAILABLE",
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

export function approvalBoundFilesDigest(files: readonly PublicationFile[]): string {
  const digest = createHash("sha256");
  // UTF-8 byte order, not host-locale collation: the native verifier hashes the
  // same bundle after sorting the paths byte-wise, and an ICU collation orders
  // punctuation and case differently. Two paths differing only by `_` vs `-`
  // (or by case) would then produce a digest the native side rejects, which is
  // unrecoverable because the approved revision is immutable.
  for (const file of [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
  )) {
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

/** Boolean form of the approval-bound file-set assertion, for boundary checks
 * that answer with a protocol code instead of propagating the exact reason. */
function isApprovalBoundPayload(
  revision: Pick<ArticleRevision, "id" | "adapterVersion" | "generatedFiles">,
  payload: unknown
): boolean {
  try {
    assertRevisionGeneratedFilesMatch(revision, payload);
    return true;
  } catch {
    return false;
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

/**
 * The one name shape the engine owns. Listing, restore selection and retention
 * must agree: a user's own manual archive can legitimately sit in the same
 * folder, and retention deleting a file no read path ever showed is silent
 * data loss.
 */
const AUTOMATIC_BACKUP_NAME = /^automatic-[A-Za-z0-9-]+\.backup$/u;

async function applyAutomaticBackupRetention(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const records = [] as Array<{ id: string; createdAt: string }>;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !AUTOMATIC_BACKUP_NAME.test(entry.name)) continue;
    const file = join(directory, entry.name);
    const info = await stat(file);
    records.push({ id: entry.name, createdAt: info.mtime.toISOString() });
  }
  const plan = planBackupRetention(records, { daily: 14, weekly: 8 });
  // A plan that retains nothing cannot be a retention decision about a healthy
  // snapshot history; never let it empty the folder.
  if (plan.keep.length === 0) return;
  for (const item of plan.remove) {
    // A snapshot still held open by an indexer or anti-virus scanner is simply
    // retried on the next pass. It must never turn an already written, valid
    // backup into a reported failure.
    await unlink(join(directory, item.id)).catch(() => undefined);
  }
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
      if (!entry.isFile() || entry.isSymbolicLink() || !AUTOMATIC_BACKUP_NAME.test(entry.name)) continue;
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
  if (typeof name !== "string" || !AUTOMATIC_BACKUP_NAME.test(name)) {
    throw new Error("AUTOMATIC_BACKUP_NAME_INVALID");
  }
  const record = (await listAutomaticBackups(directory)).find((entry) => entry.name === name);
  if (!record) throw new Error("AUTOMATIC_BACKUP_NOT_FOUND");
  return join(directory, record.name);
}

/**
 * Writes and finalizes a backup without ever replacing an existing path.
 *
 * The temporary file is a sibling of the destination, so creating a hard link
 * is one same-filesystem, atomic no-replace operation. Windows `rename` replaces
 * an existing destination and therefore cannot provide this guarantee.
 */
export async function writeBackupArchiveNoReplace(
  temporaryPath: string,
  outputPath: string,
  archive: Uint8Array,
  writeTemporary: (target: string, content: Uint8Array) => Promise<void> =
    async (target, content) => writeFile(target, content, { flag: "wx" })
): Promise<boolean> {
  let ownsTemporaryPath = true;
  try {
    try {
      await writeTemporary(temporaryPath, archive);
    } catch (error) {
      // `wx` never owns a path when another writer already created it. Do not
      // delete that writer's file while handling our exclusive-create failure.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") ownsTemporaryPath = false;
      throw error;
    }
    try {
      await link(temporaryPath, outputPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    if (ownsTemporaryPath) await unlink(temporaryPath).catch(() => undefined);
  }
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

/** Minimal read surface a snapshot needs. */
export interface BackupQueryPort {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

/**
 * A snapshot reads every table inside ONE transaction, which is already a
 * consistent MVCC view: the archive can never mix rows from before and after a
 * concurrent write.
 *
 * It deliberately does not use `runExclusive`. That gate existed for the old
 * file walk, which had to stop writes and CHECKPOINT before reading PGlite's
 * data directory. Reading rows needs neither, and PGlite's exclusive lock is
 * not re-entrant: querying from inside `runExclusive` deadlocks.
 */
export interface AutomaticBackupConsistencyGate extends BackupQueryPort {
  transaction<T>(operation: (transaction: BackupQueryPort) => Promise<T>): Promise<T>;
}

/** Identifier grammar every dumped table and column must satisfy before it is interpolated. */
const SAFE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

function quotedIdentifier(value: string): string {
  if (!SAFE_SQL_IDENTIFIER.test(value)) throw new Error("BACKUP_IDENTIFIER_INVALID");
  return `"${value}"`;
}

/**
 * Reads every table Blogbot owns so a snapshot can archive the rows instead of
 * PGlite's data directory.
 *
 * A real workspace holds roughly a thousand relation and WAL files totalling
 * hundreds of megabytes, with a single relation file already past the per-file
 * restore bound, so the file walk could never produce a restorable archive.
 * Recovery needs these rows, not Postgres internals. Values are read exactly as
 * stored, so the repository's own AES-256-GCM envelope stays intact and the
 * same-profile recovery boundary in ADR 0003 is unchanged.
 */
/**
 * Converts one column value into the JSON form the archive stores.
 *
 * The driver hands back native values (a `Date` for a timestamp, a `bigint` for
 * an identity column) that do not survive a JSON round-trip unchanged. Hashing
 * the native value at create time and the parsed value at verify time made
 * every snapshot fail its own integrity check, so normalisation happens once,
 * here, and the archive only ever contains plain JSON.
 */
function archivedValue(value: unknown, table: string, column: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    // No table Blogbot owns stores binary columns. Encoding one as a JSON
    // object would restore silently corrupted bytes, so refuse instead.
    throw new Error(`BACKUP_BINARY_COLUMN_UNSUPPORTED:${table}.${column}`);
  }
  if (typeof value === "object") return JSON.parse(JSON.stringify(value)) as unknown;
  return value;
}

export async function dumpApplicationTables(
  gate: BackupQueryPort
): Promise<LogicalTableDump[]> {
  const tables = await gate.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'blogbot%'
      ORDER BY table_name`
  );
  const dumps: LogicalTableDump[] = [];
  for (const { table_name: name } of tables.rows) {
    if (!SAFE_SQL_IDENTIFIER.test(name)) continue;
    const columns = await gate.query<{ column_name: string; is_identity: string }>(
      `SELECT column_name, is_identity FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [name]
    );
    const columnNames = columns.rows
      .map((row) => row.column_name)
      .filter((column) => SAFE_SQL_IDENTIFIER.test(column));
    // A GENERATED ALWAYS identity column rejects a plain INSERT, and letting it
    // regenerate would renumber the change cursor the optimistic version is
    // built from. Restore therefore overrides it and resets its sequence.
    const generatedColumns = columns.rows
      .filter((row) => row.is_identity === "YES" && SAFE_SQL_IDENTIFIER.test(row.column_name))
      .map((row) => row.column_name);
    if (columnNames.length === 0) continue;
    const selected = columnNames.map(quotedIdentifier).join(", ");
    const rows = await gate.query<Record<string, unknown>>(
      `SELECT ${selected} FROM ${quotedIdentifier(name)}`
    );
    dumps.push({
      name,
      columns: columnNames,
      rows: rows.rows.map((row) =>
        columnNames.map((column) => archivedValue(row[column], name, column))
      ),
      generatedColumns
    });
  }
  return dumps;
}

interface RestoreForeignKeyDependency {
  child_schema: string;
  child_table: string;
  parent_schema: string;
  parent_table: string;
}

/**
 * Orders archived tables from foreign-key parents to children.
 *
 * Metadata is resolved before the first DELETE so a partial archive, an
 * unexpected cross-scope foreign key, or a dependency cycle fails without
 * touching local data.
 */
function dependencyOrderedRestoreTables(
  tables: readonly LogicalTableDump[],
  dependencies: readonly RestoreForeignKeyDependency[]
): LogicalTableDump[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  if (byName.size !== tables.length) {
    throw new Error("BACKUP_RESTORE_TABLE_SET_AMBIGUOUS");
  }
  const childrenByParent = new Map<string, Set<string>>(
    [...byName.keys()].map((name) => [name, new Set()])
  );
  const parentCount = new Map<string, number>(
    [...byName.keys()].map((name) => [name, 0])
  );
  for (const dependency of dependencies) {
    const childIncluded = dependency.child_schema === "public" && byName.has(dependency.child_table);
    const parentIncluded = dependency.parent_schema === "public" && byName.has(dependency.parent_table);
    if (!childIncluded && !parentIncluded) continue;
    if (!childIncluded || !parentIncluded) {
      throw new Error(
        `BACKUP_RESTORE_FOREIGN_KEY_SCOPE_MISMATCH:${dependency.child_schema}.${dependency.child_table}->${dependency.parent_schema}.${dependency.parent_table}`
      );
    }
    const children = childrenByParent.get(dependency.parent_table)!;
    if (children.has(dependency.child_table)) continue;
    children.add(dependency.child_table);
    parentCount.set(dependency.child_table, parentCount.get(dependency.child_table)! + 1);
  }

  const ready = [...byName.keys()]
    .filter((name) => parentCount.get(name) === 0)
    .sort();
  const ordered: LogicalTableDump[] = [];
  while (ready.length > 0) {
    const name = ready.shift()!;
    ordered.push(byName.get(name)!);
    for (const child of [...childrenByParent.get(name)!].sort()) {
      const remaining = parentCount.get(child)! - 1;
      parentCount.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (ordered.length !== tables.length) {
    throw new Error("BACKUP_RESTORE_FOREIGN_KEY_CYCLE");
  }
  return ordered;
}

/**
 * Replaces every archived table inside one transaction.
 *
 * Restore is all-or-nothing on purpose: a partially applied snapshot would
 * leave revisions without their approvals, which is worse than a failed
 * restore. The caller holds PGlite's exclusive gate so no other engine
 * request can observe the intermediate state.
 */
export async function applyLogicalRestore(
  gate: AutomaticBackupConsistencyGate,
  tables: readonly LogicalTableDump[]
): Promise<number> {
  let restored = 0;
  await gate.transaction(async (transaction) => {
    const dependencies = await transaction.query<RestoreForeignKeyDependency>(
      `SELECT child_namespace.nspname AS child_schema,
              child.relname AS child_table,
              parent_namespace.nspname AS parent_schema,
              parent.relname AS parent_table
         FROM pg_catalog.pg_constraint AS foreign_key
         JOIN pg_catalog.pg_class AS child ON child.oid = foreign_key.conrelid
         JOIN pg_catalog.pg_namespace AS child_namespace ON child_namespace.oid = child.relnamespace
         JOIN pg_catalog.pg_class AS parent ON parent.oid = foreign_key.confrelid
         JOIN pg_catalog.pg_namespace AS parent_namespace ON parent_namespace.oid = parent.relnamespace
        WHERE foreign_key.contype = 'f'
          AND (child_namespace.nspname = 'public' OR parent_namespace.nspname = 'public')
        ORDER BY child_schema, child_table, parent_schema, parent_table`
    );
    const insertionOrder = dependencyOrderedRestoreTables(tables, dependencies.rows);

    // Children must be empty before their parents; doing every delete before
    // any insert also prevents a later parent cascade from erasing restored
    // rows.
    for (const table of [...insertionOrder].reverse()) {
      await transaction.query(`DELETE FROM ${quotedIdentifier(table.name)}`);
    }

    // Parents must exist before rows carrying foreign keys are inserted.
    for (const table of insertionOrder) {
      const identifier = quotedIdentifier(table.name);
      if (table.rows.length === 0) continue;
      const columns = table.columns.map(quotedIdentifier).join(", ");
      const placeholders = table.columns.map((_, index) => `$${String(index + 1)}`).join(", ");
      const generated = (table.generatedColumns ?? []).filter((column) => table.columns.includes(column));
      const overriding = generated.length > 0 ? " OVERRIDING SYSTEM VALUE" : "";
      for (const row of table.rows) {
        await transaction.query(
          `INSERT INTO ${identifier} (${columns})${overriding} VALUES (${placeholders})`,
          row as readonly unknown[]
        );
        restored += 1;
      }
      // Leave each identity sequence past the restored maximum, or the next
      // insert would collide with a row this restore just brought back.
      for (const column of generated) {
        await transaction.query(
          `SELECT setval(
             pg_get_serial_sequence($1, $2),
             COALESCE((SELECT MAX(${quotedIdentifier(column)}) FROM ${identifier}), 1),
             true
           )`,
          [table.name, column]
        );
      }
    }
  });
  return restored;
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
  const id = `automatic-backup-${Date.now()}`;
  try {
    const tables = await database.transaction((transaction) => dumpApplicationTables(transaction));
    const archive = await createLogicalBackup({
      tables,
      recoveryKey: automaticBackupRecoveryKey(),
      createdAt: new Date().toISOString()
    });
    return await writeAutomaticBackupArchive(id, dataDir, archive, tables);
  } catch (error) {
    return {
      version: 1,
      id,
      ok: false,
      kind: "error",
      code: "BACKUP_INVALID",
      message: error instanceof Error ? error.message : "automatic backup failed"
    };
  }
}

/**
 * Writes an automatic snapshot atomically, then applies retention.
 *
 * The archive is durable once the no-replace link lands. Retention is separate
 * housekeeping: a locked older snapshot must never make this new, valid
 * backup report itself as failed.
 */
async function writeAutomaticBackupArchive(
  id: string,
  dataDir: string,
  archive: Buffer,
  tables: readonly LogicalTableDump[]
): Promise<EngineResponse> {
  const automaticDirectory = join(dataDir, "backups");
  const outputPath = join(
    automaticDirectory,
    `automatic-${new Date().toISOString().replace(/[:.]/gu, "-")}.backup`
  );
  await mkdir(automaticDirectory, { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
  if (!await writeBackupArchiveNoReplace(temporaryPath, outputPath, archive)) {
    return {
      version: 1,
      id,
      ok: false,
      kind: "error",
      code: "BACKUP_OUTPUT_EXISTS",
      message: "automatic backup output already exists"
    };
  }
  await applyAutomaticBackupRetention(automaticDirectory)
    .catch(() => reportBackgroundTaskFault("AUTOMATIC_BACKUP_UNAVAILABLE", undefined, "retention"));
  return {
    version: 1,
    id,
    ok: true,
    kind: "backup.auto",
    outputPath,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.byteLength,
    entries: tables.length,
    rows: tables.reduce((total, table) => total + table.rows.length, 0)
  };
}

/**
 * Verify, preview and restore for the logical automatic snapshots.
 *
 * These share the file-based request kinds but not their implementation: an
 * automatic snapshot now carries rows, so it is read back through
 * `planLogicalRestore` and applied to the live database instead of being
 * unpacked into a directory.
 */
export async function handleAutomaticBackupAccess(
  input: Record<string, unknown>,
  dataDir: string,
  gate: AutomaticBackupConsistencyGate
): Promise<EngineResponse> {
  const id = typeof input.id === "string" ? input.id : "unknown";
  const kind = String(input.kind);
  const payload = isRecord(input.payload) ? input.payload : {};
  const automaticDirectory = join(dataDir, "backups");
  const failure = (code: string, message: string): EngineResponse => ({
    version: 1,
    id,
    ok: false,
    kind: "error",
    code,
    message
  });
  let archivePath: string;
  let recoveryKey: string;
  try {
    archivePath = await resolveAutomaticBackupPath(automaticDirectory, payload.backupName);
    recoveryKey = automaticBackupRecoveryKey();
  } catch (error) {
    return failure("BACKUP_INVALID", error instanceof Error ? error.message : "automatic backup selection failed");
  }
  let plan: Awaited<ReturnType<typeof planLogicalRestore>>;
  try {
    const info = await lstat(archivePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return failure("BACKUP_INVALID", "automatic backup must be a regular file");
    }
    if (info.size > MAX_BACKUP_ARCHIVE_BYTES) {
      return failure("BACKUP_INVALID", "automatic backup exceeds the local verification size limit");
    }
    plan = await planLogicalRestore({ archive: await readFile(archivePath), recoveryKey });
  } catch (error) {
    return failure("BACKUP_INVALID", error instanceof Error ? error.message : "automatic backup could not be verified");
  }
  const summary = {
    archivePath,
    createdAt: plan.createdAt,
    tables: plan.tables.map((table) => ({ name: table.name, rowCount: table.rowCount })),
    rows: plan.totalRows
  };
  if (kind === "backup.auto.verify" || kind === "backup.auto.restore.preview") {
    // Preview-first: reading the plan alone never mutates anything.
    return { version: 1, id, ok: true, kind, verified: true, ...summary };
  }
  if (kind !== "backup.auto.restore") {
    return failure("INVALID_REQUEST", "automatic backup request kind is not supported");
  }
  if (payload.confirmReplaceLocalData !== true) {
    // Restore replaces every local row. It must never happen as a side effect
    // of a verify or a mis-routed request.
    return failure("BACKUP_CONFIRMATION_REQUIRED", "restoring an automatic backup replaces local data and needs explicit confirmation");
  }
  try {
    const restored = await applyLogicalRestore(gate, logicalRestoreTables(plan));
    return { version: 1, id, ok: true, kind, restoredRows: restored, ...summary };
  } catch (error) {
    return failure("BACKUP_RESTORE_FAILED", error instanceof Error ? error.message : "automatic backup restore failed");
  }
}

export async function handleBackupRequest(
  input: Record<string, unknown>,
  dataDir: string
): Promise<EngineResponse> {
  const id = typeof input.id === "string" ? input.id : "unknown";
  // Automatic snapshots are logical row archives handled by
  // `createConsistentAutomaticBackup` / `handleAutomaticBackupAccess`; only
  // their directory listing still belongs to this file-based handler. The
  // former `backup.auto` file walk is gone: it could never produce a
  // restorable archive of a real PGlite data directory.
  const kind = input.kind === "backup.create" || input.kind === "backup.auto.list" || input.kind === "backup.verify" || input.kind === "backup.restore.preview" || input.kind === "backup.restore"
    ? input.kind
    : null;
  if (!kind) return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "backup request kind is not supported" };
  const payload = isRecord(input.payload) ? input.payload : {};
  const automatic = false;
  const automaticAccess = kind === "backup.auto.list";
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
    relativePaths = Array.isArray(payload.relativePaths)
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
  if (kind === "backup.create" && (!outputPath || !sourceDirectory || relativePaths.length === 0)) {
    return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "backup output, source directory, recovery key, and bounded file allowlist are required" };
  }
  if (kind !== "backup.create" && !automatic && (!archivePath || !recoveryKey || ((kind === "backup.restore.preview" || kind === "backup.restore") && !payload.targetDirectory))) {
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
        // A missing output is expected; the atomic no-replace link below owns creation.
      }
      await mkdir(outputDirectory, { recursive: true });
      if (archive.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
        return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: "backup archive exceeds the local verification size limit" };
      }
      const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
      if (!await writeBackupArchiveNoReplace(temporaryPath, outputPath, archive)) {
        return { version: 1, id, ok: false, kind: "error", code: "BACKUP_OUTPUT_EXISTS", message: "backup output already exists; choose a new file name" };
      }
      // The archive is already durable at this point. Retention is separate
      // housekeeping: a locked older snapshot must not report this new, valid
      // backup as a failed one.
      if (automatic) {
        await applyAutomaticBackupRetention(automaticDirectory)
          .catch(() => reportBackgroundTaskFault("AUTOMATIC_BACKUP_UNAVAILABLE", undefined, "retention"));
      }
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
    if (kind === "backup.restore") {
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
  /** Changes whenever a completed source scan makes candidate data stale. */
  candidateRefreshEpoch?: () => number;
  codexCoordinator?: CodexWorkerCoordinator;
  /** Persistent runtimes provide an application-owned media directory. */
  mediaDataDir?: string;
  /** Optional ImageGen provider; local artwork remains the safe fallback. */
  imageGenerator?: ImageGeneratorPort;
  /** True only when the host injected a processor that can reconcile the durable outbox. */
  publicationReady?: boolean;
  /** Native host drains credential-free broker commands. */
  nativePublicationBroker?: boolean;
  /** Test seam for deterministic durable native claim ownership. */
  nativePublicationRuntimeId?: string;
  /** Test seam for the native claim lease; production uses five minutes. */
  nativePublicationLeaseMs?: number;
  /** Test seam for lease and retry deadlines. */
  nativePublicationNow?: () => number;
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
  /** Test seam for deterministic durable native claim ownership. */
  nativePublicationRuntimeId?: string;
  /** Test seam for the native claim lease; production uses five minutes. */
  nativePublicationLeaseMs?: number;
  /** Test seam for lease and recovery deadlines. */
  nativePublicationNow?: () => number;
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
  let candidateCache: { expiresAt: number; epoch: number; candidates: Record<string, unknown>[] } | undefined;
  let candidateRefreshInFlight: Promise<Record<string, unknown>[]> | undefined;
  // Serializes native claims inside this engine process. The durable outbox
  // state prevents later reclaims; this guard closes the pre-update await gap.
  const activeNativePublicationClaims = new Set<string>();
  const nativePublicationRuntimeId = typeof options.nativePublicationRuntimeId === "string"
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(options.nativePublicationRuntimeId)
      ? options.nativePublicationRuntimeId
      : randomUUID();
  const nativePublicationLeaseMs = Number.isSafeInteger(options.nativePublicationLeaseMs)
    && Number(options.nativePublicationLeaseMs) >= 1_000
    && Number(options.nativePublicationLeaseMs) <= 10 * 60 * 1_000
      ? Number(options.nativePublicationLeaseMs)
      : 5 * 60 * 1_000;
  const nativePublicationNow = options.nativePublicationNow ?? Date.now;

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
          "APPROVAL.REVOKE",
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
      const candidateRefreshEpoch = options.candidateRefreshEpoch?.() ?? 0;
      if (candidateCache && candidateCache.expiresAt > now && candidateCache.epoch === candidateRefreshEpoch) {
        return {
          version: 1,
          id: input.id,
          ok: true,
          kind: "candidate.list",
          candidates: structuredClone(candidateCache.candidates)
        };
      }
      const activeRefresh = candidateRefreshInFlight;
      if (activeRefresh) {
        const candidates = await activeRefresh;
        return {
          version: 1,
          id: input.id,
          ok: true,
          kind: "candidate.list",
          candidates: structuredClone(candidates)
        };
      }
      let resolveRefresh!: (candidates: Record<string, unknown>[]) => void;
      let rejectRefresh!: (reason: unknown) => void;
      const refresh = new Promise<Record<string, unknown>[]>((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
      });
      candidateRefreshInFlight = refresh;
      // The initiating request reports its own failure. Attach a rejection
      // handler so a single failed refresh does not produce an unhandled
      // promise rejection when no concurrent request joined it.
      void refresh.catch(() => undefined);
      try {
      const sources = await options.sourceRepository.listSources();
      const candidateByStory = new Map<string, {
        candidate: Record<string, unknown>;
        evidence: CandidateRankingEvidence[];
      }>();
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
          const rankingEvidence: CandidateRankingEvidence = {
            sourceId: source.id,
            policyApproved: source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED",
            ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
            ...(source.defaultSection ? { defaultSection: source.defaultSection } : {}),
            ...(source.defaultArticleType ? { defaultArticleType: source.defaultArticleType } : {})
          };
          if (existing) {
            const candidate = existing.candidate;
            const sourceIds = Array.isArray(candidate.sourceIds) ? candidate.sourceIds : [];
            if (!sourceIds.includes(source.id) && sourceIds.length < 12) sourceIds.push(source.id);
            candidate.sourceIds = sourceIds;
            candidate.sourceCount = sourceIds.length;
            const sourceUrls = Array.isArray(candidate.sourceUrls) ? candidate.sourceUrls : [];
            const sourceUrl = String(entry.url).slice(0, 320);
            if (sourceUrl && !sourceUrls.includes(sourceUrl) && sourceUrls.length < 12) sourceUrls.push(sourceUrl);
            candidate.sourceUrls = sourceUrls;
            const existingPublishedAt = typeof candidate.publishedAt === "string" ? Date.parse(candidate.publishedAt) : Number.NaN;
            const entryPublishedAt = entry.publishedAt ? Date.parse(entry.publishedAt) : Number.NaN;
            if (Number.isFinite(entryPublishedAt) && (!Number.isFinite(existingPublishedAt) || entryPublishedAt > existingPublishedAt)) {
              candidate.publishedAt = entry.publishedAt;
            }
            candidate.duplicateScore = Math.min(100, Number(candidate.duplicateScore ?? 0) + 35);
            candidate.confidence = Math.max(Number(candidate.confidence ?? 0), source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED" ? 85 : 60);
            existing.evidence.push(rankingEvidence);
            continue;
          }
          candidateByStory.set(storyKey, {
            candidate: {
              id: candidateId,
              title: String(entry.title).slice(0, 240),
              summary: String(entry.summary ?? entry.title).slice(0, 240),
              primarySource: String(source.title ?? source.url).slice(0, 240),
              sourceCount: 1,
              section: source.defaultSection ?? "haberler",
              articleType: source.defaultArticleType ?? "news",
              confidence: source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED" ? 85 : 60,
              duplicateScore: 0,
              publishedAt: entry.publishedAt ?? null,
              discoveredAt: entry.publishedAt ?? new Date(0).toISOString(),
              sourceId: source.id,
              sourceUrl: String(entry.url).slice(0, 320),
              // Preserve bounded corroborating provenance instead of turning a
              // multi-source story into a misleading counter plus one source.
              sourceIds: [source.id],
              sourceUrls: [String(entry.url).slice(0, 320)]
            },
            evidence: [rankingEvidence]
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
      const candidateById = new Map(
        [...candidateByStory.values()].map(({ candidate }) => [String(candidate.id), candidate])
      );
      const candidates = rankCandidateStories(
        [...candidateByStory.values()].map(({ candidate, evidence }) => ({
          id: String(candidate.id),
          title: String(candidate.title),
          summary: String(candidate.summary),
          discoveredAt: String(candidate.discoveredAt),
          evidence
        })),
        now
      )
        .map((ranked) => ({
          ...candidateById.get(ranked.id),
          sourceSufficiencyScore: ranked.sourceSufficiencyScore,
          freshnessScore: ranked.freshnessScore,
          originalityScore: ranked.originalityScore,
          topicFitScore: ranked.topicFitScore,
          rankingScore: ranked.rankingScore,
          scoreReasons: ranked.scoreReasons
        }))
        .slice(0, 50);
      candidateCache = { expiresAt: Date.now() + CANDIDATE_CACHE_TTL_MS, epoch: candidateRefreshEpoch, candidates };
      resolveRefresh(candidates);
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "candidate.list",
        candidates: structuredClone(candidates)
      };
      } catch (error) {
        rejectRefresh(error);
        throw error;
      } finally {
        if (candidateRefreshInFlight === refresh) candidateRefreshInFlight = undefined;
      }
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
          // `expectedVersion` is an optimistic-concurrency precondition, not part
          // of this request's identity. The desktop derives the key from the
          // revision and payload only, so leaving the version in the fingerprint
          // meant the second preview of the same revision always failed with
          // IDEMPOTENCY_KEY_REUSED — permanently, because the key is stable.
          // Revision id, hash and payload stay in the fingerprint, so reusing the
          // key for genuinely different content is still rejected.
          canonicalJson({ revisionId, revisionHash, payload }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
            const revision = await transaction.getRevision(revisionId);
            if (computeRevisionHash(revision) !== revisionHash) throw new Error("APPROVAL_HASH_MISMATCH");
            if (await transaction.getApprovalRevocation(revisionId)) throw new Error("APPROVAL_REVOKED");
            if (isRevisionSuperseded(revision, approvalSnapshot.snapshot.revisions)) throw new Error("REVISION_SUPERSEDED");
            const approval = approvalSnapshot.snapshot.approvals.find((item) => item.revisionId === revisionId);
            if (!approval || approval.revisionHash !== revisionHash) throw new Error("NO_VALID_APPROVAL");
            const highRisk = approvalSnapshot.snapshot.highRiskApprovals.find((item) =>
              item.revisionId === revisionId && item.revisionHash === revisionHash
            ) ?? null;
            const scheduledAt = new Date(revision.scheduledAt);
            const eligibility = evaluatePublishEligibility(revision, { editorial: approval, highRisk }, {
              now: scheduledAt,
              publishingPaused: false,
              revisionLineage: approvalSnapshot.snapshot.revisions
            });
            if (!eligibility.eligible) throw new Error(eligibility.reason);
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
            const approvalBoundRequiredChecks = revision.packageVersion === 3
              ? revision.requiredChecks
              : requiredChecks ?? [];
            const approvalBoundDeployWorkflow = revision.packageVersion === 3
              ? revision.deployWorkflow
              : deployWorkflow ?? "";
            if (
              revision.packageVersion === 3 &&
              publishMode &&
              (
                approvalBoundDeployWorkflow !== deployWorkflow ||
                canonicalJson(approvalBoundRequiredChecks) !== canonicalJson(requiredChecks)
              )
            ) {
              throw new Error("APPROVAL_TARGET_MISMATCH");
            }
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
              requiredChecks: approvalBoundRequiredChecks,
              deployWorkflow: approvalBoundDeployWorkflow,
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
              requiredChecks: approvalBoundRequiredChecks,
              deployWorkflow: approvalBoundDeployWorkflow,
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
        const message = error instanceof Error ? error.message : "Publication preview failed";
        return sourceProtocolError(input.id, "command", message === "APPROVAL_REVOKED" ? "APPROVAL_REVOKED" : "PUBLICATION_PREVIEW_FAILED", message);
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
        if (approvalSnapshot.snapshot.automation.publishingPaused !== false) {
          return sourceProtocolError(input.id, "command", "PUBLISHING_PAUSED", "Publishing is paused");
        }
        const result = await repository.runIdempotent(
          `publication:${idempotencyKey}`,
          canonicalJson({ revisionId, revisionHash, previewHash, expectedVersion }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
            const revision = await transaction.getRevision(revisionId);
            if (computeRevisionHash(revision) !== revisionHash) throw new Error("APPROVAL_HASH_MISMATCH");
            if (await transaction.getApprovalRevocation(revisionId)) throw new Error("APPROVAL_REVOKED");
            const approval = approvalSnapshot.snapshot.approvals.find((item) => item.revisionId === revisionId);
            if (!approval || approval.revisionHash !== revisionHash) throw new Error("NO_VALID_APPROVAL");
            const highRisk = approvalSnapshot.snapshot.highRiskApprovals.find((item) => item.revisionId === revisionId) ?? null;
            const eligibility = evaluatePublishEligibility(revision, { editorial: approval, highRisk }, {
              now: new Date(),
              publishingPaused: approvalSnapshot.snapshot.automation.publishingPaused,
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
        const message = error instanceof Error ? error.message : "Publication enqueue failed";
        return sourceProtocolError(input.id, "command", message === "APPROVAL_REVOKED" ? "APPROVAL_REVOKED" : "PUBLICATION_ENQUEUE_FAILED", message);
      }
    }

    if (input.kind === "publication.broker.pending") {
      if (!options.nativePublicationBroker) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_BROKER_UNAVAILABLE", "Native publication broker is not configured");
      }
      const automationSnapshot = await readDashboardSync(repository, 0, 1, 1, 1);
      if (automationSnapshot.automation.publishingPaused !== false) {
        return { version: 1, id: input.id, ok: true, kind: input.kind, value: { effectIds: [] } };
      }
      const now = nativePublicationNow();
      const effectIds = (await repository.listOutbox())
        .filter((effect) => {
          if (["PENDING", "UNKNOWN"].includes(effect.state)) {
            return !effect.nextAttemptAt || Date.parse(effect.nextAttemptAt) <= now;
          }
          return effect.state === "IN_PROGRESS"
            && Number.isFinite(Date.parse(effect.nativeClaimLeaseUntil ?? ""))
            && Date.parse(effect.nativeClaimLeaseUntil ?? "") <= now;
        })
        .slice(0, 16)
        .map((effect) => effect.id);
      return { version: 1, id: input.id, ok: true, kind: input.kind, value: { effectIds } };
    }

    if (input.kind === "publication.broker.claim") {
      if (!options.nativePublicationBroker) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_BROKER_UNAVAILABLE", "Native publication broker is not configured");
      }
      const automationSnapshot = await readDashboardSync(repository, 0, 1, 1, 1);
      if (automationSnapshot.automation.publishingPaused !== false) {
        return sourceProtocolError(input.id, "command", "PUBLISHING_PAUSED", "Publishing is paused");
      }
      const effectId = typeof input.effectId === "string" ? input.effectId : "";
      if (!effectId || activeNativePublicationClaims.has(effectId)) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_EFFECT_NOT_CLAIMABLE", "Publication effect is not claimable");
      }
      activeNativePublicationClaims.add(effectId);
      try {
        const observed = await repository.getOutboxEffect(effectId);
        const effect = observed.effect;
        const nowUnixMs = nativePublicationNow();
        const retryIsDue = !effect.nextAttemptAt || Date.parse(effect.nextAttemptAt) <= nowUnixMs;
        const leaseDeadline = Date.parse(effect.nativeClaimLeaseUntil ?? "");
        const unclaimed = ["PENDING", "UNKNOWN"].includes(effect.state) && retryIsDue;
        const expiredClaim = effect.state === "IN_PROGRESS"
          && Number.isFinite(leaseDeadline)
          && leaseDeadline <= nowUnixMs;
        // Every runtime observes the row and its CAS token atomically. A live
        // owner keeps the claim until its durable lease expires; only then may
        // another runtime advance the fencing token.
        if (!unclaimed && !expiredClaim) {
          return sourceProtocolError(input.id, "command", "PUBLICATION_EFFECT_NOT_CLAIMABLE", "Publication effect is not claimable");
        }
        if (await repository.getApprovalRevocation(effect.aggregateId)) {
          await repository.updateOutbox({ ...effect, state: "FAILED", lastError: "APPROVAL_REVOKED" }, observed.version);
          return sourceProtocolError(input.id, "command", "APPROVAL_REVOKED", "Editorial approval was revoked before publication");
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
          preview.previewHash !== effect.previewHash ||
          // The preview row is mutable local state, while `revision.generatedFiles`
          // is bound to the approval. The revision hash and preview hash are both
          // readable by any protocol caller, so matching them does not prove the
          // stored bytes are still the reviewed ones. Re-assert the exact file set
          // here, at the boundary that actually hands bytes to the publisher.
          !isApprovalBoundPayload(revision, payload)
        ) {
          // An expired or mismatched preview cannot be published without a new
          // preview, so this is terminal. Leaving the row PENDING/UNKNOWN made
          // the native drainer reclaim it every poll, discard the reason, and
          // present the publication as merely "not started" forever.
          await repository.updateOutbox({ ...effect, state: "FAILED", lastError: "PUBLICATION_EFFECT_STALE" }, observed.version);
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
        const nativeClaimLeaseUntil = new Date(nowUnixMs + nativePublicationLeaseMs).toISOString();
        await repository.updateOutbox({
          ...effect,
          state: "IN_PROGRESS",
          attempts: effect.attempts + 1,
          claimAttempt,
          nativeClaimOwnerId: nativePublicationRuntimeId,
          nativeClaimLeaseUntil
        }, observed.version);
        return { version: 1, id: input.id, ok: true, kind: input.kind, value: claimValue };
      } catch (error) {
        if (error instanceof BackendStoreError && error.code === "WRITE_VERSION_CONFLICT") {
          return sourceProtocolError(input.id, "command", "PUBLICATION_EFFECT_NOT_CLAIMABLE", "Publication effect is not claimable");
        }
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
      let observed: Awaited<ReturnType<BackendRepository["getOutboxEffect"]>>;
      try {
        observed = await repository.getOutboxEffect(effectId);
      } catch {
        return sourceProtocolError(input.id, "command", "INVALID_PUBLICATION_BROKER_RESULT", "Publication broker result is invalid");
      }
      const effect = observed.effect;
      const resultRef = typeof input.resultRef === "string" ? input.resultRef.slice(0, 512) : undefined;
      const lastError = typeof input.lastError === "string" ? input.lastError.slice(0, 512) : undefined;
      const retryAfterMs = Number.isSafeInteger(input.retryAfterMs)
        && Number(input.retryAfterMs) >= 0
        && Number(input.retryAfterMs) <= 86_400_000
        ? Number(input.retryAfterMs)
        : undefined;
      const revocation = await repository.getApprovalRevocation(effect.aggregateId);
      const isRecalledClaim = effect.state === "FAILED" && effect.lastError === "APPROVAL_REVOKED";
      if (revocation) {
        if (
          (effect.state === "IN_PROGRESS" || isRecalledClaim)
          && effect.claimAttempt === claimAttempt
          && effect.nativeClaimOwnerId === nativePublicationRuntimeId
        ) {
          const {
            nextAttemptAt: _previousRetryDeadline,
            nativeClaimOwnerId: _nativeClaimOwnerId,
            nativeClaimLeaseUntil: _nativeClaimLeaseUntil,
            completedAt: _completedAt,
            ...revokedEffect
          } = effect;
          try {
            await repository.updateOutbox({
              ...revokedEffect,
              state: "FAILED",
              lastError: "APPROVAL_REVOKED",
              ...(resultRef ? { resultRef } : {})
            }, observed.version);
          } catch (error) {
            if (!(error instanceof BackendStoreError) || error.code !== "WRITE_VERSION_CONFLICT") throw error;
          }
        }
        return sourceProtocolError(input.id, "command", "APPROVAL_REVOKED", "Editorial approval was revoked before native publication completion");
      }
      if (effect.state !== "IN_PROGRESS"
        || effect.claimAttempt !== claimAttempt
        || effect.nativeClaimOwnerId !== nativePublicationRuntimeId
        || !state) {
        return sourceProtocolError(input.id, "command", "INVALID_PUBLICATION_BROKER_RESULT", "Publication broker result is invalid");
      }
      const {
        nextAttemptAt: _previousRetryDeadline,
        nativeClaimOwnerId: _nativeClaimOwnerId,
        nativeClaimLeaseUntil: _nativeClaimLeaseUntil,
        ...withoutPreviousRetryDeadline
      } = effect;
      const nextAttemptAt = state === "UNKNOWN" && retryAfterMs !== undefined
        ? new Date(Date.now() + retryAfterMs).toISOString()
        : undefined;
      let saved;
      try {
        saved = await repository.updateOutbox({
          ...withoutPreviousRetryDeadline,
          state,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
          ...(resultRef ? { resultRef } : {}),
          ...(lastError ? { lastError } : {}),
          ...(state === "SUCCEEDED" ? { completedAt: new Date(nativePublicationNow()).toISOString() } : {})
        }, observed.version);
      } catch (error) {
        if (error instanceof BackendStoreError && error.code === "WRITE_VERSION_CONFLICT") {
          const revokedDuringCompletion = await repository.getApprovalRevocation(effect.aggregateId);
          if (revokedDuringCompletion) {
            const current = await repository.getOutboxEffect(effect.id);
            if (
              current.effect.state === "FAILED"
              && current.effect.lastError === "APPROVAL_REVOKED"
              && current.effect.claimAttempt === claimAttempt
              && current.effect.nativeClaimOwnerId === nativePublicationRuntimeId
            ) {
              const {
                nextAttemptAt: _currentRetryDeadline,
                nativeClaimOwnerId: _currentClaimOwnerId,
                nativeClaimLeaseUntil: _currentClaimLeaseUntil,
                completedAt: _currentCompletedAt,
                ...revokedEffect
              } = current.effect;
              await repository.updateOutbox({
                ...revokedEffect,
                state: "FAILED",
                lastError: "APPROVAL_REVOKED",
                ...(resultRef ? { resultRef } : {})
              }, current.version).catch((conflict) => {
                if (!(conflict instanceof BackendStoreError) || conflict.code !== "WRITE_VERSION_CONFLICT") throw conflict;
              });
            }
            return sourceProtocolError(input.id, "command", "APPROVAL_REVOKED", "Editorial approval was revoked during native publication completion");
          }
          return sourceProtocolError(input.id, "command", "INVALID_PUBLICATION_BROKER_RESULT", "Publication broker result is invalid");
        }
        throw error;
      }
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
      // `syncDashboard` reports the cursor of the last change it delivered, which
      // is a paging watermark, not the optimistic version. The desktop reads
      // state with a bounded change page and then sends `serverCursor` back as
      // `expectedVersion`, so once a workspace produced more changes than fit in
      // one page every mutation failed with VERSION_CONFLICT forever. Report the
      // authoritative version here and keep the watermark under its own name for
      // clients that page through changes.
      const optimisticVersion = await repository.getVersion();
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "state",
        snapshot: {
          serverCursor: optimisticVersion,
          changeCursor: sync.serverCursor,
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

    const validation = validateEngineCommandV1(input.command);
    if (!validation.valid) {
      return revisionCommandFailure(
        input.id,
        validation.error.code,
        validation.error.message,
        validation.error.retryable
      );
    }

    const workflow = await handleLocalWorkflowCommand(input.id, validation.command, repository, options);
    if (workflow) return workflow;
    if (validation.valid && validation.command.kind === "APPROVAL.REVOKE") {
      const command = validation.command;
      try {
        const result = await repository.runIdempotent(
          `engine:${command.idempotencyKey}`,
          canonicalJson({ kind: command.kind, payload: command.payload, expectedVersion: command.expectedVersion }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== command.expectedVersion) {
              throw new Error(`VERSION_CONFLICT:${command.expectedVersion}:${currentVersion}`);
            }
            const revision = await transaction.getRevision(command.payload.revisionId);
            const actualHash = computeRevisionHash(revision);
            if (actualHash !== command.payload.revisionHash) throw new Error("APPROVAL_HASH_MISMATCH");
            const revocation = await transaction.revokeApproval({
              revisionId: revision.id,
              revisionHash: actualHash,
              deviceId: command.payload.deviceId,
              reason: command.payload.reason,
              revokedAt: new Date().toISOString()
            });
            const recalledEffectIds: string[] = [];
            for (const listed of await transaction.listOutbox()) {
              const observed = await transaction.getOutboxEffect(listed.id);
              const effect = observed.effect;
              if (
                effect.aggregateId === revision.id &&
                effect.revisionHash === actualHash &&
                (effect.state === "PENDING" || effect.state === "UNKNOWN" || effect.state === "IN_PROGRESS")
              ) {
                await transaction.updateOutbox({ ...effect, state: "FAILED", lastError: "APPROVAL_REVOKED" }, observed.version);
                recalledEffectIds.push(effect.id);
              }
            }
            return { revocation, recalledEffectIds };
          }
        );
        return revisionCommandSuccess(input.id, command, result, await repository.getVersion());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Approval revocation failed";
        const code = message.startsWith("VERSION_CONFLICT:")
          ? "VERSION_CONFLICT"
          : message.includes("IDEMPOTENCY_KEY_REUSED")
            ? "IDEMPOTENCY_KEY_REUSED"
            : ([
                "APPROVAL_HASH_MISMATCH",
                "APPROVAL_NOT_FOUND",
                "APPROVAL_ALREADY_REVOKED",
                "INVALID_APPROVAL_REVOCATION"
              ].includes(message) ? message : "ENGINE_OPERATION_FAILED");
        return revisionCommandFailure(input.id, code, message, code === "VERSION_CONFLICT");
      }
    }
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
            if (await transaction.getApprovalRevocation(revision.id)) {
              throw new Error("APPROVAL_REVOKED");
            }
            if (revision.state !== "REVIEW_REQUIRED") {
              throw new Error("REVISION_NOT_REVIEWABLE");
            }
            const actualHash = computeRevisionHash(revision);
            if (actualHash !== command.payload.revisionHash) {
              throw new Error("APPROVAL_HASH_MISMATCH");
            }
            if (command.kind === "APPROVAL.GRANT") {
              if (revision.packageVersion !== 3) {
                throw new Error("REVISION_REVIEW_UPGRADE_REQUIRED");
              }
              if (!validateRevisionPackageV3(revision)) {
                throw new Error("REVISION_PACKAGE_INCOMPLETE");
              }
              if (!("packageVersion" in command.payload) || command.payload.packageVersion !== 3) {
                throw new Error("EDITORIAL_ATTESTATION_REQUIRED");
              }
              const editorialQuality = evaluateEditorialQualityV3(
                revision.editorialAssessment,
                command.payload.attestation
              );
              if (editorialQuality.blockers.length > 0) {
                throw new Error("EDITORIAL_QUALITY_NOT_READY");
              }
              if (!editorialQuality.passed) {
                throw new Error("EDITORIAL_ATTESTATION_INVALID");
              }
            } else if (
              revision.packageVersion === 3
                ? !validateRevisionPackageV3(revision)
                : !validateRevisionPackageV2(revision)
            ) {
              throw new Error("REVISION_PACKAGE_INCOMPLETE");
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
              // The engine cannot invoke the Windows verifier itself, so this
              // timestamp stays caller-supplied — but an audit record must not
              // be able to assert a reauthentication that is not recent. Bound
              // it against the engine clock the way `approvedAt` already is.
              const reauthenticatedAt = Date.parse(command.payload.windowsReauthenticatedAt);
              const reauthenticationAgeMs = Date.now() - reauthenticatedAt;
              if (
                !Number.isFinite(reauthenticatedAt) ||
                reauthenticationAgeMs > WINDOWS_REAUTH_MAX_AGE_MS ||
                reauthenticationAgeMs < -WINDOWS_REAUTH_MAX_SKEW_MS
              ) {
                throw new Error("WINDOWS_REAUTH_STALE");
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
            if (!("packageVersion" in command.payload) || command.payload.packageVersion !== 3) {
              throw new Error("EDITORIAL_ATTESTATION_REQUIRED");
            }
            return transaction.saveApproval({
              revisionId: revision.id,
              revisionHash: actualHash,
              deviceId: command.payload.deviceId,
              approvedAt: new Date().toISOString(),
              warningSetHash: command.payload.warningSetHash,
              approvalType: "EDITORIAL",
              packageVersion: 3,
              attestation: command.payload.attestation,
              attestationHash: computeEditorialAttestationHash(command.payload.attestation)
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
                      "EDITORIAL_APPROVAL_REQUIRED",
                      "WINDOWS_REAUTH_STALE",
                      "REVISION_REVIEW_UPGRADE_REQUIRED",
                      "EDITORIAL_ATTESTATION_REQUIRED",
                      "EDITORIAL_ATTESTATION_INVALID",
                      "EDITORIAL_QUALITY_NOT_READY",
                      "APPROVAL_REVOKED",
                      "REVISION_PACKAGE_INCOMPLETE"
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
          if (options.mediaDataDir && repository.listRevisionSnapshot) {
            const snapshot = await repository.listRevisionSnapshot();
            await pruneSupersededRevisionMedia(
              options.mediaDataDir,
              snapshot.revisions,
              [command.payload.revisionId]
            ).catch(() => undefined);
          }
          return revisionCommandSuccess(input.id, command, result, await repository.getVersion());
        }

        const summaryOnly = command.kind === "REVISION.LIST" &&
          isRecord(command.payload) && command.payload.summaryOnly === true;
        const snapshot = summaryOnly && repository.listRevisionSummarySnapshot
          ? await repository.listRevisionSummarySnapshot({ limit: 100 })
          : summaryOnly && repository.listRevisionSnapshot
            ? await repository.listRevisionSnapshot()
          : (await repository.sync(0)).snapshot;
        const materialize = async (revision: ArticleRevision) => {
          const revoked = await repository.getApprovalRevocation(revision.id);
          return ({
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
            revoked ? null : snapshot.approvals.find(
              (approval: Approval) => approval.revisionId === revision.id
            ) ?? null,
          highRiskApproval:
            revoked ? null : snapshot.highRiskApprovals.find(
              (approval: HighRiskApproval) => approval.revisionId === revision.id
            ) ?? null
          });
        };
        const value =
          command.kind === "REVISION.LIST"
            ? await Promise.all(snapshot.revisions.map(materialize))
            : await materialize(await repository.getRevision(command.payload.revisionId));
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

    const result = await engine.execute(validation.command);
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
  value: EngineCommandV1,
  repository: BackendRepository,
  options: EngineProtocolOptions
): Promise<EngineResponse | null> {
  const kind = typeof value.kind === "string" ? value.kind : "";
  if (!["DRAFT.CREATE", "BOBY.GUIDE", "JOB.RETRY", "LOCAL_STATE.SET"].includes(kind)) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const idempotencyKey = typeof value.idempotencyKey === "string" ? value.idempotencyKey : "";
  const expectedVersion = typeof value.expectedVersion === "number" ? value.expectedVersion : -1;
  const payload = value.payload as Record<string, unknown>;
  // A retry has to be a real recovery action. Read the pre-retry job so the
  // handler can both refuse a retry nothing can run and restore the original
  // stop condition when the durable Codex record turns out to be unrecoverable.
  const retriedJob = kind === "JOB.RETRY" && typeof payload.jobId === "string" && payload.jobId
    ? await repository.getJob(payload.jobId).catch(() => undefined)
    : undefined;
  const retryableCodexState = retriedJob &&
    ["WAITING_CODEX", "FAILED", "DEAD_LETTER", "RETRY_SCHEDULED"].includes(retriedJob.state);
  const requiresCodexExecutor = retriedJob?.kind === "DRAFT" || retriedJob?.kind === "CODEX";
  if (retryableCodexState && requiresCodexExecutor && !options.codexCoordinator) {
    // Every retryable DRAFT/CODEX stop needs the isolated executor, not only
    // WAITING_CODEX. Requeueing a FAILED/DEAD_LETTER/RETRY_SCHEDULED row would
    // otherwise erase its diagnosis and strand a healthy-looking QUEUED job.
    return revisionCommandFailure(
      envelopeId,
      "CODEX_RUNNER_UNAVAILABLE",
      "Local Codex runner is not configured, so this job cannot be retried yet.",
      false
    );
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
              progressStage: options.codexCoordinator ? "RESEARCH_QUEUED" : "WAITING_CODEX",
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
        return updateJobWithCas(transaction, jobId, (job) => {
          if (job.state !== "FAILED" && job.state !== "DEAD_LETTER" && job.state !== "RETRY_SCHEDULED" && job.state !== "WAITING_CODEX") {
            throw new Error("JOB_NOT_RETRYABLE");
          }
          const { lastError: _lastError, ...retryableJob } = job;
          return { ...retryableJob, state: "QUEUED", attempts: job.attempts + 1 };
        });
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
      if (!createdDraft) throw new Error("DRAFT_JOB_MISSING");
      const researchSnapshot = {
        status: sourceEvidence.length > 0 ? "READY" : "NEEDS_SOURCE",
        capturedAt: new Date().toISOString(),
        sourceCount: sourceEvidence.length,
        sources: sourceEvidence.map((source) => ({
          id: typeof source.id === "string" ? source.id : "",
          sourceId: typeof source.sourceId === "string" ? source.sourceId : "",
          url: typeof source.url === "string" ? source.url : "",
          title: typeof source.title === "string" ? source.title.slice(0, 400) : "",
          contentHash: typeof source.contentHash === "string" ? source.contentHash : "",
          ...(typeof source.evidenceVersionId === "string" ? { evidenceVersionId: source.evidenceVersionId } : {})
        }))
      };
      await updateJobWithCas(repository, createdDraft.id, (job) => ({
        ...job,
        metadata: {
          ...(job.metadata ?? {}),
          progressStage: researchSnapshot.status === "READY" ? "RESEARCH_COMPLETE" : "RESEARCH_NEEDS_SOURCE",
          researchSnapshot
        }
      }));
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
      const bobyCodex = await options.codexCoordinator.submit({
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
      codex = bobyCodex;
      options.codexCoordinator.startImmediately?.({
        jobId: bobyCodex.jobId,
        idempotencyKey: bobyCodex.idempotencyKey,
        generation: bobyCodex.version
      });
    }
    if (kind === "JOB.RETRY" && options.codexCoordinator) {
      const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
      // The workflow row and the Codex coordinator record share the draft ID,
      // but have separate durable state. Requeue both sides so the Operations
      // button is a real recovery action rather than a misleading success.
      const recovery = await options.codexCoordinator.recoverInterrupted(
        codexRecoveryJobId(retriedJob ?? await repository.getJob(jobId))
      );
      if (!recovery.recovered && retriedJob?.state === "WAITING_CODEX") {
        // Nothing was requeued on the runner side, so the QUEUED row written
        // above is a job no worker will claim. Put the original stop condition
        // back instead of reporting a recovery that did not happen.
        await updateJobWithCas(repository, jobId, (job) => ({
          ...retriedJob,
          metadata: { ...(retriedJob.metadata ?? {}), ...(job.metadata ?? {}) }
        }));
        return revisionCommandFailure(
          envelopeId,
          "CODEX_RECOVERY_UNAVAILABLE",
          "The durable Codex record for this job could not be requeued.",
          false
        );
      }
      codex = recovery;
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
  const savedSchedule = isRecord(state) && isRecord(state.schedule) && isRecord(state.schedule.slots)
    ? state.schedule.slots
    : {};
  // Keep the engine's first-use behavior aligned with the visible weekly
  // calendar. A saved schedule always wins, while an empty local workspace
  // uses one clearly enabled slot per day until the editor customizes it.
  const schedule = Object.keys(savedSchedule).length > 0
    ? savedSchedule
    : {
      "slot-mon-1": { enabled: true, time: "10:00" },
      "slot-tue-1": { enabled: true, time: "16:30" },
      "slot-wed-1": { enabled: true, time: "10:00" },
      "slot-thu-1": { enabled: true, time: "16:30" },
      "slot-fri-1": { enabled: true, time: "10:00" },
      "slot-sat-1": { enabled: true, time: "11:00" },
      "slot-sun-1": { enabled: true, time: "11:00" }
    };
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
// Evidence collection happens inside the DRAFT.CREATE request, which the desktop
// bridge abandons after 30 s. Keep the whole collection well inside that budget;
// a source the engine could not read in time stays out of the evidence set.
export const DRAFT_EVIDENCE_FETCH_BUDGET_MS = 15 * 1_000;
const DRAFT_EVIDENCE_FETCH_TIMEOUT_MS = 8 * 1_000;

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
const SKIPPED_EVIDENCE_ELEMENTS = ["script", "style", "noscript"] as const;

/**
 * Reduces fetched HTML to plain evidence text in a single linear pass.
 *
 * The previous regex pipeline was quadratic on malformed markup, and source
 * pages are untrusted input: 1 MB of unclosed `<script>` took about 29 s and
 * 512 KB of bare `<` about 171 s on the engine's single thread. One broken or
 * hostile page therefore froze every other engine request well past the desktop
 * bridge's timeout. A draft fetches many pages, so this was reachable by adding
 * one ordinary source.
 */
export function htmlToEvidenceText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      parts.push(html.slice(index));
      break;
    }
    if (open > index) parts.push(html.slice(index, open));
    const tagEnd = html.indexOf(">", open);
    // An unterminated tag means the remainder is markup, exactly as a browser
    // would treat it. Never fall back to scanning it again as text.
    if (tagEnd < 0) break;
    const skipped = SKIPPED_EVIDENCE_ELEMENTS.find((name) =>
      lower.startsWith(`<${name}`, open) &&
      !/[a-z0-9-]/u.test(lower.charAt(open + name.length + 1))
    );
    if (skipped) {
      const closeAt = lower.indexOf(`</${skipped}`, tagEnd + 1);
      if (closeAt < 0) break;
      const closeEnd = html.indexOf(">", closeAt);
      index = closeEnd < 0 ? html.length : closeEnd + 1;
    } else {
      index = tagEnd + 1;
    }
    parts.push(" ");
  }
  return parts.join("").replace(/\s+/gu, " ").trim();
}

function sourceEvidenceText(body: Uint8Array): string {
  try {
    return boundedEvidenceText(
      htmlToEvidenceText(new TextDecoder("utf-8", { fatal: true }).decode(body))
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

/**
 * A repaired revision may carry either an article-specific ImageGen visual or
 * the generic local cover. Both are publishable, but the gate must say which
 * one it recorded: reporting the fallback as a checked hero package told the
 * reviewer the article visual had been verified when it was never produced.
 */
function repairMediaGates(revision: ArticleRevision, provenance: "IMAGEGEN_VISUAL" | "LOCAL_FALLBACK_VISUAL") {
  const ready = {
    id: "media",
    group: "media" as const,
    state: "PASS" as const,
    detail: provenance === "IMAGEGEN_VISUAL"
      ? "Hero medya paketi ImageGen görselinden üç yayın oranında üretildi."
      : "Hero medya paketi yerel, metinsiz kapaktan üç yayın oranında üretildi; ImageGen görseli üretilemedi.",
    policyVersion: "2",
    reasonCode: provenance
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
  if (!validateRevisionPackageV2(revision) && !validateRevisionPackageV3(revision)) {
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
  let provenance: "IMAGEGEN_VISUAL" | "LOCAL_FALLBACK_VISUAL" = "LOCAL_FALLBACK_VISUAL";
  if (imageGenerator) {
    try {
      const generated = await imageGenerator.generate({
        title: revision.tr.title,
        articleType: revision.articleType,
        section: revision.section,
        sourceTitles: revision.sources.map((source) => source.title),
        summary: revision.tr.description,
        keyClaims: revision.claims.map((claim) => claim.trText ?? claim.text),
        visualIntent: `Makalenin ana konusunu ${revision.section} bölümüne uygun, metinsiz ve gerçekçi editoryal bir sahneyle anlat; başlık için boş alan bırakma.`
      });
      artifacts = await renderGeneratedImageVariants(
        generated,
        join(dataDir, "media", successorId),
        revision.tr.slug
      );
      provenance = "IMAGEGEN_VISUAL";
    } catch {
      reportCodexLifecycle("IMAGEGEN_FALLBACK_LOCAL");
    }

  }
  artifacts ??= await renderCoverVariants(
    direction,
    join(dataDir, "media", successorId),
    revision.tr.slug
  );
  const media = artifacts.map((artifact) => ({
    role: "hero" as const,
    path: `media/${successorId}/${artifact.path}`,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    byteSize: artifact.byteSize,
    source: artifact.source
  }));
  const qualityGates = repairMediaGates(revision, provenance);
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
  const quoteHash = createHash("sha256").update(evidenceText, "utf8").digest("hex");
  return {
    evidenceText,
    evidenceSourceId: sourceId,
    evidenceAnchors: evidenceText
      ? [{ sourceId, start: 0, end: evidenceText.length, quoteHash }]
      : [],
    // Source material is data only. Codex must never treat it as instructions.
    untrusted: true
  };
}

function bindMediaProvenanceToReview(revision: RevisionPackageV3): RevisionPackageV3 {
  const sources = new Set(revision.media.map((asset) => asset.source));
  if (sources.size !== 1 || sources.has(undefined)) return revision;
  const source = revision.media[0]!.source!;
  const qualityGates = revision.qualityGates.map((gate) => gate.id !== "media" || gate.state !== "PASS"
    ? gate
    : {
        ...gate,
        reasonCode: source === "IMAGEGEN" ? "IMAGEGEN_VISUAL" : "LOCAL_RENDERER_VISUAL",
        detail: source === "IMAGEGEN"
          ? "Hero medya paketi ImageGen çıktısından üretildi; tam revizyon paketi adlandırılmış editoryal incelemeye bağlıdır."
          : "Hero medya paketi doğrulanmış yerel görsel politikasıyla üretildi; tam revizyon paketi adlandırılmış editoryal incelemeye bağlıdır."
      });
  return {
    ...revision,
    qualityGates,
    editorialReviewReportHash: createHash("sha256").update(canonicalJson({
      kind: "FINAL_REVIEW_WITH_MEDIA_PROVENANCE",
      baseReviewReportHash: revision.editorialReviewReportHash,
      media: revision.media.map(({ path, sha256, byteSize, source }) => ({ path, sha256, byteSize, source })),
      qualityGates
    }), "utf8").digest("hex")
  };
}

const MEDIA_PRUNE_MAX_REVISIONS = 512;
const MEDIA_PRUNE_MAX_CANDIDATES = 32;
const MEDIA_PRUNE_MAX_FILES_PER_REVISION = 16;
const MEDIA_PRUNE_MAX_FILE_BYTES = 32 * 1024 * 1024;
const MEDIA_PRUNE_MAX_TOTAL_BYTES = 96 * 1024 * 1024;

function mediaRootId(path: string): string | null {
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.length >= 3 && segments[0] === "media" && /^[A-Za-z0-9-]{1,128}$/u.test(segments[1] ?? "")
    ? segments[1]!
    : null;
}

async function removeBoundedRevisionMediaRoot(dataDir: string, revisionId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(revisionId)) return false;
  const mediaParent = resolve(dataDir, "media");
  const root = resolve(mediaParent, revisionId);
  if (relative(mediaParent, root) !== revisionId) return false;
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    return false;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > MEDIA_PRUNE_MAX_FILES_PER_REVISION) return false;
  const files: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9._-]{1,180}$/u.test(entry.name)) return false;
    const file = join(root, entry.name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MEDIA_PRUNE_MAX_FILE_BYTES) return false;
    totalBytes += info.size;
    if (totalBytes > MEDIA_PRUNE_MAX_TOTAL_BYTES) return false;
    files.push(file);
  }
  for (const file of files) await unlink(file);
  await rmdir(root);
  return true;
}

/**
 * Deletes only superseded media roots that no current revision still uses.
 * Every scan and deletion is deliberately bounded; an unexpected directory is
 * retained for a later operator decision instead of traversed recursively.
 */
export async function pruneSupersededRevisionMedia(
  dataDir: string,
  revisions: readonly ArticleRevision[],
  candidateIds: readonly string[]
): Promise<string[]> {
  if (
    revisions.length > MEDIA_PRUNE_MAX_REVISIONS ||
    candidateIds.length > MEDIA_PRUNE_MAX_CANDIDATES
  ) return [];
  const current = revisions.filter((revision) => !isRevisionSuperseded(revision, revisions));
  const referencedRoots = new Set(current.flatMap((revision) =>
    revision.media.flatMap((asset) => {
      const id = mediaRootId(asset.path);
      return id ? [id] : [];
    })
  ));
  const removed: string[] = [];
  for (const revisionId of [...new Set(candidateIds)].sort()) {
    const revision = revisions.find((candidate) => candidate.id === revisionId);
    if (!revision || !isRevisionSuperseded(revision, revisions) || referencedRoots.has(revisionId)) continue;
    if (await removeBoundedRevisionMediaRoot(dataDir, revisionId)) removed.push(revisionId);
  }
  return removed;
}

export async function collectDraftSourceEvidence(
  repository: SourceRepository | undefined,
  sourceIds: string[],
  urls: string[],
  transport?: FetchTransport,
  candidateUrl?: string,
  budgetMs: number = DRAFT_EVIDENCE_FETCH_BUDGET_MS
): Promise<Array<Record<string, unknown>>> {
  const evidence: Array<Record<string, unknown>> = [];
  // One shared network budget for the whole collection. Per-fetch timeouts alone
  // meant an unreachable publisher could cost 8 s each for up to 70 fetches
  // while the engine's serialized mutation lane was held, so the desktop bridge
  // timed out and dropped the sidecar mid-submit.
  const deadlineAtUnixMs = Date.now() + budgetMs;
  const remainingFetchMs = (): number => Math.min(DRAFT_EVIDENCE_FETCH_TIMEOUT_MS, deadlineAtUnixMs - Date.now());
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
        if (transport && candidateUrl && entry.url === candidateUrl && remainingFetchMs() > 0) {
          try {
            const fetched = await fetchSource(entry.url, transport, { timeoutMs: remainingFetchMs(), maxBytes: 2_000_000 });
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
      // Once the shared budget is gone the remaining URLs stay absent from the
      // evidence, which keeps the revision NEEDS_SOURCE instead of trusting a
      // page the engine never actually read.
      if (remainingFetchMs() <= 0) break;
      try {
        const fetched = await fetchSource(url, transport, { timeoutMs: remainingFetchMs(), maxBytes: 2_000_000 });
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

/**
 * A desktop session rarely stays open for a whole interval, so an interval-only
 * schedule meant the documented daily snapshot never ran at all. Startup catches
 * up whenever the last successful snapshot is missing or older than one interval.
 */
/**
 * Deliberately a few minutes, not immediate: taking the snapshot holds PGlite's
 * exclusive query gate, and an in-flight archive during the interactive startup
 * window would delay the first workspace reads.
 */
export const AUTOMATIC_BACKUP_CATCH_UP_DELAY_MS = 5 * 60 * 1_000;

/**
 * Schedules the one deferred catch-up snapshot when the last successful one is
 * missing or older than an interval. Fire-and-forget and unref'd like the
 * recurring timer: a failing snapshot is recorded as maintenance state and must
 * never keep the engine from becoming ready or from shutting down.
 */
export function scheduleOverdueAutomaticBackup(
  state: unknown,
  run: () => void,
  nowUnixMs: number = Date.now(),
  delayMs: number = AUTOMATIC_BACKUP_CATCH_UP_DELAY_MS
): ReturnType<typeof setTimeout> | undefined {
  if (!automaticBackupIsOverdue(state, nowUnixMs)) return undefined;
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return timer;
}

export function automaticBackupIsOverdue(
  state: unknown,
  nowUnixMs: number,
  intervalMs: number = automaticBackupInitialDelayMs()
): boolean {
  if (!isRecord(state)) return true;
  const succeededAt = typeof state.succeededAt === "string" ? Date.parse(state.succeededAt) : Number.NaN;
  if (!Number.isFinite(succeededAt)) return true;
  // A clock moved backwards must not postpone recovery coverage indefinitely.
  if (succeededAt > nowUnixMs) return true;
  return nowUnixMs - succeededAt >= intervalMs;
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
 * A completed, user-visible stop condition must not be replayed on the next
 * application start: an automatic replay hides the failure and makes the
 * promised manual retry pointless. A bounded runner timeout and an exhausted
 * retry budget are both such conditions, and so is an isolation rejection —
 * `CODEX_PROTOCOL_REJECTED` means the runner refused an event the task tried to
 * perform. Untrusted source text can be exactly what produced that attempt, so
 * replaying it would silently re-execute the same prompt on every start. A
 * local CLI incompatibility is different: it is normally resolved by updating
 * the desktop app or Codex itself, so a restart should recover the durable work
 * without asking the editor to recreate it. The genuinely resumable waits
 * (authentication, rate and usage limits) stay replayable as well.
 */
export function isFinalCodexStopCondition(job: BackendJob): boolean {
  if (job.state !== "WAITING_CODEX") return false;
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  return metadata.codexWaitReason === "RUNNER_TIMEOUT"
    || metadata.codexWaitReason === "RETRY_LIMIT_REACHED"
    || metadata.codexWaitReason === "PAID_FALLBACK_DISABLED"
    || metadata.codexDiagnosticCode === "CODEX_PROTOCOL_REJECTED";
}

async function updateJobWithCas(
  repository: BackendRepositoryTransaction,
  jobId: string,
  update: (job: BackendJob) => BackendJob | undefined
): Promise<BackendJob | undefined> {
  const observed = await repository.getJobRecord(jobId);
  const next = update(observed.job);
  return next ? repository.saveJob(next, observed.version) : undefined;
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
  for (const listed of jobs) {
    const job = (await repository.getJobRecord(listed.id)).job;
    if (job.kind !== "DRAFT" && job.kind !== "CODEX") continue;
    if (!["QUEUED", "RUNNING", "WAITING_CODEX", "RETRY_SCHEDULED"].includes(job.state)) continue;
    const metadata = isRecord(job.metadata) ? job.metadata : {};
    if (job.kind === "CODEX") {
      // Boby guidance is a durable CODEX job. Excluding it from recovery left it
      // RUNNING forever after an interrupted run: the queue can only claim a
      // QUEUED record and `JOB.RETRY` refuses a RUNNING job, so neither the
      // Boby panel nor Operations had any way to act on it.
      if (isFinalCodexStopCondition(job)) continue;
      const persisted = await coordinator.recoverInterrupted(job.id);
      if (persisted.recovered) {
        await updateJobWithCas(repository, job.id, (current) => {
          if (isFinalCodexStopCondition(current)) return undefined;
          const currentMetadata = isRecord(current.metadata) ? current.metadata : {};
          const { lastError: _lastError, ...queued } = current;
          return {
            ...queued,
            state: "QUEUED",
            metadata: {
              ...currentMetadata,
              recoveryCount: typeof currentMetadata.recoveryCount === "number" && Number.isSafeInteger(currentMetadata.recoveryCount)
                ? Math.max(0, currentMetadata.recoveryCount) + 1
                : 1,
              lastQueuedAtUnixMs: Date.now(),
              recoveryReason: "ENGINE_RESTART"
            }
          };
        });
        recovered += 1;
      } else if (job.state === "RUNNING") {
        // Nothing can resume this run. Record a terminal, retryable outcome
        // rather than an unreachable RUNNING row that accumulates forever.
        await updateJobWithCas(repository, job.id, (current) => current.state === "RUNNING"
          ? { ...current, state: "FAILED", lastError: "CODEX_RUNNER_INTERRUPTED" }
          : undefined);
      }
      continue;
    }
    const finalReviewJobId = typeof metadata.finalReviewJobId === "string" && metadata.finalReviewJobId.trim()
      ? metadata.finalReviewJobId
      : undefined;
    if (finalReviewJobId && typeof metadata.progressStage === "string" && metadata.progressStage.startsWith("FINAL_REVIEW")) {
      const persisted = await coordinator.recoverInterrupted(finalReviewJobId);
      if (persisted.recovered) {
        await updateJobWithCas(repository, job.id, (current) => {
          const currentMetadata = isRecord(current.metadata) ? current.metadata : {};
          const { lastError: _lastError, ...queued } = current;
          return {
            ...queued,
            state: "QUEUED",
            metadata: {
              ...currentMetadata,
              progressStage: "FINAL_REVIEW_RETRYING",
              lastQueuedAtUnixMs: Date.now(),
              recoveryReason: "ENGINE_RESTART"
            }
          };
        });
        recovered += 1;
      } else if (job.state === "RUNNING") {
        await updateJobWithCas(repository, job.id, (current) => current.state === "RUNNING"
          ? {
              ...current,
              state: "WAITING_CODEX",
              lastError: "FINAL_REVIEW_RECOVERY_REQUIRED",
              metadata: { ...(current.metadata ?? {}), progressStage: "FINAL_REVIEW_RECOVERY_REQUIRED", finalReviewJobId }
            }
          : undefined);
      }
      continue;
    }
    if (isFinalCodexStopCondition(job)) continue;
    const persisted = await coordinator.recoverInterrupted(job.id);
    if (persisted.recovered) {
      await updateJobWithCas(repository, job.id, (current) => {
        const currentMetadata = isRecord(current.metadata) ? current.metadata : {};
        const { lastError: _lastError, ...queued } = current;
        const recoveryCount = typeof currentMetadata.recoveryCount === "number" && Number.isSafeInteger(currentMetadata.recoveryCount)
          ? Math.max(0, currentMetadata.recoveryCount) + 1
          : 1;
        return {
          ...queued,
          state: "QUEUED",
          metadata: {
            ...currentMetadata,
            recoveryCount,
            lastQueuedAtUnixMs: Date.now(),
            recoveryReason: "ENGINE_RESTART"
          }
        };
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
    await updateJobWithCas(repository, job.id, (current) => {
      const { lastError: _lastError, ...queued } = current;
      const recoveryMetadata = isRecord(current.metadata) ? current.metadata : {};
      const recoveryCount = typeof recoveryMetadata.recoveryCount === "number" && Number.isSafeInteger(recoveryMetadata.recoveryCount)
        ? Math.max(0, recoveryMetadata.recoveryCount) + 1
        : 1;
      return {
        ...queued,
        state: "QUEUED",
        metadata: {
          ...recoveryMetadata,
          recoveryCount,
          lastQueuedAtUnixMs: Date.now(),
          recoveryReason: "ENGINE_RESTART"
        }
      };
    });
    recovered += 1;
  }
  return recovered;
}

export async function recoverInterruptedNativePublications(
  repository: BackendRepository,
  nowUnixMs = Date.now()
): Promise<number> {
  let recovered = 0;
  for (const listed of await repository.listOutbox()) {
    if (listed.state !== "IN_PROGRESS") continue;
    const observed = await repository.getOutboxEffect(listed.id);
    const effect = observed.effect;
    if (effect.state !== "IN_PROGRESS") continue;
    const ownerIsValid = typeof effect.nativeClaimOwnerId === "string"
      && /^[A-Za-z0-9._:-]{1,128}$/u.test(effect.nativeClaimOwnerId);
    const leaseDeadline = Date.parse(effect.nativeClaimLeaseUntil ?? "");
    if (ownerIsValid && Number.isFinite(leaseDeadline) && leaseDeadline > nowUnixMs) continue;
    const {
      nativeClaimOwnerId: _nativeClaimOwnerId,
      nativeClaimLeaseUntil: _nativeClaimLeaseUntil,
      ...requeued
    } = effect;
    try {
      await repository.updateOutbox({
        ...requeued,
        state: "UNKNOWN",
        nextAttemptAt: new Date(nowUnixMs).toISOString(),
        lastError: "NATIVE_PUBLICATION_INTERRUPTED"
      }, observed.version);
      recovered += 1;
    } catch (error) {
      if (!(error instanceof BackendStoreError) || error.code !== "WRITE_VERSION_CONFLICT") throw error;
      // Another live lane completed or renewed the row after this recovery
      // read. The CAS conflict is the desired stop condition.
    }
  }
  return recovered;
}

export async function createPersistentEngineProtocol(
  dataDir: string,
  options: PersistentEngineProtocolOptions = {}
): Promise<EngineProtocolRuntime> {
  const repository = await PGliteBackendRepository.open(dataDir);
  if (options.nativePublicationBroker) {
    await recoverInterruptedNativePublications(repository, options.nativePublicationNow?.() ?? Date.now());
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
  let automaticBackupCatchUpTimer: ReturnType<typeof setTimeout> | undefined;
  let candidateRefreshEpoch = 0;
  try {
    await queue.start();
    await sourceScanCoordinator.recover();
    if (options.startSourceWorker !== false) {
      await new SourceScanWorker(
        sourceRepository,
        queue,
        sourceTransport,
        () => { candidateRefreshEpoch += 1; }
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
          await syncCodexParentJobState(repository, submission, { kind: "WAITING", reason, ...(diagnosticCode ? { diagnosticCode } : {}), ...(diagnosticDetail ? { diagnosticDetail } : {}) });
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
            await updateJobWithCas(repository, submission.jobId, (job) => ({
              ...job,
              state: "SUCCEEDED",
              metadata: {
                ...(job.metadata ?? {}),
                completedAtUnixMs: Date.now(),
                bobyReply: (output as BobyGuideOutput).reply,
                bobyActions: (output as BobyGuideOutput).suggestedActions,
                ...(conversationSessionId ? { bobySessionId: conversationSessionId } : {})
              }
            }));
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
              // A GENERATE policy with no configured provider is unattainable,
              // not a failed attempt: leaving `media` empty made
              // `finalizeReviewedRevision` stamp HERO_MEDIA_REQUIRED and the
              // finished revision could never be approved by anyone. Render the
              // local, textless cover instead. A provider that was configured
              // and then failed still fails closed above, because there the
              // article-specific visual was a reachable editorial requirement.
              if (visualPolicy === "LOCAL_RENDERER" || (visualPolicy === "GENERATE" && !imageGenerator)) {
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
              revision.media = (artifacts ?? []).map((artifact) => ({
                role: "hero",
                path: `media/${revision.id}/${artifact.path}`,
                sha256: artifact.sha256,
                width: artifact.width,
                height: artifact.height,
                byteSize: artifact.byteSize,
                source: artifact.source
              }));
            }
            await updateJobWithCas(repository, submission.jobId, (job) => ({
              ...job,
              state: "RUNNING",
              metadata: { ...(job.metadata ?? {}), progressStage: "FINAL_REVIEW_QUEUED", finalReviewJobId: `${submission.jobId}:final-review`, qualityReviewQueuedAtUnixMs: Date.now() }
            }));
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
          const deploy = isRecord(connectors.deploy) ? connectors.deploy : {};
          const siteCheck = isRecord(checks.site) ? checks.site : {};
          const adapterDryRun = isRecord(siteCheck.adapterDryRun) ? siteCheck.adapterDryRun : {};
          const revision = bindMediaProvenanceToReview(finalizeReviewedRevision(rawRevision as unknown as ArticleRevision, output, {
            mode: site.mode === "PUBLISH" || site.mode === "LOCAL_DEV" ? site.mode : "LOCAL_ONLY",
            owner: typeof github.owner === "string" ? github.owner : undefined,
            repository: typeof github.repository === "string" ? github.repository : undefined,
            branch: typeof github.branch === "string" ? github.branch : undefined,
            baseSha: typeof github.baseSha === "string" ? github.baseSha : undefined,
            adapterId: typeof adapterDryRun.adapterId === "string" ? adapterDryRun.adapterId : undefined,
            adapterVersion: typeof adapterDryRun.adapterVersion === "string" ? adapterDryRun.adapterVersion : undefined,
            deployWorkflow: typeof deploy.workflowName === "string" ? deploy.workflowName : undefined,
            requiredChecks: Array.isArray(deploy.requiredChecks)
              ? deploy.requiredChecks.filter((value): value is string => typeof value === "string")
              : undefined
          }));
          // The fingerprint has to be stable across replays. Using the produced
          // revision poisoned this key: these durable effects run before the
          // Codex job is CAS'd to COMPLETED, so a crash in between leaves the
          // job RUNNING, restart recovery requeues it, the retry produces
          // different Codex output, the fingerprint no longer matches, and the
          // draft can never finish. The first successful materialization is the
          // durable outcome for this job, so replays must return it unchanged.
          const materialized = await repository.runIdempotent(
            `codex-materialize:${originalJobId}`,
            `codex-materialize:${originalJobId}`,
            (transaction) => transaction.insertRevision(revision)
          );
          await updateJobWithCas(repository, originalJobId, (job) => {
            const completedJob: BackendJob = {
              ...job,
              state: "SUCCEEDED",
              metadata: { ...(job.metadata ?? {}), revisionId: materialized.id, completedAtUnixMs: Date.now() }
            };
            delete completedJob.lastError;
            return completedJob;
          });
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
    // A scheduler without any drain path could only create durable effects that
    // nothing is able to reconcile. Keep that fail-closed, but recognise BOTH
    // drain paths: the in-process outbox worker above, and the native Windows
    // broker, which claims the same outbox over `publication.broker.*`. The
    // shipped desktop supplies only the native broker, so gating on the
    // in-process processor alone left scheduled publishing permanently dead
    // while `PUBLICATION.ENQUEUE` was still advertised as ready.
    const publicationDrainAvailable =
      Boolean(effectivePublicationProcessor) || options.nativePublicationBroker === true;
    if (options.startPublicationScheduler === true && publicationDrainAvailable) {
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
    // `setInterval` first fires one whole interval from now, and the timer is
    // recreated from zero on every sidecar spawn. An ordinary desktop session
    // never stays open that long, so the documented daily snapshot never ran at
    // all. Catch up once, deferred past the interactive startup window, whenever
    // the last successful snapshot is missing or older than an interval.
    automaticBackupCatchUpTimer = scheduleOverdueAutomaticBackup(
      await repository.getLocalState("maintenance.automatic-backup"),
      () => { void runAutomaticBackup(); }
    );
  } catch (error) {
    if (automaticBackupCatchUpTimer) clearTimeout(automaticBackupCatchUpTimer);
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
    candidateRefreshEpoch: () => candidateRefreshEpoch,
    publicationReady,
    nativePublicationBroker: options.nativePublicationBroker === true,
    ...(options.nativePublicationRuntimeId ? { nativePublicationRuntimeId: options.nativePublicationRuntimeId } : {}),
    ...(options.nativePublicationLeaseMs ? { nativePublicationLeaseMs: options.nativePublicationLeaseMs } : {}),
    ...(options.nativePublicationNow ? { nativePublicationNow: options.nativePublicationNow } : {}),
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
          // `code` is what a caller switches on, so it has to stay a stable
          // sentinel. Passing the raw exception text put an unbounded string
          // there — one that can echo a revision id or local detail — while the
          // human-readable slot got a constant.
          const failure = error instanceof Error ? error.message : "";
          const code = failure === "MEDIA_ASSET_NOT_FOUND" || failure === "MEDIA_ASSET_INTEGRITY_FAILURE"
            ? failure
            : "MEDIA_READ_FAILED";
          return sourceProtocolError(id, "command", code, "Media asset could not be read");
        }
      }
      if (isRecord(input) && input.kind === "backup.auto") {
        return createConsistentAutomaticBackup(repository.getDatabase(), dataDir);
      }
      // Automatic snapshots are logical row archives, so verify, preview and
      // restore go through the database rather than the directory unpacker.
      if (isRecord(input) && (input.kind === "backup.auto.verify" || input.kind === "backup.auto.restore.preview" || input.kind === "backup.auto.restore")) {
        return handleAutomaticBackupAccess(input, dataDir, repository.getDatabase());
      }
      if (isRecord(input) && (input.kind === "backup.create" || input.kind === "backup.auto.list" || input.kind === "backup.verify" || input.kind === "backup.restore.preview" || input.kind === "backup.restore")) {
        return handleBackupRequest(input, dataDir);
      }
      return protocol(input);
    },
    close: async () => {
      try {
        if (automaticBackupCatchUpTimer) clearTimeout(automaticBackupCatchUpTimer);
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
    | { kind: "WAITING"; reason: string; diagnosticCode?: string; diagnosticDetail?: string }
    | { kind: "RETRYING"; failure: string; transientFailureCount: number; retryAt: string }
): Promise<void> {
  const finalReview = submission.definitionId === "REVISION.FINAL_REVIEW";
  const originalJobId = finalReview && isRecord(submission.payload) && typeof submission.payload.originalJobId === "string"
    ? submission.payload.originalJobId
    : submission.jobId;
  if (!originalJobId) return;
  await updateJobWithCas(repository, originalJobId, (job) => {
    if (finalReview) {
      if (!["QUEUED", "RUNNING", "RETRY_SCHEDULED"].includes(job.state)) return undefined;
      if (update.kind === "STARTED") {
        return {
          ...job,
          state: "RUNNING",
          metadata: { ...(job.metadata ?? {}), progressStage: "FINAL_REVIEW", finalReviewJobId: submission.jobId, finalReviewStartedAtUnixMs: Date.now() }
        };
      }
      if (update.kind === "WAITING") {
        return {
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
        };
      }
      if (update.kind === "RETRYING") {
        return {
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
        };
      }
      return undefined;
    }
    if (update.kind === "STARTED") {
      return job.state === "QUEUED"
        ? { ...job, state: "RUNNING", metadata: { ...(job.metadata ?? {}), startedAtUnixMs: Date.now(), progressStage: "PREPARING_SOURCES" } }
        : undefined;
    }
    if (update.kind === "TASK_READY") {
      return job.state === "RUNNING"
        ? { ...job, metadata: { ...(job.metadata ?? {}), progressStage: "RUNNING_CODEX", codexStartedAtUnixMs: Date.now() } }
        : undefined;
    }
    if (update.kind === "WAITING") {
      if (job.state !== "RUNNING" && job.state !== "QUEUED") return undefined;
      return {
        ...job,
        state: "WAITING_CODEX",
        // The reason alone cannot distinguish a resumable wait from an isolation
        // rejection: both are RUNNER_REQUIRES_RETRY. Persist the diagnostic code
        // so restart recovery can tell them apart.
        metadata: { ...(job.metadata ?? {}), codexWaitReason: update.reason, ...(update.diagnosticCode ? { codexDiagnosticCode: update.diagnosticCode } : {}), ...(update.diagnosticDetail ? { codexDiagnosticDetail: update.diagnosticDetail.slice(0, 240) } : {}), waitingAtUnixMs: Date.now() }
      };
    }
    if (update.kind === "RETRYING" && (job.state === "RUNNING" || job.state === "QUEUED")) {
      return {
        ...job,
        state: "QUEUED",
        metadata: { ...(job.metadata ?? {}), progressStage: "RETRYING_CODEX", codexRetryReason: update.failure, codexRetryAttempt: update.transientFailureCount, codexRetryAtUnixMs: Date.parse(update.retryAt) }
      };
    }
    return undefined;
  });
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
          message: "request exceeds the 1,000,000-byte protocol limit"
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
