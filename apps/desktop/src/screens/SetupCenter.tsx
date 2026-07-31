import { useEffect, useMemo, useState } from "react";

import { canEnableAutomationMode, isRecoveryKeyUsable, setupConnectorLabel, summarizePrerequisites } from "../app-model.ts";
import { buildSetupRequirements } from "../types.ts";
import type { BlogbotBridge } from "../bridge.ts";
import type {
  OnboardingSettings,
  PrerequisiteSnapshot,
  SetupConnectorDraft,
  SetupConnectorId,
  SetupConnectorTestResult
} from "../types.ts";

interface SetupCenterProps {
  bridge: BlogbotBridge;
  onCompleted: () => Promise<void>;
  initialGuided?: boolean;
}

const stateLabels = {
  READY: "Hazır",
  MISSING: "Eksik",
  BLOCKED: "Bekliyor",
  ATTENTION: "Kontrol gerekli"
} as const;

const connectorStorageKey = "blogbot.setup.connector-draft.v1";
const defaultConnectorDraft: SetupConnectorDraft = {
  codex: { accountLabel: "" },
  github: { owner: "", repository: "", clientId: "" },
  site: { repositoryPath: "", publicSiteUrl: "", mode: "LOCAL_ONLY" },
  deploy: { workflowName: "" },
  backup: { folder: "" }
};

function readConnectorDraft(): SetupConnectorDraft {
  try {
    const parsed = JSON.parse(localStorage.getItem(connectorStorageKey) ?? "null") as Partial<SetupConnectorDraft> | null;
    return {
      codex: { ...defaultConnectorDraft.codex, ...parsed?.codex },
      github: { ...defaultConnectorDraft.github, ...parsed?.github },
      site: { ...defaultConnectorDraft.site, ...parsed?.site, mode: (parsed?.site?.mode ?? "LOCAL_ONLY") },
      deploy: { ...defaultConnectorDraft.deploy, ...parsed?.deploy },
      backup: { ...defaultConnectorDraft.backup, ...parsed?.backup }
    };
  } catch {
    return defaultConnectorDraft;
  }
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
  onCompleted,
  initialGuided = false
}: SetupCenterProps) {
  void initialGuided;
  const [status, setStatus] = useState<PrerequisiteSnapshot | null>(null);
  const [deviceName, setDeviceName] = useState("Blogbot Editör PC");
  const [mode, setMode] =
    useState<OnboardingSettings["mode"]>("INGEST_ONLY");
  const [scanIntervalMinutes, setScanIntervalMinutes] = useState(30);
  const [acknowledged, setAcknowledged] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [connectorMessages, setConnectorMessages] = useState<Partial<Record<SetupConnectorId, string>>>({});
  const [connectorDraft, setConnectorDraft] = useState<SetupConnectorDraft>(readConnectorDraft);
  const [backupArchivePath, setBackupArchivePath] = useState("");
  const [backupSourceDirectory, setBackupSourceDirectory] = useState("");
  const [backupOutputPath, setBackupOutputPath] = useState("");
  const [backupRelativePaths, setBackupRelativePaths] = useState("state.json");
  const [backupTargetPath, setBackupTargetPath] = useState("");
  const [backupRecoveryKey, setBackupRecoveryKey] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [localDevRunning, setLocalDevRunning] = useState(false);
  const [localDevLogPath, setLocalDevLogPath] = useState("");
  // The old seven-step wizard is retained only for backwards-compatible state shape;
  // the current product always opens on the concise target-first setup screen.
  const [guidedMode] = useState(false);
  const [guidedStep, setGuidedStep] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
      title: "Codex hesabını doğrula",
      detail: "Codex hazır değilse bu adım yayın akışını açmaz; yalnız taslak işlemleri kilitli kalır.",
      checkIds: ["codex"]
    },
    {
      title: "Kaynak çalışma alanını hazırla",
      detail: "Kaynaklar İçerik Akışı > Kaynaklar ekranından eklenir ve tek tek test edilir.",
      checkIds: ["local-engine"]
    },
    {
      title: "Çalışma tercihlerini seç",
      detail: "Bu bilgisayarın adını ve otomasyon sınırını seçin. Yazar, takvim ve yayın ayarları ilgili çalışma alanlarında tutulur.",
      checkIds: []
    },
    {
      title: connectorDraft.site.mode === "PUBLISH" ? "Yayın bağlantılarını kontrol et" : "Yerel hedefi doğrula",
      detail: connectorDraft.site.mode === "PUBLISH"
        ? "GitHub, yedek veya site formatı hazır değilse yayın düğmesi güvenle kilitli kalır."
        : "Seçtiğiniz klasör veya yerel proje hazır değilse yalnız o hedefe yazma işlemi kilitli kalır.",
      checkIds: connectorDraft.site.mode === "PUBLISH" ? ["github", "backup", "site-adapter"] as const : ["local-engine"] as const
    },
    {
      title: "Son kontrol",
      detail: "Tüm kontroller yeniden çalışır. Eksik varsa uygulama açılır, yalnız o eksikten etkilenen işlem kilitlenir.",
      checkIds: connectorDraft.site.mode === "PUBLISH"
        ? ["windows", "local-engine", "codex", "github", "backup"] as const
        : ["windows", "local-engine", "codex"] as const
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

  useEffect(() => {
    if (connectorDraft.site.mode !== "LOCAL_DEV") return;
    let active = true;
    void bridge.localDevStatus().then((result) => {
      if (active) { setLocalDevRunning(result.running); setLocalDevLogPath(result.logPath ?? ""); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [bridge, connectorDraft.site.mode]);

  const summary = useMemo(
    () => summarizePrerequisites(status?.checks ?? []),
    [status]
  );
  const currentGuidedStep = guidedSteps[guidedStep] ?? guidedSteps[0];
  const checksById = useMemo(
    () => new Map((status?.checks ?? []).map((check) => [check.id, check])),
    [status]
  );
  const currentStepChecks = currentGuidedStep.checkIds
    .map((id) => checksById.get(id))
    .filter((check): check is NonNullable<typeof check> => Boolean(check));
  const guidedReadyCount = currentStepChecks.filter((check) => check.state === "READY").length;
  const setupRequirements = useMemo(
    () => buildSetupRequirements(status?.checks ?? []),
    [status]
  );
  const save = async () => {
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
    try {
      await bridge.saveSetupConnector({
        connector: "site",
        config: connectorDraft.site
      });
      await bridge.completeOnboarding({
        deviceName: deviceName.trim(),
        mode,
        scanIntervalMinutes,
        acknowledgeApprovalBoundary: acknowledged,
        autostartEnabled
      });
      await onCompleted();
      setMessage("Bu cihazın çalışma ayarları kaydedildi.");
    } catch (reason) {
      setMessage(
        explainFailure(reason, "Kurulum ayarları kaydedilemedi.", "alanları kontrol edip tekrar deneyin.")
      );
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setConnectionMessage("Blogbot'un yerel çalışma bileşeni ve iş kuyruğu test ediliyor…");
    try {
      const result = await bridge.testLocalEngine();
      setConnectionMessage(result.detail);
      setStatus(await bridge.getPrerequisiteStatus());
    } catch (reason) {
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
    try {
      const result = await bridge.testSetupConnector({ connector, config: connectorDraft[connector] });
      const suggestion = result.repositorySuggestion
        ? ` Yerel git deposu bulundu: ${result.repositorySuggestion}`
        : "";
      const migrationHint = result.contentModel === "TYPESCRIPT_EDITORIAL_DATA"
        ? " İçerik modeli eski TypeScript verisi; yayın öncesi deneme dönüşümü gerekir."
        : "";
      if (connector === "site" && result.repositorySuggestion) {
        const match = result.repositorySuggestion.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/iu);
        if (match) {
          const owner = match[1] ?? "";
          const repository = match[2] ?? "";
          setConnectorDraft((current) => ({
            ...current,
            github: { ...current.github, owner, repository }
          }));
        }
      }
      setConnectionMessage(`${result.detail}${suggestion}${migrationHint}`);
      if (connector === "site") {
        try {
          const dryRun = (result as SetupConnectorTestResult & { adapterDryRun?: { ok?: boolean; adapterId?: string } }).adapterDryRun;
          localStorage.setItem("blogbot.setup.site-adapter.v1", JSON.stringify({
            ok: dryRun?.ok === true,
            adapterId: dryRun?.adapterId ?? "local-folder-v1"
          }));
        } catch { /* best effort local preference */ }
      }
      setConnectorMessages((current) => ({
        ...current,
        [connector]: result.ready
          ? `Biçim doğrulandı. Gerçek yetkilendirme gerekiyorsa ayrıca tamamlanmalıdır. ${result.detail}${suggestion}${migrationHint}`
          : result.detail
      }));
      setStatus(await bridge.getPrerequisiteStatus());
    } catch (reason) {
      const detail = explainFailure(reason, "Biçim testi tamamlanamadı.", "zorunlu gizli olmayan alanları doldurup yeniden deneyin.");
      setConnectionMessage(detail);
      setConnectorMessages((current) => ({ ...current, [connector]: detail }));
    } finally { setBusy(false); }
  };
  const saveConnector = async (connector: SetupConnectorId) => {
    const label = setupConnectorLabel(connector);
    setBusy(true); setConnectionMessage(`${label} ayarları yerel olarak kaydediliyor…`);
    try {
      const result = await bridge.saveSetupConnector({ connector, config: connectorDraft[connector] });
      setConnectionMessage(result.detail);
      setConnectorMessages((current) => ({ ...current, [connector]: result.detail }));
      setStatus(await bridge.getPrerequisiteStatus());
    } catch (reason) {
      const detail = explainFailure(reason, "Ayarlar kaydedilemedi.", "önce alanları biçim testiyle doğrulayın.");
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
        setConnectorDraft((current) => {
          const next = {
            ...current,
            [target]: { ...current[target], [target === "site" ? "repositoryPath" : "folder"]: selected }
          } as SetupConnectorDraft;
          try { localStorage.setItem(connectorStorageKey, JSON.stringify(next)); } catch { /* best effort local preference */ }
          return next;
        });
        setConnectorMessages((current) => ({
          ...current,
          [target]: `Seçilen klasör: ${selected}. Şimdi “Bilgileri doğrula” düğmesine basın.`
        }));
        setConnectionMessage("Klasör seçildi. Kaydetmeden önce biçim testini çalıştırın.");
      } else if (target === "backupSource") {
        setBackupSourceDirectory(selected);
        setConnectionMessage("Yedek kaynak klasörü seçildi.");
      } else if (target === "backupTarget") {
        setBackupTargetPath(selected);
        setConnectionMessage("Geri yükleme hedef klasörü seçildi.");
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
    setBusy(true);
    try {
      if (localDevRunning) {
        await bridge.stopLocalDev();
        setLocalDevRunning(false);
        setConnectionMessage("Yerel geliştirme süreci durduruldu.");
      } else {
        const result = await bridge.startLocalDev(path);
        setLocalDevRunning(result.running);
        setLocalDevLogPath(result.logPath ?? "");
        setConnectionMessage("Yerel geliştirme süreci başlatıldı. Proje kendi npm run dev çıktısını kullanıyor.");
      }
    } catch (reason) {
      setConnectionMessage(explainFailure(reason, "Yerel geliştirme süreci başlatılamadı.", "Site klasöründe package.json ve scripts.dev bulunduğunu kontrol edin."));
    } finally { setBusy(false); }
  };
  const testCodex = async () => {
    setBusy(true);
    setConnectionMessage("Yazı üretimi hesabı kontrol ediliyor…");
    try {
      const result = await bridge.testCodexRuntime();
      setConnectionMessage(result.detail);
      await bridge.getPrerequisiteStatus().then(setStatus);
    } catch (reason) {
      setConnectionMessage(explainFailure(reason, "Yazı üretimi hesabı kontrol edilemedi.", "Codex kurulumunu veya girişini kontrol edip yeniden deneyin."));
    } finally { setBusy(false); }
  };
  const startCodexLogin = async () => {
    setBusy(true);
    setConnectionMessage("Codex giriş akışı başlatılıyor…");
    try {
      const result = await bridge.startCodexLogin();
      setConnectionMessage(result.detail);
    } catch (reason) {
      setConnectionMessage(explainFailure(reason, "Codex giriş akışı başlatılamadı.", "Codex'in bu bilgisayarda kurulu olduğunu kontrol edin."));
    } finally { setBusy(false); }
  };
  const startGitHubLogin = async () => {
    if (!connectorDraft.github.clientId?.trim()) {
      setConnectorMessages((current) => ({
        ...current,
        github: "GitHub OAuth istemci kimliği gerekli. Bu, herkese açık uygulama kimliğidir; parola, token veya private key girmeyin."
      }));
      return;
    }
    setBusy(true);
    try {
      const result = await bridge.startGitHubDeviceFlow();
      const instruction = result.started && result.verificationUri && result.userCode
        ? `GitHub doğrulama adresini açın ve şu tek kullanımlık kodu girin: ${result.userCode} (${result.verificationUri})`
        : result.detail;
      setConnectorMessages((current) => ({ ...current, github: instruction ?? "GitHub yetkilendirme durumu alınamadı." }));
    } catch (reason) {
      setConnectorMessages((current) => ({ ...current, github: explainFailure(reason, "GitHub giriş penceresi açılamadı.", "bağlantı ayarlarını kontrol edip yeniden deneyin.") }));
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
    if (!window.confirm("Yalnızca boş ve yeni bir klasöre geri yükleme yapılacak. Devam edilsin mi?")) return;
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
        <button
          className="button button-primary"
          type="button"
          onClick={() => setShowAdvanced(true)}
        >
          Ayrıntılı ayarları aç
        </button>
      </header>

      {guidedMode ? (
        <section className="guided-setup" aria-labelledby="guided-setup-title">
          <div className="guided-progress" aria-label={`Kurulum adımı ${guidedStep + 1} / ${guidedSteps.length}`}>
            {guidedSteps.map((step, index) => (
              <button
                type="button"
                key={step.title}
                className={index === guidedStep ? "is-active" : index < guidedStep ? "is-complete" : ""}
                aria-label={`${index + 1}. ${step.title}`}
                onClick={() => setGuidedStep(index)}
              >
                {index < guidedStep ? "✓" : index + 1}
              </button>
            ))}
          </div>
          <div className="guided-progress-meter" aria-label={`İlerleme: ${guidedStep + 1} / ${guidedSteps.length}`}>
            <div className="guided-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={guidedSteps.length} aria-valuenow={guidedStep + 1}>
              <span style={{ width: `${((guidedStep + 1) / guidedSteps.length) * 100}%` }} />
            </div>
            <small>{guidedStep + 1} / {guidedSteps.length}</small>
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
          </div>
          <div className="guided-actions">
            <button className="button button-secondary" type="button" disabled={guidedStep === 0} onClick={() => setGuidedStep((current) => current - 1)}>Geri</button>
            {guidedStep < guidedSteps.length - 1 ? (
              <button className="button button-primary" type="button" onClick={() => setGuidedStep((current) => current + 1)}>Sonraki adım</button>
            ) : (
              <button className="button button-primary" type="button" disabled={busy} onClick={() => void refresh()}>Son testi çalıştır</button>
            )}
          </div>
          <small>Bu rehber isteğe bağlıdır. İstediğiniz an diğer menülere geçebilirsiniz.</small>
        </section>
      ) : null}

      <section className="setup-quickstart" aria-labelledby="quickstart-title">
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
                onClick={() => setConnectorDraft((current) => {
                  const next = { ...current, site: { ...current.site, mode: value } };
                  try { localStorage.setItem(connectorStorageKey, JSON.stringify(next)); } catch { /* best effort */ }
                  return next;
                })}
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
                value={connectorDraft.site.repositoryPath}
                onChange={(event) => setConnectorDraft((current) => ({
                  ...current,
                  site: { ...current.site, repositoryPath: event.target.value }
                }))}
                placeholder={connectorDraft.site.mode === "LOCAL_DEV" ? "Örn. C:\\Siteler\\benim-projem" : "Örn. C:\\Blogbot-Cikti"}
                aria-describedby="quickstart-target-help"
              />
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => void pickFolder("site")}>Bilgisayardan klasör seç</button>
            </label>
            <small id="quickstart-target-help">
              {connectorDraft.site.mode === "LOCAL_DEV"
                ? "package.json ve scripts.dev bulunan proje klasörünü seç."
                : "Blogbot bu klasöre yalnız onaylanan içerik paketini yazar."}
            </small>
          </div>
        ) : (
          <div className="quickstart-publish-note">
            <strong>Yayın bağlantısı daha sonra açılır.</strong>
            <span>GitHub bilgileri, site deposu ve workflow yalnız yayın hedefini seçtiğinde gerekir.</span>
            <button className="button button-secondary" type="button" onClick={() => setShowAdvanced(true)}>Yayın ayarlarını aç</button>
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
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>İçerik değişirse yeniden onay gerektiğini anlıyorum.</span>
          </label>
          <button
            className="button button-primary"
            type="button"
            disabled={busy || !summary.appUsable || !acknowledged || (connectorDraft.site.mode !== "PUBLISH" && !connectorDraft.site.repositoryPath.trim())}
            onClick={() => void save()}
          >
            {connectorDraft.site.mode === "PUBLISH" ? "Yayın ayarlarına geç" : "Blogbot’u bu hedefle kullan"}
          </button>
        </div>
        {connectionMessage ? <p className="form-message" role="status" aria-live="polite">{connectionMessage}</p> : null}
      </section>

      <details className="setup-advanced" open={showAdvanced} onToggle={(event) => setShowAdvanced(event.currentTarget.open)}>
        <summary>Teknik kontroller ve ayrıntılı ayarlar</summary>

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
            key={check.id}
          >
            <div>
              <span className="status-dot" aria-hidden="true" />
              <strong>{check.label}</strong>
              <small>{stateLabels[check.state]}</small>
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

      <div className="setup-input-panel">
        <div>
      <p className="section-kicker">SİZDEN İSTENEN BİLGİLER</p>
            <h2>Bu bilgisayar için yalnız gerekli tercihleri seçin.</h2>
            <p>
            Blogbot verileri bu bilgisayarda tutar. Sizden yalnız hesabı veya
            klasörü tanımlayan bilgiler istenir; parola, token ve özel anahtar
            istenmez. Bağlantı kurulmazsa kaynak tarama ve yerel inceleme yine
            kullanılabilir.
            </p>
        </div>
        <div className="input-requirements" aria-label="Kurulum için gerekenler">
          {setupRequirements.map((requirement, index) => (
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
            .filter((connector) => connectorDraft.site.mode === "PUBLISH" || !["github", "deploy"].includes(connector.id))
            .map((connector) => (
            <fieldset key={connector.id} className="connector-card">
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
                          onClick={() => setConnectorDraft((current) => {
                            const next = { ...current, site: { ...current.site, mode: value } };
                            try { localStorage.setItem(connectorStorageKey, JSON.stringify(next)); } catch { /* best effort */ }
                            return next;
                          })}
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
                    onChange={(event) => setConnectorDraft((current) => {
                      const next = { ...current, [connector.id]: { ...current[connector.id], [key]: event.target.value } };
                      try { localStorage.setItem(connectorStorageKey, JSON.stringify(next)); } catch { /* best effort local preference */ }
                      return next;
                    })}
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
                  <button className="button button-secondary" type="button" disabled={busy || !connectorDraft.site.repositoryPath.trim()} onClick={() => void toggleLocalDev()}>
                    {localDevRunning ? "npm run dev sürecini durdur" : "npm run dev sürecini başlat"}
                  </button>
                  <small>{localDevRunning ? "Çalışıyor; durdurmak için bu düğmeyi kullanın." : "Blogbot yalnız seçtiğiniz klasördeki scripts.dev komutunu çalıştırır."}</small>
                  {localDevLogPath ? <small>Çıktı günlüğü: {localDevLogPath}</small> : null}
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
                    <button className="button button-primary" type="button" disabled={busy} onClick={() => void startGitHubLogin()}>GitHub girişini başlat</button>
                    <button className="button button-secondary" type="button" disabled={busy} onClick={() => void bridge.getGitHubDeviceFlowStatus().then((result) => setConnectorMessages((current) => ({ ...current, github: result.detail ?? `GitHub durumu: ${result.status}` })))}>Durumu kontrol et</button>
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
        <fieldset className="connector-card backup-action-card">
          <legend>Yeni şifreli yedek oluştur</legend>
          <label className="field">
            <span>Kaynak veri klasörü</span>
            <input id="backup-source-directory" name="backup-source-directory" value={backupSourceDirectory} onChange={(event) => setBackupSourceDirectory(event.target.value)} autoComplete="off" placeholder="C:\\Blogbot\\data" />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupSource")}>Bilgisayardan klasör seç</button>
          </label>
          <label className="field">
            <span>Yeni yedek dosyası</span>
            <input id="backup-output-path" name="backup-output-path" value={backupOutputPath} onChange={(event) => setBackupOutputPath(event.target.value)} autoComplete="off" placeholder="C:\\Yedekler\\blogbot.backup" />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupArchive")}>Yedek klasörü seç</button>
          </label>
          <label className="field">
            <span>Alınacak dosyalar</span>
            <textarea id="backup-relative-paths" name="backup-relative-paths" value={backupRelativePaths} onChange={(event) => setBackupRelativePaths(event.target.value)} rows={2} aria-describedby="backup-create-help" />
          </label>
          <button className="button button-secondary" type="button" disabled={busy || !backupSourceDirectory || !backupOutputPath || !backupRelativePaths.trim() || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => void createBackup()}>Şifreli yedek oluştur</button>
          <small id="backup-create-help">Her satıra bir dosya yolu yazın. Dosya listesi kaynak klasörüne göre göreli olmalıdır; mevcut çıktı dosyasının üzerine yazılmaz.</small>
        </fieldset>
        <fieldset className="connector-card backup-action-card">
          <legend>Şifreli yedek doğrulama ve geri yükleme önizlemesi</legend>
          <label className="field">
            <span>Yedek dosyası</span>
            <input id="backup-archive-path" name="backup-archive-path" value={backupArchivePath} onChange={(event) => setBackupArchivePath(event.target.value)} autoComplete="off" placeholder="C:\\Yedekler\\blogbot.backup" aria-describedby="backup-help" required />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupArchive")}>Yedek klasörü seç</button>
          </label>
          <label className="field">
            <span>Boş geri yükleme klasörü</span>
            <input id="backup-target-path" name="backup-target-path" value={backupTargetPath} onChange={(event) => setBackupTargetPath(event.target.value)} autoComplete="off" placeholder="C:\\Blogbot-Restore-Test" aria-describedby="backup-help" required />
            <button className="button button-secondary folder-picker-button" type="button" disabled={busy} onClick={() => void pickFolder("backupTarget")}>Geri yükleme klasörü seç</button>
          </label>
          <label className="field">
            <span>Yedekleme şifresi <small>(en az 16 karakter; bu işlemden sonra tutulmaz)</small></span>
            <input id="backup-recovery-key" name="backup-recovery-key" type="password" value={backupRecoveryKey} onChange={(event) => setBackupRecoveryKey(event.target.value)} autoComplete="new-password" minLength={16} aria-describedby="backup-help" required />
          </label>
          <div className="button-row">
            <button className="button button-secondary" type="button" disabled={busy || !backupArchivePath || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => void verifyBackup()}>Yedeği doğrula</button>
            <button className="button button-secondary" type="button" disabled={busy || !backupArchivePath || !backupTargetPath || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => void previewBackup()}>Geri yüklemeyi önizle</button>
            <button className="button button-danger" type="button" disabled={busy || !backupArchivePath || !backupTargetPath || !isRecoveryKeyUsable(backupRecoveryKey)} onClick={() => void restoreBackup()}>Boş klasöre geri yükle</button>
          </div>
          <small id="backup-help">Şifre anahtarı yalnızca engine belleğine gönderilir. Doğrulama ve önizleme dosya yazmaz; geri yükleme ise yalnızca açık onaydan sonra seçtiğiniz boş klasöre dosya yazar.</small>
          {backupMessage ? <p className="form-message" role="status" aria-live="polite">{backupMessage}</p> : null}
        </fieldset>
        <div className="form-grid">
          <label className="field">
            <span>Bu cihazın adı</span>
            <input
              id="device-name"
              name="device-name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              autoComplete="off"
              minLength={3}
              required
            />
          </label>
          <label className="field">
            <span>Otomasyon sınırı</span>
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as OnboardingSettings["mode"])
              }
            >
              <option value="INGEST_ONLY">Yalnız kaynakları izle</option>
              <option value="DRAFT_ONLY">Taslak ve inceleme hazırla</option>
              <option value="PUBLISH_APPROVED">Onaylananları yayımla</option>
            </select>
          </label>
          <label className="field">
            <span>Kaynak tarama aralığı (dakika)</span>
            <input
              id="scan-interval-minutes"
              name="scan-interval-minutes"
              type="number"
              min={5}
              max={1440}
              step={5}
              value={scanIntervalMinutes}
              onChange={(event) => setScanIntervalMinutes(Number(event.target.value))}
              required
            />
            <small>Varsayılan 30 dakika. Bilgisayar kapalıyken tarama yapılmaz.</small>
          </label>
        </div>
        <div className="connection-probe">
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void testConnection()}
          >
            Blogbot'un yerel çalışma bileşenini test et
          </button>
          <small>
            Bu test dış ağa bağlanmaz; uygulamanın yerel veri deposunu ve
            iş kuyruğunu birlikte doğrular.
          </small>
        </div>
        {connectionMessage ? (
          <p className="form-message" role="status" aria-live="polite">{connectionMessage}</p>
        ) : null}
        <label className="acknowledgement">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            required
          />
          <span>
            İçerik paketinin herhangi bir parçası değişirse insan onayının
            geçersiz olacağını anlıyorum.
          </span>
        </label>
        <label className="acknowledgement">
          <input
            type="checkbox"
            checked={autostartEnabled}
            onChange={(event) => setAutostartEnabled(event.target.checked)}
          />
          <span>
            Windows oturumu açıldığında Blogbot'u otomatik başlat. Bu ayar daha
            sonra Ayarlar ekranından kapatılabilir.
          </span>
        </label>
        <div className="setup-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={
              busy ||
              !summary.appUsable ||
              !acknowledged ||
              deviceName.trim().length < 3 ||
              !canEnableAutomationMode(mode, summary)
            }
            onClick={() => void save()}
          >
            Bu cihazı kaydet
          </button>
          <small>
            Yerel çalışma bileşeni hazır olduğunda kaynak, taslak ve editoryal işlemler açılır.
          </small>
        </div>
        {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}
      </div>

      </details>

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
    </section>
  );
}
