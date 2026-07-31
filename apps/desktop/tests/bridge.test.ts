import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeError,
  createInvokeBridge,
  type InvokeTransport
} from "../src/bridge.ts";
import { buildSetupRequirements } from "../src/types.ts";

test("invoke bridge forwards only the named command and its typed payload", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const transport: InvokeTransport = async (command, args) => {
    calls.push({ command, args });
    return { id: "draft-7", state: "RESEARCHING" };
  };
  const bridge = createInvokeBridge(transport);

  const result = await bridge.createInstantDraft({
    instruction: "Birincil kaynağı temel alan özgün bir haber hazırla.",
    sourceIds: ["src-1"],
    urls: [],
    targetSection: "haberler",
    articleType: "news",
    urgency: "normal",
    tone: "neutral",
    length: "standard",
    visualPolicy: "GENERATE",
    scheduleIntent: "NEXT_SLOT",
    requestedPublishMode: "REVIEW"
  });

  assert.deepEqual(calls, [
    {
      command: "create_instant_draft",
      args: {
        request: {
          instruction: "Birincil kaynağı temel alan özgün bir haber hazırla.",
          sourceIds: ["src-1"],
          urls: [],
          targetSection: "haberler",
          articleType: "news",
          urgency: "normal",
          tone: "neutral",
          length: "standard",
          visualPolicy: "GENERATE",
          scheduleIntent: "NEXT_SLOT",
          requestedPublishMode: "REVIEW"
        }
      }
    }
  ]);
  assert.deepEqual(result, { id: "draft-7", state: "RESEARCHING" });
});

test("editorial workspace actions use explicit commands instead of a generic action channel", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const transport: InvokeTransport = async (command, args) => {
    calls.push({ command, args });
    return { ok: true };
  };
  const bridge = createInvokeBridge(transport);

  await bridge.promoteCandidate("candidate-1");
  await bridge.dismissCandidate("candidate-2");
  await bridge.retryJob("job-1");
  await bridge.requestRevisionEdit({
    revisionId: "rev-1",
    instruction: "İkinci iddiayı birincil kaynakla yeniden doğrula."
  });
  await bridge.updateScheduleSlot({
    slotId: "slot-mon",
    enabled: true,
    time: "10:30"
  });
  await bridge.saveDesktopPreferences({
    author: "SiberDergi Editorya",
    reviewer: "Ulaş Şahin",
    notifications: true,
    emailDigest: false,
    defaultSection: "haberler"
  });
  await bridge.scanSource("source-1");
  await bridge.scanAllSources();
  await bridge.getSourceScanStatus("desktop-scan-1");

  assert.deepEqual(calls, [
    { command: "promote_candidate", args: { candidateId: "candidate-1" } },
    { command: "dismiss_candidate", args: { candidateId: "candidate-2" } },
    { command: "retry_job", args: { jobId: "job-1" } },
    {
      command: "request_revision_edit",
      args: {
        revisionId: "rev-1",
        instruction: "İkinci iddiayı birincil kaynakla yeniden doğrula."
      }
    },
    {
      command: "update_schedule_slot",
      args: { slotId: "slot-mon", enabled: true, time: "10:30" }
    },
    {
      command: "save_desktop_preferences",
      args: {
        preferences: {
          author: "SiberDergi Editorya",
          reviewer: "Ulaş Şahin",
          notifications: true,
          emailDigest: false,
          defaultSection: "haberler"
        }
      }
    },
    { command: "scan_source", args: { sourceId: "source-1" } },
    { command: "scan_all_sources", args: undefined },
    {
      command: "get_source_scan_status",
      args: { operationId: "desktop-scan-1" }
    }
  ]);
});

test("publication enqueue forwards the immutable preview hash", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return { id: "effect-1", state: "PENDING" };
  });
  await bridge.enqueuePublication({
    revisionId: "rev-1",
    revisionHash: "a".repeat(64),
    previewHash: "b".repeat(64)
  });
  assert.deepEqual(calls, [{
    command: "enqueue_publication",
    args: { revisionId: "rev-1", revisionHash: "a".repeat(64), previewHash: "b".repeat(64) }
  }]);
});

test("offline read-only bridge serves reads and blocks mutations before transport", async () => {
  const calls: string[] = [];
  const transport: InvokeTransport = async (command) => {
    calls.push(command);
    return { sources: [] };
  };
  const bridge = createInvokeBridge(transport, { readOnly: true });

  await bridge.listSources();
  await bridge.getPrerequisiteStatus();
  await bridge.testLocalEngine();
  await bridge.getEditorialWorkspace();
  await bridge.sendTestNotification();
  await assert.rejects(
    bridge.approveRevision({
      revisionId: "rev-1",
      expectedHash: "abc"
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "OFFLINE_READ_ONLY"
  );

  assert.deepEqual(calls, [
    "list_sources",
    "get_prerequisite_status",
    "test_local_engine",
    "get_editorial_workspace",
    "send_test_notification"
  ]);
});

test("onboarding bridge sends only local runtime settings", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return { completed: true };
  });

  await bridge.completeOnboarding({
    deviceName: "Editör PC",
    mode: "DRAFT_ONLY",
    scanIntervalMinutes: 30,
    acknowledgeApprovalBoundary: true,
    autostartEnabled: true
  });

  assert.deepEqual(calls, [
    {
      command: "complete_onboarding",
      args: {
        settings: {
          deviceName: "Editör PC",
          mode: "DRAFT_ONLY",
          scanIntervalMinutes: 30,
          acknowledgeApprovalBoundary: true,
          autostartEnabled: true
        }
      }
    }
  ]);
});

test("setup requirements distinguish local installation from external authorization without secret fields", () => {
  const requirements = buildSetupRequirements([]);
  assert.deepEqual(
    requirements.filter((item) => item.kind === "EXTERNAL_AUTHORIZATION").map((item) => item.id),
    ["codex", "github", "site"]
  );
  assert.ok(requirements.some((item) => item.kind === "LOCAL_INSTALL"));
  assert.ok(requirements.every((item) => item.secretField === false));
  assert.ok(requirements.some((item) => item.id === "backup" && item.kind === "EXTERNAL_CONFIGURATION"));
});

test("setup connector dry-run forwards only redacted configuration", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => { calls.push({ command, args }); return { connector: "github", ready: true, detail: "ok" }; });
  await bridge.testSetupConnector({ connector: "github", config: { owner: "siberdergi", repository: "site" } });
  assert.deepEqual(calls, [{ command: "test_setup_connector", args: { connector: "github", config: { owner: "siberdergi", repository: "site" } } }]);
});

test("GitHub bridge exposes credential-safe device-flow and dry-run intent commands", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === "github_device_flow_start") return { started: false, writes: false, network: false, detail: "authorization requires explicit user action" };
    if (command === "github_device_flow_status") return { status: "logged-out", writes: false, network: false };
    if (command === "github_validate_repository") return { valid: true, repository: "siberdergi/site", workflow: "deploy.yml", writes: false };
    return { mode: "dry-run", writes: false, repository: "siberdergi/site", workflow: "deploy.yml", steps: ["validate-scope", "preview-pull-request", "record-intent"] };
  });

  await bridge.startGitHubDeviceFlow();
  await bridge.getGitHubDeviceFlowStatus();
  await bridge.validateGitHubRepository({ owner: "siberdergi", repository: "site", workflow: "deploy.yml" });
  await bridge.previewGitHubPullRequest({ repository: "siberdergi/site", workflow: "deploy.yml", revisionId: "rev-1", revisionHash: "a".repeat(64) });

  assert.deepEqual(calls, [
    { command: "github_device_flow_start", args: undefined },
    { command: "github_device_flow_status", args: undefined },
    { command: "github_validate_repository", args: { owner: "siberdergi", repository: "site", workflow: "deploy.yml" } },
    { command: "github_preview_pull_request", args: { repository: "siberdergi/site", workflow: "deploy.yml", revisionId: "rev-1", revisionHash: "a".repeat(64) } }
  ]);
});

test("backup bridge exposes preview-first commands without persisting recovery keys", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === "backup_restore_preview") {
      return { archivePath: "C:/backups/latest.blogbot", targetDirectory: "C:/restore", entries: [] };
    }
    if (command === "backup_restore_apply") {
      return { restored: true, targetDirectory: "C:/restore", entries: 1 };
    }
    if (command === "backup_create") {
      return { outputPath: "C:/backups/new.blogbot", archiveSha256: "b".repeat(64), bytes: 128, entries: 1 };
    }
    return { archivePath: "C:/backups/latest.blogbot", sha256: "a".repeat(64), verified: true };
  });

  await bridge.verifyBackup({ archivePath: "C:/backups/latest.blogbot", recoveryKey: "test-recovery-key" });
  await bridge.previewBackupRestore({
    archivePath: "C:/backups/latest.blogbot",
    targetDirectory: "C:/restore",
    recoveryKey: "test-recovery-key"
  });
  await bridge.restoreBackup({
    archivePath: "C:/backups/latest.blogbot",
    targetDirectory: "C:/restore",
    recoveryKey: "test-recovery-key"
  });
  await bridge.createBackup({
    sourceDirectory: "C:/Blogbot/data",
    relativePaths: ["state.json"],
    outputPath: "C:/backups/new.blogbot",
    recoveryKey: "test-recovery-key"
  });

  assert.deepEqual(calls, [
    { command: "backup_verify", args: { archivePath: "C:/backups/latest.blogbot", recoveryKey: "test-recovery-key" } },
    {
      command: "backup_restore_preview",
      args: { archivePath: "C:/backups/latest.blogbot", targetDirectory: "C:/restore", recoveryKey: "test-recovery-key" }
    },
    {
      command: "backup_restore_apply",
      args: { archivePath: "C:/backups/latest.blogbot", targetDirectory: "C:/restore", recoveryKey: "test-recovery-key" }
    },
    {
      command: "backup_create",
      args: { sourceDirectory: "C:/Blogbot/data", relativePaths: ["state.json"], outputPath: "C:/backups/new.blogbot", recoveryKey: "test-recovery-key" }
    }
  ]);
});

test("diagnostic bridge exports a redacted local support package", async () => {
  const calls: string[] = [];
  const bridge = createInvokeBridge(async (command) => {
    calls.push(command);
    return { path: "C:/Users/test/AppData/Local/Blogbot/diagnostics/latest.json", bytes: 42, included: ["engine"] };
  });

  const result = await bridge.exportDiagnostics();

  assert.equal(result.bytes, 42);
  assert.deepEqual(calls, ["export_diagnostics"]);
});
