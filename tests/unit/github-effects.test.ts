import test from "node:test";
import assert from "node:assert/strict";
import { GitHubPublicationEffects } from "../../apps/publisher/src/github-effects.ts";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

test("GitHub publication effects dispatch a configured workflow and persist an idempotent intent", async () => {
  const saved = new Map<string, unknown>();
  const calls: Array<{ url: string; method: string; redirect: unknown; body?: unknown }> = [];
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main", deployWorkflow: "deploy.yml" }, {
    store: { get: async (key) => saved.get(key), set: async (key, value) => { saved.set(key, value); } },
    fetcher: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        redirect: (init as { redirect?: unknown }).redirect,
        ...(init.body ? { body: JSON.parse(init.body) } : {})
      });
      if (init.method === "GET" && url.includes("/git/ref/heads/blogbot/deploy-")) return response({}, 404);
      if (init.method === "GET" && url.includes("/actions/runs?")) return response({ workflow_runs: [] });
      if (init.method === "POST" && url.endsWith("/git/refs")) return response({ object: { sha: "a".repeat(40) } }, 201);
      if (init.method === "POST" && url.includes("/actions/workflows/deploy.yml/dispatches")) {
        return { ok: true, status: 204, headers: { get: () => null }, json: async () => { throw new Error("204 response has no JSON body"); } };
      }
      throw new Error(`unexpected request: ${init.method} ${url}`);
    }
  });
  const intent = await effects.createDeployIntent({ key: "release-1", revisionId: "rev-1", mergeSha: "a".repeat(40) });
  assert.equal(intent.revisionId, "rev-1");
  assert.equal((await effects.findDeployIntent("release-1"))?.mergeSha, "a".repeat(40));
  const dispatch = calls.find((call) => call.url.includes("/actions/workflows/deploy.yml/dispatches"));
  assert.ok(dispatch);
  const dispatchBody = dispatch.body as { ref: string; inputs: { intent_key: string; merge_sha: string } };
  assert.match(dispatchBody.ref, /^blogbot\/deploy-intents\/[a-f0-9]{64}$/u);
  assert.match(dispatchBody.inputs.intent_key, /^[a-f0-9]{64}$/u);
  assert.equal(dispatchBody.inputs.merge_sha, "a".repeat(40));
  assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/git/refs") && (call.body as { ref?: string }).ref === `refs/heads/${dispatchBody.ref}`));
  assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/git/refs") && (call.body as { ref?: string }).ref === `refs/heads/blogbot/deploy-dispatched/${dispatchBody.inputs.intent_key}`));
  assert.ok(calls.every((call) => call.redirect === "manual"));
});

test("GitHub publication effects recover a completed dispatch marker without dispatching twice", async () => {
  let dispatches = 0;
  const mergeSha = "b".repeat(40);
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main", deployWorkflow: "deploy.yml" }, {
    fetcher: async (url, init) => {
      if (init.method === "GET" && url.includes("/git/ref/heads/blogbot/deploy-intents/")) return response({ object: { sha: mergeSha } });
      if (init.method === "GET" && url.includes("/git/ref/heads/blogbot/deploy-dispatched/")) return response({ object: { sha: mergeSha } });
      if (init.method === "POST" && url.includes("/actions/workflows/")) dispatches += 1;
      throw new Error(`unexpected request: ${init.method} ${url}`);
    }
  });

  const intent = await effects.createDeployIntent({ key: "release-retry", revisionId: "rev-retry", mergeSha });

  assert.equal(intent.mergeSha, mergeSha);
  assert.equal(dispatches, 0);
});

test("GitHub publication effects reject an invalid target before network access", () => {
  assert.throws(() => new GitHubPublicationEffects({ token: "token", repository: "not-a-repository", baseBranch: "main" }));
});

test("GitHub publication effects accept dot-prefixed names and reject URL-normalizing dot segments", () => {
  assert.doesNotThrow(() =>
    new GitHubPublicationEffects({ token: "token", repository: "owner/.github", baseBranch: "main" })
  );
  for (const repository of ["owner/.", "owner/..", "../site", "owner/site/extra"]) {
    assert.throws(() =>
      new GitHubPublicationEffects({ token: "token", repository, baseBranch: "main" })
    );
  }
});

test("GitHub publication effects enforce the shared base-branch contract", () => {
  assert.doesNotThrow(() =>
    new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "release/v1.2.3" })
  );
  for (const baseBranch of [
    "/main", "main/", "main//next", "main..next", "main:next", ".hidden", "feature/.hidden",
    "feature.lock", "feature/x.lock", "feature.", "-main", "m".repeat(201)
  ]) {
    assert.throws(
      () => new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch }),
      baseBranch
    );
  }
});

test("GitHub publication effects enforce the shared workflow filename contract", () => {
  for (const deployWorkflow of ["deploy.yml", "release_1.yaml"]) {
    assert.doesNotThrow(() =>
      new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main", deployWorkflow })
    );
  }
  for (const deployWorkflow of ["w".repeat(97) + ".yml", "a..yml", ".yml", "deploy.txt", "nested/deploy.yml"]) {
    assert.throws(
      () => new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main", deployWorkflow }),
      deployWorkflow
    );
  }
});

test("GitHub publication effects expose only the read-only base snapshot", async () => {
  const effects = new GitHubPublicationEffects({ token: "token", repository: "owner/site", baseBranch: "main" }, {
    fetcher: async () => response({ object: { sha: "a".repeat(40) } })
  });
  assert.equal(await effects.getBaseBranchSha(), "a".repeat(40));
});

test("GitHub publication request deadline includes response body parsing", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectBody: ((reason?: unknown) => void) | undefined;
  const effects = new GitHubPublicationEffects({
    token: "token",
    repository: "owner/site",
    baseBranch: "main"
  }, {
    fetcher: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => new Promise<unknown>((_resolve, reject) => {
        rejectBody = reject;
        (init as { signal?: AbortSignal }).signal?.addEventListener("abort", () => {
          reject(new Error("fixture body read aborted"));
        }, { once: true });
      })
    })
  });
  let outcome: "pending" | "resolved" | "rejected" = "pending";
  const operation = effects.getBaseBranchSha().then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; }
  );

  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  assert.ok(rejectBody, "the fixture response body must be awaiting data");
  context.mock.timers.tick(15_000);
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

  try {
    assert.equal(outcome, "rejected", "the publication request must not hang past its deadline");
  } finally {
    rejectBody?.(new Error("fixture cleanup"));
    await operation;
  }
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
