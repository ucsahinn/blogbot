import { createHash } from "node:crypto";

export type GitHubWizardConfig = {
  owner: string;
  repository: string;
  workflow: string;
};

export type GitHubAuthSnapshot =
  | { status: "logged-out" }
  | { status: "authorized"; scopes: readonly string[] }
  | { status: "degraded"; reason?: string };

export type GitHubConnectorState = "LOGIN_REQUIRED" | "READY" | "DEGRADED";
export type GitHubConnectorAssessment = {
  state: GitHubConnectorState;
  repository: string;
  workflow: string;
  requiredScopes: readonly string[];
  reason?: string;
};

// The publisher reads/writes repository contents, PRs and checks. It never
// edits workflow files or dispatches arbitrary workflows, so the sensitive
// `workflow` OAuth scope is intentionally not requested.
const requiredScopes = ["repo"] as const;
const segment = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;

function validateConfig(config: GitHubWizardConfig): GitHubWizardConfig {
  if (!config || typeof config !== "object" || !segment.test(config.owner) || !segment.test(config.repository)) {
    throw new Error("GitHub owner and repository must be safe names");
  }
  if (!/^[A-Za-z0-9_.-]+\.(?:ya?ml)$/u.test(config.workflow) || config.workflow.includes("..")) {
    throw new Error("GitHub workflow must be a safe YAML filename");
  }
  return { owner: config.owner, repository: config.repository, workflow: config.workflow };
}

export function evaluateGitHubConnectorState(config: GitHubWizardConfig, auth: GitHubAuthSnapshot): GitHubConnectorAssessment {
  const valid = validateConfig(config);
  const base = { repository: `${valid.owner}/${valid.repository}`, workflow: valid.workflow, requiredScopes };
  if (auth.status === "logged-out") return { ...base, state: "LOGIN_REQUIRED" };
  if (auth.status === "degraded") return { ...base, state: "DEGRADED", reason: auth.reason ?? "GitHub authorization is unavailable" };
  const scopes = new Set(auth.scopes);
  const missing = requiredScopes.filter((scope) => !scopes.has(scope));
  return missing.length ? { ...base, state: "DEGRADED", reason: `Missing GitHub scopes: ${missing.join(", ")}` } : { ...base, state: "READY" };
}

export interface GitHubDeviceFlowPort {
  begin(): Promise<{ userCode: string; verificationUri: string; expiresIn: number; interval: number }>;
  poll(): Promise<GitHubAuthSnapshot>;
}

function validateDeviceFlowResponse(response: Awaited<ReturnType<GitHubDeviceFlowPort["begin"]>>) {
  let verificationUri: URL;
  try {
    verificationUri = new URL(response.verificationUri);
  } catch {
    throw new Error("GitHub device flow returned an invalid verification URL");
  }
  // Device-flow UX must never redirect a user to an untrusted origin.
  if (verificationUri.protocol !== "https:" || verificationUri.hostname !== "github.com") {
    throw new Error("GitHub device flow verification URL must use https://github.com");
  }
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(verificationUri.pathname) ||
      !response.userCode.trim() ||
      !Number.isInteger(response.expiresIn) || response.expiresIn < 60 || response.expiresIn > 1_800 ||
      !Number.isInteger(response.interval) || response.interval < 1 || response.interval > 60) {
    throw new Error("GitHub device flow returned invalid expiry, polling, or user-code data");
  }
  return { ...response, verificationUri: verificationUri.toString() };
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
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/u.test(repository) || !input.revisionId || !/^[a-f0-9]{64}$/u.test(input.revisionHash)) {
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
  return { mode: "dry-run" as const, writes: false as const, generatedAt: input.now, repository: assessment.repository, workflow: assessment.workflow, steps: ["validate-scope", "preview-workflow", "record-publisher-intent"] as const };
}
