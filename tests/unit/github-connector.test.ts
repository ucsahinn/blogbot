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
import { GitHubDeviceFlowClient } from "../../apps/publisher/src/github-http.ts";

const config = { owner: "owner", repository: "site", workflow: "deploy.yml" };

test("validates wizard owner, repository, and workflow scope", () => {
  assert.deepEqual(evaluateGitHubConnectorState(config, { status: "logged-out" }), {
    state: "LOGIN_REQUIRED",
    repository: "owner/site",
    workflow: "deploy.yml",
    requiredScopes: ["repo"]
  });
  assert.throws(() => evaluateGitHubConnectorState({ ...config, owner: "../bad" }, { status: "logged-out" }));
});

test("reports ready and degraded without exposing credentials", () => {
  assert.equal(evaluateGitHubConnectorState(config, { status: "authorized", scopes: ["repo"] }).state, "READY");
  assert.equal(evaluateGitHubConnectorState(config, { status: "authorized", scopes: [] }).state, "DEGRADED");
});

test("device flow port delegates only explicit flow operations and does not persist tokens", async () => {
  const calls: string[] = [];
  const port: GitHubDeviceFlowPort = {
    begin: async () => { calls.push("begin"); return { userCode: "ABCD", verificationUri: "https://github.com/login/device", expiresIn: 600, interval: 5 }; },
  poll: async () => { calls.push("poll"); return { status: "authorized", scopes: ["repo"] }; }
  };
  const connector = createGitHubConnector(config, port);
  assert.deepEqual(await connector.beginDeviceFlow(), { userCode: "ABCD", verificationUri: "https://github.com/login/device", expiresIn: 600, interval: 5 });
  assert.equal((await connector.pollDeviceFlow()).state, "READY");
  assert.deepEqual(calls, ["begin", "poll"]);
});

test("device flow rejects untrusted verification URLs and unsafe polling bounds", async () => {
  const connector = createGitHubConnector(config, {
    begin: async () => ({ userCode: "ABCD", verificationUri: "http://evil.example/device", expiresIn: 600, interval: 5 }),
    poll: async () => ({ status: "logged-out" })
  });
  await assert.rejects(connector.beginDeviceFlow(), /verification URL/iu);
  const invalidBounds = createGitHubConnector(config, {
    begin: async () => ({ userCode: "ABCD", verificationUri: "https://github.com/login/device", expiresIn: 10, interval: 5 }),
    poll: async () => ({ status: "logged-out" })
  });
  await assert.rejects(invalidBounds.beginDeviceFlow(), /invalid expiry/iu);
});

test("publisher intent and dry-run are deterministic and no-write", () => {
  const intent = createPublisherIntent({ repository: "owner/site", workflow: "deploy.yml", revisionId: "rev-1", revisionHash: "a".repeat(64) });
  assert.equal(intent.state, "PENDING");
  assert.equal(intent.key, createPublisherIntent({ repository: "owner/site", workflow: "deploy.yml", revisionId: "rev-1", revisionHash: "a".repeat(64) }).key);
  assert.equal(advancePublisherIntent(intent, evaluateGitHubConnectorState(config, { status: "authorized", scopes: ["repo", "workflow"] })).state, "READY");
  const plan = buildGitHubPublisherDryRun({ config, intent, now: "2026-07-30T00:00:00.000Z" });
  assert.equal(plan.writes, false);
  assert.deepEqual(plan.steps, ["validate-scope", "preview-workflow", "record-publisher-intent"]);
});

test("real GitHub device transport stores only a validated token and exposes scopes", async () => {
  const calls: string[] = [];
  let stored: string | null = null;
  const testAccessToken = ["token", "never", "returned"].join("-");
  const client = new GitHubDeviceFlowClient({
    clientId: "client_12345678",
    tokenStore: { get: async () => stored, set: async (token) => { stored = token; }, clear: async () => { stored = null; } },
    fetcher: async (url, init) => {
      calls.push(`${init.method}:${url}`);
      if (url.includes("device/code")) return {
        ok: true, status: 200,
        json: async () => ({ user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", device_code: "device-code", expires_in: 900, interval: 1 }),
        headers: { get: () => null }
      };
      if (url.includes("oauth/access_token")) return {
        ok: true, status: 200,
        json: async () => ({ access_token: testAccessToken }),
        headers: { get: () => null }
      };
      return {
        ok: true, status: 200,
        json: async () => ({}),
        headers: { get: (name) => name.toLowerCase() === "x-oauth-scopes" ? "repo" : null }
      };
    }
  });
  const started = await client.begin();
  assert.equal(started.verificationUri, "https://github.com/login/device");
  const auth = await client.poll();
  assert.deepEqual(auth, { status: "authorized", scopes: ["repo"] });
  assert.equal(stored, testAccessToken);
  assert.equal(calls.length, 3);
});
