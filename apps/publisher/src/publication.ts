import { createHash } from "node:crypto";

import { parseSiteArtifactManifest } from "../../../packages/site-adapter/src/index.ts";

export type PublisherGuardCode =
  | "BUNDLE_DUPLICATE_PATH"
  | "BUNDLE_EMPTY"
  | "BUNDLE_FILE_SET_MISMATCH"
  | "BUNDLE_FILE_TAMPERED"
  | "BUNDLE_MANIFEST_MISMATCH"
  | "BUNDLE_POLICY_REQUIRED"
  | "CONTENT_PATH_FORBIDDEN"
  | "APPROVAL_HASH_MISMATCH"
  | "BASE_SHA_MISMATCH"
  | "HEAD_SHA_MISMATCH"
  | "REQUIRED_CHECKS_FAILED"
  | "REMOTE_HEAD_MISMATCH"
  | "REMOTE_STATE_INVALID";

export class PublisherGuardError extends Error {
  constructor(
    readonly code: PublisherGuardCode,
    message: string
  ) {
    super(message);
    this.name = "PublisherGuardError";
  }
}

export interface PublicationFile {
  path: string;
  content: string | Uint8Array;
}

export interface PublisherConnectorConfigInput {
  github: { repository: string; baseBranch: string; [key: string]: unknown };
  /** Generic site/hosting names are the only active contract. */
  site: { siteOrigin: string; contentRoot: string; adapterId?: string; [key: string]: unknown };
  hosting?: { host: string; releaseRoot: string; [key: string]: unknown };
}

export interface PublisherConnectorConfig {
  github: { repository: string; baseBranch: string };
  site: { siteOrigin: string; contentRoot: string; adapterId?: string };
  hosting?: { host: string; releaseRoot: string };
}

export type ConnectorConfigErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_REPOSITORY"
  | "INVALID_BRANCH"
  | "INVALID_SITE_ORIGIN"
  | "INVALID_PATH"
  | "INVALID_HOST"
  | "CREDENTIALS_NOT_ALLOWED";

export class ConnectorConfigError extends Error {
  constructor(readonly code: ConnectorConfigErrorCode, message: string) {
    super(message);
    this.name = "ConnectorConfigError";
  }
}

const credentialKeys = /(?:token|secret|password|private.?key|credential|auth)/iu;

function requiredConfigString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new ConnectorConfigError("INVALID_CONFIG", `${field} must be non-empty text`);
  }
  return value.trim();
}

function assertNoCredentials(value: Record<string, unknown>, connector: string): void {
  for (const key of Object.keys(value)) {
    if (credentialKeys.test(key)) {
      throw new ConnectorConfigError("CREDENTIALS_NOT_ALLOWED", `${connector}.${key} is not accepted; credentials stay outside the adapter`);
    }
  }
}

function absolutePosixPath(value: unknown, field: string): string {
  const path = requiredConfigString(value, field);
  if (!path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "..")) {
    throw new ConnectorConfigError("INVALID_PATH", `${field} must be an absolute POSIX path without traversal`);
  }
  return path.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
}

function absoluteLocalOrPosixPath(value: unknown, field: string): string {
  const path = requiredConfigString(value, field);
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(path);
  if (isWindowsAbsolute) {
    if (path.includes("\0") || path.split(/[\\/]+/u).some((part) => part === "..")) {
      throw new ConnectorConfigError("INVALID_PATH", `${field} must not contain traversal`);
    }
    return path.replace(/[\\/]+$/u, "");
  }
  return absolutePosixPath(path, field);
}

export function validatePublisherConnectorConfig(input: PublisherConnectorConfigInput): PublisherConnectorConfig {
  if (typeof input !== "object" || input === null) {
    throw new ConnectorConfigError("INVALID_CONFIG", "connector config must be an object");
  }
  const github = input.github;
  const genericSite = input.site;
  const genericHosting = input.hosting;
  if (!github || !genericSite) {
    throw new ConnectorConfigError("INVALID_CONFIG", "github and site connectors are required");
  }
  {
    assertNoCredentials(github, "github");
    assertNoCredentials(genericSite, "site");
    if (genericHosting) assertNoCredentials(genericHosting, "hosting");
    const repository = requiredConfigString(github.repository, "github.repository");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new ConnectorConfigError("INVALID_REPOSITORY", "github.repository must be owner/name");
    }
    const baseBranch = requiredConfigString(github.baseBranch, "github.baseBranch");
    if (!/^[A-Za-z0-9._/-]+$/u.test(baseBranch) || baseBranch.startsWith("/") || baseBranch.includes("..")) {
      throw new ConnectorConfigError("INVALID_BRANCH", "github.baseBranch is unsafe");
    }
    const siteOrigin = typeof genericSite.siteOrigin === "string" ? genericSite.siteOrigin.trim().replace(/\/$/u, "") : "";
    if (siteOrigin) {
      let parsedOrigin: URL;
      try { parsedOrigin = new URL(siteOrigin); } catch { throw new ConnectorConfigError("INVALID_SITE_ORIGIN", "site.siteOrigin must be a valid HTTPS URL"); }
      if (parsedOrigin.protocol !== "https:" || parsedOrigin.username || parsedOrigin.password) {
        throw new ConnectorConfigError("INVALID_SITE_ORIGIN", "site.siteOrigin must be an HTTPS URL without credentials");
      }
    }
    const contentRoot = absoluteLocalOrPosixPath(genericSite.contentRoot, "site.contentRoot");
    const result: PublisherConnectorConfig = {
      github: { repository, baseBranch },
      site: { siteOrigin, contentRoot, ...(genericSite.adapterId ? { adapterId: requiredConfigString(genericSite.adapterId, "site.adapterId") } : {}) }
    };
    if (genericHosting) {
      const host = requiredConfigString(genericHosting.host, "hosting.host");
      if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(host) || host.includes("..")) {
        throw new ConnectorConfigError("INVALID_HOST", "hosting.host must be a DNS host name");
      }
      result.hosting = { host, releaseRoot: absolutePosixPath(genericHosting.releaseRoot, "hosting.releaseRoot") };
    }
    return result;
  }
}

export interface PublisherDryRunStep {
  connector: "github" | "site" | "hosting";
  action: "validate-bundle" | "create-pull-request" | "merge-after-checks" | "deploy-release-preview";
  target: string;
  writes: false;
}

export interface PublisherDryRunPlan {
  mode: "dry-run";
  generatedAt: string;
  credentialsRequired: false;
  target: { repository: string; baseBranch: string; siteOrigin: string; host?: string };
  steps: PublisherDryRunStep[];
}

export function buildPublisherDryRunPlan(input: {
  command: ApprovedPublicationCommand;
  connectors: PublisherConnectorConfigInput;
  now: string;
}): PublisherDryRunPlan {
  const connectors = validatePublisherConnectorConfig(input.connectors);
  if (!input.command.bundlePolicy) {
    throw new PublisherGuardError("BUNDLE_POLICY_REQUIRED", "a generic site publication requires its adapter bundle policy");
  }
  assertApprovedBundle(input.command.files, input.command.approvedRevisionHash, input.command.revisionId, input.command.bundlePolicy);
  if (input.command.approvedRevisionHash !== input.command.currentRevisionHash) {
    throw new PublisherGuardError("APPROVAL_HASH_MISMATCH", "current revision no longer matches the approved hash");
  }
  const generatedAt = requiredConfigString(input.now, "now");
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs) || new Date(generatedAtMs).toISOString() !== generatedAt) {
    throw new ConnectorConfigError("INVALID_CONFIG", "now must be an exact UTC ISO timestamp");
  }
  const site = connectors.site;
  return {
    mode: "dry-run",
    generatedAt,
    credentialsRequired: false,
    target: { repository: connectors.github.repository, baseBranch: connectors.github.baseBranch, siteOrigin: site.siteOrigin, ...(connectors.hosting ? { host: connectors.hosting.host } : {}) },
    steps: [
      { connector: "site", action: "validate-bundle", target: site.contentRoot, writes: false },
      { connector: "github", action: "create-pull-request", target: `${connectors.github.repository}:${connectors.github.baseBranch}`, writes: false },
      { connector: "github", action: "merge-after-checks", target: connectors.github.repository, writes: false },
      ...(connectors.hosting ? [{ connector: "hosting" as const, action: "deploy-release-preview" as const, target: `${connectors.hosting.host}:${connectors.hosting.releaseRoot}`, writes: false as const }] : [])
    ]
  };
}

export interface PullRequestState {
  number: number;
  headSha: string;
  merged: boolean;
  mergeSha?: string;
  requiredChecks: "PENDING" | "PASSED" | "FAILED";
}

export interface DeployIntent {
  key: string;
  revisionId: string;
  mergeSha: string;
}

export interface PublicationEffectsPort {
  findPullRequest(key: string): Promise<PullRequestState | null>;
  createPullRequest(input: {
    key: string;
    targetRepository: string;
    baseBranch: string;
    expectedBaseSha: string;
    expectedHeadSha: string;
    files: readonly PublicationFile[];
  }): Promise<PullRequestState>;
  mergePullRequest(input: {
    key: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
  }): Promise<PullRequestState>;
  findDeployIntent(key: string): Promise<DeployIntent | null>;
  createDeployIntent(input: {
    key: string;
    revisionId: string;
    mergeSha: string;
  }): Promise<DeployIntent>;
}

export interface ApprovedPublicationCommand {
  articleId: string;
  revisionId: string;
  approvedRevisionHash: string;
  currentRevisionHash: string;
  targetRepository: string;
  baseBranch: string;
  approvedBaseSha: string;
  currentBaseSha: string;
  approvedHeadSha: string;
  currentHeadSha: string;
  files: readonly PublicationFile[];
  /** Hash-bound adapter-provided path contract. */
  bundlePolicy: PublicationBundlePolicy;
}

export interface PublicationBundlePolicy {
  adapterId: string;
  manifestPath: string;
  allowedPathPrefixes: readonly string[];
  requiredLocalePrefixes?: readonly string[];
  requiredMediaPrefix?: string;
}

export interface ReconciledPublication {
  state: "READY_TO_DEPLOY";
  pullRequestKey: string;
  mergeKey: string;
  deployKey: string;
  pullRequest: PullRequestState;
  deployIntent: DeployIntent;
}

export interface WaitingPublicationChecks {
  state: "WAITING_FOR_CHECKS";
  pullRequestKey: string;
  mergeKey: string;
  deployKey: string;
  pullRequest: PullRequestState;
  deployIntent: null;
}

export type PublicationReconcileResult =
  | ReconciledPublication
  | WaitingPublicationChecks;

export function createPublicationEffectKey(
  effect: "pull-request" | "merge" | "deploy",
  articleId: string,
  revisionId: string,
  approvedRevisionHash: string,
  targetRepository = "",
  baseBranch = "",
  approvedBaseSha = ""
): string {
  const digest = createHash("sha256")
    .update(
      [
        effect,
        articleId,
        revisionId,
        approvedRevisionHash,
        targetRepository,
        baseBranch,
        approvedBaseSha
      ].join("\0")
    )
    .digest("hex");
  return `blogbot:${effect}:${digest}`;
}

export function assertAllowedContentPath(path: string, policy: PublicationBundlePolicy): void {
  if (typeof path !== "string") {
    throw new PublisherGuardError("CONTENT_PATH_FORBIDDEN", "publisher cannot modify a non-text path");
  }
  const segments = path.split("/");
  // Keep the publisher's path contract strict even for user-supplied
  // generic adapters. Empty segments and a trailing slash can otherwise be
  // normalized differently by Git, Node, and the local materializer (and can
  // turn a supposed file entry into a directory target).
  const policyPathAllowed = policy.allowedPathPrefixes.some((prefix) =>
    // The engine derives this list from the hash-bound generated file set.
    // A single exact file is therefore a valid allow-list entry; a trailing
    // slash remains the only form that grants a directory subtree.
    path === prefix || (prefix.endsWith("/") && path.startsWith(prefix) && path.length > prefix.length)
  );
  if (
    path.length === 0 ||
    path.length > 4_096 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    !policyPathAllowed
  ) {
    throw new PublisherGuardError(
      "CONTENT_PATH_FORBIDDEN",
      `publisher cannot modify path: ${path}`
    );
  }
}

function fileDigest(content: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");
}

function assertApprovedBundle(
  files: readonly PublicationFile[],
  approvedHash: string,
  expectedRevisionId?: string,
  bundlePolicy?: PublicationBundlePolicy
): void {
  if (!bundlePolicy) {
    throw new PublisherGuardError("BUNDLE_POLICY_REQUIRED", "publication requires an adapter bundle policy");
  }
  if (files.length === 0) {
    throw new PublisherGuardError("BUNDLE_EMPTY", "approved bundle cannot be empty");
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new PublisherGuardError("BUNDLE_DUPLICATE_PATH", `duplicate bundle path: ${file.path}`);
    }
    seen.add(file.path);
    assertAllowedContentPath(file.path, bundlePolicy);
  }
  const manifestFiles = files.filter((file) => file.path === bundlePolicy.manifestPath || file.path.startsWith(bundlePolicy.manifestPath));
  const requiredLocalePrefixes = bundlePolicy.requiredLocalePrefixes ?? [];
  const hasRequiredLocales = requiredLocalePrefixes.every((prefix) => files.some((file) => file.path.startsWith(prefix)));
  const requiredMediaPrefix = bundlePolicy.requiredMediaPrefix;
  const hasMedia = !requiredMediaPrefix || files.some((file) => file.path.startsWith(requiredMediaPrefix));
  if (manifestFiles.length !== 1 || !hasRequiredLocales || !hasMedia) {
    throw new PublisherGuardError("BUNDLE_FILE_SET_MISMATCH", "bundle does not satisfy the selected site adapter file contract");
  }
  const manifestFile = manifestFiles[0]!;
  if (typeof manifestFile.content !== "string") {
    throw new PublisherGuardError("BUNDLE_MANIFEST_MISMATCH", "bundle manifest must be UTF-8 JSON");
  }
  let manifest;
  try {
    manifest = parseSiteArtifactManifest(manifestFile.content);
  } catch {
    throw new PublisherGuardError("BUNDLE_MANIFEST_MISMATCH", "bundle manifest is invalid");
  }
  if (manifest.revisionHash !== approvedHash) {
    throw new PublisherGuardError("BUNDLE_MANIFEST_MISMATCH", "bundle manifest hash differs from the approval");
  }
  if (expectedRevisionId !== undefined && manifest.revisionId !== expectedRevisionId) {
    throw new PublisherGuardError(
      "BUNDLE_MANIFEST_MISMATCH",
      "bundle manifest revision differs from the approved revision"
    );
  }
  const listed = new Set(manifest.entries.map((entry) => entry.path));
  if (listed.size !== manifest.entries.length || listed.size !== files.length - 1) {
    throw new PublisherGuardError("BUNDLE_FILE_SET_MISMATCH", "manifest file set does not match bundle files");
  }
  for (const entry of manifest.entries) {
    const file = files.find((candidate) => candidate.path === entry.path);
    if (!file) {
      throw new PublisherGuardError("BUNDLE_FILE_SET_MISMATCH", `manifest file is missing: ${entry.path}`);
    }
    const byteLength = typeof file.content === "string" ? Buffer.byteLength(file.content, "utf8") : file.content.byteLength;
    if (entry.bytes !== byteLength || entry.sha256 !== fileDigest(file.content)) {
      throw new PublisherGuardError("BUNDLE_FILE_TAMPERED", `bundle file differs from manifest: ${entry.path}`);
    }
  }
}

export async function reconcileApprovedPublication(
  command: ApprovedPublicationCommand,
  effects: PublicationEffectsPort
): Promise<PublicationReconcileResult> {
  assertApprovedBundle(
    command.files,
    command.approvedRevisionHash,
    command.revisionId,
    command.bundlePolicy
  );
  if (command.approvedRevisionHash !== command.currentRevisionHash) {
    throw new PublisherGuardError(
      "APPROVAL_HASH_MISMATCH",
      "current revision no longer matches the approved hash"
    );
  }
  if (command.approvedBaseSha !== command.currentBaseSha) {
    throw new PublisherGuardError(
      "BASE_SHA_MISMATCH",
      "target repository base no longer matches the approved SHA"
    );
  }
  if (command.approvedHeadSha !== command.currentHeadSha) {
    throw new PublisherGuardError(
      "HEAD_SHA_MISMATCH",
      "current PR head no longer matches the approved SHA"
    );
  }

  const identity = [
    command.articleId,
    command.revisionId,
    command.approvedRevisionHash,
    command.targetRepository,
    command.baseBranch,
    command.approvedBaseSha
  ] as const;
  const pullRequestKey = createPublicationEffectKey("pull-request", ...identity);
  const mergeKey = createPublicationEffectKey("merge", ...identity);
  const deployKey = createPublicationEffectKey("deploy", ...identity);

  let pullRequest = await effects.findPullRequest(pullRequestKey);
  if (pullRequest === null) {
    pullRequest = await effects.createPullRequest({
      key: pullRequestKey,
      targetRepository: command.targetRepository,
      baseBranch: command.baseBranch,
      expectedBaseSha: command.approvedBaseSha,
      expectedHeadSha: command.approvedHeadSha,
      files: command.files
    });
  }

  if (pullRequest.requiredChecks === "FAILED") {
    throw new PublisherGuardError(
      "REQUIRED_CHECKS_FAILED",
      "required checks failed for the approved pull request"
    );
  }
  if (pullRequest.requiredChecks === "PENDING") {
    return {
      state: "WAITING_FOR_CHECKS",
      pullRequestKey,
      mergeKey,
      deployKey,
      pullRequest,
      deployIntent: null
    };
  }
  // A first publication has no PR head yet. The effects implementation binds
  // the newly-created PR SHA here; subsequent retries must use the immutable
  // approved head and therefore still fail closed on any mismatch.
  const approvedHeadSha = command.approvedHeadSha || pullRequest.headSha;
  if (pullRequest.headSha !== approvedHeadSha) {
    throw new PublisherGuardError(
      "REMOTE_HEAD_MISMATCH",
      "remote PR head no longer matches the approved SHA"
    );
  }

  if (!pullRequest.merged) {
    pullRequest = await effects.mergePullRequest({
      key: mergeKey,
      pullRequestNumber: pullRequest.number,
      expectedHeadSha: approvedHeadSha
    });
  }
  if (
    pullRequest.headSha !== approvedHeadSha ||
    !pullRequest.merged ||
    !pullRequest.mergeSha
  ) {
    throw new PublisherGuardError(
      "REMOTE_STATE_INVALID",
      "remote merge state is incomplete or no longer approved"
    );
  }

  let deployIntent = await effects.findDeployIntent(deployKey);
  if (deployIntent === null) {
    deployIntent = await effects.createDeployIntent({
      key: deployKey,
      revisionId: command.revisionId,
      mergeSha: pullRequest.mergeSha
    });
  }
  if (
    deployIntent.revisionId !== command.revisionId ||
    deployIntent.mergeSha !== pullRequest.mergeSha
  ) {
    throw new PublisherGuardError(
      "REMOTE_STATE_INVALID",
      "existing deploy intent does not match the approved merge"
    );
  }

  return {
    state: "READY_TO_DEPLOY",
    pullRequestKey,
    mergeKey,
    deployKey,
    pullRequest,
    deployIntent
  };
}

// GitHub connector/device-flow and no-write intent primitives live alongside the
// publication guards so callers can consume one publisher package surface.
export {
  advancePublisherIntent,
  buildGitHubPublisherDryRun,
  createGitHubConnector,
  createPublisherIntent,
  evaluateGitHubConnectorState
} from "./github-connector.ts";
export type {
  GitHubAuthSnapshot,
  GitHubConnectorAssessment,
  GitHubConnectorState,
  GitHubDeviceFlowPort,
  GitHubWizardConfig,
  PublisherIntent
} from "./github-connector.ts";
export {
  createConnectorAwarePublicationProcessor
} from "./runtime.ts";
export { GitHubPublicationEffects } from "./github-effects.ts";
export type { GitHubEffectsStore, GitHubPublicationConfig } from "./github-effects.ts";
export type {
  PublicationConnectorState,
  PublicationRuntimeConnector,
  PublicationRuntimeOptions,
  PublicationRuntimeResolver,
  PublicationRuntimeResult
} from "./runtime.ts";
