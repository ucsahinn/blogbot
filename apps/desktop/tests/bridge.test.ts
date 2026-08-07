import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BridgeError,
  createInvokeBridge,
  userFacingBridgeError,
  type InvokeTransport
} from "../src/bridge.ts";
import { buildSetupRequirements } from "../src/types.ts";

test("invoke bridge forwards only the named command and its typed payload", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const transport: InvokeTransport = async (command, args) => {
    calls.push({ command, args });
    return { id: "draft-7", state: "RESEARCHING", queueState: "QUEUED" };
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
  assert.deepEqual(result, { id: "draft-7", state: "RESEARCHING", queueState: "QUEUED" });
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

test("offline read-only bridge serves reads and redacted diagnostics but blocks mutations before transport", async () => {
  const calls: string[] = [];
  const transport: InvokeTransport = async (command) => {
    calls.push(command);
    return { sources: [] };
  };
  const bridge = createInvokeBridge(transport, { readOnly: true });

  await bridge.listSources();
  await bridge.getPrerequisiteStatus();
  await bridge.testLocalEngine();
  await bridge.recoverLocalWorkspace();
  await bridge.getEditorialWorkspace();
  await assert.rejects(bridge.sendTestNotification(), (error: unknown) =>
    error instanceof BridgeError && error.code === "OFFLINE_READ_ONLY"
  );
  await bridge.exportDiagnostics();
  await assert.rejects(
    bridge.approveRevision({
      revisionId: "rev-1",
      expectedHash: "abc",
      warningSetHash: "def"
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "OFFLINE_READ_ONLY"
  );

  assert.deepEqual(calls, [
    "list_sources",
    "get_prerequisite_status",
    "test_local_engine",
    "recover_local_workspace",
    "get_editorial_workspace",
    "export_diagnostics"
  ]);
});

test("bridge protocol failures become actionable Turkish user messages", () => {
  assert.equal(
    userFacingBridgeError(new Error("ENGINE_UNAVAILABLE: ENGINE_RESPONSE_TIMEOUT")),
    "Yerel çalışma bileşeni zamanında yanıt vermedi. Operasyonlar’dan yerel durumu yenileyin; sorun sürerse tanılama paketi oluşturun."
  );
  assert.equal(
    userFacingBridgeError(new Error("VERSION_CONFLICT: 12:13")),
    "Veriler siz işlem yaparken değişti. Ekranı yenileyip işlemi yeniden deneyin."
  );
  assert.equal(
    userFacingBridgeError(new Error("CANDIDATE_SOURCE_MISSING")),
    "Bu adayın bağlı kaynağı artık bulunamadı. Kaynak envanterini yenileyip adayı yeniden tarayın."
  );
});

test("local workspace recovery is an explicit no-input native command", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return { ready: true, detail: "Yeni yerel çalışma alanı hazır." };
  });

  const recoverLocalWorkspace = (bridge as unknown as {
    recoverLocalWorkspace?: () => Promise<unknown>;
  }).recoverLocalWorkspace;

  assert.equal(typeof recoverLocalWorkspace, "function");
  assert.deepEqual(await recoverLocalWorkspace?.(), { ready: true, detail: "Yeni yerel çalışma alanı hazır." });
  assert.deepEqual(calls, [{ command: "recover_local_workspace", args: undefined }]);
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

test("connector state is read from the native engine-owned snapshot", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return {
      mode: "LOCAL_ONLY",
      configured: false,
      site: {
        repositoryPath: "",
        publicSiteUrl: "",
        adapterId: null,
        adapterVersion: null
      },
      checks: {},
      localReadiness: "NOT_CONFIGURED",
      externalReadiness: "NOT_CONFIGURED"
    };
  });
  const getConnectorState = (bridge as unknown as {
    getConnectorState?: () => Promise<unknown>;
  }).getConnectorState;

  assert.equal(typeof getConnectorState, "function");
  assert.deepEqual(await getConnectorState?.(), {
    mode: "LOCAL_ONLY",
    configured: false,
    site: {
      repositoryPath: "",
      publicSiteUrl: "",
      adapterId: null,
      adapterVersion: null
    },
    checks: {},
    localReadiness: "NOT_CONFIGURED",
    externalReadiness: "NOT_CONFIGURED"
  });
  assert.deepEqual(calls, [{ command: "get_connector_state", args: undefined }]);
});

test("GitHub bridge exposes read-only broker status and dry-run intent commands", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === "github_device_flow_status") return { status: "logged-out", writes: false, network: false };
    if (command === "github_validate_repository") return { valid: true, repository: "siberdergi/site", workflow: "deploy.yml", writes: false };
    return { mode: "dry-run", writes: false, repository: "siberdergi/site", workflow: "deploy.yml", steps: ["validate-scope", "preview-pull-request", "record-intent"] };
  });

  await bridge.getGitHubDeviceFlowStatus();
  await bridge.validateGitHubRepository({ owner: "siberdergi", repository: "site", workflow: "deploy.yml" });
  await bridge.previewGitHubPullRequest({ repository: "siberdergi/site", workflow: "deploy.yml", revisionId: "rev-1", revisionHash: "a".repeat(64) });

  assert.deepEqual(calls, [
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

test("every WebView bridge command is registered by the native Tauri handler", async () => {
  const [bridgeSource, nativeEntryPoint, nativeBuildManifest, defaultPermission] = await Promise.all([
    readFile(new URL("../src/bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/build.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/permissions/default.toml", import.meta.url), "utf8")
  ]);

  const commands = new Set<string>();
  for (const match of bridgeSource.matchAll(/\b(?:read|mutate)\("([a-z0-9_]+)"/gu)) {
    commands.add(match[1]!);
  }

  assert.ok(commands.size > 40, "the bridge command inventory unexpectedly became incomplete");
  for (const command of commands) {
    assert.match(
      nativeEntryPoint,
      new RegExp(`commands::${command}\\b`, "u"),
      `${command} is callable by the WebView but is missing from Tauri's native handler`
    );
    assert.match(
      nativeBuildManifest,
      new RegExp(`"${command}"`, "u"),
      `${command} is callable by the WebView but is missing from the generated Tauri manifest`
    );
    const permission = `allow-${command.replaceAll("_", "-")}`;
    assert.match(
      defaultPermission,
      new RegExp(`"${permission}"`, "u"),
      `${command} is callable by the WebView but is not granted to Blogbot's trusted desktop window`
    );
  }
});
