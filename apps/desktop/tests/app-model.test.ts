import assert from "node:assert/strict";
import test from "node:test";

import * as appModel from "../src/app-model.ts";

import {
  buildInstantCreateRequest,
  connectorDraftFromState,
  hasRuntimeCapability,
  parseOpmlSources,
  parseUrlSources,
  canEnableAutomationMode,
  codexRuntimeLabel,
  articleTypeLabel,
  candidateStateLabel,
  draftStateLabel,
  failureStateLabel,
  jobTypeLabel,
  retryModeLabel,
  sectionLabel,
  sectionArticleType,
  slotStateLabel,
  isRecoveryKeyUsable,
  setupConnectorLabel,
  summarizePrerequisites,
  summarizeWorkspace
} from "../src/app-model.ts";

test("instant draft feedback distinguishes queued research from missing Codex", () => {
  const describe = (appModel as unknown as { describeInstantDraftSubmission?: (value: { id: string; state: string; queueState: string }) => unknown }).describeInstantDraftSubmission;
  assert.equal(typeof describe, "function");
  assert.deepEqual(describe?.({ id: "draft-1", state: "RESEARCHING", queueState: "QUEUED" }), {
    waitingForCodex: false,
    kicker: "ARAŞTIRMA KUYRUKTA",
    title: "İş güvenli kuyruğa alındı.",
    detail: "OPE araştırmayı yerel ve dayanıklı kuyruğunda sürdürecek."
  });
  assert.deepEqual(describe?.({ id: "draft-2", state: "WAITING_CODEX", queueState: "WAITING_CODEX" }), {
    waitingForCodex: true,
    kicker: "YAZI ÜRETİMİ BEKLİYOR",
    title: "İş kaydedildi; Codex bağlantısı bekleniyor.",
    detail: "Kaynak seçiminiz kaybolmadı. Yazı üretimi hesabını Kurulum Merkezi'nden doğruladıktan sonra bu işi yeniden deneyin."
  });
});

test("Codex runtime states never leak protocol enums into Turkish UI", () => {
  assert.equal(codexRuntimeLabel("READY"), "Hazır");
  assert.equal(codexRuntimeLabel("BUSY"), "İşleniyor");
  assert.equal(codexRuntimeLabel("UNCONFIGURED"), "Bağlantı bekliyor");
  assert.equal(codexRuntimeLabel("UNAVAILABLE"), "Kullanılamıyor");
});

test("editorial and operations protocol enums have complete Turkish labels", () => {
  assert.equal(sectionLabel("rehberler"), "Rehberler");
  assert.equal(sectionLabel("teknoloji"), "Teknoloji");
  assert.equal(sectionArticleType("ekonomi"), "news");
  assert.equal(articleTypeLabel("deep_dive"), "Derin dosya");
  assert.equal(candidateStateLabel("ROUTING_REQUIRED"), "Rota seçimi bekliyor");
  assert.equal(draftStateLabel("REVIEW_REQUIRED"), "İnceleme bekliyor");
  assert.equal(slotStateLabel("EMPTY"), "Boş");
  assert.equal(failureStateLabel("ACTION_REQUIRED"), "Müdahale gerekli");
  assert.equal(retryModeLabel("RECONCILE_FIRST"), "Önce uzlaştır");
  assert.equal(jobTypeLabel("SOURCE_SCAN"), "Kaynak taraması");
});

test("setup draft is projected from the engine-owned connector snapshot", () => {
  const state = {
    sourceState: "AVAILABLE" as const,
    mode: "LOCAL_DEV" as const,
    configured: true,
    config: {
      codex: { accountLabel: "Yerel hesap" },
      github: { owner: "editor", repository: "site", clientId: "public-client" },
      site: { repositoryPath: "C:\\site", publicSiteUrl: "", mode: "LOCAL_DEV" as const },
      deploy: { workflowName: "deploy.yml", requiredChecks: ["build"] },
      backup: { folder: "D:\\backups" }
    },
    site: {
      repositoryPath: "C:\\site",
      publicSiteUrl: "",
      adapterId: "astro-generic",
      adapterVersion: "1"
    },
    checks: {},
    localReadiness: "LOCAL_VALIDATED" as const,
    externalReadiness: "NOT_CONFIGURED" as const
  };

  const draft = connectorDraftFromState(state);

  assert.deepEqual(draft, state.config);
  assert.notEqual(draft, state.config);
  assert.notEqual(draft.site, state.config.site);
});

test("recovery key UX requires the same minimum length as the backup domain", () => {
  assert.equal(isRecoveryKeyUsable("short key"), false);
  assert.equal(isRecoveryKeyUsable("                "), false);
  assert.equal(isRecoveryKeyUsable("correct horse 2026"), true);
});

test("bulk URL parsing keeps every unique HTTP source without an app-level cap", () => {
  const input = Array.from(
    { length: 125 },
    (_, index) => `https://example.com/feed/${index}`
  ).join("\n");

  const result = parseUrlSources(`${input}\nhttps://example.com/feed/0`);

  assert.equal(result.accepted.length, 125);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted[124], "https://example.com/feed/124");
});

test("URL parsing rejects credentials, private-looking hosts, and unsupported schemes", () => {
  const result = parseUrlSources(
    [
      "ftp://example.com/feed",
      "https://user:pass@example.com/rss",
      "http://localhost:3000/feed",
      "https://security.example.org/news"
    ].join("\n")
  );

  assert.deepEqual(result.accepted, ["https://security.example.org/news"]);
  assert.deepEqual(result.rejected, [
    "ftp://example.com/feed",
    "https://user:pass@example.com/rss",
    "http://localhost:3000/feed"
  ]);
});

test("OPML parsing accepts xmlUrl and htmlUrl outlines and de-duplicates them", () => {
  const result = parseOpmlSources(`
    <opml version="2.0"><body>
      <outline text="Feed" xmlUrl="https://example.com/feed.xml" />
      <outline text="Site" htmlUrl="https://example.org/" />
      <outline text="Duplicate" xmlUrl="https://example.com/feed.xml" />
    </body></opml>
  `);

  assert.deepEqual(result.accepted, [
    "https://example.com/feed.xml",
    "https://example.org/"
  ]);
  assert.deepEqual(result.rejected, []);
});

test("instant create stays review-only and requires instruction, evidence, and route", () => {
  assert.deepEqual(
    buildInstantCreateRequest({
      instruction: "Kısa",
      sourceIds: [],
      urls: [],
      section: "",
      articleType: "news",
      urgency: "normal",
      tone: "neutral",
      length: "standard",
      visualPolicy: "GENERATE",
      scheduleIntent: "NEXT_SLOT"
    }),
    {
      valid: false,
      errors: [
        "INSTRUCTION_TOO_SHORT",
        "SOURCE_EVIDENCE_REQUIRED",
        "TARGET_SECTION_REQUIRED"
      ]
    }
  );

  assert.deepEqual(
    buildInstantCreateRequest({
      instruction: "Son kimlik güvenliği gelişmelerini kanıtlarıyla haberleştir.",
      sourceIds: ["src-1", "src-1"],
      urls: ["https://example.com/advisory", "https://example.com/advisory"],
      section: "haberler",
      articleType: "news",
      urgency: "urgent",
      tone: "technical",
      length: "deep",
      visualPolicy: "LOCAL_RENDERER",
      scheduleIntent: "UNSCHEDULED"
    }),
    {
      valid: true,
      request: {
        instruction: "Son kimlik güvenliği gelişmelerini kanıtlarıyla haberleştir.",
        sourceIds: ["src-1"],
        urls: ["https://example.com/advisory"],
        targetSection: "haberler",
        articleType: "news",
        urgency: "urgent",
        tone: "technical",
        length: "deep",
        visualPolicy: "LOCAL_RENDERER",
        scheduleIntent: "UNSCHEDULED",
        requestedPublishMode: "REVIEW"
      }
    }
  );
});

test("prerequisite summary keeps the app usable while local capabilities stay locked", () => {
  assert.deepEqual(
    summarizePrerequisites([
      { id: "windows", state: "READY", scope: "APP" },
      { id: "webview2", state: "READY", scope: "APP" },
      { id: "secure-store", state: "READY", scope: "APP" },
      { id: "local-engine", state: "MISSING", scope: "WRITE" },
      { id: "codex", state: "BLOCKED", scope: "WRITE" },
      { id: "github", state: "BLOCKED", scope: "PUBLISH" }
    ]),
    {
      appUsable: true,
      writeReady: false,
      publishReady: false,
      ready: 3,
      total: 6
    }
  );
});

test("prerequisite summary never treats an unloaded check list as ready", () => {
  assert.deepEqual(summarizePrerequisites([]), {
    appUsable: false,
    writeReady: false,
    publishReady: false,
    ready: 0,
    total: 0
  });
});

test("optional backup checks never block opening the local app", () => {
  const summary = summarizePrerequisites([
    { id: "windows", state: "READY", scope: "APP" },
    { id: "webview2", state: "READY", scope: "APP" },
    { id: "secure-store", state: "READY", scope: "APP" },
    { id: "local-engine", state: "READY", scope: "WRITE" },
    { id: "local-database", state: "READY", scope: "WRITE" },
    { id: "local-queue", state: "READY", scope: "WRITE" },
    { id: "backup", state: "BLOCKED", scope: "APP" }
  ]);
  assert.equal(summary.appUsable, true);
  assert.equal(summary.writeReady, true);
  assert.equal(summary.publishReady, false);
});

test("connector labels hide internal adapter ids from the setup UI", () => {
  assert.equal(setupConnectorLabel("codex"), "Yazı üretimi");
  assert.equal(setupConnectorLabel("github"), "GitHub");
  assert.equal(setupConnectorLabel("backup"), "Yedekleme");
});

test("automation mode availability follows prerequisite summary", () => {
  assert.equal(canEnableAutomationMode("INGEST_ONLY", { appUsable: true, writeReady: false, publishReady: false }), true);
  assert.equal(canEnableAutomationMode("DRAFT_ONLY", { appUsable: true, writeReady: false, publishReady: false }), false);
  assert.equal(canEnableAutomationMode("PUBLISH_APPROVED", { appUsable: true, writeReady: true, publishReady: false }), false);
  assert.equal(canEnableAutomationMode("PUBLISH_APPROVED", { appUsable: true, writeReady: true, publishReady: true }), true);
});

test("source scan availability follows the explicit runtime capability", () => {
  assert.equal(
    hasRuntimeCapability(["SOURCE.LIST", "SOURCE.TEST"], "SOURCE.SCAN"),
    false
  );
  assert.equal(
    hasRuntimeCapability(["SOURCE.LIST", "SOURCE.SCAN"], "SOURCE.SCAN"),
    true
  );
});

test("local mutation access follows the real bridge state instead of a synthetic capability", () => {
  const canMutateLocally = (appModel as unknown as {
    canMutateLocally?: (input: {
      engineRunning: boolean;
      bridgeReady: boolean;
    }) => boolean;
  }).canMutateLocally;

  assert.equal(typeof canMutateLocally, "function");
  assert.equal(canMutateLocally?.({ engineRunning: true, bridgeReady: true }), true);
  assert.equal(canMutateLocally?.({ engineRunning: false, bridgeReady: true }), false);
  assert.equal(canMutateLocally?.({ engineRunning: true, bridgeReady: false }), false);
});

test("workspace summary separates daily editorial work from intervention failures", () => {
  assert.deepEqual(
    summarizeWorkspace({
      today: [
        { state: "OPEN", priority: "HIGH" },
        { state: "DONE", priority: "NORMAL" }
      ],
      candidates: [
        { state: "NEW" },
        { state: "NEEDS_SOURCE" },
        { state: "DISMISSED" }
      ],
      drafts: [
        { state: "REVIEW_REQUIRED" },
        { state: "DRAFTING" }
      ],
      scheduled: [{ state: "READY" }, { state: "BLOCKED" }],
      failures: [
        { state: "ACTION_REQUIRED" },
        { state: "RETRYING" },
        { state: "RESOLVED" }
      ]
    }),
    {
      openToday: 1,
      activeCandidates: 2,
      reviewRequired: 1,
      scheduledReady: 1,
      actionRequired: 1
    }
  );
});
