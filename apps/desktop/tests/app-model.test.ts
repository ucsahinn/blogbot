import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstantCreateRequest,
  hasRuntimeCapability,
  parseOpmlSources,
  parseUrlSources,
  canEnableAutomationMode,
  isRecoveryKeyUsable,
  setupConnectorLabel,
  summarizePrerequisites,
  summarizeWorkspace
} from "../src/app-model.ts";

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
