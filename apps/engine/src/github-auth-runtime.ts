import type { BackendRepository } from "../../../packages/database/src/backend-repository.ts";
import { GitHubDeviceFlowClient, type GitHubFetchResponse, type GitHubTokenStore } from "../../publisher/src/github-http.ts";

type AuthClient = GitHubDeviceFlowClient & { getPollIntervalSeconds(): number };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Engine-owned GitHub device flow. The native layer never receives a token;
 * it only receives the verification URI, user code, and redacted status.
 */
export class GitHubAuthRuntime {
  private client: AuthClient | undefined;
  private flowActive = false;
  private readonly tokenStore: GitHubTokenStore;

  constructor(
    private readonly repository: BackendRepository,
    private readonly clientId = process.env.BLOGBOT_GITHUB_CLIENT_ID?.trim() ?? ""
  ) {
    this.tokenStore = {
      get: async () => {
        const value = await repository.getLocalState("connector.github.token");
        return typeof value === "object" && value !== null && typeof (value as { token?: unknown }).token === "string"
          ? (value as { token: string }).token
          : null;
      },
      set: async (token) => repository.setLocalState("connector.github.token", { token }),
      clear: async () => repository.setLocalState("connector.github.token", { token: null })
    };
  }

  private async configuredClientId(): Promise<string> {
    const configured = await this.repository.getLocalState("connector.github");
    const value = configured && typeof configured === "object" && typeof (configured as { clientId?: unknown }).clientId === "string"
      ? (configured as { clientId: string }).clientId.trim()
      : "";
    return value || this.clientId;
  }

  private async requireClient(): Promise<AuthClient> {
    const clientId = await this.configuredClientId();
    if (!clientId) throw new Error("GITHUB_CLIENT_ID_REQUIRED");
    if (this.client) return this.client;
    this.client = new GitHubDeviceFlowClient({
      clientId,
      tokenStore: this.tokenStore,
      fetcher: async (url, init) => fetch(url, init) as unknown as Promise<GitHubFetchResponse>
    });
    return this.client;
  }

  async begin(): Promise<Record<string, unknown>> {
    const result = await (await this.requireClient()).begin();
    this.flowActive = true;
    return { started: true, writes: false, network: true, ...result };
  }

  async poll(): Promise<Record<string, unknown>> {
    if (!this.flowActive) return this.status();
    const client = await this.requireClient();
    const result = await client.poll();
    if (result.status === "authorized" || result.status === "degraded") this.flowActive = false;
    return {
      writes: false,
      network: true,
      status: result.status,
      ...(result.status === "authorized" ? { scopes: result.scopes ?? [] } : {}),
      ...(result.status === "degraded" ? { detail: result.reason ?? "GitHub yetkilendirmesi doğrulanamadı." } : {}),
      pollIntervalSeconds: client.getPollIntervalSeconds()
    };
  }

  async status(): Promise<Record<string, unknown>> {
    if (!(await this.configuredClientId())) return { status: "unconfigured", writes: false, network: false, detail: "GitHub OAuth client ID yapılandırılmadı." };
    const token = await this.tokenStore.get();
    return token
      ? { status: "authorized", writes: false, network: false, scopes: ["repo"] }
      : { status: "logged-out", writes: false, network: false };
  }
}

export function isGitHubAuthRequest(value: unknown): value is Record<string, unknown> & { kind: string } {
  const item = record(value);
  return item.kind === "github.auth.begin" || item.kind === "github.auth.poll" || item.kind === "github.auth.status";
}
