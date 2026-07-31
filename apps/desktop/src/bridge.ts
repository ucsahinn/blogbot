import type {
  BootstrapSnapshot,
  DesktopPreferences,
  EditorialWorkspaceSnapshot,
  InstantCreateCommand,
  OnboardingSettings,
  OperationsSnapshot,
  PrerequisiteSnapshot,
  ReviewRevision,
  LocalEngineTestResult,
  SourceInput,
  SourceRecord,
  SourceScanResult,
  SourceScanStatus,
  SourceTestResult
  ,SetupConnectorDraft, SetupConnectorId, SetupConnectorTestResult
} from "./types.ts";

export type InvokeTransport = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

export interface BackupVerifyResult {
  archivePath: string;
  sha256: string;
  verified: boolean;
  entries?: ReadonlyArray<{ relativePath: string; size: number; sha256: string; status: "create" | "conflict" }>;
}

export interface BackupCreateResult {
  outputPath: string;
  archiveSha256: string;
  bytes: number;
  entries: number;
}

export interface BackupRestorePreview {
  archivePath: string;
  targetDirectory: string;
  entries: ReadonlyArray<{
    relativePath: string;
    size: number;
    status: "create" | "conflict";
  }>;
}

export class BridgeError extends Error {
  readonly code: "OFFLINE_READ_ONLY" | "BRIDGE_UNAVAILABLE" | "COMMAND_FAILED";

  constructor(
    code: "OFFLINE_READ_ONLY" | "BRIDGE_UNAVAILABLE" | "COMMAND_FAILED",
    message: string
  ) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export interface BlogbotBridge {
  getBootstrapSnapshot(): Promise<BootstrapSnapshot>;
  getPrerequisiteStatus(): Promise<PrerequisiteSnapshot>;
  testLocalEngine(): Promise<LocalEngineTestResult>;
  pickLocalFolder(): Promise<string | null>;
  localDevStatus(): Promise<{ running: boolean; logPath?: string }>;
  startLocalDev(path: string): Promise<{ running: boolean; directory: string; logPath?: string }>;
  stopLocalDev(): Promise<{ running: boolean }>;
  getLocalDevLogs(): Promise<{ path: string | null; lines: string[] }>;
  testCodexRuntime(): Promise<{ available: boolean; authenticated: boolean; runnerReady?: boolean; version?: string; detail: string }>;
  startCodexLogin(): Promise<{ started: boolean; detail: string }>;
  testSetupConnector(input: { connector: SetupConnectorId; config: SetupConnectorDraft[SetupConnectorId] }): Promise<SetupConnectorTestResult>;
  saveSetupConnector(input: { connector: SetupConnectorId; config: SetupConnectorDraft[SetupConnectorId] }): Promise<SetupConnectorTestResult>;
  startGitHubDeviceFlow(): Promise<{ started: boolean; writes: false; network: boolean; verificationUri?: string; userCode?: string; detail?: string }>;
  getGitHubDeviceFlowStatus(): Promise<{ status: "unconfigured" | "logged-out" | "pending" | "authorized" | "degraded"; writes: false; network: boolean; scopes?: string[]; detail?: string }>;
  validateGitHubRepository(input: { owner: string; repository: string; workflow: string }): Promise<{ valid: boolean; repository: string; workflow: string; writes: false; detail?: string }>;
  previewGitHubPullRequest(input: { repository: string; workflow: string; revisionId: string; revisionHash: string }): Promise<{ mode: "dry-run"; writes: false; repository: string; workflow: string; steps: readonly string[] }>;
  getAutostartStatus(): Promise<{ enabled: boolean }>;
  setAutostart(enabled: boolean): Promise<{ enabled: boolean }>;
  sendTestNotification(): Promise<{ shown: boolean }>;
  getEditorialWorkspace(): Promise<EditorialWorkspaceSnapshot>;
  promoteCandidate(candidateId: string): Promise<{ ok: true }>;
  dismissCandidate(candidateId: string): Promise<{ ok: true }>;
  retryJob(jobId: string): Promise<{ ok: true }>;
  requestRevisionEdit(input: {
    revisionId: string;
    instruction: string;
  }): Promise<{ ok: true }>;
  updateScheduleSlot(input: {
    slotId: string;
    enabled: boolean;
    time: string;
  }): Promise<{ ok: true }>;
  saveDesktopPreferences(
    preferences: DesktopPreferences
  ): Promise<{ ok: true }>;
  listSources(): Promise<{ sources: SourceRecord[] }>;
  testSource(url: string): Promise<SourceTestResult>;
  scanSource(sourceId: string): Promise<SourceScanResult>;
  scanAllSources(): Promise<SourceScanResult>;
  getSourceScanStatus(operationId: string): Promise<SourceScanStatus>;
  previewOpml(input: string): Promise<{ urls: string[] }>;
  saveSources(sources: SourceInput[]): Promise<{ sources: SourceRecord[] }>;
  createInstantDraft(
    request: InstantCreateCommand
  ): Promise<{ id: string; state: "RESEARCHING" }>;
  getReviewRevision(revisionId: string): Promise<ReviewRevision>;
  approveRevision(input: {
    revisionId: string;
    expectedHash: string;
  }): Promise<{
    approvedAt: string;
    revisionHash: string;
    state: "REVIEW_REQUIRED" | "APPROVED";
  }>;
  approveHighRiskRevision(input: {
    revisionId: string;
    expectedHash: string;
    riskChecklistHash: string;
    confirmReauthenticated: boolean;
  }): Promise<{ approvedAt: string; revisionHash: string; approvalType: "HIGH_RISK" }>;
  enqueuePublication(input: {
    revisionId: string;
    revisionHash: string;
    previewHash: string;
  }): Promise<{ id: string; state: string; revisionId: string; revisionHash: string }>;
  materializeLocalPreview(input: {
    revisionId: string;
    revisionHash: string;
    previewHash: string;
    targetDirectory: string;
  }): Promise<{ written: number; targetDirectory: string; backupDirectory?: string }>;
  previewPublication(input: {
    revisionId: string;
    revisionHash: string;
    payload: Record<string, unknown>;
  }): Promise<{ previewHash: string; [key: string]: unknown }>;
  getOperations(): Promise<OperationsSnapshot>;
  getEngineDiagnostics(): Promise<{ path: string | null; lines: string[] }>;
  exportDiagnostics(): Promise<{ path: string; bytes: number; included: string[] }>;
  completeOnboarding(
    settings: OnboardingSettings
  ): Promise<{ completed: true }>;
  setRuntimePause(input: {
    target: "ingestion" | "publishing";
    paused: boolean;
  }): Promise<{ paused: boolean }>;
  verifyBackup(input: { archivePath: string; recoveryKey: string }): Promise<BackupVerifyResult>;
  previewBackupRestore(input: {
    archivePath: string;
    targetDirectory: string;
    recoveryKey: string;
  }): Promise<BackupRestorePreview>;
  restoreBackup(input: {
    archivePath: string;
    targetDirectory: string;
    recoveryKey: string;
  }): Promise<{ restored: true; targetDirectory: string; entries: number }>;
  createBackup(input: {
    sourceDirectory: string;
    relativePaths: string[];
    outputPath: string;
    recoveryKey: string;
  }): Promise<BackupCreateResult>;
}

function resultAs<T>(value: unknown): T {
  return value as T;
}

export function createInvokeBridge(
  invoke: InvokeTransport,
  options: { readOnly?: boolean } = {}
): BlogbotBridge {
  const readOnly = options.readOnly ?? false;

  const read = async <T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> => resultAs<T>(await invoke(command, args));

  const mutate = async <T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> => {
    if (readOnly) {
      throw new BridgeError(
        "OFFLINE_READ_ONLY",
        "Yerel çalışma bileşeni kurtarma modunda. Kurulum Merkezi'ndeki Önkoşul testini çalıştırıp yeniden deneyin."
      );
    }
    return resultAs<T>(await invoke(command, args));
  };

  return {
    getBootstrapSnapshot: () => read("get_bootstrap_snapshot"),
    getPrerequisiteStatus: () => read("get_prerequisite_status"),
    testLocalEngine: () => read("test_local_engine"),
    pickLocalFolder: () => read("pick_local_folder"),
    localDevStatus: () => read("local_dev_status"),
    startLocalDev: (path) => mutate("start_local_dev", { path }),
    stopLocalDev: () => mutate("stop_local_dev"),
    getLocalDevLogs: () => read("get_local_dev_logs"),
    testCodexRuntime: () => read("test_codex_runtime"),
    startCodexLogin: () => mutate("start_codex_login"),
    testSetupConnector: (input) => read("test_setup_connector", input as Record<string, unknown>),
    saveSetupConnector: (input) => mutate("save_setup_connector", input as Record<string, unknown>),
    startGitHubDeviceFlow: () => mutate("github_device_flow_start"),
    getGitHubDeviceFlowStatus: () => read("github_device_flow_status"),
    validateGitHubRepository: (input) => read("github_validate_repository", input),
    previewGitHubPullRequest: (input) => read("github_preview_pull_request", input),
    getAutostartStatus: () => read("autostart_status"),
    setAutostart: (enabled) => mutate("set_autostart", { enabled }),
    sendTestNotification: () => read("send_test_notification"),
    getEditorialWorkspace: () => read("get_editorial_workspace"),
    promoteCandidate: (candidateId) =>
      mutate("promote_candidate", { candidateId }),
    dismissCandidate: (candidateId) =>
      mutate("dismiss_candidate", { candidateId }),
    retryJob: (jobId) => mutate("retry_job", { jobId }),
    requestRevisionEdit: (input) => mutate("request_revision_edit", input),
    updateScheduleSlot: (input) => mutate("update_schedule_slot", input),
    saveDesktopPreferences: (preferences) =>
      mutate("save_desktop_preferences", { preferences }),
    listSources: () => read("list_sources"),
    testSource: (url) => read("test_source", { url }),
    scanSource: (sourceId) => mutate("scan_source", { sourceId }),
    scanAllSources: () => mutate("scan_all_sources"),
    getSourceScanStatus: (operationId) =>
      read("get_source_scan_status", { operationId }),
    previewOpml: (input) => read("preview_opml", { input }),
    saveSources: (sources) => mutate("save_sources", { sources }),
    createInstantDraft: (request) =>
      mutate("create_instant_draft", { request }),
    getReviewRevision: (revisionId) =>
      read("get_review_revision", { revisionId }),
    approveRevision: (input) => mutate("approve_revision", input),
    approveHighRiskRevision: (input) => mutate("approve_high_risk_revision", input),
    enqueuePublication: (input) => mutate("enqueue_publication", input),
    materializeLocalPreview: (input) => mutate("materialize_local_preview", input),
    previewPublication: (input) => mutate("preview_publication", input),
    getOperations: () => read("get_operations"),
    getEngineDiagnostics: () => read("get_engine_diagnostics"),
    exportDiagnostics: () => read("export_diagnostics"),
    completeOnboarding: (settings) =>
      mutate("complete_onboarding", {
        settings: {
          deviceName: settings.deviceName,
          mode: settings.mode,
          scanIntervalMinutes: settings.scanIntervalMinutes,
          acknowledgeApprovalBoundary: settings.acknowledgeApprovalBoundary,
          autostartEnabled: settings.autostartEnabled
        }
      }),
    setRuntimePause: (input) => mutate("set_runtime_pause", input)
    ,verifyBackup: (input) => read("backup_verify", input)
    ,previewBackupRestore: (input) => read("backup_restore_preview", input)
    ,restoreBackup: (input) => mutate("backup_restore_apply", input)
    ,createBackup: (input) => mutate("backup_create", input)
  };
}
