import test from "node:test";
import assert from "node:assert/strict";
import { GitHubPublicationEffects } from "../../apps/publisher/src/github-effects.ts";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

test("GitHub publication effects dispatch a configured workflow and persist an idempotent intent", async () => {
  const saved = new Map<string, unknown>();
  const calls: string[] = [];
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main", deployWorkflow: "deploy.yml" }, {
    store: { get: async (key) => saved.get(key), set: async (key, value) => { saved.set(key, value); } },
    fetcher: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return response({}, 204);
    }
  });
  const intent = await effects.createDeployIntent({ key: "release-1", revisionId: "rev-1", mergeSha: "a".repeat(40) });
  assert.equal(intent.revisionId, "rev-1");
  assert.equal((await effects.findDeployIntent("release-1"))?.mergeSha, "a".repeat(40));
  assert.match(calls[0] ?? "", /actions\/workflows\/deploy.yml\/dispatches/u);
});

test("GitHub publication effects reject an invalid target before network access", () => {
  assert.throws(() => new GitHubPublicationEffects({ token: "token", repository: "not-a-repository", baseBranch: "main" }));
});

test("GitHub publication effects expose only the read-only base snapshot", async () => {
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main" }, {
    fetcher: async () => response({ object: { sha: "a".repeat(40) } })
  });
  assert.equal(await effects.getBaseBranchSha(), "a".repeat(40));
});

test("GitHub publication effects expose real check status instead of assuming every PR is pending", async () => {
  const head = "b".repeat(40);
  const calls: string[] = [];
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main" }, {
    fetcher: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (url.includes("/pulls?")) {
        return response([{ number: 7, head: { sha: head, ref: "blogbot/key" }, merged_at: null }]);
      }
      if (url.includes(`/commits/${head}/status`)) {
        return response({ state: "success", statuses: [{ state: "success" }] });
      }
      if (url.includes(`/commits/${head}/check-runs`)) {
        return response({ check_runs: [{ status: "completed", conclusion: "success" }] });
      }
      return response({}, 404);
    }
  });
  const state = await effects.findPullRequest("key");
  assert.equal(state?.requiredChecks, "PASSED");
  assert.ok(calls.some((call) => call.includes("/status")));
  assert.ok(calls.some((call) => call.includes("/check-runs")));
});

test("GitHub merge effect rechecks required status and refuses a pending workflow", async () => {
  const head = "c".repeat(40);
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main" }, {
    fetcher: async (url) => {
      if (url.includes("/pulls/7")) return response({ number: 7, head: { sha: head, ref: "blogbot/key" }, merged_at: null });
      if (url.includes(`/commits/${head}/status`)) return response({ state: "pending", statuses: [{ state: "pending" }] });
      if (url.includes(`/commits/${head}/check-runs`)) return response({ check_runs: [{ status: "in_progress", conclusion: null }] });
      return response({}, 404);
    }
  });
  await assert.rejects(
    effects.mergePullRequest({ key: "key", pullRequestNumber: 7, expectedHeadSha: head }),
    /required checks are still pending/u
  );
});
