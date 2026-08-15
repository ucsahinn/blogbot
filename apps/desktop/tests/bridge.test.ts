import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BridgeError,
  createCoalescingBridge,
  createInvokeBridge,
  userFacingUpdateError,
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

test("coalescing bridge makes one native workspace call for concurrent readers", async () => {
  let calls = 0;
  const bridge = createCoalescingBridge(createInvokeBridge(async (command) => {
    assert.equal(command, "get_editorial_workspace");
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { drafts: [] };
  }));

  const [first, second] = await Promise.all([
    bridge.getEditorialWorkspace(),
    bridge.getEditorialWorkspace()
  ]);

  assert.deepEqual(first, { drafts: [] });
  assert.deepEqual(second, { drafts: [] });
  assert.equal(calls, 1);
});

test("coalescing bridge retries an in-flight workspace read after a mutation", async () => {
  const workspaceResponses: Array<(value: unknown) => void> = [];
  let workspaceCalls = 0;
  let finishPromotion: (() => void) | undefined;
  const bridge = createCoalescingBridge(createInvokeBridge(async (command) => {
    if (command === "get_editorial_workspace") {
      workspaceCalls += 1;
      return new Promise((resolve) => workspaceResponses.push(resolve));
    }
    assert.equal(command, "promote_candidate");
    return new Promise((resolve) => {
      finishPromotion = () => resolve({ ok: true, state: "RESEARCH_QUEUED", job: null });
    });
  }));

  const staleRead = bridge.getEditorialWorkspace();
  await Promise.resolve();
  const promotion = bridge.promoteCandidate("candidate-1");
  workspaceResponses[0]!({ snapshot: "before-mutation" });
  await Promise.resolve();

  assert.equal(workspaceCalls, 1, "a replacement read waits until the mutation settles");
  finishPromotion?.();
  await promotion;
  await Promise.resolve();
  assert.equal(workspaceCalls, 2);

  workspaceResponses[1]!({ snapshot: "after-mutation" });
  assert.deepEqual(await staleRead, { snapshot: "after-mutation" });
});

test("Boby guidance uses a bounded native request and a separate non-blocking status read", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return command === "request_boby_guidance"
      ? { id: "boby-1", state: "QUEUED" }
      : { id: "boby-1", state: "SUCCEEDED", reply: "Taslağı Editoryal Masa'da incele.", suggestedActions: [] };
  });

  const submitted = await bridge.requestBobyGuidance({
    question: "Taslağı nerede incelerim?",
    activePage: "content",
    runtimeState: "ONLINE",
    safeWorkspaceSummary: { draftCount: 2, reviewCount: 1, sourceCount: 3 }
  });
  const result = await bridge.getBobyGuidance("boby-1");

  assert.deepEqual(submitted, { id: "boby-1", state: "QUEUED" });
  assert.deepEqual(result, { id: "boby-1", state: "SUCCEEDED", reply: "Taslağı Editoryal Masa'da incele.", suggestedActions: [] });
  assert.deepEqual(calls, [
    {
      command: "request_boby_guidance",
      args: {
        request: {
          question: "Taslağı nerede incelerim?",
          activePage: "content",
          runtimeState: "ONLINE",
          safeWorkspaceSummary: { draftCount: 2, reviewCount: 1, sourceCount: 3 }
        }
      }
    },
    { command: "get_boby_guidance", args: { guidanceId: "boby-1" } }
  ]);
});

test("coalescing bridge does not hold a newly opened workspace behind a long mutation", async () => {
  let finishBackup: (() => void) | undefined;
  const bridge = createCoalescingBridge(createInvokeBridge(async (command) => {
    if (command === "backup_create") {
      return new Promise((resolve) => {
        finishBackup = () => resolve({ outputPath: "C:/backup.blogbot", archiveSha256: "a".repeat(64), bytes: 1, entries: 1 });
      });
    }
    assert.equal(command, "get_editorial_workspace");
    return { snapshot: "available-during-backup" };
  }));

  const backup = bridge.createBackup({
    sourceDirectory: "C:/source",
    relativePaths: ["state.json"],
    outputPath: "C:/backup.blogbot",
    recoveryKey: "recovery-key"
  });
  await Promise.resolve();

  const workspace = await Promise.race([
    bridge.getEditorialWorkspace(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("workspace read was held behind backup")), 50))
  ]);

  assert.deepEqual(workspace, { snapshot: "available-during-backup" });
  finishBackup?.();
  await backup;
});

test("coalescing bridge clears rejected reads so a later reader can retry", async () => {
  let calls = 0;
  const bridge = createCoalescingBridge(createInvokeBridge(async (command) => {
    assert.equal(command, "get_editorial_workspace");
    calls += 1;
    if (calls === 1) throw new Error("temporary native failure");
    return { drafts: [] };
  }));

  await assert.rejects(bridge.getEditorialWorkspace(), /temporary native failure/u);
  assert.deepEqual(await bridge.getEditorialWorkspace(), { drafts: [] });
  assert.equal(calls, 2);
});

test("completed snapshot freshness is opt-in and scoped", async () => {
  let defaultCalls = 0;
  const uncachedBridge = createCoalescingBridge(createInvokeBridge(async () => {
    defaultCalls += 1;
    return { drafts: [] };
  }));
  await uncachedBridge.getEditorialWorkspace();
  await uncachedBridge.getEditorialWorkspace();
  assert.equal(defaultCalls, 2);

  let cachedCalls = 0;
  const cachedBridge = createCoalescingBridge(
    createInvokeBridge(async () => {
      cachedCalls += 1;
      return { drafts: [] };
    }),
    { completedSnapshotFreshnessMs: { workspace: 1_000 } }
  );
  await cachedBridge.getEditorialWorkspace();
  await cachedBridge.getEditorialWorkspace();
  assert.equal(cachedCalls, 1);
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
    author: "Yerel Editorya",
    reviewer: "Ulaş Şahin",
    notifications: true,
    emailDigest: false,
    defaultSection: "haberler",
    showSourceReferences: true
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
          author: "Yerel Editorya",
          reviewer: "Ulaş Şahin",
          notifications: true,
          emailDigest: false,
          defaultSection: "haberler",
          showSourceReferences: true
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
    userFacingBridgeError(new Error("LOCAL_DATA_KEY_RECOVERY_REQUIRED")),
    "Yerel şifreli çalışma alanı bu Windows kullanıcısının anahtarıyla açılamadı. Uygulamayı kapatıp yeniden açın; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun."
  );
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

test("unsigned updater errors distinguish an invalid legacy response from a network outage", () => {
  assert.match(
    userFacingUpdateError(new Error("signature verification failed")),
    /eski imzalı güncelleme yolu.*SHA-256/u
  );
  assert.match(
    userFacingUpdateError(new Error("failed to connect to endpoint")),
    /Güncelleme kaynağına ulaşılamadı/u
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
  await bridge.testSetupConnector({ connector: "github", config: { owner: "owner", repository: "site" } });
  assert.deepEqual(calls, [{ command: "test_setup_connector", args: { connector: "github", config: { owner: "owner", repository: "site" } } }]);
});

test("deploy connector forwards an explicit required GitHub check policy", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return { connector: "deploy", ready: true, detail: "ok" };
  });

  await bridge.testSetupConnector({
    connector: "deploy",
    config: { workflowName: "deploy.yml", requiredChecks: ["build", "test"] }
  });

  assert.deepEqual(calls, [{
    command: "test_setup_connector",
    args: { connector: "deploy", config: { workflowName: "deploy.yml", requiredChecks: ["build", "test"] } }
  }]);
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

test("GitHub bridge starts device flow only through an explicit mutation", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return {
      status: "pending",
      writes: false,
      network: true,
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device"
    };
  });

  assert.deepEqual(await bridge.startGitHubDeviceFlow(), {
    status: "pending",
    writes: false,
    network: true,
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device"
  });
  assert.deepEqual(calls, [{ command: "github_device_flow_start", args: undefined }]);

  const readOnlyBridge = createInvokeBridge(async () => {
    throw new Error("transport must not run in read-only mode");
  }, { readOnly: true });
  await assert.rejects(
    () => readOnlyBridge.startGitHubDeviceFlow(),
    (reason: unknown) => reason instanceof BridgeError && reason.code === "OFFLINE_READ_ONLY"
  );
});

test("GitHub bridge polls and clears authorization only through explicit mutations", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    return { status: command === "github_device_flow_clear" ? "logged-out" : "pending", writes: false, network: true };
  });

  await bridge.pollGitHubDeviceFlow();
  await bridge.clearGitHubDeviceFlow();
  assert.deepEqual(calls, [
    { command: "github_device_flow_poll", args: undefined },
    { command: "github_device_flow_clear", args: undefined }
  ]);

  const readOnlyBridge = createInvokeBridge(async () => {
    throw new Error("transport must not run in read-only mode");
  }, { readOnly: true });
  await assert.rejects(() => readOnlyBridge.pollGitHubDeviceFlow(), BridgeError);
  await assert.rejects(() => readOnlyBridge.clearGitHubDeviceFlow(), BridgeError);
});

test("GitHub bridge exposes read-only broker status and dry-run intent commands", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const bridge = createInvokeBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === "github_device_flow_status") return { status: "logged-out", writes: false, network: false };
    if (command === "github_validate_repository") return { valid: true, repository: "owner/site", workflow: "deploy.yml", writes: false };
    return { mode: "dry-run", writes: false, repository: "owner/site", workflow: "deploy.yml", steps: ["validate-scope", "preview-pull-request", "record-intent"] };
  });

  await bridge.getGitHubDeviceFlowStatus();
  await bridge.validateGitHubRepository({ owner: "owner", repository: "site", workflow: "deploy.yml" });
  await bridge.previewGitHubPullRequest({ repository: "owner/site", workflow: "deploy.yml", revisionId: "rev-1", revisionHash: "a".repeat(64) });

  assert.deepEqual(calls, [
    { command: "github_device_flow_status", args: undefined },
    { command: "github_validate_repository", args: { owner: "owner", repository: "site", workflow: "deploy.yml" } },
    { command: "github_preview_pull_request", args: { repository: "owner/site", workflow: "deploy.yml", revisionId: "rev-1", revisionHash: "a".repeat(64) } }
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
  await bridge.listAutomaticBackups();
  await bridge.verifyAutomaticBackup({ backupName: "automatic-2026-08-11T00-00-00-000Z.backup" });
  await bridge.previewAutomaticBackupRestore({
    backupName: "automatic-2026-08-11T00-00-00-000Z.backup",
    targetDirectory: "C:/restore-auto"
  });
  await bridge.restoreAutomaticBackup({
    backupName: "automatic-2026-08-11T00-00-00-000Z.backup",
    targetDirectory: "C:/restore-auto"
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
    },
    { command: "automatic_backup_list", args: undefined },
    { command: "automatic_backup_verify", args: { backupName: "automatic-2026-08-11T00-00-00-000Z.backup" } },
    {
      command: "automatic_backup_restore_preview",
      args: { backupName: "automatic-2026-08-11T00-00-00-000Z.backup", targetDirectory: "C:/restore-auto" }
    },
    {
      command: "automatic_backup_restore_apply",
      args: { backupName: "automatic-2026-08-11T00-00-00-000Z.backup", targetDirectory: "C:/restore-auto" }
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
