import type {
  GitHubAuthSnapshot,
  GitHubDeviceFlowPort
} from "./github-connector.ts";

export interface GitHubTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface GitHubFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

export type GitHubFetch = (
  input: string,
  init: { method: "POST" | "GET"; headers?: Record<string, string>; body?: string }
) => Promise<GitHubFetchResponse>;

const DEVICE_ENDPOINT = "https://github.com/login/device/code";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const API_ENDPOINT = "https://api.github.com/user";
const FETCH_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

/** Real GitHub device-flow transport. Tokens are handed to the caller's
 * protected store and never appear in the returned assessment or errors. */
export class GitHubDeviceFlowClient implements GitHubDeviceFlowPort {
  private readonly fetcher: GitHubFetch;
  private readonly clientId: string;
  private readonly tokenStore: GitHubTokenStore;
  private deviceCode: string | null = null;
  private pollIntervalSeconds = 5;
  private expiresAt = 0;

  constructor(input: {
    clientId: string;
    tokenStore: GitHubTokenStore;
    fetcher?: GitHubFetch;
  }) {
    if (!/^[A-Za-z0-9_-]{8,200}$/u.test(input.clientId)) {
      throw new Error("GitHub OAuth client id is invalid");
    }
    this.clientId = input.clientId;
    this.tokenStore = input.tokenStore;
    this.fetcher = input.fetcher ?? ((url, init) => fetch(url, init) as unknown as Promise<GitHubFetchResponse>);
  }

  private async request(url: string, init: { method: "POST" | "GET"; headers?: Record<string, string>; body?: string }): Promise<GitHubFetchResponse> {
    return await Promise.race([
      this.fetcher(url, init),
      new Promise<GitHubFetchResponse>((_, reject) => setTimeout(() => reject(new Error("GitHub request timed out")), FETCH_TIMEOUT_MS))
    ]);
  }

  async begin() {
    const response = await this.request(DEVICE_ENDPOINT, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ client_id: this.clientId, scope: "repo" })
    });
    const body = record(await response.json());
    const userCode = nonEmptyString(body.user_code);
    const verificationUri = nonEmptyString(body.verification_uri);
    const deviceCode = nonEmptyString(body.device_code);
    const expiresIn = body.expires_in;
    const interval = body.interval;
    if (!response.ok || !userCode || !verificationUri || !deviceCode ||
      !Number.isInteger(expiresIn) || !Number.isInteger(interval)) {
      throw new Error("GitHub device authorization could not be started");
    }
    this.deviceCode = deviceCode;
    this.pollIntervalSeconds = Math.max(1, Number(interval));
    this.expiresAt = Date.now() + Number(expiresIn) * 1000;
    return { userCode, verificationUri, expiresIn: Number(expiresIn), interval: this.pollIntervalSeconds };
  }

  async poll(): Promise<GitHubAuthSnapshot> {
    if (!this.deviceCode || Date.now() >= this.expiresAt) {
      this.deviceCode = null;
      return { status: "degraded", reason: "GitHub device code expired" };
    }
    const response = await this.request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ client_id: this.clientId, device_code: this.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
    });
    const body = record(await response.json());
    const error = nonEmptyString(body.error);
    if (error === "authorization_pending" || error === "slow_down") {
      if (error === "slow_down") this.pollIntervalSeconds = Math.min(60, this.pollIntervalSeconds + 5);
      return { status: "logged-out" };
    }
    const token = nonEmptyString(body.access_token);
    if (!response.ok || !token) return { status: "degraded", reason: "GitHub authorization failed" };
    const user = await this.request(API_ENDPOINT, { method: "GET", headers: jsonHeaders(token) });
    if (!user.ok) {
      await this.tokenStore.clear();
      this.deviceCode = null;
      return { status: "degraded", reason: "GitHub token validation failed" };
    }
    const scopes = (user.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
    await this.tokenStore.set(token);
    this.deviceCode = null;
    this.expiresAt = 0;
    return { status: "authorized", scopes };
  }

  getPollIntervalSeconds(): number { return this.pollIntervalSeconds; }
}
