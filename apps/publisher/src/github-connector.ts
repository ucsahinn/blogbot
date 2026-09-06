import { createHash } from "node:crypto";
import { isSafeGitHubWorkflowName } from "../../../packages/contracts/src/github-policy.ts";

export type GitHubWizardConfig = {
  owner: string;
  repository: string;
  workflow: string;
};

export type GitHubAuthSnapshot =
  | { status: "logged-out" }
  | {
      status: "authorized";
      repository: string;
      permissions: readonly string[];
    }
  | { status: "degraded"; reason?: string };

export type GitHubConnectorState = "LOGIN_REQUIRED" | "READY" | "DEGRADED";
export type GitHubConnectorAssessment = {
  state: GitHubConnectorState;
  repository: string;
  workflow: string;
  requiredPermissions: readonly string[];
  reason?: string;
};

export const requiredGitHubAppPermissions = [
  "actions:write",
  "administration:read",
  "checks:read",
  "contents:write",
  "metadata:read",
  "pull_requests:write"
] as const;
const ownerSegment = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const repositorySegment = /^[A-Za-z0-9_.-]{1,100}$/u;
const branchName = /^[A-Za-z0-9._/-]{1,200}$/u;

export function isSafeGitHubRepositoryName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repository] = parts;
  return Boolean(
    owner &&
    repository &&
    ownerSegment.test(owner) &&
    repositorySegment.test(repository) &&
    repository !== "." &&
    repository !== ".."
  );
}

export function isSafeGitHubBranchName(value: unknown): value is string {
  return typeof value === "string"
    && branchName.test(value)
    && !value.startsWith("-")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("//")
    && !value.includes("..")
    && value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function validateConfig(config: GitHubWizardConfig): GitHubWizardConfig {
  if (
    !config ||
    typeof config !== "object" ||
    typeof config.owner !== "string" ||
    typeof config.repository !== "string" ||
    !isSafeGitHubRepositoryName(`${config.owner}/${config.repository}`)
  ) {
    throw new Error("GitHub owner and repository must be safe names");
  }
  if (!isSafeGitHubWorkflowName(config.workflow)) {
    throw new Error("GitHub workflow must be a safe YAML filename");
  }
  return { owner: config.owner, repository: config.repository, workflow: config.workflow };
}

export function evaluateGitHubConnectorState(config: GitHubWizardConfig, auth: GitHubAuthSnapshot): GitHubConnectorAssessment {
  const valid = validateConfig(config);
  const base = {
    repository: `${valid.owner}/${valid.repository}`,
    workflow: valid.workflow,
    requiredPermissions: requiredGitHubAppPermissions
  };
  if (auth.status === "logged-out") return { ...base, state: "LOGIN_REQUIRED" };
  if (auth.status === "degraded") return { ...base, state: "DEGRADED", reason: auth.reason ?? "GitHub authorization is unavailable" };
  const granted = new Set(auth.permissions);
  const exactPermissions = granted.size === requiredGitHubAppPermissions.length
    && requiredGitHubAppPermissions.every((permission) => granted.has(permission));
  if (auth.repository.toLowerCase() !== base.repository.toLowerCase()) {
    return { ...base, state: "DEGRADED", reason: "GitHub App authorization is bound to a different repository" };
  }
  return exactPermissions
    ? { ...base, state: "READY" }
    : { ...base, state: "DEGRADED", reason: "GitHub App repository permissions are not exactly least-privileged" };
}

export interface GitHubDeviceFlowPort {
  begin(): Promise<{ userCode: string; verificationUri: string; expiresIn: number; interval: number }>;
  poll(): Promise<GitHubAuthSnapshot>;
}

function validateDeviceFlowResponse(response: Awaited<ReturnType<GitHubDeviceFlowPort["begin"]>>) {
  // The device code must be entered only at GitHub's documented endpoint.
  // Exact matching also excludes alternate ports, query strings, and fragments.
  if (response.verificationUri !== "https://github.com/login/device") {
    throw new Error("GitHub device flow returned an invalid verification URL");
  }
  if (!response.userCode.trim() ||
      !Number.isInteger(response.expiresIn) || response.expiresIn < 60 || response.expiresIn > 1_800 ||
      !Number.isInteger(response.interval) || response.interval < 1 || response.interval > 60) {
    throw new Error("GitHub device flow returned invalid expiry, polling, or user-code data");
  }
  return response;
}

export function createGitHubConnector(config: GitHubWizardConfig, flow: GitHubDeviceFlowPort) {
  const validated = validateConfig(config);
  return {
    config: validated,
    beginDeviceFlow: async () => validateDeviceFlowResponse(await flow.begin()),
    async pollDeviceFlow() {
      return evaluateGitHubConnectorState(validated, await flow.poll());
    }
  };
}

export type PublisherIntent = {
  key: string;
  repository: string;
  workflow: string;
  revisionId: string;
  revisionHash: string;
  state: "PENDING" | "READY" | "DEGRADED";
};

export function createPublisherIntent(input: Omit<PublisherIntent, "key" | "state">): PublisherIntent {
  const repository = input.repository.trim();
  if (!isSafeGitHubRepositoryName(repository) || !input.revisionId || !/^[a-f0-9]{64}$/u.test(input.revisionHash)) {
    throw new Error("publisher intent scope is invalid");
  }
  const key = createHash("sha256").update([repository, input.workflow, input.revisionId, input.revisionHash].join("\0")).digest("hex");
  return { ...input, repository, key: `blogbot:github-intent:${key}`, state: "PENDING" };
}

/** Pure intent transition; it records readiness without invoking GitHub or mutating remote state. */
export function advancePublisherIntent(intent: PublisherIntent, assessment: GitHubConnectorAssessment): PublisherIntent {
  if (assessment.repository !== intent.repository || assessment.workflow !== intent.workflow) {
    return { ...intent, state: "DEGRADED" };
  }
  return { ...intent, state: assessment.state === "READY" ? "READY" : assessment.state === "DEGRADED" ? "DEGRADED" : "PENDING" };
}

export function buildGitHubPublisherDryRun(input: { config: GitHubWizardConfig; intent: PublisherIntent; now: string }) {
  const assessment = evaluateGitHubConnectorState(input.config, { status: "logged-out" });
  if (assessment.repository !== input.intent.repository || assessment.workflow !== input.intent.workflow) throw new Error("publisher intent does not match GitHub wizard scope");
  if (new Date(input.now).toISOString() !== input.now) throw new Error("now must be an exact UTC ISO timestamp");
  return { mode: "dry-run" as const, writes: false as const, generatedAt: input.now, repository: assessment.repository, workflow: assessment.workflow, steps: ["validate-github-app-permissions", "preview-workflow", "record-publisher-intent"] as const };
}
