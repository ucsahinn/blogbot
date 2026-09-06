import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubConnector,
  evaluateGitHubConnectorState,
  buildGitHubPublisherDryRun,
  createPublisherIntent,
  advancePublisherIntent,
  type GitHubDeviceFlowPort
} from "../../apps/publisher/src/github-connector.ts";
import {
  GitHubDeviceFlowClient,
  type GitHubAppCredentials,
  type GitHubFetchResponse
} from "../../apps/publisher/src/github-http.ts";

const config = { owner: "owner", repository: "site", workflow: "deploy.yml" };
const permissions = [
  "actions:write",
  "administration:read",
  "checks:read",
  "contents:write",
  "metadata:read",
  "pull_requests:write"
] as const;

function response(status: number, body: unknown): GitHubFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null }
  };
}

function formBody(body: string | undefined): Record<string, string> | null {
  return body ? Object.fromEntries(new URLSearchParams(body).entries()) : null;
}

test("validates wizard target and reports exact GitHub App permissions", () => {
  assert.deepEqual(evaluateGitHubConnectorState(config, { status: "logged-out" }), {
    state: "LOGIN_REQUIRED",
    repository: "owner/site",
    workflow: "deploy.yml",
    requiredPermissions: permissions
  });
  assert.throws(() =>
    evaluateGitHubConnectorState({ ...config, owner: "../bad" }, { status: "logged-out" })
  );
});

test("GitHub wizard enforces the publication workflow filename contract", () => {
  for (const workflow of ["deploy.yml", "release_1.yaml"]) {
    assert.equal(
      evaluateGitHubConnectorState({ ...config, workflow }, { status: "logged-out" }).workflow,
      workflow
    );
  }
  for (const workflow of ["w".repeat(97) + ".yml", "a..yml", ".yml", "deploy.txt", "nested/deploy.yml"]) {
    assert.throws(
      () => evaluateGitHubConnectorState({ ...config, workflow }, { status: "logged-out" }),
      workflow
    );
  }
});

test("repository validation accepts dot-prefixed names but rejects URL-normalizing dot segments", () => {
  const dotRepository = { ...config, repository: ".github" };
  assert.equal(evaluateGitHubConnectorState(dotRepository, {
    status: "authorized",
    repository: "owner/.github",
    permissions
  }).state, "READY");
  assert.equal(createPublisherIntent({
    repository: "owner/.github",
    workflow: "deploy.yml",
    revisionId: "rev-dot",
    revisionHash: "a".repeat(64)
  }).repository, "owner/.github");

  assert.throws(() =>
    evaluateGitHubConnectorState({ ...config, owner: ".github" }, { status: "logged-out" })
  );
  for (const repository of ["owner/.", "owner/..", "../site", "owner/site/extra"]) {
    assert.throws(() => createPublisherIntent({
      repository,
      workflow: "deploy.yml",
      revisionId: "rev-unsafe",
      revisionHash: "a".repeat(64)
    }));
  }
});

test("GitHub App transport uses the same safe repository-name contract", () => {
  const tokenStore = {
    get: async () => null,
    set: async () => undefined,
    clear: async () => undefined
  };
  assert.doesNotThrow(() => new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/.github",
    tokenStore
  }));
  for (const repository of ["owner/.", "owner/..", "../site", "owner/site/extra"]) {
    assert.throws(() => new GitHubDeviceFlowClient({
      clientId: "client_12345678",
      repository,
      tokenStore
    }));
  }
});

test("readiness is repository-bound and exact-permission fail-closed", () => {
  assert.equal(evaluateGitHubConnectorState(config, {
    status: "authorized",
    repository: "owner/site",
    permissions
  }).state, "READY");
  assert.equal(evaluateGitHubConnectorState(config, {
    status: "authorized",
    repository: "owner/other",
    permissions
  }).state, "DEGRADED");
  assert.equal(evaluateGitHubConnectorState(config, {
    status: "authorized",
    repository: "owner/site",
    permissions: permissions.slice(1)
  }).state, "DEGRADED");
  assert.equal(evaluateGitHubConnectorState(config, {
    status: "authorized",
    repository: "owner/site",
    permissions: [...permissions, "issues:write"]
  }).state, "DEGRADED");
});

test("device flow port delegates explicit operations without exposing credentials", async () => {
  const calls: string[] = [];
  const port: GitHubDeviceFlowPort = {
    begin: async () => {
      calls.push("begin");
      return {
        userCode: "ABCD",
        verificationUri: "https://github.com/login/device",
        expiresIn: 600,
        interval: 5
      };
    },
    poll: async () => {
      calls.push("poll");
      return { status: "authorized", repository: "owner/site", permissions };
    }
  };
  const connector = createGitHubConnector(config, port);
  assert.deepEqual(await connector.beginDeviceFlow(), {
    userCode: "ABCD",
    verificationUri: "https://github.com/login/device",
    expiresIn: 600,
    interval: 5
  });
  assert.equal((await connector.pollDeviceFlow()).state, "READY");
  assert.deepEqual(calls, ["begin", "poll"]);
});

test("device flow rejects untrusted verification URLs and unsafe polling bounds", async () => {
  const connector = createGitHubConnector(config, {
    begin: async () => ({
      userCode: "ABCD",
      verificationUri: "http://evil.example/device",
      expiresIn: 600,
      interval: 5
    }),
    poll: async () => ({ status: "logged-out" })
  });
  await assert.rejects(connector.beginDeviceFlow(), /verification URL/iu);
  const invalidBounds = createGitHubConnector(config, {
    begin: async () => ({
      userCode: "ABCD",
      verificationUri: "https://github.com/login/device",
      expiresIn: 10,
      interval: 5
    }),
    poll: async () => ({ status: "logged-out" })
  });
  await assert.rejects(invalidBounds.beginDeviceFlow(), /invalid expiry/iu);
});

test("device flow accepts only GitHub's exact verification endpoint", async () => {
  for (const verificationUri of [
    "https://github.com:444/login/device",
    "https://github.com/login/device?continue=unexpected",
    "https://github.com/login/device#unexpected"
  ]) {
    const connector = createGitHubConnector(config, {
      begin: async () => ({
        userCode: "ABCD",
        verificationUri,
        expiresIn: 600,
        interval: 5
      }),
      poll: async () => ({ status: "logged-out" })
    });
    await assert.rejects(
      connector.beginDeviceFlow(),
      /verification URL/iu,
      verificationUri
    );
  }
});

test("publisher intent and dry-run are deterministic and no-write", () => {
  const intent = createPublisherIntent({
    repository: "owner/site",
    workflow: "deploy.yml",
    revisionId: "rev-1",
    revisionHash: "a".repeat(64)
  });
  assert.equal(intent.state, "PENDING");
  assert.equal(intent.key, createPublisherIntent({
    repository: "owner/site",
    workflow: "deploy.yml",
    revisionId: "rev-1",
    revisionHash: "a".repeat(64)
  }).key);
  assert.equal(advancePublisherIntent(intent, evaluateGitHubConnectorState(config, {
    status: "authorized",
    repository: "owner/site",
    permissions
  })).state, "READY");
  const plan = buildGitHubPublisherDryRun({
    config,
    intent,
    now: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(plan.writes, false);
  assert.deepEqual(plan.steps, [
    "validate-github-app-permissions",
    "preview-workflow",
    "record-publisher-intent"
  ]);
});

test("GitHub App device transport stores a rotating repository-bound credential bundle", async () => {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, string> | null;
    redirect: unknown;
  }> = [];
  const savedCredentials: GitHubAppCredentials[] = [];
  const now = 1_000_000;
  const accessToken = ["access", "never", "returned"].join("-");
  const refreshToken = ["refresh", "never", "returned"].join("-");
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => savedCredentials.at(-1) ?? null,
      set: async (credentials) => { savedCredentials.push(credentials); },
      clear: async () => { savedCredentials.splice(0); }
    },
    fetcher: async (url, init) => {
      calls.push({
        url,
        headers: init.headers ?? {},
        body: formBody(init.body),
        redirect: (init as { redirect?: unknown }).redirect
      });
      if (url.endsWith("/login/device/code")) {
        return response(200, {
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          device_code: "device-code",
          expires_in: 900,
          interval: 5
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return response(200, {
          access_token: accessToken,
          expires_in: 28_800,
          refresh_token: refreshToken,
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: ""
        });
      }
      if (url.endsWith("/repos/owner/site")) {
        return response(200, { id: 7, full_name: "owner/site" });
      }
      if (url.includes("/user/installations?")) {
        return response(200, {
          installations: [{
            id: 42,
            repository_selection: "selected",
            permissions: {
              actions: "write",
              administration: "read",
              checks: "read",
              contents: "write",
              metadata: "read",
              pull_requests: "write"
            }
          }]
        });
      }
      if (url.endsWith("/user/installations/42/repositories?per_page=2")) {
        return response(200, {
          total_count: 1,
          repositories: [{ id: 7, full_name: "owner/site" }]
        });
      }
      return response(404, {});
    }
  });

  const started = await client.begin();
  assert.equal(started.verificationUri, "https://github.com/login/device");
  const auth = await client.poll();
  assert.deepEqual(auth, {
    status: "authorized",
    repository: "owner/site",
    permissions
  });
  assert.deepEqual(calls[0]?.body, { client_id: "client_12345678" });
  assert.equal(calls[0]?.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(calls[1]?.body, {
    client_id: "client_12345678",
    device_code: "device-code",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code"
  });
  assert.equal(calls[1]?.headers["content-type"], "application/x-www-form-urlencoded");
  assert.ok(calls.every((call) => call.redirect === "manual"));
  const stored = savedCredentials.at(-1);
  assert.ok(stored);
  assert.equal(stored.accessToken, accessToken);
  assert.equal(stored.refreshToken, refreshToken);
  assert.equal(stored.repository, "owner/site");
  assert.equal(stored.accessExpiresAt, now + 28_800_000);
  assert.equal(stored.refreshExpiresAt, now + 15_897_600_000);
  assert.equal(JSON.stringify(auth).includes(accessToken), false);
  assert.equal(JSON.stringify(auth).includes(refreshToken), false);
});

test("GitHub authorization uses documented list endpoints and binds both repository ID and name", async () => {
  for (const fixture of [
    { id: 7, name: "OWNER/site", count: 1, valid: true },
    { id: 8, name: "owner/site", count: 1, valid: false },
    { id: 7, name: "owner/other", count: 1, valid: false },
    { id: 7, name: "owner/site", count: 2, valid: false }
  ]) {
    const credentials: GitHubAppCredentials = {
      clientId: "client_12345678", repository: "owner/site",
      accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
      accessExpiresAt: 900_000, refreshExpiresAt: 9_000_000
    };
    const client = new GitHubDeviceFlowClient({
      clientId: credentials.clientId, repository: credentials.repository, now: () => 1_000,
      tokenStore: { get: async () => credentials, set: async () => {}, clear: async () => {} },
      fetcher: async (url) => {
        if (url.endsWith("/repos/owner/site")) return response(200, { id: 7, full_name: "owner/site" });
        if (url.includes("/user/installations?")) return response(200, { installations: [
          { id: 41, repository_selection: "selected", permissions: {} },
          { id: 42, repository_selection: "selected", permissions: Object.fromEntries(permissions.map((p) => p.split(":"))) }
        ] });
        if (url.endsWith("/41/repositories?per_page=2")) return response(200, {
          total_count: 1, repositories: [{ id: 9, full_name: "another/project" }]
        });
        if (url.endsWith("/42/repositories?per_page=2")) return response(200, {
          total_count: fixture.count, repositories: [{ id: fixture.id, full_name: fixture.name }]
        });
        return response(404, {});
      }
    });
    if (fixture.valid) assert.equal(await client.getValidAccessToken(), "synthetic-access");
    else await assert.rejects(client.getValidAccessToken());
  }
});

test("concurrent device polls share one token exchange", async () => {
  let tokenPolls = 0;
  let releaseTokenResponse: (() => void) | undefined;
  const tokenResponseGate = new Promise<void>((resolve) => {
    releaseTokenResponse = resolve;
  });
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => 1_000_000,
    tokenStore: {
      get: async () => null,
      set: async () => undefined,
      clear: async () => undefined
    },
    fetcher: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return response(200, {
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          device_code: "device-code",
          expires_in: 900,
          interval: 5
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        tokenPolls += 1;
        await tokenResponseGate;
        return response(200, {
          access_token: "device-access-fixture",
          expires_in: 28_800,
          refresh_token: "device-refresh-fixture",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: ""
        });
      }
      if (url.endsWith("/repos/owner/site")) {
        return response(200, { id: 7, full_name: "owner/site" });
      }
      if (url.includes("/user/installations?")) {
        return response(200, {
          installations: [{
            id: 42,
            repository_selection: "selected",
            permissions: {
              actions: "write",
              administration: "read",
              checks: "read",
              contents: "write",
              metadata: "read",
              pull_requests: "write"
            }
          }]
        });
      }
      if (url.endsWith("/user/installations/42/repositories?per_page=2")) {
        return response(200, {
          total_count: 1,
          repositories: [{ id: 7, full_name: "owner/site" }]
        });
      }
      return response(404, {});
    }
  });

  await client.begin();
  const firstPoll = client.poll();
  const secondPoll = client.poll();
  releaseTokenResponse?.();

  const results = await Promise.all([firstPoll, secondPoll]);
  assert.deepEqual(results, [
    { status: "authorized", repository: "owner/site", permissions },
    { status: "authorized", repository: "owner/site", permissions }
  ]);
  assert.equal(tokenPolls, 1, "one device code must produce at most one token exchange in flight");
});

test("device grant survives transient repository validation without polling the token endpoint twice", async () => {
  let tokenPolls = 0;
  let repositoryChecks = 0;
  let stored: GitHubAppCredentials | null = null;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => 1_000_000,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => { stored = null; }
    },
    fetcher: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return response(200, {
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          device_code: "device-code",
          expires_in: 900,
          interval: 5
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        tokenPolls += 1;
        return response(200, {
          access_token: "device-access-fixture",
          expires_in: 28_800,
          refresh_token: "device-refresh-fixture",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: ""
        });
      }
      if (url.endsWith("/repos/owner/site")) {
        repositoryChecks += 1;
        return repositoryChecks === 1
          ? response(503, {})
          : response(200, { id: 7, full_name: "owner/site" });
      }
      if (url.includes("/user/installations?")) {
        return response(200, {
          installations: [{
            id: 42,
            repository_selection: "selected",
            permissions: {
              actions: "write",
              administration: "read",
              checks: "read",
              contents: "write",
              metadata: "read",
              pull_requests: "write"
            }
          }]
        });
      }
      if (url.endsWith("/user/installations/42/repositories?per_page=2")) {
        return response(200, {
          total_count: 1,
          repositories: [{ id: 7, full_name: "owner/site" }]
        });
      }
      return response(404, {});
    }
  });

  await client.begin();
  assert.deepEqual(await client.poll(), {
    status: "degraded",
    reason: "GitHub App validation temporarily unavailable"
  });
  assert.equal(stored, null, "an unvalidated grant must not be persisted");

  assert.deepEqual(await client.poll(), {
    status: "authorized",
    repository: "owner/site",
    permissions
  });
  assert.equal(tokenPolls, 1, "an issued device grant must not be requested twice");
  assert.equal(repositoryChecks, 2);
  assert.equal(
    (stored as GitHubAppCredentials | null)?.accessToken,
    "device-access-fixture"
  );
});

test("device polling preserves its code across a transient token-endpoint response", async () => {
  let tokenPolls = 0;
  let stored: GitHubAppCredentials | null = null;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => 1_000_000,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => { stored = null; }
    },
    fetcher: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return response(200, {
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          device_code: "device-code",
          expires_in: 900,
          interval: 5
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        tokenPolls += 1;
        return tokenPolls === 1
          ? response(503, {})
          : response(200, {
              access_token: "device-access-fixture",
              expires_in: 28_800,
              refresh_token: "device-refresh-fixture",
              refresh_token_expires_in: 15_897_600,
              token_type: "bearer",
              scope: ""
            });
      }
      if (url.endsWith("/repos/owner/site")) {
        return response(200, { id: 7, full_name: "owner/site" });
      }
      if (url.includes("/user/installations?")) {
        return response(200, {
          installations: [{
            id: 42,
            repository_selection: "selected",
            permissions: {
              actions: "write",
              administration: "read",
              checks: "read",
              contents: "write",
              metadata: "read",
              pull_requests: "write"
            }
          }]
        });
      }
      if (url.endsWith("/user/installations/42/repositories?per_page=2")) {
        return response(200, {
          total_count: 1,
          repositories: [{ id: 7, full_name: "owner/site" }]
        });
      }
      return response(404, {});
    }
  });

  await client.begin();
  assert.deepEqual(await client.poll(), {
    status: "degraded",
    reason: "GitHub App authorization temporarily unavailable"
  });
  assert.equal(stored, null);
  assert.deepEqual(await client.poll(), {
    status: "authorized",
    repository: "owner/site",
    permissions
  });
  assert.equal(tokenPolls, 2);
  assert.equal(
    (stored as GitHubAppCredentials | null)?.accessToken,
    "device-access-fixture"
  );
});

test("an unvalidated in-memory device grant expires at its original access-token deadline", async () => {
  let now = 1_000_000;
  let tokenPolls = 0;
  let repositoryChecks = 0;
  let stored: GitHubAppCredentials | null = null;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => { stored = null; }
    },
    fetcher: async (url) => {
      if (url.endsWith("/login/device/code")) {
        return response(200, {
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          device_code: "device-code",
          expires_in: 900,
          interval: 5
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        tokenPolls += 1;
        return response(200, {
          access_token: "device-access-fixture",
          expires_in: 28_800,
          refresh_token: "device-refresh-fixture",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: ""
        });
      }
      if (url.endsWith("/repos/owner/site")) {
        repositoryChecks += 1;
        return response(503, {});
      }
      return response(404, {});
    }
  });

  await client.begin();
  assert.deepEqual(await client.poll(), {
    status: "degraded",
    reason: "GitHub App validation temporarily unavailable"
  });

  now += 28_800_000;
  assert.deepEqual(await client.poll(), {
    status: "degraded",
    reason: "GitHub App device grant expired"
  });
  assert.equal(tokenPolls, 1);
  assert.equal(repositoryChecks, 1);
  assert.equal(stored, null);
});

test("GitHub App access token refresh rotates without a client secret", async () => {
  const bodies: Record<string, string>[] = [];
  const contentTypes: string[] = [];
  let stored: GitHubAppCredentials | null = {
    clientId: "client_12345678",
    repository: "owner/site",
    accessToken: "expired-access-fixture",
    refreshToken: "stored-refresh-fixture",
    accessExpiresAt: 1_100,
    refreshExpiresAt: 99_999_999
  };
  const now = 1_000_000;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => { stored = null; }
    },
    fetcher: async (url, init) => {
      if (init.body) {
        bodies.push(formBody(init.body) ?? {});
        contentTypes.push(init.headers?.["content-type"] ?? "");
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return response(200, {
          access_token: "rotated-access-fixture",
          expires_in: 28_800,
          refresh_token: "rotated-refresh-fixture",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: ""
        });
      }
      if (url.endsWith("/repos/owner/site")) return response(200, { id: 7 });
      if (url.includes("/user/installations?")) {
        return response(200, {
          installations: [{
            id: 42,
            repository_selection: "selected",
            permissions: {
              actions: "write",
              administration: "read",
              checks: "read",
              contents: "write",
              metadata: "read",
              pull_requests: "write"
            }
          }]
        });
      }
      if (url.endsWith("/user/installations/42/repositories?per_page=2")) {
        return response(200, {
          total_count: 1,
          repositories: [{ id: 7, full_name: "owner/site" }]
        });
      }
      return response(404, {});
    }
  });

  assert.equal(await client.getValidAccessToken(), "rotated-access-fixture");
  assert.deepEqual(bodies[0], {
    client_id: "client_12345678",
    grant_type: "refresh_token",
    refresh_token: "stored-refresh-fixture"
  });
  assert.equal(Object.hasOwn(bodies[0] ?? {}, "client_secret"), false);
  assert.equal(contentTypes[0], "application/x-www-form-urlencoded");
  assert.equal(stored?.accessToken, "rotated-access-fixture");
  assert.equal(stored?.refreshToken, "rotated-refresh-fixture");
});

test("GitHub App refresh clears stale credentials when installation revalidation fails", async () => {
  let stored: GitHubAppCredentials | null = {
    clientId: "client_12345678",
    repository: "owner/site",
    accessToken: "expired-access-fixture",
    refreshToken: "stored-refresh-fixture",
    accessExpiresAt: 1_100,
    refreshExpiresAt: 99_999_999
  };
  let clearCalls = 0;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => 1_000_000,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => {
        clearCalls += 1;
        stored = null;
      }
    },
    fetcher: async (url) => {
      if (url.endsWith("/login/oauth/access_token")) {
        return response(200, {
          access_token: "rotated-access-fixture",
          expires_in: 28_800,
          refresh_token: "rotated-refresh-fixture",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: ""
        });
      }
      if (url.endsWith("/repos/owner/site")) return response(200, { id: 7 });
      if (url.includes("/user/installations?")) {
        return response(200, {
          installations: [{
            id: 42,
            repository_selection: "selected",
            permissions: {
              actions: "write",
              administration: "read",
              checks: "read",
              contents: "write",
              issues: "write",
              metadata: "read",
              pull_requests: "write"
            }
          }]
        });
      }
      if (url.endsWith("/user/installations/42/repositories?per_page=2")) {
        return response(200, { total_count: 1, repositories: [{ id: 7, full_name: "owner/site" }] });
      }
      return response(404, {});
    }
  });

  await assert.rejects(
    client.getValidAccessToken(),
    /permissions are not exactly least-privileged/iu
  );
  assert.equal(stored, null);
  assert.equal(clearCalls, 1);
});

test("GitHub App fresh access token is revalidated before use", async () => {
  const now = 1_000_000;
  let stored: GitHubAppCredentials | null = {
    clientId: "client_12345678",
    repository: "owner/site",
    accessToken: "fresh-access-fixture",
    refreshToken: "stored-refresh-fixture",
    accessExpiresAt: now + 600_000,
    refreshExpiresAt: now + 99_999_999
  };
  let clearCalls = 0;
  const calls: string[] = [];
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => {
        clearCalls += 1;
        stored = null;
      }
    },
    fetcher: async (url) => {
      calls.push(url);
      if (url.endsWith("/repos/owner/site")) return response(200, { id: 7 });
      if (url.includes("/user/installations?")) {
        return response(200, {
          installations: [{
            id: 42,
            repository_selection: "selected",
            permissions: {
              actions: "write",
              administration: "read",
              checks: "read",
              contents: "write",
              issues: "write",
              metadata: "read",
              pull_requests: "write"
            }
          }]
        });
      }
      if (url.endsWith("/user/installations/42/repositories?per_page=2")) {
        return response(200, { total_count: 1, repositories: [{ id: 7, full_name: "owner/site" }] });
      }
      return response(404, {});
    }
  });

  await assert.rejects(
    client.getValidAccessToken(),
    /permissions are not exactly least-privileged/iu
  );
  assert.ok(calls.some((url) => url.endsWith("/repos/owner/site")));
  assert.equal(stored, null);
  assert.equal(clearCalls, 1);
});
test("GitHub App fresh token survives a transient repository validation outage", async () => {
  const now = 1_000_000;
  let stored: GitHubAppCredentials | null = {
    clientId: "client_12345678",
    repository: "owner/site",
    accessToken: "fresh-access-fixture",
    refreshToken: "stored-refresh-fixture",
    accessExpiresAt: now + 600_000,
    refreshExpiresAt: now + 99_999_999
  };
  let clearCalls = 0;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => {
        clearCalls += 1;
        stored = null;
      }
    },
    fetcher: async () => response(503, {})
  });

  await assert.rejects(
    client.getValidAccessToken(),
    /temporarily unavailable/iu
  );
  assert.ok(stored);
  assert.equal(clearCalls, 0);
});

test("GitHub App preserves credentials when a transient response body is not JSON", async () => {
  const now = 1_000_000;
  let stored: GitHubAppCredentials | null = {
    clientId: "client_12345678",
    repository: "owner/site",
    accessToken: "fresh-access-fixture",
    refreshToken: "stored-refresh-fixture",
    accessExpiresAt: now + 600_000,
    refreshExpiresAt: now + 99_999_999
  };
  let clearCalls = 0;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => {
        clearCalls += 1;
        stored = null;
      }
    },
    fetcher: async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => { throw new SyntaxError("fixture is not JSON"); }
    })
  });

  await assert.rejects(
    client.getValidAccessToken(),
    /temporarily unavailable/iu
  );
  assert.ok(stored);
  assert.equal(clearCalls, 0);
});

test("GitHub App refresh preserves its reusable credential after a transient token endpoint outage", async () => {
  const now = 1_000_000;
  let stored: GitHubAppCredentials | null = {
    clientId: "client_12345678",
    repository: "owner/site",
    accessToken: "expiring-access-fixture",
    refreshToken: "stored-refresh-fixture",
    accessExpiresAt: now + 1_000,
    refreshExpiresAt: now + 99_999_999
  };
  let clearCalls = 0;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => {
        clearCalls += 1;
        stored = null;
      }
    },
    fetcher: async () => response(503, {})
  });

  await assert.rejects(
    client.getValidAccessToken(),
    /temporarily unavailable/iu
  );
  assert.ok(stored);
  assert.equal(clearCalls, 0);
});

test("GitHub App refresh preserves the rotated pair during transient repository revalidation", async () => {
  const now = 1_000_000;
  let stored: GitHubAppCredentials | null = {
    clientId: "client_12345678",
    repository: "owner/site",
    accessToken: "expiring-access-fixture",
    refreshToken: "stored-refresh-fixture",
    accessExpiresAt: now + 1_000,
    refreshExpiresAt: now + 99_999_999
  };
  let refreshRequests = 0;
  let clearCalls = 0;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => stored,
      set: async (credentials) => { stored = credentials; },
      clear: async () => {
        clearCalls += 1;
        stored = null;
      }
    },
    fetcher: async (url) => {
      if (url.endsWith("/login/oauth/access_token")) {
        refreshRequests += 1;
        return response(200, {
          access_token: "rotated-access-fixture",
          expires_in: 28_800,
          refresh_token: "rotated-refresh-fixture",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: ""
        });
      }
      return response(503, {});
    }
  });

  await assert.rejects(client.getValidAccessToken(), /temporarily unavailable/iu);
  assert.equal(stored?.accessToken, "rotated-access-fixture");
  assert.equal(stored?.refreshToken, "rotated-refresh-fixture");
  assert.equal(clearCalls, 0);

  await assert.rejects(client.getValidAccessToken(), /temporarily unavailable/iu);
  assert.equal(refreshRequests, 1, "a consumed refresh token must not be exchanged again");
  assert.equal(clearCalls, 0);
});

test("GitHub HTTP timeout plumbing passes an abort signal to the token transport", async () => {
  const now = 1_000_000;
  let signalProvided = false;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    now: () => now,
    tokenStore: {
      get: async () => ({
        clientId: "client_12345678",
        repository: "owner/site",
        accessToken: "fresh-access-fixture",
        refreshToken: "stored-refresh-fixture",
        accessExpiresAt: now + 600_000,
        refreshExpiresAt: now + 99_999_999
      }),
      set: async () => undefined,
      clear: async () => undefined
    },
    fetcher: async (_url, init) => {
      signalProvided = (init as { signal?: unknown }).signal instanceof AbortSignal;
      return response(503, {});
    }
  });

  await assert.rejects(client.getValidAccessToken(), /temporarily unavailable/iu);
  assert.equal(signalProvided, true);
});

test("GitHub request deadline includes response body parsing", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectBody: ((reason?: unknown) => void) | undefined;
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    repository: "owner/site",
    tokenStore: {
      get: async () => null,
      set: async () => undefined,
      clear: async () => undefined
    },
    fetcher: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => new Promise<unknown>((_resolve, reject) => {
        rejectBody = reject;
        init.signal?.addEventListener("abort", () => {
          reject(new Error("fixture body read aborted"));
        }, { once: true });
      })
    })
  });
  let outcome: "pending" | "resolved" | "rejected" = "pending";
  const operation = client.begin().then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; }
  );

  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  assert.ok(rejectBody, "the fixture response body must be awaiting data");
  context.mock.timers.tick(15_000);
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

  try {
    assert.equal(outcome, "rejected", "the declared request deadline must abort a stalled body");
  } finally {
    rejectBody?.(new Error("fixture cleanup"));
    await operation;
  }
});
