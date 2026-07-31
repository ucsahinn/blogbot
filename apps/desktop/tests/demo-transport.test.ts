import assert from "node:assert/strict";
import test from "node:test";

import { createInvokeBridge } from "../src/bridge.ts";
import { createDemoTransport } from "../src/demo-data.ts";

test("demo transports isolate source and workspace mutations", async () => {
  const first = createInvokeBridge(createDemoTransport());
  const second = createInvokeBridge(createDemoTransport());

  await first.promoteCandidate("candidate-cisa-001");
  await first.retryJob("failure-source-timeout");
  await first.updateScheduleSlot({
    slotId: "slot-wed",
    enabled: false,
    time: "09:15"
  });

  const mutated = await first.getEditorialWorkspace();
  const isolated = await second.getEditorialWorkspace();

  assert.equal(
    mutated.candidates.find((item) => item.id === "candidate-cisa-001")?.state,
    "PROMOTED"
  );
  assert.equal(
    isolated.candidates.find((item) => item.id === "candidate-cisa-001")?.state,
    "NEW"
  );
  assert.equal(
    mutated.failures.find((item) => item.id === "failure-source-timeout")?.state,
    "RETRYING"
  );
  assert.deepEqual(
    mutated.weeklySlots.find((item) => item.id === "slot-wed"),
    {
      id: "slot-wed",
      dayLabel: "Çarşamba",
      time: "09:15",
      enabled: false,
      articleId: null,
      articleTitle: null,
      state: "EMPTY"
    }
  );
});

test("promoting a source-poor candidate creates a blocked draft", async () => {
  const bridge = createInvokeBridge(createDemoTransport());

  await bridge.promoteCandidate("candidate-supply-chain");
  const workspace = await bridge.getEditorialWorkspace();
  const draft = workspace.drafts.find(
    (item) => item.id === "draft-candidate-supply-chain"
  );

  assert.equal(draft?.state, "NEEDS_SOURCE");
  assert.equal(draft?.blockers, 1);
});

test("demo doctor and workspace expose only local runtime capabilities and logical Codex roles", async () => {
  const bridge = createInvokeBridge(createDemoTransport());

  const [bootstrap, prerequisites, workspace, engineProbe] = await Promise.all([
    bridge.getBootstrapSnapshot(),
    bridge.getPrerequisiteStatus(),
    bridge.getEditorialWorkspace(),
    bridge.testLocalEngine()
  ]);

  assert.deepEqual(
    prerequisites.checks.map((check) => check.id),
    [
      "windows",
      "webview2",
      "secure-store",
      "local-engine",
      "local-database",
      "local-queue",
    "codex",
    "clock",
    "github",
    "backup",
      "site-adapter"
    ]
  );
  assert.deepEqual(
    workspace.codexRoles.map((role) => role.role),
    ["FAST", "DEFAULT", "DEEP_REVIEW"]
  );
  assert.deepEqual(
    workspace.systemHealth.map((item) => item.id),
    ["engine", "pglite", "codex", "github", "site-adapter"]
  );
  assert.deepEqual(bootstrap.connection, {
    engineRunning: true,
    engineLabel: "Blogbot Engine · bu bilgisayar",
    bridgeReady: true,
    latencyMs: 8,
    storageLabel: "PGlite · yerel ve şifreli",
    lastSyncAt: "2026-07-29T12:44:12.000Z"
  });
  assert.deepEqual(engineProbe, {
    ready: true,
    component: "local-engine",
    detail: "Yerel engine, PGlite ve iş kuyruğu çalışıyor."
  });
});

test("tested Atom metadata is preserved when a source is saved for rights review", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const testResult = await bridge.testSource(
    "https://security.example.org/atom.xml"
  );

  const result = await bridge.saveSources([
    {
      url: testResult.url,
      section: "haberler",
      articleType: "news",
      kind: testResult.kind,
      title: testResult.title,
      language: "en"
    }
  ]);

  assert.deepEqual(result.sources[0], {
    id: "src-demo-5",
    name: "security.example.org",
    url: "https://security.example.org/atom.xml",
    kind: "ATOM",
    health: "HEALTHY",
    section: "haberler",
    articleType: "news",
    lastCheckedAt: result.sources[0]?.lastCheckedAt,
    lastItemAt: null,
    discoveredFeeds: [],
    enabled: true,
    version: 1,
    language: "en",
    trustStatus: "PENDING",
    rightsStatus: "PENDING",
    canPublish: false,
    blockers: ["TRUST_REVIEW_REQUIRED", "RIGHTS_REVIEW_REQUIRED"]
  });
});
