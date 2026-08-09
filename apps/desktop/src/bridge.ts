import type {
  BootstrapSnapshot,
  ConnectorStateSnapshot,
  DesktopPreferences,
  EditorialWorkspaceSnapshot,
  InstantCreateCommand,
  InstantDraftSubmission,
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
  openProjectPage(): Promise<{ opened: true }>;
  checkUnsignedUpdate(): Promise<UnsignedDesktopUpdate | null>;
  installUnsignedUpdate(update: UnsignedDesktopUpdate): Promise<void>;
  getBootstrapSnapshot(): Promise<BootstrapSnapshot>;
  getPrerequisiteStatus(): Promise<PrerequisiteSnapshot>;
  testLocalEngine(): Promise<LocalEngineTestResult>;
  recoverLocalWorkspace(): Promise<{ ready: boolean; detail: string }>;
  pickLocalFolder(): Promise<string | null>;
  localDevStatus(): Promise<{ running: boolean; supported: boolean }>;
  startLocalDev(path: string, trustedProject: boolean): Promise<{ running: boolean; directory: string }>;
  stopLocalDev(): Promise<{ running: boolean }>;
  testCodexRuntime(): Promise<{ available: boolean; authenticated: boolean; runnerReady?: boolean; version?: string; detail: string }>;
  startCodexLogin(): Promise<{ started: boolean; detail: string }>;
  testSetupConnector(input: { connector: SetupConnectorId; config: SetupConnectorDraft[SetupConnectorId] }): Promise<SetupConnectorTestResult>;
  saveSetupConnector(input: { connector: SetupConnectorId; config: SetupConnectorDraft[SetupConnectorId] }): Promise<SetupConnectorTestResult>;
  getConnectorState(): Promise<ConnectorStateSnapshot>;
  getGitHubDeviceFlowStatus(): Promise<{ status: "unconfigured" | "logged-out" | "pending" | "authorized" | "degraded"; writes: false; network: boolean; scopes?: string[]; detail?: string }>;
  validateGitHubRepository(input: { owner: string; repository: string; workflow: string }): Promise<{ valid: boolean; repository: string; workflow: string; writes: false; detail?: string }>;
  previewGitHubPullRequest(input: { repository: string; workflow: string; revisionId: string; revisionHash: string }): Promise<{ mode: "dry-run"; writes: false; repository: string; workflow: string; steps: readonly string[] }>;
  getAutostartStatus(): Promise<{ enabled: boolean }>;
  setAutostart(enabled: boolean): Promise<{ enabled: boolean }>;
  sendTestNotification(): Promise<{ shown: boolean }>;
  getEditorialWorkspace(): Promise<EditorialWorkspaceSnapshot>;
  promoteCandidate(candidateId: string): Promise<{
    ok: true;
    state: "RESEARCH_QUEUED";
    job: { id?: string } | null;
  }>;
  dismissCandidate(candidateId: string): Promise<{ ok: true }>;
  retryJob(jobId: string): Promise<{ ok: true }>;
  requestRevisionEdit(input: {
    revisionId: string;
    instruction: string;
    title?: string;
  }): Promise<{
    ok: true;
    state: "RESEARCH_QUEUED";
    job: { id?: string } | null;
  }>;
  repairRevisionMedia(revisionId: string): Promise<{
    revision: { id: string; revisionHash: string };
  }>;
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
  reviewSource(input: {
    sourceId: string;
    expectedVersion: number;
    trustStatus: "APPROVED" | "REJECTED";
    rightsStatus: "APPROVED" | "REJECTED";
    rationale: string;
  }): Promise<{ source: SourceRecord }>;
  createInstantDraft(
    request: InstantCreateCommand
  ): Promise<InstantDraftSubmission>;
  getReviewRevision(revisionId: string): Promise<ReviewRevision>;
  approveRevision(input: {
    revisionId: string;
    expectedHash: string;
    warningSetHash: string;
  }): Promise<{
    approvedAt: string;
    revisionHash: string;
    state: "REVIEW_REQUIRED" | "APPROVED";
  }>;
  approveHighRiskRevision(input: {
    revisionId: string;
    expectedHash: string;
    riskChecklistHash: string;
    warningSetHash: string;
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
  exportDiagnostics(): Promise<{ path: string; directory: string; bytes: number; included: string[]; opened: boolean }>;
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

/**
 * Native commands retain stable diagnostic codes for logs and support, but
 * those codes are not useful as the primary user-facing explanation. Keep a
 * small shared mapping at the WebView boundary so every screen can present a
 * next action without inventing a successful state.
 */
export function userFacingBridgeError(
  reason: unknown,
  fallback = "İşlem tamamlanamadı. Lütfen yeniden deneyin."
): string {
  const raw = reason instanceof Error ? reason.message.trim() : "";
  const code = raw.toUpperCase();
  if (!raw) return fallback;
  if (code.includes("ENGINE_NATIVE_MODULES_MISSING")) {
    return "Blogbot'un paketlenmiş yerel engine bileşenleri eksik veya bozuk. Uygulamayı yeniden kurun; sorun sürerse Operasyonlar'dan sır içermeyen tanılama paketi oluşturun.";
  }
  if (code.includes("ENGINE_RESPONSE_TIMEOUT")) {
    return "Yerel çalışma bileşeni zamanında yanıt vermedi. Operasyonlar’dan yerel durumu yenileyin; sorun sürerse tanılama paketi oluşturun.";
  }
  if (code.includes("OFFLINE_READ_ONLY") || code.includes("ENGINE_DEGRADED")) {
    return "Yerel çalışma alanı şu anda salt okunur. Kurulum Merkezi’nden önkoşul testini çalıştırıp yeniden deneyin.";
  }
  if (code.includes("VERSION_CONFLICT")) {
    return "Veriler siz işlem yaparken değişti. Ekranı yenileyip işlemi yeniden deneyin.";
  }
  if (code.includes("CANDIDATE_SOURCE_MISSING")) {
    return "Bu adayın bağlı kaynağı artık bulunamadı. Kaynak envanterini yenileyip adayı yeniden tarayın.";
  }
  if (code.includes("CANDIDATE_CATALOG_UNAVAILABLE")) {
    return "Aday kataloğu şu anda okunamıyor. Yerel engine durumunu yenileyip tekrar deneyin.";
  }
  if (code.includes("CODEX")) {
    return "Yazı üretimi çalışma zamanı hazır değil. Kurulum Merkezi’nden Codex hesabını ve yerel runner durumunu kontrol edin.";
  }
  if (code.includes("GITHUB_CREDENTIAL_BROKER_UNAVAILABLE")) {
    return "GitHub yayın bağlantısı henüz güvenli olarak yapılandırılmadı. Yayın kuyruğu kapalı tutuldu.";
  }
  if (code.includes("BACKUP")) {
    return "Yedek işlemi tamamlanamadı. Seçilen klasörleri, dosya yolunu ve yedekleme şifresini kontrol edin.";
  }
  if (/\b(?:ENGINE|STATE|LOCAL_DATA|LOCAL_STATE)_[A-Z_]+\b/u.test(code)) {
    return "Yerel çalışma bileşeni bu işlemi doğrulayamadı. Operasyonlar’dan durumu yenileyip tekrar deneyin.";
  }
  // Native diagnostics and transport exceptions can include internal command
  // names, protocol codes, paths, or English library details. Only our typed
  // bridge errors are intentionally authored as safe Turkish user messages;
  // every other unknown error remains in diagnostics and uses the caller's
  // contextual fallback in the UI.
  return reason instanceof BridgeError ? raw : fallback;
}

export interface UnsignedDesktopUpdate {
  version: string;
  notes: string;
  url: string;
  sha256: string;
}

export function userFacingUpdateError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message.trim().toLowerCase() : "";
  if (/(?:signature|signature verification|public key|verification)/u.test(raw)) {
    return "Güncelleme kaynağına ulaşıldı, fakat eski imzalı güncelleme yolu kullanıldı. Bu sürüm SHA-256 doğrulamalı imzasız release akışını kullanır.";
  }
  if (/(?:timeout|timed out|connect|network|dns|http|endpoint)/u.test(raw)) {
    return "Güncelleme kaynağına ulaşılamadı. İnternet bağlantınızı kontrol edip yeniden deneyin.";
  }
  return "Güncelleme denetlenemedi. Blogbot imzasız GitHub release akışını kullanır; indirilen kurulum yalnızca HTTPS kaynağı ve SHA-256 özeti doğrulanırsa başlatılır. Bağlantıyı kontrol edip yeniden deneyin.";
}

export function userFacingPublicationQueueError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message.toUpperCase() : "";
  if (raw.includes("GITHUB_CREDENTIAL_BROKER_UNAVAILABLE")) {
    return "GitHub yayını güvenli depo yetkilendirmesi hazır olmadığı için kapalı. Yerel çıktı kullanın veya güvenli yayın aracısının bulunduğu sürümü bekleyin.";
  }
  return userFacingBridgeError(
    reason,
    "Yayın kuyruğuna alım tamamlanamadı. Yayın önizlemesini yeniden hazırlayın; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun."
  );
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
    openProjectPage: () => read("open_project_page"),
    checkUnsignedUpdate: () => read("check_unsigned_update"),
    installUnsignedUpdate: (update) => mutate("install_unsigned_update", { request: update }),
    getBootstrapSnapshot: () => read("get_bootstrap_snapshot"),
    getPrerequisiteStatus: () => read("get_prerequisite_status"),
    testLocalEngine: () => read("test_local_engine"),
    recoverLocalWorkspace: () => read("recover_local_workspace"),
    pickLocalFolder: () => read("pick_local_folder"),
    localDevStatus: () => read("local_dev_status"),
    startLocalDev: (path, trustedProject) => mutate("start_local_dev", { path, trustedProject }),
    stopLocalDev: () => mutate("stop_local_dev"),
    testCodexRuntime: () => read("test_codex_runtime"),
    startCodexLogin: () => mutate("start_codex_login"),
    testSetupConnector: (input) => read("test_setup_connector", input as Record<string, unknown>),
    saveSetupConnector: (input) => mutate("save_setup_connector", input as Record<string, unknown>),
    getConnectorState: () => read("get_connector_state"),
    getGitHubDeviceFlowStatus: () => read("github_device_flow_status"),
    validateGitHubRepository: (input) => read("github_validate_repository", input),
    previewGitHubPullRequest: (input) => read("github_preview_pull_request", input),
    getAutostartStatus: () => read("autostart_status"),
    setAutostart: (enabled) => mutate("set_autostart", { enabled }),
    sendTestNotification: () => mutate("send_test_notification"),
    getEditorialWorkspace: () => read("get_editorial_workspace"),
    promoteCandidate: (candidateId) =>
      mutate("promote_candidate", { candidateId }),
    dismissCandidate: (candidateId) =>
      mutate("dismiss_candidate", { candidateId }),
    retryJob: (jobId) => mutate("retry_job", { jobId }),
    requestRevisionEdit: (input) => mutate("request_revision_edit", input),
    repairRevisionMedia: (revisionId) =>
      mutate("repair_revision_media", { revisionId }),
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
    reviewSource: (input) => mutate("review_source", input),
    createInstantDraft: (request) =>
      mutate("create_instant_draft", { request }),
    getReviewRevision: (revisionId) =>
      read("get_review_revision", { revisionId }),
    approveRevision: (input) => mutate("approve_revision", input),
    approveHighRiskRevision: (input) => mutate("approve_high_risk_revision", { request: input }),
    enqueuePublication: (input) => mutate("enqueue_publication", input),
    materializeLocalPreview: (input) => mutate("materialize_local_preview", input),
    previewPublication: (input) => mutate("preview_publication", input),
    getOperations: () => read("get_operations"),
    getEngineDiagnostics: () => read("get_engine_diagnostics"),
    // A redacted support bundle is needed precisely when the runtime has
    // entered recovery mode. It is not an editorial or external effect, so
    // keep it available through the read-only bridge path.
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

/**
 * The desktop mounts and unmounts several workspaces while navigation changes.
 * Those screens often request the same local snapshot at the same time. Share
 * only short-lived reads, and clear them before every mutation so a successful
 * command can never be hidden behind stale UI data.
 */
type CoalescedSnapshot =
  | "bootstrap"
  | "prerequisites"
  | "connectors"
  | "workspace"
  | "operations"
  | "diagnostics";

export interface CoalescingBridgeOptions {
  /**
   * Completed snapshots are never reused by default. A caller may opt a
   * specific snapshot into a short monotonic freshness window when its screen
   * has independently established that reuse is safe.
   */
  completedSnapshotFreshnessMs?: Partial<Record<CoalescedSnapshot, number>>;
}

export function createCoalescingBridge(
  bridge: BlogbotBridge,
  options: CoalescingBridgeOptions = {}
): BlogbotBridge {
  const reads = new Map<CoalescedSnapshot, Promise<unknown>>();
  const completed = new Map<CoalescedSnapshot, {
    generation: number;
    validThrough: number;
    value: unknown;
  }>();
  let generation = 0;
  let pendingMutations = 0;
  let resolveMutationQuiescence: (() => void) | undefined;
  let mutationQuiescence = Promise.resolve();

  const freshnessWindow = (key: CoalescedSnapshot): number => {
    const windowMs = options.completedSnapshotFreshnessMs?.[key];
    return typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs > 0
      ? windowMs
      : 0;
  };
  const beginMutation = () => {
    generation += 1;
    completed.clear();
    reads.clear();
    if (pendingMutations === 0) {
      mutationQuiescence = new Promise<void>((resolve) => {
        resolveMutationQuiescence = resolve;
      });
    }
    pendingMutations += 1;
  };
  const finishMutation = () => {
    pendingMutations -= 1;
    if (pendingMutations === 0) {
      resolveMutationQuiescence?.();
      resolveMutationQuiescence = undefined;
    }
  };
  const readCurrent = async <T>(
    key: CoalescedSnapshot,
    read: () => Promise<T>
  ): Promise<T> => {
    await mutationQuiescence;
    const readGeneration = generation;
    const value = await read();
    await mutationQuiescence;
    if (readGeneration !== generation) {
      return readCurrent(key, read);
    }
    const windowMs = freshnessWindow(key);
    if (windowMs) {
      completed.set(key, {
        generation: readGeneration,
        validThrough: performance.now() + windowMs,
        value
      });
    }
    return value;
  };
  const share = <T>(key: CoalescedSnapshot, read: () => Promise<T>): Promise<T> => {
    const existing = reads.get(key);
    if (existing) return existing as Promise<T>;

    const cached = completed.get(key);
    if (cached && cached.generation === generation && cached.validThrough > performance.now()) {
      return Promise.resolve(cached.value as T);
    }
    completed.delete(key);

    const promise = readCurrent(key, read);
    reads.set(key, promise);
    void promise.then(
      () => {
        if (reads.get(key) === promise) reads.delete(key);
      },
      () => {
        if (reads.get(key) === promise) reads.delete(key);
      }
    );
    return promise;
  };
  const coalesced: BlogbotBridge = {
    ...bridge,
    getBootstrapSnapshot: () => share("bootstrap", () => bridge.getBootstrapSnapshot()),
    getPrerequisiteStatus: () => share("prerequisites", () => bridge.getPrerequisiteStatus()),
    getConnectorState: () => share("connectors", () => bridge.getConnectorState()),
    getEditorialWorkspace: () => share("workspace", () => bridge.getEditorialWorkspace()),
    getOperations: () => share("operations", () => bridge.getOperations()),
    getEngineDiagnostics: () => share("diagnostics", () => bridge.getEngineDiagnostics())
  };
  const invalidatingMutations = new Set([
    "installUnsignedUpdate", "recoverLocalWorkspace", "startLocalDev",
    "stopLocalDev", "startCodexLogin", "saveSetupConnector", "setAutostart",
    "sendTestNotification", "promoteCandidate", "dismissCandidate", "retryJob",
    "requestRevisionEdit", "repairRevisionMedia", "updateScheduleSlot", "saveDesktopPreferences",
    "scanSource", "scanAllSources", "saveSources", "reviewSource",
    "createInstantDraft", "approveRevision", "approveHighRiskRevision",
    "enqueuePublication", "materializeLocalPreview", "completeOnboarding",
    "setRuntimePause", "restoreBackup", "createBackup"
  ]);
  return new Proxy(coalesced, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string" || !invalidatingMutations.has(property)) {
        return value;
      }
      return (...args: unknown[]) => {
        beginMutation();
        return Promise.resolve(value(...args)).finally(finishMutation);
      };
    }
  });
}
