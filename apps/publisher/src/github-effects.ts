import { Buffer } from "node:buffer";
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
}

export interface GitHubEffectsStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

type ResponseLike = { ok: boolean; status: number; json(): Promise<unknown>; headers: { get(name: string): string | null } };
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<ResponseLike>;

const API = "https://api.github.com";
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,200}$/u;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertConfig(config: GitHubPublicationConfig): void {
  if (!config.token.trim() || !SAFE_REPOSITORY.test(config.repository) || !SAFE_BRANCH.test(config.baseBranch)) {
    throw new Error("GitHub publication connector configuration is invalid");
  }
  if (config.deployWorkflow && !/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(config.deployWorkflow)) {
    throw new Error("GitHub deploy workflow is invalid");
  }
}

function branchName(key: string): string {
  const normalized = key.replace(/[^A-Za-z0-9._/-]+/gu, "-").slice(0, 140);
  return `blogbot/${normalized}`;
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
function aggregateRequiredChecks(statusBody: unknown, checksBody: unknown): RequiredChecksState {
  const statusesValue = object(statusBody).statuses;
  const checkRunsValue = object(checksBody).check_runs;
  const statuses: unknown[] = Array.isArray(statusesValue) ? statusesValue : [];
  const checkRuns: unknown[] = Array.isArray(checkRunsValue) ? checkRunsValue : [];
  if (statuses.length === 0 && checkRuns.length === 0) return "PENDING";

  for (const item of statuses) {
    const state = string(object(item).state)?.toLowerCase();
    if (state === "failure" || state === "error") return "FAILED";
    if (state !== "success") return "PENDING";
  }
  for (const item of checkRuns) {
    const itemObject = object(item);
    const status = string(itemObject.status)?.toLowerCase();
    const conclusion = string(itemObject.conclusion)?.toLowerCase();
    if (status !== "completed") return "PENDING";
    if (!conclusion || failedCheckConclusions.has(conclusion)) return "FAILED";
    if (!successfulCheckConclusions.has(conclusion)) return "PENDING";
  }
  return "PASSED";
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
    const response = await this.fetcher(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${this.config.token}`
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const parsed = await response.json();
    return { response, body: parsed };
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
    return aggregateRequiredChecks(statusResult.body, checksResult.body);
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
    if (!ref.response.ok && ref.response.status !== 422) throw new Error(`GitHub branch creation failed (${ref.response.status})`);
    for (const file of input.files) {
      if (!file.path || file.path.includes("..") || file.path.startsWith("/")) throw new Error("unsafe publication path");
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

  async createDeployIntent(input: { key: string; revisionId: string; mergeSha: string }): Promise<DeployIntent> {
    if (!this.config.deployWorkflow) throw new Error("hosting workflow is not configured");
    const dispatched = await this.request(this.path(`/actions/workflows/${encodeURIComponent(this.config.deployWorkflow)}/dispatches`), "POST", { ref: this.config.baseBranch, inputs: { release_id: input.key, merge_sha: input.mergeSha } });
    if (!dispatched.response.ok) throw new Error(`GitHub deployment workflow dispatch failed (${dispatched.response.status})`);
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
