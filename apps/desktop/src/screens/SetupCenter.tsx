import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { canEnableAutomationMode, connectorDraftFromState, isRecoveryKeyUsable, setupConnectorLabel, summarizePrerequisites } from "../app-model.ts";
import { ConfirmationDialog } from "../components/ConfirmationDialog.tsx";
import { buildSetupRequirements } from "../types.ts";
import type { BlogbotBridge } from "../bridge.ts";
import type {
  OnboardingSettings,
  ConnectorStateSnapshot,
  PrerequisiteSnapshot,
  SetupConnectorDraft,
  SetupConnectorId
} from "../types.ts";

interface SetupCenterProps {
  bridge: BlogbotBridge;
  connectorState: ConnectorStateSnapshot;
  readOnly: boolean;
  startInGuide?: boolean;
  onConnectorStateChange: (state: ConnectorStateSnapshot) => void;
  onCompleted: () => Promise<void>;
}

const stateLabels = {
  READY: "Hazır",
  MISSING: "Eksik",
  BLOCKED: "Bekliyor",
  ATTENTION: "Kontrol gerekli"
} as const;

const legacyConnectorKeys = ["blogbot.setup.connector-draft.v1", "blogbot.setup.site-adapter.v1"] as const;

type SetupTaskId = "overview" | "first-start" | "writing" | "publishing" | "backup" | "diagnostics";

const setupTasks: ReadonlyArray<{
  id: Exclude<SetupTaskId, "overview">;
  title: string;
  detail: string;
  action: string;
}> = [
  {
    id: "first-start",
    title: "İlk başlangıç",
    detail: "Bu bilgisayarı, yerel çalışma bileşenini ve ilk içerik hedefini adım adım hazırlayın.",
    action: "İlk başlangıcı aç"
  },
  {
    id: "writing",
    title: "Yazı üretimi hesabı",
    detail: "Codex çalışma zamanını kontrol edin veya güvenli giriş akışını başlatın.",
    action: "Yazı üretimi hesabını aç"
  },
  {
    id: "publishing",
    title: "Yayın bağlantısı",
    detail: "Yerel klasör, proje veya GitHub hedefini ayrı bir görev içinde doğrulayın.",
    action: "Yayın bağlantısını aç"
  },
  {
    id: "backup",
    title: "Yedekleme ve kurtarma",
    detail: "Şifreli yedek oluşturun, doğrulayın ve geri yüklemeyi yazmadan önce önizleyin.",
    action: "Yedekleme ve kurtarmayı aç"
  },
  {
    id: "diagnostics",
    title: "Tanılama ve onarım",
    detail: "Engine, yerel veritabanı, kuyruk ve bağlantı durumlarını tek yerde inceleyin.",
    action: "Tanılama ve onarımı aç"
  }
] as const;

function formatFolderPath(path: string): string {
  return path.trim();
}

function explainFailure(reason: unknown, fallback: string, recovery: string): string {
  const raw = reason instanceof Error ? reason.message.trim() : "";
  const detail = raw.includes("CODEX_NOT_INSTALLED")
    ? "Codex çalışma zamanı bu bilgisayarda bulunamadı. Blogbot bunu otomatik kurmaz; önce Codex'i kurup device login yapın."
    : raw.includes("GITHUB_CLIENT_ID_REQUIRED")
      ? "GitHub OAuth istemci kimliği yapılandırılmadı. Kurulum Merkezi'ndeki GitHub alanına public client ID değerini girin; token veya private key girmeyin."
      : raw.includes("ENGINE") || raw.includes("engine")
    ? "Blogbot'un yerel çalışma bileşeni hazır değil."
    : raw.includes("SOURCE")
      ? "Kaynak kontrolü tamamlanamadı."
      : raw.includes("BACKUP") || raw.includes("archive")
        ? "Yedek dosyası doğrulanamadı."
        : raw.includes("GITHUB") || raw.includes("GitHub")
          ? "GitHub bağlantısı henüz doğrulanamadı."
          : fallback;
  return `${detail} Sonraki adım: ${recovery}`;
}

export function SetupCenter({
  bridge,
  connectorState,
  readOnly,
  startInGuide = false,
  onConnectorStateChange,
  onCompleted
}: SetupCenterProps) {
  const [status, setStatus] = useState<PrerequisiteSnapshot | null>(null);
  const [deviceName, setDeviceName] = useState("Blogbot Editör PC");
  const [mode, setMode] =
    useState<OnboardingSettings["mode"]>("INGEST_ONLY");
  const [scanIntervalMinutes, setScanIntervalMinutes] = useState(30);
  const [acknowledged, setAcknowledged] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [connectorMessages, setConnectorMessages] = useState<Partial<Record<SetupConnectorId, string>>>({});
  const [connectorDraft, setConnectorDraft] = useState<SetupConnectorDraft>(() => connectorDraftFromState(connectorState));
  const [legacyConnectorNotice, setLegacyConnectorNotice] = useState(() =>
    legacyConnectorKeys.some((key) => localStorage.getItem(key) !== null)
  );
  const [backupArchivePath, setBackupArchivePath] = useState("");
  const [backupSourceDirectory, setBackupSourceDirectory] = useState("");
  const [backupOutputPath, setBackupOutputPath] = useState("");
  const [backupRelativePaths, setBackupRelativePaths] = useState("state.json");
  const [backupTargetParent, setBackupTargetParent] = useState("");
  const [backupTargetName, setBackupTargetName] = useState("Blogbot-Geri-Yukleme");
  const [backupRecoveryKey, setBackupRecoveryKey] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [restoreConfirmationOpen, setRestoreConfirmationOpen] = useState(false);
  const [localDevRunning, setLocalDevRunning] = useState(false);
  const [localDevSupported, setLocalDevSupported] = useState(false);
  const [localDevStatusChecking, setLocalDevStatusChecking] = useState(false);
  const [localDevStatusError, setLocalDevStatusError] = useState(false);
  const [localDevTrusted, setLocalDevTrusted] = useState(false);
  const [githubBrokerStatus, setGitHubBrokerStatus] = useState<"unknown" | "unconfigured" | "logged-out" | "pending" | "authorized" | "degraded">("unknown");
  const [selectedTask, setSelectedTask] = useState<SetupTaskId>(() =>
    startInGuide ? "first-start" : "overview"
  );
  const guidedMode = selectedTask === "first-start";
  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedStatus, setGuidedStatus] = useState("");
  const [guidedFinalResult, setGuidedFinalResult] = useState("");
  const [engineRecoveryAvailable, setEngineRecoveryAvailable] = useState(false);
  const quickstartRef = useRef<HTMLElement>(null);
  const restoreFolderNameValid = /^[^<>:"/\\|?*]{1,80}$/u.test(backupTargetName.trim())
    && backupTargetName.trim() !== "."
    && backupTargetName.trim() !== "..";
  const backupTargetPath = backupTargetParent && restoreFolderNameValid
    ? `${backupTargetParent.replace(/[\\/]+$/u, "")}\\${backupTargetName.trim()}`
    : "";

  // The two setup routes have distinct promises: the Center is a task hub,
  // while the Guide must begin the focused first-start wizard immediately.
  // Keep direct hash navigation truthful even after the component is mounted.
  useEffect(() => {
    setSelectedTask(startInGuide ? "first-start" : "overview");
    setGuidedStep(0);
  }, [startInGuide]);

  useEffect(() => {
    setConnectorDraft(connectorDraftFromState(connectorState));
  }, [connectorState]);

  useEffect(() => {
    let active = true;
    void bridge.getAutostartStatus()
      .then(({ enabled }) => {
        if (active) setAutostartEnabled(enabled);
      })
      .catch(() => {
        if (active) setMessage("Windows başlangıç tercihi okunamadı. Bu tercih doğrulanana kadar değiştirilmeyecek.");
      });
    return () => { active = false; };
  }, [bridge]);

  useEffect(() => {
    let active = true;
    void bridge.getGitHubDeviceFlowStatus()
      .then((result) => {
        if (!active) return;
        setGitHubBrokerStatus(result.status);
      })
      .catch(() => {
        if (!active) return;
        setGitHubBrokerStatus("degraded");
      });
    return () => { active = false; };
  }, [bridge]);

  const refreshConnectorState = async () => {
    const next = await bridge.getConnectorState();
    onConnectorStateChange(next);
    return next;
  };

  const acknowledgeLegacyConnectorData = () => {
    for (const key of legacyConnectorKeys) localStorage.removeItem(key);
    setLegacyConnectorNotice(false);
  };

  const guidedSteps = [
    {
      title: "Bu bilgisayarı kontrol et",
      detail: "Windows, WebView2 ve güvenli anahtar deposu otomatik test edilir.",
      checkIds: ["windows", "webview2", "secure-store"]
    },
    {
      title: "Blogbot'un yerel çalışma bileşenini doğrula",
      detail: "Uygulamanın yerel veri deposu ve iş kuyruğu birlikte test edilir.",
      checkIds: ["local-engine", "local-database", "local-queue"]
    },
    {
      title: "Çalışma tercihlerini seç",
      detail: "Bu bilgisayarın adını ve otomasyon sınırını seçin. Yazar, takvim ve yayın ayarları ilgili çalışma alanlarında tutulur.",
      checkIds: []
    },
    {
      title: "İlk içerik hedefini seç",
      detail: "Onaylanan içerik paketinin gideceği klasörü veya yerel projeyi Windows seçicisiyle belirleyin.",
      checkIds: ["local-engine"]
    },
    {
      title: "Son kontrol",
      detail: "Temel yerel kontroller yeniden çalışır. Yazı üretimi ve yayın bağlantılarını daha sonra kendi görevlerinden tamamlayabilirsiniz.",
      checkIds: ["windows", "local-engine"] as const
    }
  ] as const;

  const refresh = async () => {
    setBusy(true);
    setMessage("Önkoşul kontrolleri çalıştırılıyor…");
    try {
      setStatus(await bridge.getPrerequisiteStatus());
    } catch (reason) {
      setMessage(
        explainFailure(reason, "Önkoşul denetimi tamamlanamadı.", "yeniden test edin; sürerse uygulamayı yeniden başlatın.")
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void bridge
      .getPrerequisiteStatus()
      .then((result) => {
        if (active) setStatus(result);
      })
      .catch((reason) => {
        if (active) {
          setMessage(
            explainFailure(reason, "Önkoşul denetimi tamamlanamadı.", "yeniden test edin; sürerse uygulamayı yeniden başlatın.")
          );
        }
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  const refreshLocalDevStatus = useCallback(async () => {
    setLocalDevStatusChecking(true);
    setLocalDevStatusError(false);
    try {
      const result = await bridge.localDevStatus();
      setLocalDevRunning(result.running);
      setLocalDevSupported(result.supported);
    } catch {
      setLocalDevRunning(false);
      setLocalDevSupported(false);
      setLocalDevStatusError(true);
    } finally {
      setLocalDevStatusChecking(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (connectorDraft.site.mode !== "LOCAL_DEV") return;
    void refreshLocalDevStatus();
  }, [connectorDraft.site.mode, refreshLocalDevStatus]);

  const summary = useMemo(
    () => summarizePrerequisites(status?.checks ?? []),
    [status]
  );
  const quickstartActivationReason = readOnly
    ? "Yerel çalışma alanı yeniden bağlanana kadar bu hedef etkinleştirilemez."
    : busy
      ? "Süren işlem tamamlanana kadar bekleyin."
      : !summary.appUsable
        ? "Önce yerel çalışma bileşenini test edin."
        : !acknowledged && connectorDraft.site.mode !== "PUBLISH" && !connectorDraft.site.repositoryPath.trim()
          ? `Önce ${connectorDraft.site.mode === "LOCAL_DEV" ? "proje klasörünü" : "çıktı klasörünü"} seçin ve içerik değişirse yeniden onay gerektiğini onaylayın.`
          : !acknowledged
            ? "İçerik değişirse yeniden onay gerektiğini onaylayın."
            : connectorDraft.site.mode !== "PUBLISH" && !connectorDraft.site.repositoryPath.trim()
              ? `Önce ${connectorDraft.site.mode === "LOCAL_DEV" ? "proje klasörünü" : "çıktı klasörünü"} seçin.`
              : "";
  const guidedTargetSelectionReason = readOnly
    ? "Yerel çalışma alanı yeniden bağlanana kadar hedef seçimine geçilemez."
    : deviceName.trim().length < 3
      ? "Devam etmek için bu bilgisayarın adını en az 3 karakter olarak yazın."
      : "";
  const currentGuidedStep = guidedSteps[guidedStep] ?? guidedSteps[0];
  const selectedTaskDefinition = setupTasks.find((task) => task.id === selectedTask);
  const checksById = useMemo(
    () => new Map((status?.checks ?? []).map((check) => [check.id, check])),
    [status]
  );
  const currentStepChecks = currentGuidedStep.checkIds
    .map((id) => checksById.get(id))
    .filter((check): check is NonNullable<typeof check> => Boolean(check));
  const guidedReadyCount = currentStepChecks.filter((check) => check.state === "READY").length;
  const focusedTaskCheckIds: Array<PrerequisiteSnapshot["checks"][number]["id"]> = selectedTask === "writing"
    ? ["codex"]
    : selectedTask === "publishing"
      ? ["github", "site-adapter"]
      : selectedTask === "backup"
        ? ["backup"]
        : selectedTask === "diagnostics"
          ? [...checksById.keys()]
          : [];
  const focusedTaskChecks = focusedTaskCheckIds
    .map((id) => checksById.get(id))
    .filter((check): check is NonNullable<typeof check> => Boolean(check));
  const focusedTaskReadyCount = focusedTaskChecks.filter((check) => check.state === "READY").length;
  const setupRequirements = useMemo(
    () => buildSetupRequirements(status?.checks ?? []),
    [status]
  );
  const nextSetupTask = useMemo(() => {
    const nextCheck = (status?.checks ?? []).find((check) => check.state !== "READY");
    if (!nextCheck) return null;
    const taskId: Exclude<SetupTaskId, "overview"> = ["codex"].includes(nextCheck.id)
      ? "writing"
      : ["github", "site-adapter", "deploy"].includes(nextCheck.id)
        ? "publishing"
        : ["backup"].includes(nextCheck.id)
          ? "backup"
          : ["local-engine", "local-database", "local-queue"].includes(nextCheck.id)
            ? "diagnostics"
            : "first-start";
    return { check: nextCheck, task: setupTasks.find((task) => task.id === taskId)! };
  }, [status]);
  const moveToTargetSelection = () => {
    setGuidedStep(3);
    window.requestAnimationFrame(() => {
      const target = quickstartRef.current;
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      target?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    });
  };
  const runGuidedFinalCheck = async () => {
    setBusy(true);
    setGuidedFinalResult("");
    try {
      const nextStatus = await bridge.getPrerequisiteStatus();
      const nextSummary = summarizePrerequisites(nextStatus.checks);
      setStatus(nextStatus);
      setGuidedFinalResult(
        `Son kontrol tamamlandı. ${nextSummary.ready}/${nextSummary.total} kontrol hazır. ${
          nextSummary.appUsable
            ? "Blogbot açılabilir; hazır olmayan özellikler güvenle kapalı kalır."
            : "Yerel çalışma bileşeni hazır değil; aşağıdaki eksikleri giderip testi yeniden çalıştırın."
        }`
      );
    } catch (reason) {
      setGuidedFinalResult(
        explainFailure(reason, "Son kontrol tamamlanamadı.", "yerel çalışma bileşenini yeniden başlatıp testi tekrarlayın.")
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (connectorDraft.site.mode === "PUBLISH") {
      setSelectedTask("publishing");
      setConnectionMessage("Yayın hedefi henüz kaydedilmedi. Önce yayın bağlantısı görevindeki site, GitHub ve workflow bilgilerini doğrulayın.");
      return;
    }
    if (!Number.isInteger(scanIntervalMinutes) || scanIntervalMinutes < 5 || scanIntervalMinutes > 1440) {
      setMessage("Tarama aralığı 5 ile 1440 dakika arasında tam sayı olmalı.");
      return;
    }
    if (!canEnableAutomationMode(mode, summary)) {
      setMessage(
        mode === "INGEST_ONLY"
          ? "Bu bilgisayarın temel uygulama önkoşulları hazır değil."
          : mode === "DRAFT_ONLY"
            ? "Taslak üretimi için Blogbot'un yerel çalışma bileşenini hazırlayın."
            : "Onaylı yayın için yerel çalışma bileşeni, yazı üretimi hesabı ve yayın bağlantısı hazır olmalı."
      );
      return;
    }
    setBusy(true);
    setMessage("");
    let targetSaved = false;
    try {
      await bridge.saveSetupConnector({
        connector: "site",
        config: connectorDraft.site
      });
      targetSaved = true;
      await bridge.completeOnboarding({
        deviceName: deviceName.trim(),
        mode,
        scanIntervalMinutes,
        acknowledgeApprovalBoundary: acknowledged,
        autostartEnabled: autostartEnabled ?? (await bridge.getAutostartStatus()).enabled
      });
      try {
        await refreshConnectorState();
        await onCompleted();
        setMessage("Bu cihazın çalışma ayarları kaydedildi.");
      } catch (reason) {
        setMessage(
          `Bu cihazın çalışma ayarları kaydedildi; ancak güncel bağlantı veya çalışma alanı görünümü yenilenemedi. Sonraki adım: Kurulum Merkezi'nden yenileyin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`
        );
      }
    } catch (reason) {
      setMessage(
        targetSaved
          ? explainFailure(
              reason,
              "Çıktı hedefi yerel olarak kaydedildi; ancak cihazın çalışma ayarları tamamlanamadı.",
              "alanları kontrol edip yalnız çalışma ayarlarını yeniden kaydedin."
            )
          : explainFailure(reason, "Kurulum ayarları kaydedilemedi.", "alanları kontrol edip tekrar deneyin.")
      );
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async (advanceGuidedSetup = false) => {
    setBusy(true);
    if (advanceGuidedSetup) setGuidedStatus("");
    setConnectionMessage("Blogbot'un yerel çalışma bileşeni ve iş kuyruğu test ediliyor…");
    try {
      const result = await bridge.testLocalEngine();
      setConnectionMessage(result.detail);
      setEngineRecoveryAvailable(false);
      if (result.ready && advanceGuidedSetup && guidedStep === 1) {
        setGuidedStep(2);
        setGuidedStatus("Yerel çalışma bileşeni hazır. Çalışma tercihleri adımına geçildi.");
        setConnectionMessage("Yerel çalışma bileşeni hazır. Çalışma tercihleri adımına geçildi.");
      }
      try {
        setStatus(await bridge.getPrerequisiteStatus());
      } catch (reason) {
        setConnectionMessage(
          `Yerel çalışma bileşeni hazır; ancak önkoşul kartları yenilenemedi. Sonraki adım: Kurulum Merkezi'nden yeniden test edin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`
        );
        if (advanceGuidedSetup && result.ready) {
          setGuidedStatus(
            `Yerel çalışma bileşeni hazır; ancak önkoşul kartları yenilenemedi. Sonraki adım: Kurulum Merkezi'nden yeniden test edin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`
          );
        }
      }
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : "";
      setEngineRecoveryAvailable(raw.includes("ENGINE_RESPONSE_TIMEOUT"));
      setConnectionMessage(
        explainFailure(reason, "Blogbot'un yerel çalışma bileşeni test edilemedi.", "uygulamayı yeniden başlatıp testi tekrarlayın.")
      );
    } finally {
      setBusy(false);
    }
  };
  const testConnector = async (connector: SetupConnectorId) => {
    const label = setupConnectorLabel(connector);
    setBusy(true); setConnectionMessage(`${label} biçim testi çalıştırılıyor…`);
    let result: Awaited<ReturnType<BlogbotBridge["testSetupConnector"]>> | null = null;
    try {
      const tested = await bridge.testSetupConnector({ connector, config: connectorDraft[connector] });
      result = tested;
      const suggestion = tested.repositorySuggestion
        ? ` Yerel git deposu bulundu: ${tested.repositorySuggestion}`
        : "";
      const migrationHint = tested.contentModel === "TYPESCRIPT_EDITORIAL_DATA"
        ? " İçerik modeli eski TypeScript verisi; yayın öncesi deneme dönüşümü gerekir."
        : "";
      if (connector === "site" && tested.repositorySuggestion) {
        const match = tested.repositorySuggestion.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/iu);
        if (match) {
          const owner = match[1] ?? "";
          const repository = match[2] ?? "";
          setConnectorDraft((current) => ({
            ...current,
            github: { ...current.github, owner, repository }
          }));
        }
      }
      setConnectionMessage(`${tested.detail}${suggestion}${migrationHint}`);
      setConnectorMessages((current) => ({
        ...current,
        [connector]: tested.ready
          ? `Biçim doğrulandı. Gerçek yetkilendirme gerekiyorsa ayrıca tamamlanmalıdır. ${tested.detail}${suggestion}${migrationHint}`
          : tested.detail
      }));
      try {
        setStatus(await bridge.getPrerequisiteStatus());
        await refreshConnectorState();
        if (connector === "site" && tested.ready && guidedStep === 3) {
          setGuidedStep(4);
          setConnectionMessage("Hedef doğrulandı. Son kontrole geçildi.");
        }
      } catch (reason) {
        const detail = `${tested.ready ? "Biçim doğrulandı" : "Biçim testi tamamlandı; hedef henüz hazır değil"}; ancak güncel bağlantı durumu yenilenemedi. Sonraki adım: Kurulum Merkezi'nden yeniden deneyin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`;
        setConnectionMessage(detail);
        setConnectorMessages((current) => ({ ...current, [connector]: detail }));
      }
    } catch (reason) {
      const detail = result
        ? `Biçim testi tamamlandı; ancak güncel durum yenilenemedi. Sonraki adım: Kurulum Merkezi'nden yeniden deneyin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`
        : explainFailure(reason, "Biçim testi tamamlanamadı.", "zorunlu gizli olmayan alanları doldurup yeniden deneyin.");
      setConnectionMessage(detail);
      setConnectorMessages((current) => ({ ...current, [connector]: detail }));
    } finally { setBusy(false); }
  };
  const saveConnector = async (connector: SetupConnectorId) => {
    const label = setupConnectorLabel(connector);
    setBusy(true); setConnectionMessage(`${label} ayarları yerel olarak kaydediliyor…`);
    let result: Awaited<ReturnType<BlogbotBridge["saveSetupConnector"]>> | null = null;
    try {
      const saved = await bridge.saveSetupConnector({ connector, config: connectorDraft[connector] });
      result = saved;
      setConnectionMessage(saved.detail);
      setConnectorMessages((current) => ({ ...current, [connector]: saved.detail }));
      try {
        setStatus(await bridge.getPrerequisiteStatus());
        await refreshConnectorState();
      } catch (reason) {
        const detail = `Ayar yerel olarak kaydedildi; ancak güncel bağlantı durumu yenilenemedi. Sonraki adım: Kurulum Merkezi'nden yeniden deneyin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`;
        setConnectionMessage(detail);
        setConnectorMessages((current) => ({ ...current, [connector]: detail }));
      }
    } catch (reason) {
      const detail = result
        ? `Ayar yerel olarak kaydedildi; ancak güncel durum yenilenemedi. Sonraki adım: Kurulum Merkezi'nden yeniden deneyin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`
        : explainFailure(reason, "Ayarlar kaydedilemedi.", "önce alanları biçim testiyle doğrulayın.");
      setConnectionMessage(detail);
      setConnectorMessages((current) => ({ ...current, [connector]: detail }));
    } finally { setBusy(false); }
  };
  const pickFolder = async (target: "site" | "backup" | "backupSource" | "backupTarget" | "backupArchive") => {
    setBusy(true);
    setConnectionMessage("Windows klasör seçici açılıyor…");
    try {
      const selected = await bridge.pickLocalFolder();
      if (!selected) {
        setConnectionMessage("Klasör seçimi iptal edildi; hiçbir ayar değiştirilmedi.");
        return;
      }
      if (target === "site" || target === "backup") {
        setConnectorDraft((current) => ({
            ...current,
            [target]: { ...current[target], [target === "site" ? "repositoryPath" : "folder"]: selected }
          } as SetupConnectorDraft));
        if (target === "site") setLocalDevTrusted(false);
        setConnectorMessages((current) => ({
          ...current,
          [target]: `Seçilen klasör: ${selected}. Şimdi “Bilgileri doğrula” düğmesine basın.`
        }));
        setConnectionMessage("Klasör seçildi. Kaydetmeden önce biçim testini çalıştırın.");
      } else if (target === "backupSource") {
        setBackupSourceDirectory(selected);
        setConnectionMessage("Yedek kaynak klasörü seçildi.");
      } else if (target === "backupTarget") {
        setBackupTargetParent(selected);
        setConnectionMessage("Geri yükleme üst klasörü seçildi. Blogbot bunun altında yeni ve boş bir klasör oluşturacak.");
      } else {
        const archivePath = `${selected.replace(/[\\/]+$/u, "")}\\blogbot.backup`;
        setBackupOutputPath(archivePath);
        setBackupArchivePath(archivePath);
        setConnectionMessage(`Yedek dosyası için seçilen klasör: ${selected}`);
      }
    } catch (reason) {
      setConnectionMessage(explainFailure(reason, "Klasör seçici açılamadı.", "Windows uygulamasını yeniden başlatıp tekrar deneyin."));
    } finally {
      setBusy(false);
    }
  };
  const toggleLocalDev = async () => {
    const path = connectorDraft.site.repositoryPath.trim();
    const stopping = localDevRunning;
    setBusy(true);
    try {
      if (stopping) {
        await bridge.stopLocalDev();
        setLocalDevRunning(false);
        setConnectorMessages((current) => ({ ...current, site: "Yerel geliştirme süreci durduruldu." }));
      } else {
        const result = await bridge.startLocalDev(path, localDevTrusted);
        setLocalDevRunning(result.running);
        setConnectorMessages((current) => ({
          ...current,
          site: "Yerel geliştirme süreci başlatıldı. Proje kendi npm run dev çıktısını kullanıyor."
        }));
      }
    } catch (reason) {
      const detail = stopping
          ? explainFailure(reason, "Yerel geliştirme süreci durdurulamadı.", "Sürecin çalışıp çalışmadığını kontrol edin; gerekirse uygulamayı yeniden başlatın.")
          : explainFailure(reason, "Yerel geliştirme süreci başlatılamadı.", "Site klasöründe package.json ve scripts.dev bulunduğunu kontrol edin.");
      setConnectorMessages((current) => ({ ...current, site: detail }));
    } finally { setBusy(false); }
  };
  const testCodex = async () => {
    setBusy(true);
    setConnectionMessage("Yazı üretimi hesabı kontrol ediliyor…");
    try {
      const result = await bridge.testCodexRuntime();
      let detail = result.detail;
      try {
        setStatus(await bridge.getPrerequisiteStatus());
      } catch (reason) {
        detail = `${result.detail} Önkoşul kartları yenilenemedi; Kurulum Merkezi'nden yeniden deneyin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`;
      }
      setConnectionMessage(detail);
      setConnectorMessages((current) => ({ ...current, codex: detail }));
    } catch (reason) {
      const detail = explainFailure(reason, "Yazı üretimi hesabı kontrol edilemedi.", "Codex kurulumunu veya girişini kontrol edip yeniden deneyin.");
      setConnectionMessage(detail);
      setConnectorMessages((current) => ({ ...current, codex: detail }));
    } finally { setBusy(false); }
  };
  const startCodexLogin = async () => {
    setBusy(true);
    setConnectionMessage("Codex giriş akışı başlatılıyor…");
    try {
      const result = await bridge.startCodexLogin();
      setConnectionMessage(result.detail);
      setConnectorMessages((current) => ({ ...current, codex: result.detail }));
    } catch (reason) {
      const detail = explainFailure(reason, "Codex giriş akışı başlatılamadı.", "Codex'in bu bilgisayarda kurulu olduğunu kontrol edin.");
      setConnectionMessage(detail);
      setConnectorMessages((current) => ({ ...current, codex: detail }));
    } finally { setBusy(false); }
  };
  const recoverLocalWorkspace = async () => {
    setBusy(true);
    setConnectionMessage("Önceki yerel çalışma alanı korunuyor; yeni alan hazırlanıyor…");
    try {
      const result = await bridge.recoverLocalWorkspace();
      let detail = result.detail;
      try {
        setStatus(await bridge.getPrerequisiteStatus());
      } catch (reason) {
        detail = `${result.detail} Önkoşul kartları yenilenemedi; Kurulum Merkezi'nden yeniden deneyin. (${explainFailure(reason, "Ayrıntı alınamadı.", "yeniden deneyin.")})`;
      }
      setConnectionMessage(detail);
      setEngineRecoveryAvailable(!result.ready);
      if (result.ready && guidedStep === 1) {
        setGuidedStep(2);
        setGuidedStatus(detail);
      }
    } catch (reason) {
      setConnectionMessage(
        explainFailure(reason, "Yerel çalışma alanı kurtarılamadı.", "tanılama paketini oluşturup destek ekibiyle paylaşın.")
      );
    } finally {
      setBusy(false);
    }
  };
  const refreshGitHubLoginStatus = async () => {
    setBusy(true);
    try {
      const result = await bridge.getGitHubDeviceFlowStatus();
      setGitHubBrokerStatus(result.status);
      setConnectorMessages((current) => ({
        ...current,
        github: result.detail ?? `GitHub durumu: ${result.status}`
      }));
    } catch (reason) {
      setGitHubBrokerStatus("degraded");
      setConnectorMessages((current) => ({
        ...current,
        github: explainFailure(reason, "GitHub yetkilendirme durumu alınamadı.", "Kurulum denetimini yeniden çalıştırıp tekrar deneyin.")
      }));
    } finally {
      setBusy(false);
    }
  };
  const verifyBackup = async () => {
    setBusy(true); setBackupMessage("Yedek doğrulanıyor; anahtar yalnızca bu işlem için bellekte tutuluyor…");
    try {
      const result = await bridge.verifyBackup({ archivePath: backupArchivePath, recoveryKey: backupRecoveryKey });
      setBackupMessage(result.verified ? `Yedek doğrulandı: ${result.entries?.length ?? 0} dosya.` : "Yedek doğrulanamadı.");
    } catch (reason) {
      setBackupMessage(explainFailure(reason, "Yedek doğrulanamadı.", "dosya yolunu ve recovery key'i kontrol edip yeniden deneyin."));
    } finally { setBackupRecoveryKey(""); setBusy(false); }
  };
  const createBackup = async () => {
    setBusy(true); setBackupMessage("Şifreli yedek oluşturuluyor; anahtar yalnızca bu işlem için bellekte tutuluyor…");
    try {
      const result = await bridge.createBackup({
        sourceDirectory: backupSourceDirectory,
        outputPath: backupOutputPath,
        relativePaths: backupRelativePaths.split(/[\n,;]+/u).map((value) => value.trim()).filter(Boolean),
        recoveryKey: backupRecoveryKey
      });
      setBackupMessage(`Yedek oluşturuldu: ${result.entries} dosya, ${result.bytes} bayt.`);
    } catch (reason) {
      setBackupMessage(explainFailure(reason, "Yedek oluşturulamadı.", "kaynak klasörü, dosya listesini ve yeni çıktı yolunu kontrol edip yeniden deneyin."));
    } finally { setBackupRecoveryKey(""); setBusy(false); }
  };
  const previewBackup = async () => {
    setBusy(true); setBackupMessage("Geri yükleme önizlemesi hazırlanıyor; hiçbir dosya yazılmayacak…");
    try {
      const result = await bridge.previewBackupRestore({ archivePath: backupArchivePath, targetDirectory: backupTargetPath, recoveryKey: backupRecoveryKey });
      setBackupMessage(`Geri yükleme önizlemesi hazır: ${result.entries.length} dosya; hiçbir dosya yazılmadı.`);
    } catch (reason) {
      setBackupMessage(explainFailure(reason, "Geri yükleme önizlemesi alınamadı.", "arşiv ve boş hedef klasörü kontrol edip yeniden deneyin."));
    } finally { setBackupRecoveryKey(""); setBusy(false); }
  };
  const restoreBackup = async () => {
    setBusy(true); setBackupMessage("Geri yükleme çalışıyor; yalnızca onaylanan boş klasöre yazılıyor…");
    try {
      const result = await bridge.restoreBackup({ archivePath: backupArchivePath, targetDirectory: backupTargetPath, recoveryKey: backupRecoveryKey });
      setBackupMessage(`Geri yükleme tamamlandı: ${result.entries} dosya.`);
    } catch (reason) {
      setBackupMessage(explainFailure(reason, "Geri yükleme yapılamadı.", "hedef klasörün boş ve yazılabilir olduğunu doğrulayın."));
    } finally { setBackupRecoveryKey(""); setBusy(false); }
  };
  const connectorFields: Array<{
    id: SetupConnectorId;
    label: string;
    description: string;
    fields: Array<[string, string, boolean?]>;
  }> = [
    {
      id: "codex",
      label: "Yazı üretimi hesabı",
      description: "Taslak ve Türkçe/İngilizce yerelleştirme için bu bilgisayardaki Codex çalışma zamanını bağlarsınız. Blogbot parola veya token istemez; Codex kurulumu ve device login ayrı bir adımdır.",
      fields: [["accountLabel", "Hesabı ayırt etmek için görünen ad"]]
    },
    {
      id: "github",
      label: "Sitenin GitHub deposu",
      description: "Onaylanan yazıların gönderileceği site deposu. GitHub hesabı ayrı ve güvenli bir pencerede bağlanır.",
      fields: [["owner", "GitHub kullanıcı adı / kuruluş"], ["repository", "Site deposu adı"], ["clientId", "GitHub OAuth istemci kimliği (gerekli)"]]
    },
    {
      id: "site",
      label: connectorDraft.site.mode === "LOCAL_ONLY" ? "Çıktı klasörü" : connectorDraft.site.mode === "LOCAL_DEV" ? "Yerel proje" : "Yayın hedefi",
      description: connectorDraft.site.mode === "LOCAL_ONLY"
        ? "Onaylı dosyaların yazılacağı herhangi bir klasörü seçin. GitHub veya hosting gerekmez."
        : connectorDraft.site.mode === "LOCAL_DEV"
          ? "Bilgisayarınızdaki proje klasörü. package.json içindeki scripts.dev komutu isteğe bağlı olarak başlatılır."
          : "Yerel proje klasörü ve yayın adresi. GitHub alanları yalnız bu hedef seçildiğinde kullanılır.",
      fields: [["repositoryPath", connectorDraft.site.mode === "LOCAL_ONLY" ? "Çıktı klasörü (ör. C:\\Blogbot-Cikti)" : "Proje klasörü (ör. C:\\Siteler\\benim-site)"], ["publicSiteUrl", "Public adres (yayın için)", false]]
    },
    {
      id: "deploy",
      label: "Yayın workflow'u",
      description: "GitHub Actions üzerinde seçtiğiniz statik siteyi yayınlayan workflow dosyası. Bu alan hosting sunucusuna doğrudan erişim vermez.",
      fields: [["workflowName", "Workflow dosyası (ör. deploy.yml)"]]
    },
    {
      id: "backup",
      label: "Yedekleme",
      description: "Şifreli yedeklerin konacağı yer. Yedekleme şifresi kaydedilmez; kaybedilirse yedek geri açılamaz.",
      fields: [["folder", "Yedek klasörü"]]
    }
  ];
  const githubBrokerHelp = githubBrokerStatus === "unconfigured"
    ? "GitHub App broker bu uygulama paketinde yapılandırılmadı; gerçek giriş ve yayın kapalı tutuluyor."
    : githubBrokerStatus === "unknown"
      ? "GitHub broker durumu doğrulanıyor; doğrulama tamamlanana kadar giriş kapalı tutulur."
      : githubBrokerStatus === "degraded"
        ? "GitHub yetkilendirme durumu okunamadı; gerçek giriş ve yayın kapalı tutuluyor."
        : githubBrokerStatus === "authorized"
          ? "Bu bilgisayarda GitHub yetkilendirmesi zaten tamamlanmış görünüyor; yayın yine ayrı insan onayı ve connector denetimi ister."
          : githubBrokerStatus === "pending"
            ? "GitHub giriş onayı bekliyor; tarayıcıdaki device login adımını tamamlayıp durumu yenileyin."
            : githubBrokerStatus === "logged-out"
              ? "Bu paket GitHub girişini WebView üzerinden başlatmaz. Güvenli broker kurulumu tamamlandığında cihaz doğrulamasını o akıştan başlatın; burada yalnız durum görünür."
              : "Giriş için yalnız public OAuth istemci kimliği gerekir. Token ve private key Blogbot ekranına yazılmaz; depo erişimi doğrulanmadan yayın kapalı kalır.";

  return (
    <section className="page setup-page" aria-busy={busy}>
      <header className="page-header">
        <div>
          <p className="section-kicker">KURULUM VE BAĞLANTI MERKEZİ</p>
          <h1>Blogbot her zaman açılır; hazır olmayan işlem güvenle kilitlenir.</h1>
          <p>
            Bu ekran kurulumu zorunlu bir açılış kapısı yapmaz. Eksik bileşenleri
            test eder, ne gerektiğini açıklar ve diğer uygulama menülerini
            erişilebilir bırakır.
          </p>
          <p className="setup-note">
            Blogbot tamamen bu bilgisayarda çalışır. Siz yalnız kaynakları,
            hedef bölümü ve yayın zamanını seçersiniz; teknik bağlantılar hazır
            değilse ilgili düğme güvenle kilitli kalır.
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
        >
              {busy ? "Kontroller çalışıyor…" : "Tümünü yeniden test et"}
        </button>
      </header>

      {readOnly ? (
        <p className="inline-notice" role="status" aria-live="polite">
          <strong>Kurulum değişiklikleri yerel çalışma alanı yeniden bağlanana kadar salt okunur.</strong> Tanılama sonuçlarını yenileyebilirsiniz; klasör, bağlantı, ayar ve yedek değişiklikleri bağlantı geri gelene kadar güvenle kilitlenir.
        </p>
      ) : null}

      {legacyConnectorNotice ? (
        <section className="sync-error-banner" role="status" aria-live="polite">
          <div>
            <strong>Eski tarayıcı ayarları kullanılmıyor.</strong>
            <span>Bağlantıların kaynak gerçeği artık yalnız yerel engine veritabanıdır. Eski değerler içe aktarılmadı.</span>
          </div>
          <button className="button button-secondary" type="button" onClick={acknowledgeLegacyConnectorData}>
            Anladım, eski veriyi kaldır
          </button>
        </section>
      ) : null}

      {selectedTask === "overview" ? (
        <section className="setup-task-hub" aria-labelledby="setup-task-hub-title">
          <div className={`setup-readiness-summary ${nextSetupTask ? "is-actionable" : "is-ready"}`} role="status" aria-live="polite">
            <div>
              <p className="section-kicker">ŞİMDİ YAPILACAK</p>
              <strong>{nextSetupTask ? nextSetupTask.check.label : "Blogbot kullanıma hazır"}</strong>
              <span>{nextSetupTask ? nextSetupTask.check.detail : `${summary.ready}/${summary.total} kontrol hazır. Hazır olmayan özellikler güvenle kapalı kalır.`}</span>
            </div>
            {nextSetupTask ? (
              <button className="button button-primary" type="button" onClick={() => { setSelectedTask(nextSetupTask.task.id); setGuidedStep(0); }}>
                {nextSetupTask.task.action}
              </button>
            ) : null}
          </div>
          <div className="setup-task-hub-heading">
            <p className="section-kicker">KISA VE ODAKLI KURULUM</p>
            <h2 id="setup-task-hub-title">Ne yapmak istiyorsunuz?</h2>
            <p>Yalnız ihtiyacınız olan görevi açın. Diğer bağlantılar ve teknik ayrıntılar kapalı kalır.</p>
          </div>
          <div className="setup-task-grid">
            {setupTasks.map((task, index) => (
              <button
                key={task.id}
                className="setup-task-card"
                type="button"
                onClick={() => {
                  setSelectedTask(task.id);
                  setGuidedStep(0);
                }}
                aria-label={`${task.title}: ${task.detail}`}
              >
                <span className="setup-task-index" aria-hidden="true">{index + 1}</span>
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.detail}</small>
                </span>
                <b>{task.action}</b>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="setup-task-heading" aria-labelledby="setup-task-title">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setSelectedTask("overview")}
          >
            Kurulum görevlerine dön
          </button>
          <div>
            <p className="section-kicker">ODAKLI KURULUM GÖREVİ</p>
            <h2 id="setup-task-title">{selectedTaskDefinition?.title}</h2>
            <p>{selectedTaskDefinition?.detail}</p>
          </div>
          {selectedTask !== "first-start" && focusedTaskChecks.length > 0 ? (
            <div className="setup-task-readiness">
              <div
                className="guided-progress-track"
                role="progressbar"
                aria-label={`${selectedTaskDefinition?.title ?? "Kurulum görevi"} hazırlığı`}
                aria-valuemin={0}
                aria-valuemax={focusedTaskChecks.length}
                aria-valuenow={focusedTaskReadyCount}
              >
                <span style={{ width: `${(focusedTaskReadyCount / focusedTaskChecks.length) * 100}%` }} />
              </div>
              <small>{focusedTaskReadyCount}/{focusedTaskChecks.length} kontrol hazır</small>
            </div>
          ) : null}
        </section>
      )}

      {guidedMode ? (
        <section className="guided-setup guided-setup-panel" aria-labelledby="guided-setup-title">
          <div className="guided-progress guided-progress-shell" aria-label={`Kurulum adımı ${guidedStep + 1} / ${guidedSteps.length}`}>
            {guidedSteps.map((step, index) => (
              <button
                type="button"
                key={step.title}
                className={index === guidedStep ? "is-active" : index < guidedStep ? "is-complete" : ""}
                aria-label={`${index + 1}. ${step.title}`}
                disabled={index > guidedStep}
                onClick={() => setGuidedStep(index)}
              >
                <span className="guided-step-index" aria-hidden="true">{index < guidedStep ? "✓" : index + 1}</span>
                <span className="guided-step-label">{step.title}</span>
                <span className="guided-step-state">
                  {index < guidedStep ? "Tamamlandı" : index === guidedStep ? "Şimdi" : "Bekliyor"}
                </span>
                </button>
            ))}
            <div
              className="guided-progress-inline-meter"
              role="progressbar"
              aria-label="İlk başlangıç ilerlemesi"
              aria-valuemin={0}
              aria-valuemax={guidedSteps.length}
              aria-valuenow={guidedStep + 1}
            >
              <span style={{ width: `${((guidedStep + 1) / guidedSteps.length) * 100}%` }} />
            </div>
          </div>
          <div>
            <p className="section-kicker">ADIM {guidedStep + 1} / {guidedSteps.length}</p>
            <h2 id="guided-setup-title">{currentGuidedStep.title}</h2>
            <p>{currentGuidedStep.detail}</p>
            {currentStepChecks.length > 0 ? (
              <div className="guided-check-summary" aria-live="polite">
                <strong>{guidedReadyCount}/{currentStepChecks.length} kontrol hazır</strong>
                <ul>
                  {currentStepChecks.map((check) => (
                    <li key={check.id} className={`check-${check.state.toLowerCase()}`}>
                      <span aria-hidden="true">{check.state === "READY" ? "✓" : "•"}</span>
                      <span>{check.label}: {stateLabels[check.state]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {guidedStatus ? (
              <div className="guided-final-result" role="status" aria-live="polite">
                <strong>Yerel bileşen sonucu</strong>
                <span>{guidedStatus}</span>
              </div>
            ) : null}
            {guidedStep === guidedSteps.length - 1 && guidedFinalResult ? (
              <div className="guided-final-result" role="status" aria-live="polite">
                <strong>Kurulum özeti</strong>
                <span>{guidedFinalResult}</span>
              </div>
            ) : null}
            {guidedStep === 2 ? (
              <fieldset className="guided-preferences" disabled={readOnly}>
                <legend>Bu bilgisayardaki çalışma tercihiniz</legend>
                <label className="field">
                  <span>Bu cihazın adı</span>
                  <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} autoComplete="off" minLength={3} required />
                </label>
                <label className="field">
                  <span>Blogbot ne kadar ilerlesin?</span>
                  <select value={mode} onChange={(event) => setMode(event.target.value as OnboardingSettings["mode"])}>
                    <option value="INGEST_ONLY">Yalnız kaynakları izle</option>
                    <option value="DRAFT_ONLY">Taslak ve inceleme hazırla</option>
                    <option value="PUBLISH_APPROVED">Yalnız insan onaylı paketleri yayına hazırla</option>
                  </select>
                  <small>Yayınlama, bu seçeneğe rağmen her zaman ayrı insan onayı ister.</small>
                </label>
                <label className="field">
                  <span>Kaynakları ne sıklıkla tara?</span>
                  <select value={scanIntervalMinutes} onChange={(event) => setScanIntervalMinutes(Number(event.target.value))}>
                    <option value={15}>15 dakikada bir</option>
                    <option value={30}>30 dakikada bir</option>
                    <option value={60}>Saatte bir</option>
                    <option value={180}>3 saatte bir</option>
                  </select>
                </label>
                <label className="checkbox-field guided-autostart">
                  <input
                    type="checkbox"
                    checked={autostartEnabled ?? false}
                    disabled={readOnly || autostartEnabled === null}
                    onChange={(event) => setAutostartEnabled(event.target.checked)}
                  />
                  Windows oturumu açıldığında Blogbot'u otomatik başlat.
                  {autostartEnabled === null ? <small>Mevcut tercih okunuyor…</small> : null}
                </label>
              </fieldset>
            ) : null}
          </div>
          <div className="guided-actions">
            <button className="button button-secondary" type="button" disabled={guidedStep === 0} onClick={() => setGuidedStep((current) => current - 1)}>Geri</button>
            {guidedStep === 1 ? (
              <button
                className="button button-primary"
                type="button"
                disabled={busy || readOnly}
                onClick={() => void testConnection(true)}
              >
                {busy ? "Yerel bileşen denetleniyor…" : "Yerel bileşeni denetle ve devam et"}
              </button>
            ) : guidedStep === 2 ? (
              <>
                <button
                  className="button button-primary"
                  type="button"
                  disabled={Boolean(guidedTargetSelectionReason)}
                  aria-describedby={guidedTargetSelectionReason ? "guided-target-selection-reason" : undefined}
                  onClick={moveToTargetSelection}
                >
                  Hedef seçimine geç
                </button>
                {guidedTargetSelectionReason ? <small id="guided-target-selection-reason" className="action-unavailable-reason">{guidedTargetSelectionReason}</small> : null}
              </>
            ) : guidedStep === 3 ? (
              <span className="guided-next-hint">Aşağıdan hedefi seçin; doğrulama başarılı olunca son kontrole geçilir.</span>
            ) : guidedStep < guidedSteps.length - 1 ? (
              <button className="button button-primary" type="button" onClick={() => setGuidedStep((current) => current + 1)}>Sonraki adım</button>
            ) : (
              <button className="button button-primary" type="button" disabled={busy} onClick={() => void runGuidedFinalCheck()}>{busy ? "Kontrol ediliyor…" : "Son testi çalıştır"}</button>
            )}
          </div>
          <small>Bu rehber isteğe bağlıdır. İstediğiniz an diğer menülere geçebilirsiniz.</small>
        </section>
      ) : null}

      {guidedMode && guidedStep === 3 ? <section ref={quickstartRef} className="setup-quickstart" aria-labelledby="quickstart-title" tabIndex={-1}>
        <div className="quickstart-heading">
          <p className="section-kicker">İLK ADIM</p>
          <h2 id="quickstart-title">İçeriği nereye göndereceksin?</h2>
          <p>Bir hedef seç. Blogbot yalnız seçtiğin hedef için dosya hazırlar.</p>
        </div>
        <div className="quickstart-modes" role="radiogroup" aria-label="İçerik hedefi">
          {([
            ["LOCAL_ONLY", "Bir klasöre yaz", "Onaylanan içerik paketini seçtiğin klasöre bırakır."],
            ["LOCAL_DEV", "Yerel projene yaz", "Bilgisayarındaki npm run dev ile çalışan projeyi kullanır."],
            ["PUBLISH", "Yayındaki siteye gönder", "GitHub ve sitenin kendi yayın akışıyla gönderir."]
          ] as const).map(([value, title, detail]) => {
            const selected = connectorDraft.site.mode === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`quickstart-mode ${selected ? "is-selected" : ""}`}
                disabled={readOnly}
                onClick={() => setConnectorDraft((current) => ({ ...current, site: { ...current.site, mode: value } }))}
              >
                <strong>{title}</strong>
                <span>{detail}</span>
              </button>
            );
          })}
        </div>
        {connectorDraft.site.mode !== "PUBLISH" ? (
          <div className="quickstart-target">
            <label className="field">
              <span>{connectorDraft.site.mode === "LOCAL_DEV" ? "Proje klasörü" : "Çıktı klasörü"}</span>
              <input
                value={formatFolderPath(connectorDraft.site.repositoryPath)}
                disabled={readOnly}
                readOnly
                placeholder={connectorDraft.site.mode === "LOCAL_DEV" ? "Örn. C:\\Siteler\\benim-projem" : "Örn. C:\\Blogbot-Cikti"}
                aria-describedby="quickstart-target-help"
              />
              <button className="button button-secondary" type="button" disabled={readOnly || busy} onClick={() => void pickFolder("site")}>Bilgisayardan klasör seç</button>
            </label>
            <small id="quickstart-target-help">
              {connectorDraft.site.mode === "LOCAL_DEV"
                ? "package.json ve scripts.dev bulunan proje klasörünü seç."
                : "Blogbot bu klasöre yalnız onaylanan içerik paketini yazar."}
            </small>
            {connectorDraft.site.repositoryPath.trim() ? (
              <div className="quickstart-selection" role="status" aria-live="polite">
                <div>
                  <strong>Seçili klasör</strong>
                  <code title={connectorDraft.site.repositoryPath}>{formatFolderPath(connectorDraft.site.repositoryPath)}</code>
                  <span>
                    {connectorDraft.site.mode === "LOCAL_DEV"
                      ? "Sıradaki adım: proje yapısını doğrulayın; ardından isterseniz yerel geliştirme sürecini başlatın."
                      : "Sıradaki adım: klasör yazma hedefini doğrulayın; onaylı içerik yalnız bu hedefe hazırlanır."}
                  </span>
                </div>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => void testConnector("site")}
                >
                  {busy ? "Doğrulanıyor…" : "Klasörü doğrula ve sonraki adıma geç"}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="quickstart-publish-note">
            <strong>Yayın bağlantısı daha sonra açılır.</strong>
            <span>GitHub bilgileri, site deposu ve workflow yalnız yayın hedefini seçtiğinde gerekir.</span>
            <button className="button button-secondary" type="button" onClick={() => setSelectedTask("publishing")}>Yayın bağlantısı görevini aç</button>
          </div>
        )}
        {!summary.appUsable ? (
          <div className="quickstart-status is-warning" role="status">
            <div>
              <strong>Önce yerel çalışma bileşenini hazırla</strong>
              <span>Bu bilgisayarda Blogbot motoru hazır olduğunda kaynak ve taslak işlemleri açılır.</span>
            </div>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void testConnection()}>
              {busy ? "Kontrol ediliyor…" : "Yerel bileşeni test et"}
            </button>
          </div>
        ) : null}
        <div className="quickstart-actions">
          <label className="acknowledgement">
            <input type="checkbox" checked={acknowledged} disabled={readOnly} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>İçerik değişirse yeniden onay gerektiğini anlıyorum.</span>
          </label>
          <button
            className="button button-primary"
            type="button"
            disabled={readOnly || busy || !summary.appUsable || !acknowledged || (connectorDraft.site.mode !== "PUBLISH" && !connectorDraft.site.repositoryPath.trim())}
            aria-describedby={quickstartActivationReason ? "quickstart-activation-prerequisite" : undefined}
            onClick={() => {
              if (connectorDraft.site.mode === "PUBLISH") {
                setSelectedTask("publishing");
                setConnectionMessage("Yayın hedefi henüz kaydedilmedi. Önce yayın bağlantısı görevindeki site, GitHub ve workflow bilgilerini doğrulayın.");
                return;
              }
              void save();
            }}
          >
            {connectorDraft.site.mode === "PUBLISH" ? "Yayın ayarlarına geç" : "Blogbot’u bu hedefle kullan"}
          </button>
          {quickstartActivationReason ? <small id="quickstart-activation-prerequisite" className="action-unavailable-reason">{quickstartActivationReason}</small> : null}
        </div>
        {connectionMessage ? <p className="form-message" role="status" aria-live="polite">{connectionMessage}</p> : null}
      </section> : null}

      {engineRecoveryAvailable ? (
        <section className="setup-recovery" role="status" aria-live="polite">
          <div>
            <p className="section-kicker">YEREL VERİ KURTARMA</p>
            <h2>Yerel çalışma alanı kurtarma gerektiriyor</h2>
            <p>Blogbot motoru mevcut yerel veriyi açarken zaman aşımına uğradı. Kurtarma, önceki çalışma alanını silmez; onu bu bilgisayardaki kurtarma klasörüne taşır ve yeni, boş bir yerel çalışma alanı açar.</p>
          </div>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => void recoverLocalWorkspace()}>
            {busy ? "Kurtarılıyor…" : "Yeni yerel çalışma alanıyla kurtar"}
          </button>
        </section>
      ) : null}

      {selectedTask !== "overview" && selectedTask !== "first-start" ? (
      <section className="setup-advanced setup-task-detail" aria-labelledby="setup-task-detail-title">
        <h3 id="setup-task-detail-title">
          {selectedTask === "diagnostics" ? "Canlı teknik durum" : `${selectedTaskDefinition?.title ?? "Kurulum"} adımları`}
        </h3>

      {selectedTask === "diagnostics" ? <>
      <div className="setup-overview">
        <div>
          <span>Uygulama</span>
          <strong>{summary.appUsable ? "Kullanılabilir" : "Onarım gerekli"}</strong>
        </div>
        <div>
          <span>Kaynak ve taslak işlemleri</span>
          <strong>{summary.writeReady ? "Hazır" : "Yerel bileşen bekliyor"}</strong>
        </div>
        <div>
          <span>{connectorDraft.site.mode === "PUBLISH" ? "Onaylı yayın" : "Seçili hedef"}</span>
          <strong>{connectorDraft.site.mode === "PUBLISH"
            ? (summary.publishReady ? "Hazır" : "Yayın bağlantısı bekliyor")
            : (connectorDraft.site.repositoryPath.trim() ? "Klasör seçildi" : "Klasör seçin")}</strong>
        </div>
        <div>
          <span>Kontrol</span>
          <strong>{summary.total ? `${summary.ready}/${summary.total} hazır` : "Test bekleniyor"}</strong>
        </div>
      </div>

      <div className="prerequisite-grid">
        {(status?.checks ?? []).map((check) => (
          <article
            className={`prerequisite-card state-${check.state.toLowerCase()}`}
            data-state={check.state}
            key={check.id}
          >
            <div>
              <span className="status-dot" aria-hidden="true" />
              <strong>{check.label}</strong>
              <span className="prerequisite-state-badge" aria-label={`Durum: ${stateLabels[check.state]}`}>
                <span aria-hidden="true">{check.state === "READY" ? "✓" : check.state === "MISSING" || check.state === "BLOCKED" ? "!" : "?"}</span>
                {stateLabels[check.state]}
              </span>
            </div>
            <p>{check.detail}</p>
            {check.userAction ? <em>{check.userAction}</em> : null}
            {check.id === "local-engine" && check.state !== "READY" ? (
              <button
                className="button button-secondary prerequisite-action"
                type="button"
                disabled={busy}
                onClick={() => void testConnection()}
              >
                  Yerel bileşeni test et
              </button>
            ) : null}
          </article>
        ))}
      </div>
      </> : null}

      {selectedTask !== "diagnostics" ? <div className="setup-input-panel">
        <div>
      <p className="section-kicker">SİZDEN İSTENEN BİLGİLER</p>
            <h2>Bu görev için yalnız gerekli bilgileri seçin.</h2>
            <p>
            Blogbot verileri bu bilgisayarda tutar. Bu görevle ilgisi olmayan
            alanlar gösterilmez; parola, token ve özel anahtar istenmez.
            </p>
        </div>
        <div className="input-requirements" aria-label="Kurulum için gerekenler">
          {setupRequirements
            .filter((requirement) => selectedTask === "writing"
              ? requirement.id === "codex"
              : selectedTask === "publishing"
                ? ["github", "site"].includes(requirement.id)
                : selectedTask === "backup"
                  ? requirement.id === "backup"
                  : false)
            .map((requirement, index) => (
            <div key={requirement.id} className={`setup-requirement requirement-${requirement.kind.toLowerCase()}`}>
              <strong>{index + 1}</strong>
              <span>
                <b>{requirement.label}</b>
                <small>{requirement.detail}</small>
                <small>
                  {requirement.kind === "LOCAL_INSTALL"
                    ? "Uygulama paketiyle otomatik kurulur ve test edilir."
                    : requirement.kind === "EXTERNAL_CONFIGURATION"
                      ? "Yerel yol veya seçenek kullanıcıdan alınır; secret, token veya private key tutulmaz."
                      : "Dış yetkilendirme gerekir; bu ekranda secret, token veya private key istenmez."}
                </small>
              </span>
              <small className={`requirement-state state-${requirement.state.toLowerCase()}`}>
                {stateLabels[requirement.state]}
              </small>
            </div>
          ))}
        </div>
        <div className="connector-input-grid" aria-label="Gizli olmayan bağlantı bilgileri">
          {connectorFields
            .filter((connector) => selectedTask === "writing"
              ? connector.id === "codex"
              : selectedTask === "publishing"
                ? ["site", "github", "deploy"].includes(connector.id)
                : selectedTask === "backup"
                  ? connector.id === "backup"
                  : false)
            .map((connector) => (
            <fieldset key={connector.id} className="connector-card" data-testid={`setup-connector-${connector.id}`} disabled={readOnly}>
              <legend>{connector.label}</legend>
              <p className="field-help">{connector.description}</p>
              {connector.id === "site" ? (
                <label className="field">
                  <span>İçeriğin nereye gideceği</span>
                  <div className="mode-choice-grid" role="radiogroup" aria-label="İçerik hedefi">
                    {([
                      ["LOCAL_ONLY", "Klasöre yaz", "Bir klasör seçin; onaylı Blogbot içerik paketi ve manifest yalnızca oraya yazılır."],
                      ["LOCAL_DEV", "Yerel projeye gönder", "package.json içindeki npm run dev ile çalışan projenize yazar."],
                      ["PUBLISH", "Yayındaki siteye gönder", "GitHub deposu, CI ve projenizin yayın akışıyla gönderir; hesap bağlantısı gerekir."]
                    ] as const).map(([value, title, detail], index) => {
                      const selected = connectorDraft.site.mode === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`mode-choice ${selected ? "is-selected" : ""}`}
                          onClick={() => setConnectorDraft((current) => ({ ...current, site: { ...current.site, mode: value } }))}
                        >
                          <strong>{index + 1}. {title}</strong>
                          <small>{detail}</small>
                        </button>
                      );
                    })}
                  </div>
                  <small>
                    {connectorDraft.site.mode === "LOCAL_ONLY"
                      ? "Klasör seçiciyle bir hedef seçin. GitHub, hosting veya public adres gerekmez."
                      : connectorDraft.site.mode === "LOCAL_DEV"
                        ? "Proje klasörünü seçin; Blogbot scripts.dev komutunu test eder ve isterse başlatır."
                        : "Site deposu, public adres ve yayın workflow'u doğrulanmadan yayın düğmesi açılmaz."}
                  </small>
                </label>
              ) : null}
              {connector.fields
                .filter(([key]) => !(connector.id === "site" && key === "publicSiteUrl" && connectorDraft.site.mode !== "PUBLISH"))
                .map(([key, label, required = true]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <input
                    id={`${connector.id}-${key}`}
                    name={`${connector.id}-${key}`}
                    value={String(connectorDraft[connector.id][key as keyof typeof connectorDraft[typeof connector.id]])}
                    onChange={(event) => setConnectorDraft((current) => ({
                      ...current,
                      [connector.id]: { ...current[connector.id], [key]: event.target.value }
                    }))}
                    autoComplete="off"
                    required={required}
                  />
                  {(connector.id === "site" && key === "repositoryPath") || (connector.id === "backup" && key === "folder") ? (
                    <button
                      className="button button-secondary folder-picker-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void pickFolder(connector.id === "site" ? "site" : "backup")}
                    >
                      Bilgisayardan klasör seç
                    </button>
                  ) : null}
                </label>
                ))}
              {connector.id === "site" && connectorDraft.site.mode === "LOCAL_DEV" ? (
                <div className="local-dev-control">
                  <span className="field-help">Yerel proje sunucusu</span>
                  {!localDevRunning ? <label className="checkbox-field"><input type="checkbox" checked={localDevTrusted} onChange={(event) => setLocalDevTrusted(event.target.checked)} /> Seçtiğim proje klasörüne ve <code>npm run dev</code> komutuna güveniyorum.</label> : null}
                  <button className="button button-secondary" type="button" disabled={!localDevSupported || busy || !connectorDraft.site.repositoryPath.trim() || (!localDevRunning && !localDevTrusted)} aria-describedby="local-dev-unavailable" onClick={() => void toggleLocalDev()}>
                    {localDevRunning ? "npm run dev sürecini durdur" : "npm run dev sürecini başlat"}
                  </button>
                  {localDevStatusError ? (
                    <div className="local-dev-status-error" role="status" aria-live="polite">
                      <small id="local-dev-unavailable">Yerel proje sunucusunun durumu okunamadı. Güvenlik nedeniyle başlatma kapalı tutuldu; durumu yeniden deneyin.</small>
                      <button className="button button-quiet" type="button" disabled={busy || localDevStatusChecking} onClick={() => void refreshLocalDevStatus()}>{localDevStatusChecking ? "Kontrol ediliyor…" : "Durumu yeniden dene"}</button>
                    </div>
                  ) : <small id="local-dev-unavailable">{localDevSupported ? (localDevRunning ? "Çalışıyor; durdurmak için bu düğmeyi kullanın." : "Blogbot yalnız seçtiğiniz klasördeki komutu, daraltılmış bir ortamla ve çıktı günlüğünü uygulamaya aktarmadan çalıştırır.") : "Güvenli süreç aracısı bu sürümde hazır değil; Blogbot proje komutlarını genel kullanıcı yetkisiyle çalıştırmaz. Komutu seçtiğiniz projede kendiniz başlatabilirsiniz."}</small>}
                </div>
              ) : null}
              <div className="button-row">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => void testConnector(connector.id)}>Bilgileri doğrula</button>
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => void saveConnector(connector.id)}>Bu ayarı kaydet</button>
                {connector.id === "codex" ? (
                  <>
                    <button className="button button-secondary" type="button" disabled={busy} onClick={() => void testCodex()}>Bağlantıyı kontrol et</button>
                    <button className="button button-primary" type="button" disabled={busy} onClick={() => void startCodexLogin()}>Giriş penceresini aç</button>
                  </>
                ) : null}
                {connector.id === "github" ? (
                  <>
                    <button className="button button-secondary" type="button" disabled={busy} aria-describedby="github-broker-help" onClick={() => void refreshGitHubLoginStatus()}>Durumu kontrol et</button>
                    <small id="github-broker-help">{githubBrokerHelp}</small>
                  </>
                ) : null}
              </div>
              {connectorMessages[connector.id] ? (
                <p className="form-message" role="status" aria-live="polite">
                  {connectorMessages[connector.id]}
                </p>
              ) : null}
              <small>Önce bilgileri doğrulayın, sonra kaydedin. Parola, token veya özel anahtar bu ekrana yazılmaz.</small>
            </fieldset>
          ))}
        </div>
        {selectedTask === "backup" ? <>
        <p className="inline-notice" id="backup-folder-grant" role="note">
          <strong>Yedek dosya erişimi Windows seçimiyle sınırlandırılır.</strong> Blogbot yalnızca bu ekrandaki klasör seçiciyle izin verdiğiniz konumları kullanır; elle yazılmış başka yollar native katmanda reddedilir.
        </p>
        <fieldset className="connector-card backup-action-card" aria-describedby="backup-folder-grant" disabled={readOnly}>
          <legend>Yeni şifreli yedek oluştur</legend>
          <label className="field">
            <span>Kaynak veri klasörü</span>
            <input id="backup-source-directory" name="backup-source-directory" value={backupSourceDirectory} readOnly autoComplete="off" placeholder="Windows seçicisinden klasör seçin" />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupSource")}>Bilgisayardan klasör seç</button>
          </label>
          <label className="field">
            <span>Yeni yedek dosyası</span>
            <input id="backup-output-path" name="backup-output-path" value={backupOutputPath} readOnly autoComplete="off" placeholder="Windows seçicisinden yedek klasörü seçin" />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupArchive")}>Yedek klasörü seç</button>
          </label>
          <label className="field">
            <span>Alınacak dosyalar</span>
            <textarea id="backup-relative-paths" name="backup-relative-paths" value={backupRelativePaths} onChange={(event) => setBackupRelativePaths(event.target.value)} rows={2} aria-describedby="backup-create-help" />
          </label>
          <label className="field">
            <span>Yeni yedekleme şifresi <small>(en az 16 karakter; kaydedilmez)</small></span>
            <input id="backup-create-recovery-key" name="backup-create-recovery-key" type="password" value={backupRecoveryKey} onChange={(event) => setBackupRecoveryKey(event.target.value)} autoComplete="new-password" minLength={16} aria-describedby="backup-create-help" required />
          </label>
          <button className="button button-secondary" type="button" disabled={busy || !backupSourceDirectory || !backupOutputPath || !backupRelativePaths.trim() || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => void createBackup()}>Şifreli yedek oluştur</button>
          <small id="backup-create-help">Her satıra bir dosya yolu yazın. Dosya listesi kaynak klasörüne göre göreli olmalıdır; mevcut çıktı dosyasının üzerine yazılmaz.</small>
        </fieldset>
        <fieldset className="connector-card backup-action-card" aria-describedby="backup-folder-grant" disabled={readOnly}>
          <legend>Şifreli yedek doğrulama ve geri yükleme önizlemesi</legend>
          <label className="field">
            <span>Yedek dosyası</span>
            <input id="backup-archive-path" name="backup-archive-path" value={backupArchivePath} readOnly autoComplete="off" placeholder="Windows seçicisinden yedek klasörü seçin" aria-describedby="backup-help" required />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupArchive")}>Yedek klasörü seç</button>
          </label>
          <label className="field">
            <span>Geri yükleme üst klasörü</span>
            <input id="backup-target-parent" name="backup-target-parent" value={backupTargetParent} readOnly autoComplete="off" placeholder="Windows seçicisinden üst klasörü seçin" aria-describedby="backup-help" required />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupTarget")}>Üst klasörü seç</button>
          </label>
          <label className="field">
            <span>Oluşturulacak yeni klasörün adı</span>
            <input id="backup-target-name" name="backup-target-name" value={backupTargetName} onChange={(event) => setBackupTargetName(event.target.value)} autoComplete="off" maxLength={80} aria-invalid={!restoreFolderNameValid} aria-describedby="backup-help" required />
            {backupTargetPath ? <code className="selected-restore-path">{backupTargetPath}</code> : null}
          </label>
          <label className="field">
            <span>Yedekleme şifresi <small>(en az 16 karakter; bu işlemden sonra tutulmaz)</small></span>
            <input id="backup-recovery-key" name="backup-recovery-key" type="password" value={backupRecoveryKey} onChange={(event) => setBackupRecoveryKey(event.target.value)} autoComplete="new-password" minLength={16} aria-describedby="backup-help" required />
          </label>
          <div className="button-row">
            <button className="button button-secondary" type="button" disabled={busy || !backupArchivePath || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => void verifyBackup()}>Yedeği doğrula</button>
            <button className="button button-secondary" type="button" disabled={busy || !backupArchivePath || !backupTargetPath || !restoreFolderNameValid || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => void previewBackup()}>Geri yüklemeyi önizle</button>
            <button className="button button-danger" type="button" disabled={busy || !backupArchivePath || !backupTargetPath || !restoreFolderNameValid || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => setRestoreConfirmationOpen(true)}>Yeni klasöre geri yükle</button>
          </div>
          <small id="backup-help">Şifre anahtarı yalnızca engine belleğine gönderilir. Önizleme dosya yazmaz; geri yükleme yalnız açık onaydan sonra seçtiğiniz üst klasörün altında henüz var olmayan yeni klasörü oluşturur.</small>
          {backupMessage ? <p className="form-message" role="status" aria-live="polite">{backupMessage}</p> : null}
        </fieldset>
        </> : null}
      </div> : null}

      </section>
      ) : null}

      {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}

      <aside className="setup-note">
        <strong>Son kullanıcı bilgisayarına kurulmayacaklar</strong>
        <p>
          Node.js, Rust, Visual Studio Build Tools, Docker ve ayrı bir veritabanı servisi son
          kullanıcıdan istenmez. Gerekli çalışma dosyaları kurulum paketine
          dahil edilir; yerel veri deposu uygulamanın içinde çalışır. Yalnız
          Codex/GitHub hesap bağlantıları kullanıcı tarafından isteğe bağlı olarak
          yapılandırılır.
        </p>
      </aside>
      {restoreConfirmationOpen ? (
        <ConfirmationDialog
          title="Geri yüklemeyi onayla"
          detail="Yalnızca boş ve yeni bir klasöre geri yükleme yapılacak. Var olan bir klasörün veya yedek dosyasının üzerine yazılmaz."
          confirmLabel="Geri yüklemeyi başlat"
          busy={busy}
          onCancel={() => setRestoreConfirmationOpen(false)}
          onConfirm={() => {
            setRestoreConfirmationOpen(false);
            void restoreBackup();
          }}
        />
      ) : null}
    </section>
  );
}
