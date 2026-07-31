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
  validateClaimEvidence,
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
import { createCodexWorkerCoordinator, type CodexWorkerCoordinator } from "./codex-worker.ts";
import { createDraftCodexTaskResolver, materializeDraftRevision, isDraftCodexOutput } from "./codex-draft.ts";
import { buildPublicationPreview } from "./publication-preview.ts";
import { PGliteCodexJobStore, PGliteCodexQueueAdapter, registerCodexQueueWorker } from "./pglite-codex-job-store.ts";
import { startPublicationOutboxWorker, type PublicationEffectProcessor, type PublicationOutboxWorker } from "./publication-outbox-worker.ts";
import { PublicationScheduler } from "./publication-scheduler.ts";
import { GitHubAuthRuntime, isGitHubAuthRequest } from "./github-auth-runtime.ts";
import { GitHubPublicationEffects } from "../../publisher/src/github-effects.ts";
import { createConnectorAwarePublicationProcessor, type ApprovedPublicationCommand } from "../../publisher/src/publication.ts";
import { renderCoverVariants, type ArtDirection } from "../../../packages/visuals/src/index.ts";

const MAX_LINE_BYTES = 1_000_000;
// Keep restore verification bounded even when a compromised/local renderer
// points the engine at an unexpectedly large file.  Portable archives are
// intended for local application state, not unbounded disk imaging.
const MAX_BACKUP_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_AUTOMATIC_BACKUP_FILES = 256;
const MAX_AUTOMATIC_BACKUP_BYTES = 512 * 1024 * 1024;

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
  githubAuthRuntime?: GitHubAuthRuntime;
}

export interface PersistentEngineProtocolOptions {
  sourceTransport?: FetchTransport;
  startSourceWorker?: boolean;
  /** Start periodic source scans only for the packaged application runtime. */
  startSourceScheduler?: boolean;
  codexCommand?: string;
  codexHome?: string;
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

    if (isGitHubAuthRequest(input) && options.githubAuthRuntime) {
      try {
        const value = input.kind === "github.auth.begin"
          ? await options.githubAuthRuntime.begin()
          : input.kind === "github.auth.poll"
            ? await options.githubAuthRuntime.poll()
            : await options.githubAuthRuntime.status();
        return { version: 1, id: input.id, ok: true, kind: "value", value };
      } catch (error) {
        return {
          version: 1,
          id: input.id,
          ok: false,
          kind: "error",
          code: "GITHUB_AUTH_UNAVAILABLE",
          message: error instanceof Error ? error.message.slice(0, 256) : "GitHub authentication unavailable"
        };
      }
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
          ...(options.sourceScanCoordinator ? ["SOURCE.SCAN"] : []),
          ...(options.sourceRepository ? ["CANDIDATE.LIST"] : []),
          ...(options.githubAuthRuntime ? ["GITHUB.AUTH"] : []),
          "REVISION.SAVE",
          "REVISION.LIST",
          "REVISION.GET",
          "APPROVAL.GRANT",
          "APPROVAL.GRANT_HIGH_RISK",
          "PUBLICATION.PREVIEW",
          "PUBLICATION.ENQUEUE",
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
            const entries = await options.sourceRepository!.listEntries(source.id);
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
      const sources = await options.sourceRepository.listSources();
      const candidateByStory = new Map<string, Record<string, unknown>>();
      for (const source of sources) {
        if (source.status !== "ACTIVE") continue;
        const entries = await options.sourceRepository.listEntries(source.id);
        for (const entry of entries) {
          const candidateId = `candidate-${createCandidateKey(source.id, entry.externalId)}`;
          const title = String(entry.title);
          const storyKey = [...candidateByStory.keys()].find((key) => candidateSimilarity(key, title) >= 0.72)
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
            title: entry.title,
            summary: entry.summary ?? entry.title,
            primarySource: source.title ?? source.url,
            sourceCount: 1,
            section: source.defaultSection ?? "haberler",
            articleType: source.defaultArticleType ?? "news",
            confidence: source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED" ? 85 : 60,
            duplicateScore: 0,
            discoveredAt: entry.publishedAt ?? new Date(0).toISOString(),
            sourceId: source.id,
            sourceUrl: entry.url,
            scoreReasons: [
              source.trustStatus === "APPROVED" && source.rightsStatus === "APPROVED" ? "Güven ve kullanım hakkı doğrulandı" : "Kaynak incelemesi bekliyor",
              entry.publishedAt ? "Güncel yayın zamanı bulundu" : "Yayın zamanı yok"
            ]
          });
        }
      }
      const candidates = [...candidateByStory.values()];
      candidates.sort((left, right) => String(right.discoveredAt).localeCompare(String(left.discoveredAt)));
      return {
        version: 1,
        id: input.id,
        ok: true,
        kind: "candidate.list",
        candidates
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
        const result = await repository.runIdempotent(
          `publication-preview:${idempotencyKey}`,
          canonicalJson({ revisionId, revisionHash, expectedVersion, payload }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
            const revision = await transaction.getRevision(revisionId);
            if (computeRevisionHash(revision) !== revisionHash) throw new Error("APPROVAL_HASH_MISMATCH");
            const snapshot = await repository.sync(0);
            const approval = snapshot.snapshot.approvals.find((item) => item.revisionId === revisionId);
            if (!approval || approval.revisionHash !== revisionHash) throw new Error("NO_VALID_APPROVAL");
            const githubState = (await repository.getLocalState("connector.github")) ?? ((await repository.getLocalState("desktop.connectors")) as Record<string, unknown> | undefined)?.github;
            const githubTokenState = await repository.getLocalState("connector.github.token");
            const deployState = (await repository.getLocalState("connector.deploy")) ?? ((await repository.getLocalState("desktop.connectors")) as Record<string, unknown> | undefined)?.deploy;
            // Setup stores the generic site connector in the encrypted
            // desktop catalog. Keep the old standalone key as a migration
            // fallback, but never require it for the local-only/local-dev
            // targets. Those modes still need the selected folder as the
            // content root for preview validation and materialization.
            const desktopConnectorState = await repository.getLocalState("desktop.connectors");
            const siteState = (await repository.getLocalState("connector.site")) ??
              (isRecord(desktopConnectorState) ? desktopConnectorState.site : undefined);
            const githubObject = isRecord(githubState) ? githubState : {};
            const tokenObject = isRecord(githubTokenState) ? githubTokenState : {};
            const siteObject = isRecord(siteState) ? siteState : {};
            const configuredTargetRepository = String(payload.targetRepository ?? "") || (
              typeof githubObject.owner === "string" && typeof githubObject.repository === "string"
                ? `${githubObject.owner.trim()}/${githubObject.repository.trim()}`
                : ""
            );
            // A local-only preview still uses the shared dry-run validator,
            // which expects a repository-shaped identifier. This sentinel is
            // never sent to GitHub and publication resolver rejects it unless
            // a real connector is configured.
            const targetRepository = configuredTargetRepository || "local/local";
            const baseBranch = String(payload.baseBranch ?? "") || "main";
            const siteOrigin = String(payload.siteOrigin ?? "") || (typeof siteObject.publicSiteUrl === "string" ? siteObject.publicSiteUrl.trim() : "");
            const contentRoot = String(payload.contentRoot ?? "") || (typeof siteObject.repositoryPath === "string" ? siteObject.repositoryPath.trim() : "");
            let approvedBaseSha = typeof payload.approvedBaseSha === "string" ? payload.approvedBaseSha : "";
            if (!approvedBaseSha && typeof tokenObject.token === "string" && targetRepository) {
              const effects = new GitHubPublicationEffects({
                token: tokenObject.token,
                repository: targetRepository,
                baseBranch,
                ...(typeof deployState === "object" && deployState !== null && typeof (deployState as Record<string, unknown>).workflowName === "string"
                  ? { deployWorkflow: (deployState as Record<string, unknown>).workflowName as string }
                  : {})
              });
              approvedBaseSha = await effects.getBaseBranchSha();
            }
            const previewPayload = {
              ...payload,
              targetRepository,
              baseBranch,
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
              bundlePolicy: payload.bundlePolicy as never,
              siteOrigin,
              contentRoot,
              now: String(payload.now ?? new Date().toISOString())
            } as Parameters<typeof buildPublicationPreview>[0];
            if (typeof payload.adapterId === "string") previewInput.adapterId = payload.adapterId;
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
        const result = await repository.runIdempotent(
          `publication:${idempotencyKey}`,
          canonicalJson({ revisionId, revisionHash, previewHash, expectedVersion }),
          async (transaction) => {
            const currentVersion = await transaction.getVersion();
            if (currentVersion !== expectedVersion) throw new Error(`VERSION_CONFLICT:${expectedVersion}:${currentVersion}`);
            const revision = await transaction.getRevision(revisionId);
            if (computeRevisionHash(revision) !== revisionHash) throw new Error("APPROVAL_HASH_MISMATCH");
            const snapshot = await repository.sync(0);
            const approval = snapshot.snapshot.approvals.find((item) => item.revisionId === revisionId);
            if (!approval || approval.revisionHash !== revisionHash) throw new Error("NO_VALID_APPROVAL");
            if (revision.translationParity?.status === "MISMATCHED" || revision.translationParity?.status === "PENDING") {
              throw new Error("TRANSLATION_PARITY_NOT_READY");
            }
            if (!validateClaimEvidence(revision) || revision.claims.some((claim) => claim.status !== "VERIFIED")) {
              throw new Error("CLAIM_EVIDENCE_NOT_READY");
            }
            if (revision.riskLevel === "HIGH") {
              const highRisk = snapshot.snapshot.highRiskApprovals.find((item) => item.revisionId === revisionId);
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
          jobs: sync.snapshot.jobs,
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
            if (command.kind === "APPROVAL.GRANT_HIGH_RISK") {
              if (revision.riskLevel !== "HIGH") {
                throw new Error("HIGH_RISK_APPROVAL_NOT_REQUIRED");
              }
              return transaction.saveHighRiskApproval({
                revisionId: revision.id,
                revisionHash: actualHash,
                deviceId: command.payload.deviceId,
                approvedAt: new Date().toISOString(),
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
        const materialize = (revision: ArticleRevision) => ({
          revision,
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
              instruction: typeof payload.instruction === "string" ? payload.instruction : "",
              sourceIds,
              urls,
              section: typeof payload.section === "string" ? payload.section : "haberler",
              articleType: typeof payload.articleType === "string" ? payload.articleType : "news"
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
        if (job.state !== "FAILED" && job.state !== "DEAD_LETTER" && job.state !== "RETRY_SCHEDULED") {
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
      const sourceEvidence = options.sourceRepository
        ? await collectDraftSourceEvidence(options.sourceRepository, sourceIds, urls, options.sourceTransport)
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
    const time = typeof raw.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.exec(raw.time);
    const weekday = dayBySlot[slotId];
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

function boundedEvidenceText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replaceAll("\u0000", "").slice(0, MAX_EVIDENCE_TEXT);
}

function candidateTokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("tr-TR").normalize("NFKC").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function candidateSimilarity(left: string, right: string): number {
  const a = candidateTokens(left);
  const b = candidateTokens(right);
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
  transport?: FetchTransport
): Promise<Array<Record<string, unknown>>> {
  const evidence: Array<Record<string, unknown>> = [];
  for (const sourceId of [...new Set(sourceIds)].slice(0, 50)) {
    if (!repository) break;
    try {
      const source = await repository.getSource(sourceId);
      const entries = await repository.listEntries(sourceId);
      for (const entry of entries.slice(0, 20)) {
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
  const githubAuthRuntime = new GitHubAuthRuntime(repository);
  const sourceRetentionTimer = setInterval(() => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
    void sourceRepository.purgeExpiredEntries(cutoff).catch(() => undefined);
  }, 24 * 60 * 60 * 1_000);
  sourceRetentionTimer.unref?.();
  void sourceRepository.purgeExpiredEntries(new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString()).catch(() => undefined);
  const automaticBackupTimer = setInterval(() => {
    void handleBackupRequest({ version: 1, id: `automatic-backup-${Date.now()}`, kind: "backup.auto", payload: {} }, dataDir);
  }, 24 * 60 * 60 * 1_000);
  automaticBackupTimer.unref?.();
  // A restart is the first opportunity after an offline period; take one
  // snapshot immediately, then continue on the daily interval.
  void handleBackupRequest({ version: 1, id: `automatic-backup-start-${Date.now()}`, kind: "backup.auto", payload: {} }, dataDir);
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
    if (codexCommand) {
      await mkdir(codexHome, { recursive: true });
      const codexStore = new PGliteCodexJobStore(repository.getDatabase());
      codexCoordinator = createCodexWorkerCoordinator({
        persistence: codexStore,
        queue: new PGliteCodexQueueAdapter(queue),
        codex: createCodexCliPort({ command: codexCommand, codexHome, timeoutMs: 15 * 60 * 1_000 }),
        taskResolver: createDraftCodexTaskResolver(),
        onCompleted: async ({ submission, output }) => {
          if (submission.definitionId !== "DRAFT.CREATE" || !isDraftCodexOutput(output)) {
            throw new Error("CODEX_OUTPUT_NOT_A_DRAFT");
          }
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
          await repository.runIdempotent(
            `codex-materialize:${submission.jobId}`,
            canonicalJson(revision),
            (transaction) => transaction.insertRevision(revision)
          );
          const job = await repository.getJob(submission.jobId);
          const completedJob: BackendJob = {
            ...job,
            state: "SUCCEEDED",
            metadata: { ...(job.metadata ?? {}), revisionId: revision.id, completedAtUnixMs: Date.now() }
          };
          delete completedJob.lastError;
          await repository.saveJob(completedJob);
        }
      });
      await registerCodexQueueWorker(queue, codexCoordinator);
    }
    let effectivePublicationProcessor = options.publicationProcessor;
    if (!effectivePublicationProcessor) {
      const desktopConnectors = await repository.getLocalState("desktop.connectors");
      const github = (await repository.getLocalState("connector.github")) ?? (isRecord(desktopConnectors) ? desktopConnectors.github : undefined);
      const deploy = (await repository.getLocalState("connector.deploy")) ?? (isRecord(desktopConnectors) ? desktopConnectors.deploy : undefined);
      const tokenValue = await repository.getLocalState("connector.github.token");
      const token = isRecord(tokenValue) && typeof tokenValue.token === "string" ? tokenValue.token.trim() : "";
      const owner = isRecord(github) && typeof github.owner === "string" ? github.owner.trim() : "";
      const repositoryName = isRecord(github) && typeof github.repository === "string" ? github.repository.trim() : "";
      const workflowName = isRecord(deploy) && typeof deploy.workflowName === "string" ? deploy.workflowName.trim() : "";
      if (token && owner && repositoryName && workflowName) {
        const effects = new GitHubPublicationEffects({
          token,
          repository: `${owner}/${repositoryName}`,
          baseBranch: "main",
          deployWorkflow: workflowName
        }, {
          store: {
            get: (key) => repository.getLocalState(key),
            set: (key, value) => repository.setLocalState(key, value)
          }
        });
        effectivePublicationProcessor = createConnectorAwarePublicationProcessor({
          connector: { state: "READY" },
          effects,
          resolver: {
            resolve: async (effect) => {
              const snapshot = (await repository.sync(0)).snapshot;
              const revision = snapshot.revisions.find((item) => item.id === effect.aggregateId);
              const preview = await repository.getLocalState(`publication.preview:${effect.aggregateId}`);
              if (!revision || !isRecord(preview) || !isRecord(preview.payload)) return null;
              // The outbox row is the immutable publication intent. Never
              // resolve a command from mutable preview state alone: an old
              // preview must not be replayed for a newer (or different)
              // revision hash after a crash/restart.
              if (typeof effect.revisionHash !== "string" || !/^[a-f0-9]{64}$/iu.test(effect.revisionHash)) return null;
              const currentRevisionHash = computeRevisionHash(revision);
              if (currentRevisionHash !== effect.revisionHash) return null;
              const approved = snapshot.approvals.find((item) => item.revisionId === effect.aggregateId);
              if (!approved || approved.revisionHash !== effect.revisionHash || approved.revisionHash !== preview.revisionHash) return null;
              const payload = preview.payload;
              if (!Array.isArray(payload.files)) return null;
              const approvedBaseSha = typeof payload.approvedBaseSha === "string" ? payload.approvedBaseSha : "";
              const currentBaseSha = typeof payload.currentBaseSha === "string" ? payload.currentBaseSha : "";
              // Local-only projects can be reviewed and drafted without a
              // public URL. External publication stays blocked until the
              // canonical public address is configured and the preview is
              // regenerated against it.
              if (typeof payload.siteOrigin !== "string" || !payload.siteOrigin.trim()) return null;
              // A publication without a read-only base snapshot cannot prove
              // that the reviewed repository is still the one being changed.
              if (!/^[a-f0-9]{7,64}$/iu.test(approvedBaseSha) || approvedBaseSha !== currentBaseSha) return null;
              const command: ApprovedPublicationCommand = {
                articleId: revision.translationKey,
                revisionId: revision.id,
                approvedRevisionHash: effect.revisionHash,
                currentRevisionHash,
                targetRepository: typeof payload.targetRepository === "string" ? payload.targetRepository : "",
                baseBranch: typeof payload.baseBranch === "string" ? payload.baseBranch : "main",
                approvedBaseSha,
                currentBaseSha,
                approvedHeadSha: typeof payload.approvedHeadSha === "string" ? payload.approvedHeadSha : "",
                currentHeadSha: typeof payload.currentHeadSha === "string" ? payload.currentHeadSha : "",
                files: payload.files as never,
                ...(isRecord(payload.bundlePolicy) ? { bundlePolicy: payload.bundlePolicy as never } : {})
              };
              return command;
            }
          }
        });
      }
    }
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
  return {
    handle: async (input: unknown) => {
      if (isRecord(input) && (input.kind === "backup.create" || input.kind === "backup.auto" || input.kind === "backup.verify" || input.kind === "backup.restore.preview" || input.kind === "backup.restore")) {
        return handleBackupRequest(input, dataDir);
      }
      const protocolOptions: EngineProtocolOptions = {
        sourceRepository,
        sourceTransport,
        sourceScanCoordinator
      };
      if (codexCoordinator) protocolOptions.codexCoordinator = codexCoordinator;
      protocolOptions.githubAuthRuntime = githubAuthRuntime;
      return createEngineProtocol(repository, "ready", protocolOptions)(input);
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
  try {
    for await (const line of readBoundedLines(input)) {
      if (line === null) {
        writeResponse(output, {
          version: 1,
          id: "unknown",
          ok: false,
          kind: "error",
          code: "REQUEST_TOO_LARGE",
          message: "request exceeds the 1 MiB protocol limit"
        });
        continue;
      }
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeResponse(output, {
          version: 1,
          id: "unknown",
          ok: false,
          kind: "error",
          code: "INVALID_JSON",
          message: "request must be a JSON object"
        });
        continue;
      }

      try {
        writeResponse(output, await runtime.handle(parsed));
      } catch (error) {
        writeResponse(output, {
          version: 1,
          id: isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : "unknown",
          ok: false,
          kind: "error",
          code: "ENGINE_FAILURE",
          message: error instanceof Error ? error.message : "engine failure"
        });
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

function writeResponse(output: NodeJS.WritableStream, response: EngineResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
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
