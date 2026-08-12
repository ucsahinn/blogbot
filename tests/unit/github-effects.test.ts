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
      return {
        ok: true,
        status: 204,
        headers: { get: () => null },
        json: async () => { throw new Error("204 response has no JSON body"); }
      };
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

test("GitHub publication effects never treat an existing publication branch as a successful creation", async () => {
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main" }, {
    fetcher: async (url, init) => {
      if (url.includes("/git/ref/heads/main")) return response({ object: { sha: "a".repeat(40) } });
      if (init.method === "POST" && url.endsWith("/git/refs")) return response({ message: "Reference already exists" }, 422);
      throw new Error(`unexpected request: ${init.method} ${url}`);
    }
  });
  await assert.rejects(
    effects.createPullRequest({
      key: "existing-branch",
      targetRepository: "owner/site",
      baseBranch: "main",
      expectedBaseSha: "a".repeat(40),
      expectedHeadSha: "b".repeat(40),
      files: [{ path: "content/tr/story.md", content: "article" }]
    }),
    /branch already exists/i
  );
});

test("GitHub publication effects evaluate only explicitly configured required checks", async () => {
  const head = "b".repeat(40);
  const calls: string[] = [];
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main", requiredChecks: ["verify"] }, {
    fetcher: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (url.includes("/pulls?")) {
        return response([{ number: 7, head: { sha: head, ref: "blogbot/key" }, merged_at: null }]);
      }
      if (url.includes(`/commits/${head}/status`)) {
        return response({ state: "success", statuses: [{ context: "optional", state: "failure" }, { context: "verify", state: "success" }] });
      }
      if (url.includes(`/commits/${head}/check-runs`)) {
        return response({ check_runs: [{ name: "optional", status: "completed", conclusion: "failure" }, { name: "verify", status: "completed", conclusion: "success" }] });
      }
      return response({}, 404);
    }
  });
  const state = await effects.findPullRequest("key");
  assert.equal(state?.requiredChecks, "PASSED");
  assert.ok(calls.some((call) => call.includes("/status")));
  assert.ok(calls.some((call) => call.includes("/check-runs")));
});

test("GitHub publication effects keep merge pending without an explicit required-check policy", async () => {
  const head = "d".repeat(40);
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main" }, {
    fetcher: async (url) => {
      if (url.includes("/pulls?")) return response([{ number: 8, head: { sha: head, ref: "blogbot/key" }, merged_at: null }]);
      if (url.includes(`/commits/${head}/status`)) return response({ statuses: [{ context: "verify", state: "success" }] });
      if (url.includes(`/commits/${head}/check-runs`)) return response({ check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
      return response({}, 404);
    }
  });
  assert.equal((await effects.findPullRequest("key"))?.requiredChecks, "PENDING");
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
