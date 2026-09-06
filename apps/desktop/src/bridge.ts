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

export interface AutomaticBackupSnapshot {
  name: string;
  bytes: number;
  createdAt: string;
}

export interface AutomaticBackupRestoreSummary {
  archivePath: string;
  createdAt: string;
  tables: ReadonlyArray<{ name: string; rowCount: number }>;
  rows: number;
}

export interface AutomaticBackupVerifyResult extends AutomaticBackupRestoreSummary {
  verified: boolean;
}

export interface AutomaticBackupRestoreResult extends AutomaticBackupRestoreSummary {
  restoredRows: number;
}

export type EditorialSourceRoleV3 = "primary" | "independent" | "supporting";

export interface EditorialApprovalAttestationV3 {
  editorialReview: {
    reviewer: string;
    sourceRoles: Array<{ sourceId: string; role: EditorialSourceRoleV3 }>;
  };
  expertReview: null | {
    reviewer: string;
    qualifications: string;
    reviewScope: string;
  };
  ethicsReview: null | {
    reviewer: string;
    reviewScope: string;
    rationale: string;
  };
}

export type GitHubDeviceFlowStatus = "unconfigured" | "logged-out" | "pending" | "authorized" | "reauthorization-required" | "expired" | "access-denied" | "degraded";

export interface GitHubDeviceFlowResult {
  status: GitHubDeviceFlowStatus;
  writes: false;
  network: boolean;
  userCode?: string;
  verificationUri?: "https://github.com/login/device";
  repository?: string;
  permissions?: string[];
  detail?: string;
}

export interface BobyGuidanceRequest {
  question: string;
  activePage: string;
  runtimeState: "ONLINE" | "DEGRADED" | "OFFLINE";
  safeWorkspaceSummary: { draftCount: number; reviewCount: number; sourceCount: number };
}

export interface BobyGuidanceStatus {
  id: string;
  state: "QUEUED" | "RUNNING" | "WAITING_CODEX" | "SUCCEEDED" | "FAILED";
  reply?: string;
  waitReason?: string;
  suggestedActions?: Array<{ id: string; label: string }>;
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
  checkUnsignedUpdate(): Promise<UnsignedDesktopUpdateCheck>;
  installUnsignedUpdate(update: UnsignedDesktopUpdate): Promise<void>;
  getBootstrapSnapshot(options?: { fresh?: boolean }): Promise<BootstrapSnapshot>;
  getPrerequisiteStatus(): Promise<PrerequisiteSnapshot>;
  testLocalEngine(): Promise<LocalEngineTestResult>;
  verifyLocalIntegrity(): Promise<{ verified: true; completedAt: string }>;
  recoverLocalWorkspace(): Promise<{ ready: boolean; detail: string }>;
  pickLocalFolder(): Promise<string | null>;
  localDevStatus(): Promise<{ running: boolean; supported: boolean }>;
  startLocalDev(path: string, trustedProject: boolean): Promise<{ running: boolean; directory: string }>;
  stopLocalDev(): Promise<{ running: boolean }>;
  testCodexRuntime(): Promise<{ available: boolean; authenticated: boolean; runnerReady?: boolean; version?: string; detail: string }>;
  startCodexLogin(): Promise<{ started: boolean; detail: string }>;
  testSetupConnector(input: { connector: SetupConnectorId; config: SetupConnectorDraft[SetupConnectorId] }): Promise<SetupConnectorTestResult>;
  saveSetupConnector(input: { connector: SetupConnectorId; config: SetupConnectorDraft[SetupConnectorId] }): Promise<SetupConnectorTestResult>;
  getConnectorState(options?: { fresh?: boolean }): Promise<ConnectorStateSnapshot>;
  startGitHubDeviceFlow(): Promise<GitHubDeviceFlowResult>;
  pollGitHubDeviceFlow(): Promise<GitHubDeviceFlowResult>;
  clearGitHubDeviceFlow(): Promise<GitHubDeviceFlowResult>;
  getGitHubDeviceFlowStatus(): Promise<GitHubDeviceFlowResult>;
  validateGitHubRepository(input: { owner: string; repository: string; workflow: string }): Promise<{ valid: boolean; repository: string; workflow: string; writes: false; detail?: string }>;
  /**
   * Reads the base-branch tip and stores it with the connector.
   *
   * Approval binds `targetBaseSha`, so a PUBLISH-mode revision cannot be
   * approved until this has run at least once. It fails closed when GitHub is
   * not authorized rather than reporting a SHA it never read.
   */
  captureGitHubBaseSha(input: { owner: string; repository: string; branch: string }): Promise<{ captured: boolean; repository?: string; branch?: string; baseSha?: string; reason?: string; detail?: string }>;
  previewGitHubPullRequest(input: { repository: string; workflow: string; revisionId: string; revisionHash: string }): Promise<{ mode: "dry-run"; writes: false; repository: string; workflow: string; steps: readonly string[] }>;
  getAutostartStatus(): Promise<{ enabled: boolean }>;
  setAutostart(enabled: boolean): Promise<{ enabled: boolean }>;
  sendTestNotification(): Promise<{ shown: boolean }>;
  requestBobyGuidance(request: BobyGuidanceRequest): Promise<Pick<BobyGuidanceStatus, "id" | "state">>;
  getBobyGuidance(guidanceId: string): Promise<BobyGuidanceStatus>;
  getEditorialWorkspace(options?: { includeCandidates?: boolean; fresh?: boolean }): Promise<EditorialWorkspaceSnapshot>;
  promoteCandidate(candidateId: string): Promise<{
    ok: true;
    state: "RESEARCH_QUEUED";
    job: { id?: string } | null;
  }>;
  dismissCandidate(candidateId: string): Promise<{ ok: true }>;
  /** Hides local desk rows without deleting their immutable editorial records. */
  hideDrafts(draftIds: readonly string[]): Promise<{ ok: true; hidden: number }>;
  restoreHiddenDrafts(): Promise<{ ok: true; restored: number }>;
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
    articleId?: string | null;
    articleTitle?: string | null;
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
  readRevisionMedia(input: { revisionId: string; sha256: string }): Promise<{ contentBase64: string; mimeType: string }>;
  approveRevision(input: {
    revisionId: string;
    expectedHash: string;
    warningSetHash: string;
    packageVersion: 3;
    attestation: EditorialApprovalAttestationV3;
  }): Promise<{
    approvedAt: string;
    revisionHash: string;
    state: "REVIEW_REQUIRED" | "APPROVED";
  }>;
  revokeApproval(input: {
    revisionId: string;
    expectedHash: string;
    reason: string;
  }): Promise<{
    revokedAt: string;
    revisionHash: string;
    state: "REVIEW_REQUIRED";
    recalledEffectIds: string[];
  }>;
  approveHighRiskRevision(input: {
    revisionId: string;
    expectedHash: string;
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
  listAutomaticBackups(): Promise<{ snapshots: AutomaticBackupSnapshot[] }>;
  verifyAutomaticBackup(input: { backupName: string }): Promise<AutomaticBackupVerifyResult>;
  previewAutomaticBackupRestore(input: { backupName: string }): Promise<AutomaticBackupVerifyResult>;
  restoreAutomaticBackup(input: {
    backupName: string;
    confirmReplaceLocalData: true;
  }): Promise<AutomaticBackupRestoreResult>;
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
  const raw = reason instanceof Error ? reason.message.trim() : typeof reason === "string" ? reason.trim() : "";
  const code = raw.toUpperCase();
  if (!raw) return fallback;
  if (code.includes("ENGINE_NATIVE_MODULES_MISSING")) {
    return "OPE'nin paketlenmiş yerel engine bileşenleri eksik veya bozuk. Uygulamayı yeniden kurun; sorun sürerse Operasyonlar'dan sır içermeyen tanılama paketi oluşturun.";
  }
  if (code.includes("LOCAL_DATA_KEY_RECOVERY_REQUIRED")) {
    return "Yerel şifreli çalışma alanı bu Windows kullanıcısının anahtarıyla açılamadı. Uygulamayı kapatıp yeniden açın; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun.";
  }
  if (code.includes("LOCAL_DATA_DECRYPT_FAILED") || code.includes("ENGINE_CLOSED_PIPE") || code.includes("ENGINE_PROTOCOL_FAULT") || code.includes("ENGINE_READ_FAILED")) {
    return "Yerel şifreli çalışma alanı açılamadı. Kurulum Merkezi’ndeki Tanılama ve onarım bölümünden Yerel veri bütünlüğünü doğrula adımını çalıştırın; veri silinmez.";
  }
  if (code.includes("ENGINE_RESPONSE_TIMEOUT")) {
    return "Yerel çalışma bileşeni zamanında yanıt vermedi. Operasyonlar’dan yerel durumu yenileyin; sorun sürerse tanılama paketi oluşturun.";
  }
  if (code.includes("BOOTSTRAP_TIMEOUT")) {
    return "OPE çalışma alanı hazırlanırken zaman aşımına uğradı. Yeniden deneyin; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun.";
  }
  if (code.includes("OFFLINE_READ_ONLY") || code.includes("ENGINE_DEGRADED")) {
    return "Yerel çalışma alanı şu anda salt okunur. Kurulum Merkezi’nden önkoşul testini çalıştırıp yeniden deneyin.";
  }
  if (code.includes("VERSION_CONFLICT")) {
    return "Veriler siz işlem yaparken değişti. Ekranı yenileyip işlemi yeniden deneyin.";
  }
  if (code.includes("REVISION_REVIEW_UPGRADE_REQUIRED")) {
    return "Bu eski revizyon yalnızca okunabilir. İnsan inceleme beyanı içeren V3 paketini oluşturup yeni revizyonu açın.";
  }
  if (code.includes("EDITORIAL_ATTESTATION")) {
    return "İnsan inceleme beyanı tamamlanmadı. Editör adını, her kaynağın rol onayını ve gerekli uzman veya etik inceleme alanlarını doldurun.";
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

export type UnsignedDesktopUpdateCheck =
  | { kind: "updateAvailable"; update: UnsignedDesktopUpdate }
  | { kind: "upToDate"; latestVersion: string }
  | { kind: "localBuildNewer"; latestVersion: string };

export function userFacingUpdateError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message.trim().toLowerCase() : "";
  if (/(?:signature|signer|authenticode|timestamp|time-stamp|public key|verification)/u.test(raw)) {
    return "İmzalı güncelleme doğrulanamadı. SHA-256, Windows yayıncı kimliği veya güvenilir zaman damgası kapısı geçilemedi. Kurulum başlatılmadı.";
  }
  if (/(?:timeout|timed out|connect|network|dns|http|endpoint)/u.test(raw)) {
    return "Güncelleme kaynağına ulaşılamadı. İnternet bağlantınızı kontrol edip yeniden deneyin.";
  }
  return "Güncelleme denetlenemedi. OPE kurulumu yalnız HTTPS kaynağı, SHA-256 özeti, sabitlenmiş Windows yayıncı kimliği ve güvenilir zaman damgası doğrulanırsa başlatır. Bağlantıyı kontrol edip yeniden deneyin.";
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
    verifyLocalIntegrity: () => mutate("verify_local_integrity"),
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
    startGitHubDeviceFlow: () => mutate("github_device_flow_start"),
    pollGitHubDeviceFlow: () => mutate("github_device_flow_poll"),
    clearGitHubDeviceFlow: () => mutate("github_device_flow_clear"),
    getGitHubDeviceFlowStatus: () => read("github_device_flow_status"),
    validateGitHubRepository: (input) => read("github_validate_repository", input),
    captureGitHubBaseSha: (input) => read("github_capture_base_sha", input),
    previewGitHubPullRequest: (input) => read("github_preview_pull_request", input),
    getAutostartStatus: () => read("autostart_status"),
    setAutostart: (enabled) => mutate("set_autostart", { enabled }),
    sendTestNotification: () => mutate("send_test_notification"),
    requestBobyGuidance: (request) => mutate("request_boby_guidance", { request }),
    getBobyGuidance: (guidanceId) => read("get_boby_guidance", { guidanceId }),
    getEditorialWorkspace: (options) => read("get_editorial_workspace", options?.includeCandidates ? { includeCandidates: true } : undefined),
    promoteCandidate: (candidateId) =>
      mutate("promote_candidate", { candidateId }),
    dismissCandidate: (candidateId) =>
      mutate("dismiss_candidate", { candidateId }),
    hideDrafts: (draftIds) => mutate("hide_drafts", { draftIds }),
    restoreHiddenDrafts: () => mutate("restore_hidden_drafts"),
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
    readRevisionMedia: (input) => read("read_revision_media", input),
    approveRevision: (input) => mutate("approve_revision", input),
    revokeApproval: (input) => mutate("revoke_revision_approval", input),
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
    ,listAutomaticBackups: () => read("automatic_backup_list")
    ,verifyAutomaticBackup: (input) => read("automatic_backup_verify", input)
    ,previewAutomaticBackupRestore: (input) => read("automatic_backup_restore_preview", input)
    ,restoreAutomaticBackup: (input) => mutate("automatic_backup_restore_apply", input)
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
  | "workspaceCandidates"
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
    snapshotGeneration: number;
    validThrough: number;
    value: unknown;
  }>();
  const snapshotGenerations = new Map<CoalescedSnapshot, number>();
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
  const snapshotGeneration = (key: CoalescedSnapshot): number => snapshotGenerations.get(key) ?? 0;
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
    // A backup, repair, or other durable mutation can take minutes. New
    // navigation must keep rendering the last available local projection
    // while that work continues; only a read that actually crossed a
    // mutation boundary is stale and has to wait for reconciliation.
    const readGeneration = generation;
    const readSnapshotGeneration = snapshotGeneration(key);
    const value = await read();
    if (readGeneration !== generation || readSnapshotGeneration !== snapshotGeneration(key)) {
      await mutationQuiescence;
      return readCurrent(key, read);
    }
    const windowMs = freshnessWindow(key);
    if (windowMs) {
      completed.set(key, {
        generation: readGeneration,
        snapshotGeneration: readSnapshotGeneration,
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
    if (
      cached
      && cached.generation === generation
      && cached.snapshotGeneration === snapshotGeneration(key)
      && cached.validThrough > performance.now()
    ) {
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
  const fresh = <T>(key: CoalescedSnapshot, read: () => Promise<T>): Promise<T> => {
    snapshotGenerations.set(key, snapshotGeneration(key) + 1);
    completed.delete(key);
    reads.delete(key);
    return share(key, read);
  };
  const coalesced: BlogbotBridge = {
    ...bridge,
    getBootstrapSnapshot: (options) => options?.fresh
      ? fresh("bootstrap", () => bridge.getBootstrapSnapshot({ fresh: true }))
      : share("bootstrap", () => bridge.getBootstrapSnapshot()),
    getPrerequisiteStatus: () => share("prerequisites", () => bridge.getPrerequisiteStatus()),
    getConnectorState: (options) => options?.fresh
      ? fresh("connectors", () => bridge.getConnectorState({ fresh: true }))
      : share("connectors", () => bridge.getConnectorState()),
    getEditorialWorkspace: (options) => {
      const key = options?.includeCandidates ? "workspaceCandidates" : "workspace";
      const read = () => bridge.getEditorialWorkspace({
        ...(options?.includeCandidates ? { includeCandidates: true } : {}),
        ...(options?.fresh ? { fresh: true } : {})
      });
      return options?.fresh ? fresh(key, read) : share(key, read);
    },
    getOperations: () => share("operations", () => bridge.getOperations()),
    getEngineDiagnostics: () => share("diagnostics", () => bridge.getEngineDiagnostics())
  };
  const invalidatingMutations = new Set([
    "installUnsignedUpdate", "recoverLocalWorkspace", "startLocalDev",
    "stopLocalDev", "startCodexLogin", "saveSetupConnector", "startGitHubDeviceFlow", "setAutostart",
    "sendTestNotification", "promoteCandidate", "dismissCandidate", "hideDrafts", "restoreHiddenDrafts", "retryJob",
    "requestRevisionEdit", "repairRevisionMedia", "updateScheduleSlot", "saveDesktopPreferences",
    "scanSource", "scanAllSources", "saveSources", "reviewSource",
    "createInstantDraft", "approveRevision", "revokeApproval", "approveHighRiskRevision",
    "enqueuePublication", "materializeLocalPreview", "completeOnboarding",
    "setRuntimePause", "restoreBackup", "createBackup", "restoreAutomaticBackup"
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
