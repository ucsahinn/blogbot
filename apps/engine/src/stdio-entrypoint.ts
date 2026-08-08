import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { lstat, readdir, stat, unlink } from "node:fs/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  fetchSource,
  type FetchTransport
} from "../../fetcher/src/fetch-source.ts";
import { createNodeFetchTransport } from "../../fetcher/src/node-transport.ts";
import { validateEngineCommandV1 } from "../../../packages/contracts/src/index.ts";
import type { BackendJob, BackendRepository } from "../../../packages/database/src/backend-repository.ts";
import { InMemoryBackendStore } from "../../../packages/database/src/in-memory-backend-store.ts";
import { PGliteBackendRepository } from "../../../packages/database/src/pglite-backend-repository.ts";
import {
  PGliteSourceRepository,
  SourceRepositoryError,
  type SourceRepository
} from "../../../packages/database/src/source-repository.ts";
import {
  canonicalJson,
  computeRevisionHash,
  validateApprovalGates,
  validateClaimEvidence,
  validateRevisionPackageV2,
  type Approval,
  type ArticleRevision,
  type HighRiskApproval
} from "../../../packages/editorial/src/revision.ts";
import {
  analyzeSourceDocument,
  SourceDocumentError
} from "../../../packages/security/src/source-document.ts";
import { assertSafeSourceUrl } from "../../../packages/security/src/url-policy.ts";
import { applyPortableRestorePlan, createPortableBackup, planPortableRestore } from "../../../packages/backup/src/portable-backup.ts";
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
import { createCodexWorkerCoordinator, type CodexWorkerCoordinator } from "./codex-worker.ts";
import {
  createDraftCodexTaskResolver,
  finalizeReviewedRevision,
  isDraftCodexOutput,
  isFinalReviewCodexOutput,
  materializeDraftRevision
} from "./codex-draft.ts";
import { buildPublicationPreview } from "./publication-preview.ts";
import { PGliteCodexJobStore, PGliteCodexQueueAdapter, registerCodexQueueWorker } from "./pglite-codex-job-store.ts";
import { startPublicationOutboxWorker, type PublicationEffectProcessor, type PublicationOutboxWorker } from "./publication-outbox-worker.ts";
import { PublicationScheduler } from "./publication-scheduler.ts";
import { renderCoverVariants, type ArtDirection } from "../../../packages/visuals/src/index.ts";
import type { PublicationBundlePolicy } from "../../publisher/src/publication.ts";

const MAX_LINE_BYTES = 1_000_000;
// Keep restore verification bounded even when a compromised/local renderer
// points the engine at an unexpectedly large file.  Portable archives are
// intended for local application state, not unbounded disk imaging.
const MAX_BACKUP_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_AUTOMATIC_BACKUP_FILES = 256;
const MAX_AUTOMATIC_BACKUP_BYTES = 512 * 1024 * 1024;
// Candidate triage is a projection, not a full archive browser. Reading and
// decrypting an unbounded feed catalog on every desktop refresh was the main
// source of multi-second freezes on large local workspaces.
const MAX_CANDIDATE_ENTRIES_PER_SOURCE = 250;

/**
 * Background maintenance has no request/response caller to surface failures
 * to. Keep stdout reserved for NDJSON and emit only stable, secret-safe codes
 * to the engine diagnostics channel.
 */
export function reportBackgroundTaskFault(
  code: "SOURCE_RETENTION_UNAVAILABLE" | "AUTOMATIC_BACKUP_UNAVAILABLE",
  write: (line: string) => void = (line) => process.stderr.write(line)
): void {
  try {
    write(`[Blogbot] ${code}\n`);
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
  code: "CODEX_JOB_STARTED" | "CODEX_JOB_WAITING" | "CODEX_JOB_RETRYING" | "CODEX_JOB_COMPLETED" | "CODEX_PROTOCOL_REJECTED" | "CODEX_OUTPUT_INVALID" | "CODEX_OUTPUT_MISSING" | "CODEX_CLI_INVALID_EVENT" | "CODEX_CLI_INVALID_FINAL_OUTPUT" | "CODEX_PROCESS_FAILED" | "CODEX_UNKNOWN_FAILURE",
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
    const bytes = publicationContentBytes(candidate.content);
    actual.set(candidate.path, {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength
    });
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
      if (output.length >= MAX_AUTOMATIC_BACKUP_FILES || totalBytes > MAX_AUTOMATIC_BACKUP_BYTES) {
        throw new Error("AUTOMATIC_BACKUP_LIMIT_EXCEEDED");
      }
      output.push(nextRelative);
    }
  }
  await walk(root, "");
  return output;
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

export async function handleBackupRequest(
  input: Record<string, unknown>,
  dataDir: string
): Promise<EngineResponse> {
  const id = typeof input.id === "string" ? input.id : "unknown";
  const kind = input.kind === "backup.create" || input.kind === "backup.auto" || input.kind === "backup.verify" || input.kind === "backup.restore.preview" || input.kind === "backup.restore"
    ? input.kind
    : null;
  if (!kind) return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "backup request kind is not supported" };
  const payload = isRecord(input.payload) ? input.payload : {};
  const archivePath = typeof payload.archivePath === "string" ? payload.archivePath : "";
  const automatic = kind === "backup.auto";
  const automaticDirectory = join(dataDir, "backups");
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
  if (automatic) {
    try { recoveryKey = automaticBackupRecoveryKey(); }
    catch (error) { return { version: 1, id, ok: false, kind: "error", code: "BACKUP_INVALID", message: error instanceof Error ? error.message : "automatic backup key unavailable" }; }
  }
  const targetDirectory = typeof payload.targetDirectory === "string"
    ? payload.targetDirectory
    : join(dataDir, ".backup-verify-preview");
  if ((kind === "backup.create" || automatic) && (!outputPath || !sourceDirectory || relativePaths.length === 0 || relativePaths.length > MAX_AUTOMATIC_BACKUP_FILES)) {
    return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "backup output, source directory, recovery key, and bounded file allowlist are required" };
  }
  if (kind !== "backup.create" && !automatic && (!archivePath || !recoveryKey || ((kind === "backup.restore.preview" || kind === "backup.restore") && !payload.targetDirectory))) {
    return { version: 1, id, ok: false, kind: "error", code: "INVALID_REQUEST", message: "archive path, recovery key, and restore target are required" };
  }
  try {
    if (kind === "backup.create" || automatic) {
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
    if (kind === "backup.restore") {
      await applyPortableRestorePlan(plan);
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
  /** True only when the host injected a processor that can reconcile the durable outbox. */
  publicationReady?: boolean;
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
  publicationProcessor?: PublicationEffectProcessor;
  /** Enabled by default so due approved work is recovered after restart. */
  startPublicationScheduler?: boolean;
  publicationSchedulerPollMs?: number;
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
        capabilities: [
          "AUTOMATION.SET",
          ...(options.sourceRepository ? ["SOURCE.LIST"] : []),
          ...(options.sourceTransport ? ["SOURCE.TEST"] : []),
          ...(options.sourceRepository ? ["SOURCE.SAVE"] : []),
          ...(options.sourceRepository ? ["SOURCE.REVIEW"] : []),
          ...(options.sourceScanCoordinator ? ["SOURCE.SCAN"] : []),
          ...(options.sourceRepository ? ["CANDIDATE.LIST"] : []),
          "REVISION.SAVE",
          "REVISION.LIST",
          "REVISION.GET",
          "APPROVAL.GRANT",
          "APPROVAL.GRANT_HIGH_RISK",
          "PUBLICATION.PREVIEW",
          ...(options.publicationReady ? ["PUBLICATION.ENQUEUE"] : []),
          "BACKUP.CREATE",
          "BACKUP.VERIFY",
          "DRAFT.CREATE",
          "JOB.RETRY",
          ...(options.codexCoordinator ? ["CODEX.RUNNER"] : [])
        ],
        detail: repository.persistence === "pglite" && queueStatus === "ready"
          ? "Local engine storage and durable queue are ready."
          : "Engine protocol is available; durable local storage is not configured."
      };
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
            const entries = await options.sourceRepository!.listEntriesBounded(source.id, 25);
            const lastItemAt = entries
              .map((entry) => entry.publishedAt)
              .filter((value): value is string => typeof value === "string" && value.length > 0)
              .sort()
              .at(-1) ?? null;
            return {
              ...source,
              lastItemAt,
              capabilities:
                await options.sourceRepository!.getSourceCapabilities(source.id)
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
      for (const source of sources) {
        if (source.status !== "ACTIVE") continue;
        const entries = await options.sourceRepository.listEntriesBounded(source.id, MAX_CANDIDATE_ENTRIES_PER_SOURCE);
        for (const entry of entries) {
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
      }
      // Candidate inventory is polled by the desktop shell. Keep this a
      // bounded triage projection so a large feed catalog never freezes the
      // bridge; the selected candidate is re-read when research starts.
      const candidates = [...candidateByStory.values()].slice(0, 50);
      candidates.sort((left, right) => String(right.discoveredAt).localeCompare(String(left.discoveredAt)));
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
            const checkObject = isRecord(desktopConnectorChecks) ? desktopConnectorChecks : {};
            const siteCheck = isRecord(checkObject.site) ? checkObject.site : {};
            const adapterDryRun = isRecord(siteCheck.adapterDryRun) ? siteCheck.adapterDryRun : {};
            const publishMode = siteObject.mode === "PUBLISH";
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
              createdAt: preview.plan.generatedAt
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
            if (revision.translationParity?.status === "MISMATCHED" || revision.translationParity?.status === "PENDING") {
              throw new Error("TRANSLATION_PARITY_NOT_READY");
            }
            if (!validateClaimEvidence(revision) || revision.claims.some((claim) => claim.status !== "VERIFIED")) {
              throw new Error("CLAIM_EVIDENCE_NOT_READY");
            }
            const gateStatus = validateApprovalGates(revision, approval.warningSetHash);
            if (gateStatus !== "READY") throw new Error(gateStatus);
            if (revision.riskLevel === "HIGH") {
              const highRisk = approvalSnapshot.snapshot.highRiskApprovals.find((item) =>
                item.revisionId === revisionId && item.revisionHash === revisionHash
              );
              if (!highRisk) throw new Error("HIGH_RISK_APPROVAL_REQUIRED");
            }
            const preview = await transaction.getLocalState(`publication.preview:${revisionId}`);
            if (!isRecord(preview) || preview.revisionHash !== revisionHash || preview.previewHash !== previewHash) {
              throw new Error("NO_VALID_PUBLICATION_PREVIEW");
            }
            return transaction.enqueuePublication(revisionId, revisionHash);
          }
        );
        return { version: 1, id: input.id, ok: true, kind: "publication.enqueue", value: result };
      } catch (error) {
        return sourceProtocolError(input.id, "command", "PUBLICATION_ENQUEUE_FAILED", error instanceof Error ? error.message : "Publication enqueue failed");
      }
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
      const sync = await repository.sync(input.afterCursor);
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "state",
        snapshot: {
          serverCursor: sync.serverCursor,
          automation: sync.snapshot.automation,
          // The state envelope is polled by the desktop shell. Keep it a
          // dashboard projection: completed Codex records can contain large
          // prompts/outputs and must be fetched only by an explicit detail
          // command, never on every workspace refresh.
          jobs: sync.snapshot.jobs.map((job) => ({
            id: job.id,
            kind: job.kind,
            state: job.state,
            attempts: job.attempts,
            ...(job.lastError ? { lastError: job.lastError } : {}),
            ...(job.metadata ? { metadata: job.metadata } : {})
          })),
          outbox: sync.snapshot.outbox,
          changes: sync.changes
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
              return transaction.saveHighRiskApproval({
                revisionId: revision.id,
                revisionHash: actualHash,
                deviceId: command.payload.deviceId,
                approvedAt: new Date().toISOString(),
                warningSetHash: command.payload.warningSetHash,
                approvalType: "HIGH_RISK",
                riskChecklistHash: command.payload.riskChecklistHash,
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
        validation.command.kind === "REVISION.GET")
    ) {
      const command = validation.command;
      try {
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

        const snapshot = (await repository.sync(0)).snapshot;
        const summaryOnly = command.kind === "REVISION.LIST" &&
          isRecord(command.payload) && command.payload.summaryOnly === true;
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
  if (!["DRAFT.CREATE", "JOB.RETRY", "LOCAL_STATE.SET"].includes(kind)) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const idempotencyKey = typeof value.idempotencyKey === "string" ? value.idempotencyKey : "";
  const expectedVersion = typeof value.expectedVersion === "number" ? value.expectedVersion : -1;
  const payload = isRecord(value.payload) ? value.payload : {};
  if (!requestId || !idempotencyKey || !Number.isSafeInteger(expectedVersion)) {
    return revisionCommandFailure(envelopeId, "INVALID_COMMAND", "Workflow command metadata is invalid", false);
  }
  try {
    const resolvedSchedule = kind === "DRAFT.CREATE" ? await resolveNextSlot(repository, payload) : undefined;
    const effectivePayload = resolvedSchedule ? { ...payload, scheduledAt: resolvedSchedule } : payload;
    const result = await repository.runIdempotent(
      `engine:${idempotencyKey}`,
      canonicalJson({ kind, payload, expectedVersion }),
      async (transaction) => {
        const current = await transaction.getVersion();
        if (current !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${current}`);
        if (kind === "DRAFT.CREATE") {
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
      codex = await options.codexCoordinator.submit({
        jobId: draftId,
        idempotencyKey: `draft:${idempotencyKey}`,
        definitionId: "DRAFT.CREATE",
        payload: { ...effectivePayload, sources: sourceEvidence }
      });
    }
    if (kind === "JOB.RETRY" && options.codexCoordinator) {
      const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
      // The workflow row and the Codex coordinator record share the draft ID,
      // but have separate durable state. Requeue both sides so the Operations
      // button is a real recovery action rather than a misleading success.
      codex = await options.codexCoordinator.recoverInterrupted(jobId);
    }
    return revisionCommandSuccess(envelopeId, { requestId, idempotencyKey, kind: kind as "LOCAL_STATE.SET" }, { backendJob: result, codex }, await repository.getVersion());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow command failed";
    const code = message.startsWith("VERSION_CONFLICT:") ? "VERSION_CONFLICT" : message.includes("IDEMPOTENCY_KEY_REUSED") ? "IDEMPOTENCY_KEY_REUSED" : "ENGINE_OPERATION_FAILED";
    return revisionCommandFailure(envelopeId, code, message, code === "VERSION_CONFLICT");
  }
}

async function resolveNextSlot(
  repository: BackendRepository,
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
  return candidates[0]?.toISOString();
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
      kind: command.kind as "REVISION.SAVE" | "DRAFT.CREATE" | "JOB.RETRY" | "LOCAL_STATE.SET" | "APPROVAL.GRANT" | "APPROVAL.GRANT_HIGH_RISK",
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

const MAX_EVIDENCE_TEXT = 4_096;
// A desktop editor must never leave an apparent live task running for a
// quarter-hour without a user-visible decision. Longer work can be retried
// explicitly from Operations after the runner explains its stop condition.
export const CODEX_RUNNER_TIMEOUT_MS = 5 * 60 * 1_000;

function boundedEvidenceText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replaceAll("\u0000", "").slice(0, MAX_EVIDENCE_TEXT);
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
      const entries = await repository.listEntries(sourceId);
      const selectedEntries = candidateUrl
        ? entries.filter((entry) => entry.url === candidateUrl).slice(0, 1)
        : entries.slice(0, 20);
      for (const entry of selectedEntries) {
        evidence.push({
          id: `${sourceId}:${entry.externalId}`,
          sourceId,
          url: entry.url || source.url,
          title: entry.title,
          summary: entry.summary ?? "",
          publishedAt: entry.publishedAt ?? null,
          fetchedAt: source.updatedAt,
          // Feed entries do not retain full publisher bodies. Bind the
          // evidence snapshot to the normalized text we actually pass to the
          // runner instead of using an unverifiable zero hash.
          contentHash: createHash("sha256").update(boundedEvidenceText(entry.summary ?? entry.title), "utf8").digest("hex"),
          ...evidenceFields(entry.summary ?? entry.title, sourceId)
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
          evidence.push({
            id: `url:${bodyHash}:${entry.externalId}`,
            sourceId: `url:${bodyHash}`,
            url: entry.url,
            title: entry.title,
            summary: entry.summary ?? "",
            publishedAt: entry.publishedAt ?? null,
            fetchedAt: new Date().toISOString(),
            contentHash: bodyHash,
            ...evidenceFields(entry.summary ?? entry.title, `url:${bodyHash}`)
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
    if (job.kind !== "DRAFT" || !["QUEUED", "RUNNING", "WAITING_CODEX"].includes(job.state)) continue;
    const metadata = isRecord(job.metadata) ? job.metadata : {};
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

export async function createPersistentEngineProtocol(
  dataDir: string,
  options: PersistentEngineProtocolOptions = {}
): Promise<EngineProtocolRuntime> {
  const repository = await PGliteBackendRepository.open(dataDir);
  const sourceRepository = await PGliteSourceRepository.fromDatabase(
    repository.getDatabase()
  );
  const queue = new LocalQueueRuntime(repository.getDatabase());
  const sourceTransport =
    options.sourceTransport ?? createNodeFetchTransport();
  const sourceScanCoordinator = new SourceScanCoordinator(
    sourceRepository,
    queue
  );
  const sourceScanScheduler = new SourceScanScheduler(
    repository,
    sourceRepository,
    sourceScanCoordinator
  );
  let codexCoordinator: CodexWorkerCoordinator | undefined;
  let publicationOutboxWorker: PublicationOutboxWorker | undefined;
  let publicationScheduler: PublicationScheduler | undefined;
  // Keep the advertised capability independent from worker startup scope so
  // every later doctor request reports the same injected host capability.
  const publicationReady = Boolean(options.publicationProcessor);
  const sourceRetentionTimer = setInterval(() => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
    void sourceRepository.purgeExpiredEntries(cutoff).catch(() => reportBackgroundTaskFault("SOURCE_RETENTION_UNAVAILABLE"));
  }, 24 * 60 * 60 * 1_000);
  sourceRetentionTimer.unref?.();
  void sourceRepository
    .purgeExpiredEntries(new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString())
    .catch(() => reportBackgroundTaskFault("SOURCE_RETENTION_UNAVAILABLE"));
  const automaticBackupTimer = setInterval(() => {
    void handleBackupRequest({ version: 1, id: `automatic-backup-${Date.now()}`, kind: "backup.auto", payload: {} }, dataDir)
      .catch(() => reportBackgroundTaskFault("AUTOMATIC_BACKUP_UNAVAILABLE"));
  }, 24 * 60 * 60 * 1_000);
  automaticBackupTimer.unref?.();
  // A restart is the first opportunity after an offline period; take one
  // snapshot immediately, then continue on the daily interval.
  void handleBackupRequest({ version: 1, id: `automatic-backup-start-${Date.now()}`, kind: "backup.auto", payload: {} }, dataDir)
    .catch(() => reportBackgroundTaskFault("AUTOMATIC_BACKUP_UNAVAILABLE"));
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
          if (submission.definitionId === "REVISION.FINAL_REVIEW" && isRecord(submission.payload)) {
            const originalJobId = typeof submission.payload.originalJobId === "string" ? submission.payload.originalJobId : "";
            if (!originalJobId) return;
            const job = await repository.getJob(originalJobId);
            if (job.state !== "RUNNING") return;
            await repository.saveJob({
              ...job,
              metadata: { ...(job.metadata ?? {}), progressStage: "FINAL_REVIEW", finalReviewStartedAtUnixMs: Date.now() }
            });
            return;
          }
          if (submission.definitionId !== "DRAFT.CREATE") return;
          const job = await repository.getJob(submission.jobId);
          if (job.state !== "QUEUED") return;
          await repository.saveJob({
            ...job,
            state: "RUNNING",
            metadata: {
              ...(job.metadata ?? {}),
              startedAtUnixMs: Date.now(),
              progressStage: "PREPARING_SOURCES"
            }
          });
        },
        onTaskReady: async ({ submission }) => {
          if (submission.definitionId !== "DRAFT.CREATE") return;
          const job = await repository.getJob(submission.jobId);
          if (job.state !== "RUNNING") return;
          await repository.saveJob({
            ...job,
            metadata: { ...(job.metadata ?? {}), progressStage: "RUNNING_CODEX", codexStartedAtUnixMs: Date.now() }
          });
        },
        onWaiting: async ({ submission, reason, diagnosticCode, diagnosticDetail }) => {
          reportCodexLifecycle("CODEX_JOB_WAITING");
          if (diagnosticCode) reportCodexLifecycle(diagnosticCode, (line) => process.stderr.write(line), diagnosticDetail);
          if (submission.definitionId !== "DRAFT.CREATE") return;
          const job = await repository.getJob(submission.jobId);
          if (job.state !== "RUNNING" && job.state !== "QUEUED") return;
          await repository.saveJob({
            ...job,
            state: "WAITING_CODEX",
            metadata: {
              ...(job.metadata ?? {}),
              codexWaitReason: reason,
              ...(diagnosticDetail ? { codexDiagnosticDetail: diagnosticDetail.slice(0, 240) } : {}),
              waitingAtUnixMs: Date.now()
            }
          });
        },
        onRetrying: async ({ submission, failure }) => {
          reportCodexLifecycle("CODEX_JOB_RETRYING");
          if (submission.definitionId !== "DRAFT.CREATE") return;
          const job = await repository.getJob(submission.jobId);
          if (job.state !== "RUNNING" && job.state !== "QUEUED") return;
          await repository.saveJob({
            ...job,
            state: "QUEUED",
            metadata: {
              ...(job.metadata ?? {}),
              progressStage: "RETRYING_CODEX",
              codexRetryReason: failure,
              codexRetryAtUnixMs: Date.now()
            }
          });
        },
        onCompleted: async ({ submission, output }) => {
          reportCodexLifecycle("CODEX_JOB_COMPLETED");
          if (submission.definitionId === "DRAFT.CREATE" && isDraftCodexOutput(output)) {
            const revision = materializeDraftRevision(submission.jobId, submission.payload, output);
            const visualPolicy = isRecord(submission.payload) && typeof submission.payload.visualPolicy === "string"
              ? submission.payload.visualPolicy
              : "NONE";
            if (visualPolicy !== "NONE") {
              const direction: ArtDirection = {
                title: output.tr.title,
                palette: ["#08131f", "#32d3a6"],
                motifs: ["network", "shield"],
                externalAssets: [],
                depictsRealPerson: false,
                depictsBrandLogo: false
              };
              const artifacts = await renderCoverVariants(direction, join(dataDir, "media", revision.id), revision.tr.slug);
              revision.media = await Promise.all(artifacts.map(async (artifact) => ({
                role: "hero",
                path: `media/${revision.id}/${artifact.path}`,
                sha256: artifact.sha256,
                width: artifact.width,
                height: artifact.height,
                contentBase64: (await readFile(artifact.absolutePath)).toString("base64")
              })));
            }
            const job = await repository.getJob(submission.jobId);
            await repository.saveJob({
              ...job,
              state: "RUNNING",
              metadata: { ...(job.metadata ?? {}), progressStage: "FINAL_REVIEW_QUEUED", qualityReviewQueuedAtUnixMs: Date.now() }
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
    const effectivePublicationProcessor = options.publicationProcessor;
    if (effectivePublicationProcessor) {
      publicationOutboxWorker = startPublicationOutboxWorker(repository, effectivePublicationProcessor);
    }
    if (options.startPublicationScheduler === true) {
      publicationScheduler = new PublicationScheduler(
        repository,
        () => new Date(),
        options.publicationSchedulerPollMs ?? 60_000
      );
      publicationScheduler.start();
    }
  } catch (error) {
    clearInterval(automaticBackupTimer);
    clearInterval(sourceRetentionTimer);
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
    ...(codexCoordinator ? { codexCoordinator } : {})
  };
  const protocol = createEngineProtocol(repository, "ready", protocolOptions);
  return {
    handle: async (input: unknown) => {
      if (isRecord(input) && (input.kind === "backup.create" || input.kind === "backup.auto" || input.kind === "backup.verify" || input.kind === "backup.restore.preview" || input.kind === "backup.restore")) {
        return handleBackupRequest(input, dataDir);
      }
      return protocol(input);
    },
    close: async () => {
      try {
        clearInterval(automaticBackupTimer);
        clearInterval(sourceRetentionTimer);
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

export async function runStdioEngine(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  dataDir: string = defaultDataDir()
): Promise<void> {
  const runtime = await createPersistentEngineProtocol(dataDir, {
    startSourceScheduler: true,
    startPublicationScheduler: true
  });
  let outputBroken = false;
  output.on("error", () => {
    // The desktop can restart the sidecar while an async response is still
    // being flushed. Treat that as a normal transport shutdown; never let an
    // unhandled EPIPE bring down Node with a visible console traceback.
    outputBroken = true;
  });
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

      try {
        if (!writeResponse(output, await runtime.handle(parsed))) break;
      } catch (error) {
        if (!writeResponse(output, {
          version: 1,
          id: isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : "unknown",
          ok: false,
          kind: "error",
          code: "ENGINE_FAILURE",
          message: error instanceof Error ? error.message : "engine failure"
        })) break;
      }
    }
  } finally {
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
