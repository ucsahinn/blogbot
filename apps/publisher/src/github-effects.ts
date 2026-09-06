import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isSafeGitHubWorkflowName } from "../../../packages/contracts/src/github-policy.ts";
import { isSafeGitHubBranchName, isSafeGitHubRepositoryName } from "./github-connector.ts";
import { isEngineMediaReference } from "./publication.ts";
import type {
  DeployIntent,
  PublicationEffectsPort,
  PublicationFile,
  PullRequestState
} from "./publication.ts";

export interface GitHubPublicationConfig {
  token: string;
  repository: string;
  baseBranch: string;
  deployWorkflow?: string;
  /** Exact branch-protection check contexts that must pass before merge. */
  requiredChecks?: readonly string[];
}

export interface GitHubEffectsStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

type ResponseLike = { ok: boolean; status: number; json(): Promise<unknown>; headers: { get(name: string): string | null } };
type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: "manual";
  signal?: AbortSignal;
}) => Promise<ResponseLike>;

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertConfig(config: GitHubPublicationConfig): void {
  if (!config.token.trim() || !isSafeGitHubRepositoryName(config.repository) || !isSafeGitHubBranchName(config.baseBranch)) {
    throw new Error("GitHub publication connector configuration is invalid");
  }
  if (config.deployWorkflow && !isSafeGitHubWorkflowName(config.deployWorkflow)) {
    throw new Error("GitHub deploy workflow is invalid");
  }
  if (config.requiredChecks && (
    config.requiredChecks.length === 0 ||
    config.requiredChecks.some((name) => typeof name !== "string" || !name.trim() || name.length > 200) ||
    new Set(config.requiredChecks.map((name) => name.trim())).size !== config.requiredChecks.length
  )) {
    throw new Error("GitHub required check policy is invalid");
  }
}

function branchName(key: string): string {
  const normalized = key.replace(/[^A-Za-z0-9._/-]+/gu, "-").slice(0, 140);
  return `blogbot/${normalized}`;
}

function deployIntentId(input: { key: string; revisionId: string; mergeSha: string }): string {
  if (
    typeof input.key !== "string" || !input.key.trim() || input.key.length > 512 ||
    typeof input.revisionId !== "string" || !input.revisionId.trim() || input.revisionId.length > 256 ||
    !/^[a-f0-9]{40}$/iu.test(input.mergeSha)
  ) {
    throw new Error("GitHub deploy intent is invalid");
  }
  return createHash("sha256")
    .update([input.key, input.revisionId, input.mergeSha.toLowerCase()].join("\0"))
    .digest("hex");
}

function sha(value: unknown): string {
  const result = string(value);
  if (!result || !/^[a-f0-9]{7,64}$/iu.test(result)) throw new Error("GitHub response did not contain a valid SHA");
  return result;
}

type RequiredChecksState = "PENDING" | "PASSED" | "FAILED";

const successfulCheckConclusions = new Set(["success", "skipped", "neutral"]);
const failedCheckConclusions = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);

/**
 * Read both GitHub's legacy commit-status contexts and the Checks API. We do
 * not infer success from an empty response: a repository with no checks is
 * deliberately kept pending until its required workflow is configured.
 */
function aggregateRequiredChecks(statusBody: unknown, checksBody: unknown, requiredNames: readonly string[] | undefined): RequiredChecksState {
  if (!requiredNames?.length) return "PENDING";
  const required = new Set(requiredNames.map((name) => name.trim()));
  const statusesValue = object(statusBody).statuses;
  const checkRunsValue = object(checksBody).check_runs;
  const statuses: unknown[] = Array.isArray(statusesValue) ? statusesValue : [];
  const checkRuns: unknown[] = Array.isArray(checkRunsValue) ? checkRunsValue : [];
  const seen = new Set<string>();

  for (const item of statuses) {
    const itemObject = object(item);
    const name = string(itemObject.context);
    if (!name || !required.has(name)) continue;
    seen.add(name);
    const state = string(itemObject.state)?.toLowerCase();
    if (state === "failure" || state === "error") return "FAILED";
    if (state !== "success") return "PENDING";
  }
  for (const item of checkRuns) {
    const itemObject = object(item);
    const name = string(itemObject.name);
    if (!name || !required.has(name)) continue;
    seen.add(name);
    const status = string(itemObject.status)?.toLowerCase();
    const conclusion = string(itemObject.conclusion)?.toLowerCase();
    if (status !== "completed") return "PENDING";
    if (!conclusion || failedCheckConclusions.has(conclusion)) return "FAILED";
    if (!successfulCheckConclusions.has(conclusion)) return "PENDING";
  }
  return required.size === seen.size ? "PASSED" : "PENDING";
}

export class GitHubPublicationEffects implements PublicationEffectsPort {
  private readonly fetcher: FetchLike;
  private readonly config: GitHubPublicationConfig;
  private readonly store: GitHubEffectsStore | undefined;

  constructor(config: GitHubPublicationConfig, options: { fetcher?: FetchLike; store?: GitHubEffectsStore } = {}) {
    assertConfig(config);
    this.config = { ...config };
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init) as unknown as Promise<ResponseLike>);
    this.store = options.store;
  }

  private async request(path: string, method = "GET", body?: unknown): Promise<{ response: ResponseLike; body: unknown }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("GitHub publication request timed out"));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      let response: ResponseLike;
      try {
        response = await Promise.race([
          this.fetcher(`${API}${path}`, {
            method,
            headers: {
              accept: "application/vnd.github+json",
              "content-type": "application/json",
              "x-github-api-version": "2022-11-28",
              authorization: `Bearer ${this.config.token}`
            },
            redirect: "manual",
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
          }),
          deadline
        ]);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error("GitHub publication request timed out", { cause: error });
        }
        throw error;
      }
      // GitHub's workflow-dispatch endpoint deliberately returns 204 No
      // Content. Parsing it as JSON turns a successful dispatch into a local
      // transport failure before the intent can be persisted.
      if (response.status === 204) return { response, body: null };
      try {
        return {
          response,
          body: await Promise.race([response.json(), deadline])
        };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error("GitHub publication request timed out", { cause: error });
        }
        // Preserve an error response's status even when a proxy or gateway
        // supplies an empty/non-JSON body. Successful responses still require
        // valid JSON and therefore remain fail-closed.
        if (!response.ok) return { response, body: null };
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private path(suffix: string): string {
    return `/repos/${this.config.repository}${suffix}`;
  }

  private async requiredChecks(headSha: string): Promise<RequiredChecksState> {
    const [statusResult, checksResult] = await Promise.all([
      this.request(this.path(`/commits/${encodeURIComponent(headSha)}/status`)),
      this.request(this.path(`/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`))
    ]);
    if (!statusResult.response.ok) {
      throw new Error(`GitHub commit status lookup failed (${statusResult.response.status})`);
    }
    if (!checksResult.response.ok) {
      throw new Error(`GitHub check-runs lookup failed (${checksResult.response.status})`);
    }
    return aggregateRequiredChecks(statusResult.body, checksResult.body, this.config.requiredChecks);
  }

  /** Read-only snapshot used to bind a local approval to the current base. */
  async getBaseBranchSha(): Promise<string> {
    const { response, body } = await this.request(this.path(`/git/ref/heads/${encodeURIComponent(this.config.baseBranch)}`));
    if (!response.ok) throw new Error(`GitHub base branch lookup failed (${response.status})`);
    return sha(object(object(body).object).sha);
  }

  async findPullRequest(key: string): Promise<PullRequestState | null> {
    const head = encodeURIComponent(`${this.config.repository.split("/")[0]}:${branchName(key)}`);
    const { response, body } = await this.request(this.path(`/pulls?state=all&head=${head}&per_page=20`));
    if (!response.ok) throw new Error(`GitHub PR lookup failed (${response.status})`);
    const items = Array.isArray(body) ? body : [];
    const item = items.find((value) => branchName(key) === string(object(value).head && object(object(value).head).ref));
    if (!item) return null;
    const pullRequest = this.pullRequestState(item);
    return { ...pullRequest, requiredChecks: await this.requiredChecks(pullRequest.headSha) };
  }

  async createPullRequest(input: { key: string; targetRepository: string; baseBranch: string; expectedBaseSha: string; expectedHeadSha: string; files: readonly PublicationFile[] }): Promise<PullRequestState> {
    if (input.targetRepository !== this.config.repository || input.baseBranch !== this.config.baseBranch) throw new Error("GitHub publication target mismatch");
    const { response: refResponse, body: refBody } = await this.request(this.path(`/git/ref/heads/${encodeURIComponent(input.baseBranch)}`));
    if (!refResponse.ok) throw new Error(`GitHub base branch lookup failed (${refResponse.status})`);
    const baseSha = sha(object(object(refBody).object).sha);
    if (input.expectedBaseSha && input.expectedBaseSha !== baseSha) throw new Error("GitHub base branch changed after approval");
    const branch = branchName(input.key);
    const ref = await this.request(this.path("/git/refs"), "POST", { ref: `refs/heads/${branch}`, sha: baseSha });
    // A 422 is normally an existing branch, but it can also represent a
    // malformed ref or a prior partial write. Treating it as success lets a
    // retry silently append files to an unknown branch. The durable outbox
    // remains retryable, while the operator can inspect or remove the branch.
    if (!ref.response.ok) {
      if (ref.response.status === 422) {
        throw new Error("GitHub publication branch already exists; refusing to continue an unverified partial publication");
      }
      throw new Error(`GitHub branch creation failed (${ref.response.status})`);
    }
    for (const file of input.files) {
      if (!file.path || file.path.includes("..") || file.path.startsWith("/")) throw new Error("unsafe publication path");
      if (isEngineMediaReference(file.content)) {
        throw new Error("engine media reference must be materialized before GitHub publication");
      }
      const encoded = typeof file.content === "string" ? Buffer.from(file.content, "utf8").toString("base64") : Buffer.from(file.content).toString("base64");
      const current = await this.request(this.path(`/contents/${file.path}?ref=${encodeURIComponent(branch)}`));
      const existingSha = current.response.ok ? string(object(current.body).sha) ?? undefined : undefined;
      const result = await this.request(this.path(`/contents/${file.path}`), "PUT", {
        message: `Blogbot publication ${input.key}`,
        content: encoded,
        branch,
        ...(existingSha ? { sha: existingSha } : {})
      });
      if (!result.response.ok) throw new Error(`GitHub content write failed (${result.response.status})`);
    }
    const created = await this.request(this.path("/pulls"), "POST", {
      title: `Blogbot publication ${input.key}`,
      head: branch,
      base: input.baseBranch,
      body: "Created by Blogbot from an immutable, human-approved revision."
    });
    if (!created.response.ok) throw new Error(`GitHub PR creation failed (${created.response.status})`);
    return this.pullRequestState(created.body);
  }

  async mergePullRequest(input: { key: string; pullRequestNumber: number; expectedHeadSha: string }): Promise<PullRequestState> {
    const current = await this.request(this.path(`/pulls/${input.pullRequestNumber}`));
    if (!current.response.ok) throw new Error(`GitHub PR lookup failed (${current.response.status})`);
    const currentHead = sha(object(object(current.body).head).sha);
    if (input.expectedHeadSha && currentHead !== input.expectedHeadSha) throw new Error("GitHub PR head changed after approval");
    const requiredChecks = await this.requiredChecks(currentHead);
    if (requiredChecks !== "PASSED") {
      throw new Error(requiredChecks === "FAILED" ? "GitHub required checks failed" : "GitHub required checks are still pending");
    }
    const merged = await this.request(this.path(`/pulls/${input.pullRequestNumber}/merge`), "PUT", { merge_method: "squash", sha: currentHead });
    if (!merged.response.ok) throw new Error(`GitHub PR merge failed (${merged.response.status})`);
    const mergeSha = sha(object(merged.body).sha);
    return { number: input.pullRequestNumber, headSha: currentHead, merged: true, mergeSha, requiredChecks };
  }

  async findDeployIntent(key: string): Promise<DeployIntent | null> {
    const value = await this.store?.get(`github.deploy:${key}`);
    return value && typeof value === "object" ? value as DeployIntent : null;
  }

  private async readDeployMarker(branch: string): Promise<string | null> {
    const marker = await this.request(this.path(`/git/ref/heads/${branch}`));
    if (marker.response.status === 404) return null;
    if (!marker.response.ok) throw new Error(`GitHub deploy marker lookup failed (${marker.response.status})`);
    return sha(object(object(marker.body).object).sha).toLowerCase();
  }

  private async ensureDeployMarker(branch: string, mergeSha: string): Promise<void> {
    const existing = await this.readDeployMarker(branch);
    if (existing !== null) {
      if (existing !== mergeSha.toLowerCase()) throw new Error("GitHub deploy marker points at a different merge SHA");
      return;
    }
    const created = await this.request(this.path("/git/refs"), "POST", { ref: `refs/heads/${branch}`, sha: mergeSha.toLowerCase() });
    if (created.response.ok) return;
    if (created.response.status === 422) {
      const raced = await this.readDeployMarker(branch);
      if (raced === mergeSha.toLowerCase()) return;
    }
    throw new Error(`GitHub deploy marker creation failed (${created.response.status})`);
  }

  private async matchingDeployRunExists(intentBranch: string, mergeSha: string): Promise<boolean> {
    const runs = await this.request(this.path(`/actions/runs?event=workflow_dispatch&head_sha=${encodeURIComponent(mergeSha)}&per_page=100`));
    if (!runs.response.ok) throw new Error(`GitHub deployment run lookup failed (${runs.response.status})`);
    const values = object(runs.body).workflow_runs;
    return Array.isArray(values) && values.some((value) => {
      const run = object(value);
      return string(run.head_branch) === intentBranch && string(run.head_sha)?.toLowerCase() === mergeSha.toLowerCase();
    });
  }

  async createDeployIntent(input: { key: string; revisionId: string; mergeSha: string }): Promise<DeployIntent> {
    if (!this.config.deployWorkflow) throw new Error("hosting workflow is not configured");
    const intentKey = deployIntentId(input);
    const intentBranch = `blogbot/deploy-intents/${intentKey}`;
    const dispatchedBranch = `blogbot/deploy-dispatched/${intentKey}`;
    await this.ensureDeployMarker(intentBranch, input.mergeSha);
    const alreadyMarked = await this.readDeployMarker(dispatchedBranch);
    if (alreadyMarked !== null && alreadyMarked !== input.mergeSha.toLowerCase()) throw new Error("GitHub dispatched marker points at a different merge SHA");
    if (alreadyMarked === null) {
      const alreadyRunning = await this.matchingDeployRunExists(intentBranch, input.mergeSha);
      if (!alreadyRunning) {
        const dispatched = await this.request(
          this.path(`/actions/workflows/${encodeURIComponent(this.config.deployWorkflow)}/dispatches`),
          "POST",
          { ref: intentBranch, inputs: { intent_key: intentKey, merge_sha: input.mergeSha.toLowerCase() } }
        );
        if (!dispatched.response.ok) throw new Error(`GitHub deployment workflow dispatch failed (${dispatched.response.status})`);
      }
      await this.ensureDeployMarker(dispatchedBranch, input.mergeSha);
    }
    const intent = { key: input.key, revisionId: input.revisionId, mergeSha: input.mergeSha };
    await this.store?.set(`github.deploy:${input.key}`, intent);
    return intent;
  }

  private pullRequestState(value: unknown): PullRequestState {
    const item = object(value);
    return {
      number: Number(item.number),
      headSha: sha(object(item.head).sha),
      merged: Boolean(item.merged_at),
      ...(string(item.merge_commit_sha) ? { mergeSha: string(item.merge_commit_sha)! } : {}),
      requiredChecks: "PENDING"
    };
  }
}
