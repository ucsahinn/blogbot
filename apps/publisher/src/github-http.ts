import {
  isSafeGitHubRepositoryName,
  requiredGitHubAppPermissions,
  type GitHubAuthSnapshot,
  type GitHubDeviceFlowPort
} from "./github-connector.ts";

export interface GitHubAppCredentials {
  clientId: string;
  repository: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface GitHubTokenStore {
  get(): Promise<GitHubAppCredentials | null>;
  set(credentials: GitHubAppCredentials): Promise<void>;
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
  init: {
    method: "POST" | "GET";
    headers?: Record<string, string>;
    body?: string;
    redirect: "manual";
    signal?: AbortSignal;
  }
) => Promise<GitHubFetchResponse>;

const DEVICE_ENDPOINT = "https://github.com/login/device/code";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const API_ENDPOINT = "https://api.github.com";
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MIN_ACCESS_EXPIRY_SECONDS = 60;
const MAX_ACCESS_EXPIRY_SECONDS = 86_400;
const MAX_REFRESH_EXPIRY_SECONDS = 34_560_000;
const MAX_INSTALLATION_PAGES = 20;
const INSTALLATION_PAGE_SIZE = 100;

class GitHubTransientRequestError extends Error {}

function isTransientGitHubStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

type TokenGrant = {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
};

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

function oauthHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded"
  };
}

function oauthForm(parameters: Record<string, string>): string {
  return new URLSearchParams(parameters).toString();
}

function parseTokenGrant(value: unknown): TokenGrant {
  const body = record(value);
  const accessToken = nonEmptyString(body.access_token);
  const refreshToken = nonEmptyString(body.refresh_token);
  const accessExpiresIn = body.expires_in;
  const refreshExpiresIn = body.refresh_token_expires_in;
  if (!Number.isInteger(accessExpiresIn)
      || !Number.isInteger(refreshExpiresIn)
      || !refreshToken) {
    throw new Error("GitHub App token expiration and rotation are required");
  }
  if (typeof body.scope !== "undefined"
      && (typeof body.scope !== "string" || body.scope.trim() !== "")) {
    throw new Error("Classic GitHub OAuth scopes are not accepted");
  }
  if (!accessToken
      || body.token_type !== "bearer"
      || Number(accessExpiresIn) < MIN_ACCESS_EXPIRY_SECONDS
      || Number(accessExpiresIn) > MAX_ACCESS_EXPIRY_SECONDS
      || Number(refreshExpiresIn) <= Number(accessExpiresIn)
      || Number(refreshExpiresIn) > MAX_REFRESH_EXPIRY_SECONDS) {
    throw new Error("GitHub App token response is invalid");
  }
  return {
    accessToken,
    refreshToken,
    accessExpiresIn: Number(accessExpiresIn),
    refreshExpiresIn: Number(refreshExpiresIn)
  };
}

function validateStoredCredentials(
  value: GitHubAppCredentials | null,
  clientId: string,
  repository: string
): GitHubAppCredentials {
  if (!value
      || value.clientId !== clientId
      || value.repository.toLowerCase() !== repository.toLowerCase()
      || !nonEmptyString(value.accessToken)
      || !nonEmptyString(value.refreshToken)
      || !Number.isSafeInteger(value.accessExpiresAt)
      || !Number.isSafeInteger(value.refreshExpiresAt)
      || value.refreshExpiresAt <= value.accessExpiresAt) {
    throw new Error("GitHub App reauthorization is required");
  }
  return value;
}

function exactPermissionSnapshot(installation: Record<string, unknown>): readonly string[] {
  if (installation.repository_selection !== "selected") {
    throw new Error("GitHub App must use selected repositories");
  }
  const permissionObject = record(installation.permissions);
  const granted = Object.entries(permissionObject)
    .map(([name, level]) => `${name}:${String(level)}`);
  const grantedSet = new Set(granted);
  if (grantedSet.size !== requiredGitHubAppPermissions.length
      || !requiredGitHubAppPermissions.every((permission) => grantedSet.has(permission))) {
    throw new Error("GitHub App permissions are not exactly least-privileged");
  }
  return requiredGitHubAppPermissions;
}

/** GitHub App user-to-server device flow.
 *
 * The configured App must enable device flow and expiring user tokens. Its
 * installation must select exactly the configured repository and grant only
 * the repository permissions listed by `requiredGitHubAppPermissions`.
 * No client secret or private key is accepted by this desktop flow.
 */
export class GitHubDeviceFlowClient implements GitHubDeviceFlowPort {
  private readonly fetcher: GitHubFetch;
  private readonly clientId: string;
  private readonly repository: string;
  private readonly tokenStore: GitHubTokenStore;
  private readonly now: () => number;
  private deviceCode: string | null = null;
  private pollIntervalSeconds = 5;
  private expiresAt = 0;
  private pendingCredentials: GitHubAppCredentials | null = null;
  private pollInFlight: Promise<GitHubAuthSnapshot> | null = null;
  private refreshInFlight: Promise<string> | null = null;

  constructor(input: {
    clientId: string;
    repository: string;
    tokenStore: GitHubTokenStore;
    fetcher?: GitHubFetch;
    now?: () => number;
  }) {
    if (!/^[A-Za-z0-9._-]{8,128}$/u.test(input.clientId)) {
      throw new Error("GitHub App client id is invalid");
    }
    if (!isSafeGitHubRepositoryName(input.repository)) {
      throw new Error("GitHub App repository is invalid");
    }
    this.clientId = input.clientId;
    this.repository = input.repository.toLowerCase();
    this.tokenStore = input.tokenStore;
    this.fetcher = input.fetcher
      ?? ((url, init) => fetch(url, init) as unknown as Promise<GitHubFetchResponse>);
    this.now = input.now ?? Date.now;
  }

  private async requestJson(
    url: string,
    init: { method: "POST" | "GET"; headers?: Record<string, string>; body?: string }
  ): Promise<{ response: GitHubFetchResponse; body: Record<string, unknown> }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GitHubTransientRequestError("GitHub request temporarily unavailable"));
      }, FETCH_TIMEOUT_MS);
    });
    try {
      let response: GitHubFetchResponse;
      try {
        response = await Promise.race([
          this.fetcher(url, {
            ...init,
            redirect: "manual",
            signal: controller.signal
          }),
          deadline
        ]);
      } catch (error) {
        if (error instanceof GitHubTransientRequestError) throw error;
        throw new GitHubTransientRequestError("GitHub request temporarily unavailable");
      }
      let parsedBody: unknown;
      try {
        parsedBody = await Promise.race([response.json(), deadline]);
      } catch (error) {
        if (error instanceof GitHubTransientRequestError || controller.signal.aborted) {
          throw new GitHubTransientRequestError("GitHub request temporarily unavailable");
        }
        // Error responses are classified by their HTTP status at the call
        // site. GitHub, a proxy, or a gateway may legitimately return an
        // empty/non-JSON error body; do not let that erase the status signal.
        if (!response.ok) return { response, body: {} };
        throw error;
      }
      const body = record(parsedBody);
      return { response, body };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async getApi(
    path: string,
    token: string,
    accepted: readonly number[] = [200]
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!path.startsWith("/")) throw new Error("GitHub API path is invalid");
    const { response, body } = await this.requestJson(`${API_ENDPOINT}${path}`, {
      method: "GET",
      headers: jsonHeaders(token)
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("GitHub App reauthorization is required");
    }
    if (isTransientGitHubStatus(response.status)) {
      throw new GitHubTransientRequestError("GitHub request temporarily unavailable");
    }
    if (!accepted.includes(response.status)) {
      throw new Error("GitHub App validation failed");
    }
    return { status: response.status, body };
  }

  private async validateRepository(token: string): Promise<readonly string[]> {
    const repositoryResponse = await this.getApi(`/repos/${this.repository}`, token);
    const repositoryId = repositoryResponse.body.id;
    if (!Number.isSafeInteger(repositoryId) || Number(repositoryId) <= 0) {
      throw new Error("GitHub App repository response is invalid");
    }

    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const list = await this.getApi(
        `/user/installations?per_page=${INSTALLATION_PAGE_SIZE}&page=${page}`,
        token
      );
      const installations = Array.isArray(list.body.installations)
        ? list.body.installations.map(record)
        : null;
      if (!installations) throw new Error("GitHub App installation response is invalid");

      for (const installation of installations) {
        const installationId = installation.id;
        if (!Number.isSafeInteger(installationId) || Number(installationId) <= 0) {
          throw new Error("GitHub App installation response is invalid");
        }
        const selected = await this.getApi(
          `/user/installations/${Number(installationId)}/repositories?per_page=2`,
          token,
          [200, 404]
        );
        if (selected.status === 404) continue;
        const selectedRepositories = Array.isArray(selected.body.repositories)
          ? selected.body.repositories.map(record)
          : null;
        if (!selectedRepositories) throw new Error("GitHub App repository response is invalid");
        if (!selectedRepositories.some((entry) => entry.id === repositoryId
            && String(entry.full_name ?? "").toLowerCase() === this.repository)) continue;
        const permissionSnapshot = exactPermissionSnapshot(installation);
        if (selected.body.total_count !== 1
            || selectedRepositories?.length !== 1
            || String(selectedRepositories[0]?.full_name ?? "").toLowerCase()
              !== this.repository) {
          throw new Error("GitHub App must select only the configured repository");
        }
        return permissionSnapshot;
      }
      if (installations.length < INSTALLATION_PAGE_SIZE) break;
    }
    throw new Error("GitHub App cannot access the configured repository");
  }

  private credentialsFromGrant(grant: TokenGrant): GitHubAppCredentials {
    const now = this.now();
    return {
      clientId: this.clientId,
      repository: this.repository,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      accessExpiresAt: now + grant.accessExpiresIn * 1000,
      refreshExpiresAt: now + grant.refreshExpiresIn * 1000
    };
  }

  async begin() {
    const { response, body } = await this.requestJson(DEVICE_ENDPOINT, {
      method: "POST",
      headers: oauthHeaders(),
      body: oauthForm({ client_id: this.clientId })
    });
    const userCode = nonEmptyString(body.user_code);
    const verificationUri = nonEmptyString(body.verification_uri);
    const deviceCode = nonEmptyString(body.device_code);
    const expiresIn = body.expires_in;
    const interval = body.interval;
    if (!response.ok
        || !userCode
        || verificationUri !== "https://github.com/login/device"
        || !deviceCode
        || !Number.isInteger(expiresIn)
        || Number(expiresIn) < 60
        || Number(expiresIn) > 1_800
        || !Number.isInteger(interval)
        || Number(interval) < 5
        || Number(interval) > 60) {
      throw new Error("GitHub App device authorization could not be started");
    }
    this.deviceCode = deviceCode;
    this.pollIntervalSeconds = Number(interval);
    this.expiresAt = this.now() + Number(expiresIn) * 1000;
    this.pendingCredentials = null;
    return {
      userCode,
      verificationUri,
      expiresIn: Number(expiresIn),
      interval: this.pollIntervalSeconds
    };
  }

  private async pollOnce(): Promise<GitHubAuthSnapshot> {
    if (this.pendingCredentials && this.now() >= this.pendingCredentials.accessExpiresAt) {
      this.pendingCredentials = null;
      this.deviceCode = null;
      this.expiresAt = 0;
      return { status: "degraded", reason: "GitHub App device grant expired" };
    }
    if (!this.pendingCredentials && (!this.deviceCode || this.now() >= this.expiresAt)) {
      this.deviceCode = null;
      return { status: "degraded", reason: "GitHub App device code expired" };
    }
    let credentials = this.pendingCredentials;
    if (!credentials) {
      const { response, body } = await this.requestJson(TOKEN_ENDPOINT, {
        method: "POST",
        headers: oauthHeaders(),
        body: oauthForm({
          client_id: this.clientId,
          device_code: this.deviceCode ?? "",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        })
      });
      if (isTransientGitHubStatus(response.status)) {
        return {
          status: "degraded",
          reason: "GitHub App authorization temporarily unavailable"
        };
      }
      const error = nonEmptyString(body.error);
      if (error === "authorization_pending" || error === "slow_down") {
        if (error === "slow_down") {
          this.pollIntervalSeconds = Math.min(60, this.pollIntervalSeconds + 5);
        }
        return { status: "logged-out" };
      }
      try {
        if (!response.ok) throw new Error("GitHub App authorization failed");
        credentials = this.credentialsFromGrant(parseTokenGrant(body));
      } catch {
        await this.tokenStore.clear();
        this.pendingCredentials = null;
        this.deviceCode = null;
        this.expiresAt = 0;
        return { status: "degraded", reason: "GitHub App authorization failed" };
      }
    }

    try {
      const permissions = await this.validateRepository(credentials.accessToken);
      await this.tokenStore.set(credentials);
      this.pendingCredentials = null;
      this.deviceCode = null;
      this.expiresAt = 0;
      return {
        status: "authorized",
        repository: this.repository,
        permissions
      };
    } catch (error) {
      if (error instanceof GitHubTransientRequestError) {
        this.pendingCredentials = credentials;
        return {
          status: "degraded",
          reason: "GitHub App validation temporarily unavailable"
        };
      }
      await this.tokenStore.clear();
      this.pendingCredentials = null;
      this.deviceCode = null;
      this.expiresAt = 0;
      return { status: "degraded", reason: "GitHub App authorization failed" };
    }
  }

  async poll(): Promise<GitHubAuthSnapshot> {
    if (!this.pollInFlight) {
      this.pollInFlight = this.pollOnce()
        .finally(() => { this.pollInFlight = null; });
    }
    return await this.pollInFlight;
  }

  private async refresh(credentials: GitHubAppCredentials): Promise<string> {
    const { response, body } = await this.requestJson(TOKEN_ENDPOINT, {
      method: "POST",
      headers: oauthHeaders(),
      body: oauthForm({
        client_id: this.clientId,
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken
      })
    });
    if (!response.ok) {
      if (isTransientGitHubStatus(response.status)) {
        throw new GitHubTransientRequestError("GitHub request temporarily unavailable");
      }
      await this.tokenStore.clear();
      throw new Error("GitHub App reauthorization is required");
    }
    let rotated: GitHubAppCredentials;
    try {
      if (nonEmptyString(body.error)) {
        throw new Error("GitHub App reauthorization is required");
      }
      const grant = parseTokenGrant(body);
      rotated = this.credentialsFromGrant(grant);
      // Exchanging a refresh token consumes the old pair. Persist its
      // replacement before repository revalidation so a transient GitHub
      // outage cannot strand the client with an already-consumed token.
      await this.tokenStore.set(rotated);
    } catch (error) {
      await this.tokenStore.clear();
      throw error;
    }
    try {
      await this.validateRepository(rotated.accessToken);
    } catch (error) {
      if (!(error instanceof GitHubTransientRequestError)) {
        await this.tokenStore.clear();
      }
      throw error;
    }
    return rotated.accessToken;
  }

  async getValidAccessToken(): Promise<string> {
    let credentials: GitHubAppCredentials;
    try {
      credentials = validateStoredCredentials(
        await this.tokenStore.get(),
        this.clientId,
        this.repository
      );
    } catch (error) {
      await this.tokenStore.clear();
      throw error;
    }
    const now = this.now();
    if (credentials.refreshExpiresAt <= now + REFRESH_MARGIN_MS) {
      await this.tokenStore.clear();
      throw new Error("GitHub App reauthorization is required");
    }
    if (credentials.accessExpiresAt > now + REFRESH_MARGIN_MS) {
      try {
        await this.validateRepository(credentials.accessToken);
        return credentials.accessToken;
      } catch (error) {
        if (!(error instanceof GitHubTransientRequestError)) {
          await this.tokenStore.clear();
        }
        throw error;
      }
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(credentials)
        .finally(() => { this.refreshInFlight = null; });
    }
    return await this.refreshInFlight;
  }

  getPollIntervalSeconds(): number {
    return this.pollIntervalSeconds;
  }
}
