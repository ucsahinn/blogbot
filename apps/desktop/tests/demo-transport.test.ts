import assert from "node:assert/strict";
import test from "node:test";

import { createInvokeBridge } from "../src/bridge.ts";
import { createDemoTransport } from "../src/demo-data.ts";

test("demo transport exposes the canonical connector snapshot required at bootstrap", async () => {
  const bridge = createInvokeBridge(createDemoTransport());

  const state = await bridge.getConnectorState();

  assert.equal(state.sourceState, "AVAILABLE");
  assert.equal(state.mode, "LOCAL_ONLY");
  assert.equal(state.configured, false);
  assert.equal(state.site.adapterId, "local-folder-v1");
  assert.equal(state.localReadiness, "LOCAL_VALIDATED");
  assert.equal(state.externalReadiness, "NOT_CONFIGURED");
});

test("demo Boby guidance responds to the editor's question instead of repeating one menu hint", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const request = (question: string) => bridge.requestBobyGuidance({
    question,
    activePage: "content",
    runtimeState: "ONLINE",
    safeWorkspaceSummary: { draftCount: 1, reviewCount: 0, sourceCount: 2 }
  });

  const sourceRequest = await request("Kaynak nasıl eklenir?");
  const draftRequest = await request("Bu konu için post hazırla");
  const sourceReply = await bridge.getBobyGuidance(sourceRequest.id);
  const draftReply = await bridge.getBobyGuidance(draftRequest.id);

  assert.equal(sourceReply.state, "SUCCEEDED");
  assert.equal(draftReply.state, "SUCCEEDED");
  assert.notEqual(sourceReply.reply, draftReply.reply);
  assert.match(sourceReply.reply ?? "", /kaynak/iu);
  assert.match(draftReply.reply ?? "", /taslak/iu);
});

test("demo transports isolate source and workspace mutations", async () => {
  const first = createInvokeBridge(createDemoTransport());
  const second = createInvokeBridge(createDemoTransport());

  await first.promoteCandidate("candidate-cisa-001");
  await first.retryJob("failure-source-timeout");
  await first.updateScheduleSlot({
    slotId: "slot-wed-1",
    enabled: false,
    time: "09:15"
  });

  const mutated = await first.getEditorialWorkspace();
  const isolated = await second.getEditorialWorkspace();

  assert.equal(
    mutated.candidates.find((item) => item.id === "candidate-cisa-001")?.state,
    "RESEARCH_QUEUED"
  );
  const queuedDraft = mutated.drafts.find((item) => item.id === "draft-candidate-candidate-cisa-001");
  assert.equal(queuedDraft?.titleTr, "Resmî kurum yeni bir duyuru yayımladı");
  assert.equal(queuedDraft?.reviewable, false);
  assert.equal(queuedDraft?.detail, "Araştırma güvenli yerel kuyruğa alındı.");
  assert.equal(
    isolated.candidates.find((item) => item.id === "candidate-cisa-001")?.state,
    "NEW"
  );
  assert.equal(
    mutated.failures.find((item) => item.id === "failure-source-timeout")?.state,
    "RETRYING"
  );
  assert.deepEqual(
    mutated.weeklySlots.find((item) => item.id === "slot-wed-1"),
    {
      id: "slot-wed-1",
      dayLabel: "Çarşamba",
      time: "09:15",
      enabled: false,
      articleId: null,
      articleTitle: null,
      state: "EMPTY"
    }
  );
  assert.equal(mutated.weeklySlots.filter((item) => item.dayLabel === "Çarşamba").length, 5);
});

test("promoting a source-poor candidate creates a blocked draft", async () => {
  const bridge = createInvokeBridge(createDemoTransport());

  await bridge.promoteCandidate("candidate-supply-chain");
  const workspace = await bridge.getEditorialWorkspace();
  const draft = workspace.drafts.find(
    (item) => item.id === "draft-candidate-candidate-supply-chain"
  );

  assert.equal(draft?.state, "NEEDS_SOURCE");
  assert.equal(draft?.blockers, 1);
});

test("instant create persists a non-reviewable editorial draft with the editor instruction", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const instruction = "Kamu kaynaklarını karşılaştıran özgün bir analiz hazırla";

  const created = await bridge.createInstantDraft({
    instruction,
    sourceIds: ["source-1"],
    urls: [],
    targetSection: "analiz",
    articleType: "analysis",
    urgency: "normal",
    tone: "technical",
    length: "standard",
    visualPolicy: "NONE",
    scheduleIntent: "UNSCHEDULED",
    requestedPublishMode: "REVIEW"
  });
  const workspace = await bridge.getEditorialWorkspace();
  const draft = workspace.drafts.find((item) => item.id === created.id);

  assert.equal(draft?.titleTr, instruction);
  assert.equal(draft?.section, "analiz");
  assert.equal(draft?.state, "DRAFTING");
  assert.equal(draft?.reviewable, false);
});

test("demo workspace never marks an active draft reviewable or invents a measured percentage", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const workspace = await bridge.getEditorialWorkspace();
  const activeDrafts = workspace.drafts.filter((draft) => draft.state === "DRAFTING");

  assert.ok(activeDrafts.length > 0);
  for (const draft of activeDrafts) {
    assert.equal(draft.reviewable, false);
    assert.equal(draft.completion, null);
  }
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

test("demo transport supports the approval-bound local publication preview lifecycle", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const revision = await bridge.getReviewRevision("rev-demo-001");

  await bridge.approveRevision({
    revisionId: revision.id,
    expectedHash: revision.revisionHash,
    warningSetHash: "a".repeat(64)
  });
  const preview = await bridge.previewPublication({
    revisionId: revision.id,
    revisionHash: revision.revisionHash,
    payload: { files: [], bundlePolicy: {}, now: "1970-01-01T00:00:00.000Z" }
  });
  const result = await bridge.materializeLocalPreview({
    revisionId: revision.id,
    revisionHash: revision.revisionHash,
    previewHash: preview.previewHash,
    targetDirectory: "C:\\Blogbot-Demo"
  });

  assert.match(preview.previewHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.written, 0);
  assert.equal(result.backupDirectory, null);
});
