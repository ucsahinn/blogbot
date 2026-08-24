import { useCallback, useEffect, useState, type ReactNode } from "react";

import desktopPackage from "../../package.json" with { type: "json" };

import bobyAvatar from "../assets/boby-avatar-v3.webp";
import opeLogo from "../assets/ope-logo-v2.png";
import { userFacingUpdateError, type BlogbotBridge, type UnsignedDesktopUpdate } from "../bridge.ts";
import type { BootstrapSnapshot } from "../types.ts";

export type PageId =
  | "dashboard"
  | "content"
  | "content-candidates"
  | "instant"
  | "editorial"
  | "editorial-review"
  | "publishing"
  | "operations"
  | "settings"
  | "setup"
  | "setup-guide";

const navigation: Array<{
  id: PageId;
  label: string;
  icon: string;
  shortcut?: string;
}> = [
  { id: "dashboard", label: "Genel Bakış", icon: "⌂" },
  { id: "content", label: "İçerik Akışı", icon: "◎" },
  { id: "editorial", label: "Editoryal Masa", icon: "✓" },
  { id: "publishing", label: "Takvim ve Yayın", icon: "◫" },
  { id: "operations", label: "Operasyonlar", icon: "⋮" }
];

const UPDATE_CHECK_DELAY_MS = 1_500;

function NavIcon({ page }: { page: PageId }) {
  const path = page === "dashboard"
    ? "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H8v6H3a1 1 0 0 1-1-1V10.5Z"
    : page === "content"
      ? "M4 5h16M4 12h16M4 19h10"
      : page === "editorial"
        ? "m5 12 4 4L19 6"
        : page === "publishing"
          ? "M4 5h16v14H4zM8 3v4M16 3v4M4 10h16"
          : "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4";
  return <svg className="nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

interface AppShellProps {
  activePage: PageId;
  snapshot: BootstrapSnapshot;
  children: ReactNode;
  onNavigate: (page: PageId) => void;
  onOpenSetup: () => void;
  onOpenSettings: () => void;
  onOpenBoby: () => void;
  onExportDiagnostics: () => Promise<{ path: string; directory: string; bytes: number; included: string[]; opened: boolean }>;
  bridge: BlogbotBridge;
  syncError?: string;
}

export function AppShell({
  activePage,
  snapshot,
  children,
  onNavigate,
  onOpenSetup,
  onOpenSettings,
  onOpenBoby,
  onExportDiagnostics,
  bridge,
  syncError = ""
}: AppShellProps) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<UnsignedDesktopUpdate | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatePhase, setUpdatePhase] = useState("idle");
  const [updateMessage, setUpdateMessage] = useState("");
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticMessage, setDiagnosticMessage] = useState("");

  const openProjectPage = async () => {
    try {
      await bridge.openProjectPage();
    } catch {
      setUpdateMessage("GitHub sayfası varsayılan tarayıcıda açılamadı. Bağlantıyı daha sonra yeniden deneyin.");
    }
  };

  const exportDiagnostics = async () => {
    setDiagnosticBusy(true);
    setDiagnosticMessage("");
    try {
      const result = await onExportDiagnostics();
      setDiagnosticMessage(`Tanı paketi hazırlandı ve klasör açıldı: ${result.directory}`);
    } catch {
      setDiagnosticMessage("Tanı paketi oluşturulamadı. Operasyonlar ekranından yeniden deneyin.");
    } finally {
      setDiagnosticBusy(false);
    }
  };

  const checkForUpdate = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__) {
      setUpdateMessage("Güncelleme denetimi yalnız paketlenmiş OPE uygulamasında yapılır.");
      return;
    }
    setUpdateBusy(true);
    setUpdatePhase("checking");
    setPendingUpdate(null);
    setUpdateMessage("Güncellemeler güvenli bağlantıyla denetleniyor…");
    try {
      const result = await bridge.checkUnsignedUpdate();
      if (result.kind === "upToDate") {
        setUpdatePhase("idle");
        setUpdateMessage(`Bu bilgisayardaki OPE, yayınlanmış ${result.latestVersion} sürümüyle güncel.`);
        return;
      }
      if (result.kind === "localBuildNewer") {
        setUpdatePhase("idle");
        setUpdateMessage(`Bu bilgisayardaki OPE, yayınlanmış ${result.latestVersion} sürümünden daha yeni. Yeni bir yayın paketi henüz yok.`);
        return;
      }
      const update = result.update;
      setPendingUpdate(update);
      setUpdatePhase("available");
      setUpdateMessage(`OPE ${update.version} hazır. İndirmeyi ve kurulumu siz başlatın.`);
    } catch (reason) {
      setUpdatePhase("error");
      setUpdateMessage(userFacingUpdateError(reason));
    } finally {
      setUpdateBusy(false);
    }
  }, [bridge]);

  const installPendingUpdate = async () => {
    if (!pendingUpdate) return;
    setUpdateBusy(true);
    setUpdatePhase("installing");
    try {
      setUpdateMessage("Güncelleme indiriliyor ve SHA-256 ile doğrulanıyor…");
      await bridge.installUnsignedUpdate(pendingUpdate);
      setUpdatePhase("handoff");
      setUpdateMessage("OPE kapanıyor. Kurulum sihirbazı birkaç saniye içinde açılacak; kurulum bitene kadar bu pencereyi kapatmayın.");
    } catch {
      setUpdatePhase("error");
      setUpdateMessage("Güncelleme indirilemedi veya SHA-256 doğrulaması başarısız oldu. Kurulum başlatılmadı.");
    } finally {
      setUpdateBusy(false);
    }
  };

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const timer = window.setTimeout(() => {
      void checkForUpdate();
    }, UPDATE_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [checkForUpdate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        onNavigate("instant");
      }
      if (event.ctrlKey && event.key === ",") {
        event.preventDefault();
        onOpenSettings();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNavigate, onOpenSettings]);

  useEffect(() => {
    const workspace = document.getElementById("main-workspace");
    workspace?.focus({ preventScroll: true });
  }, [activePage]);

  const runtimeLabel =
    snapshot.runtime === "ONLINE"
      ? "Yerel sistem hazır"
      : snapshot.runtime === "DEGRADED"
        ? "Bazı özellikler bekliyor"
        : "Yerel kurtarma modu";
  const isNavigationActive = (page: PageId) =>
    activePage === page ||
    (page === "content" && ["content-candidates", "instant"].includes(activePage)) ||
    (page === "editorial" && activePage === "editorial-review");
  const updateAvailable = updatePhase === "available" && pendingUpdate !== null;
  const aboutControlLabel = updateAvailable ? `${pendingUpdate.version} indir ve kur` : "Hakkında";
  const aboutControlAriaLabel = updateAvailable
    ? `OPE ${pendingUpdate.version} güncellemesini indir ve kur`
    : "OPE hakkında";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-workspace">Ana içeriğe geç</a>
      <aside className="sidebar" aria-label="Uygulama araçları">
        <div className="brand-lockup">
          <img className="brand-avatar ope-logo" src={opeLogo} alt="" width="42" height="42" />
          <span>
            <strong>OPE</strong>
            <small>OpenPostEditör</small>
          </span>
        </div>

        <nav className="primary-nav" aria-label="Ana menü">
          <p className="nav-eyebrow">Çalışma alanı</p>
          {navigation.map((item) => (
            <button
              className={`nav-item ${isNavigationActive(item.id) ? "is-active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-label={item.label}
              aria-current={isNavigationActive(item.id) ? "page" : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                <NavIcon page={item.id} />
              </span>
              <span>{item.label}</span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              {item.id === "content" && snapshot.pipeline[2]?.count ? (
                <span className="nav-count">{snapshot.pipeline[2].count}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <button type="button" className="boby-launcher" aria-label="Editör Boby'yi aç" onClick={onOpenBoby}>
          <img src={bobyAvatar} alt="" width="32" height="32" />
          <span>
            <strong>Editör Boby</strong>
            <small>Doğrudan yardım iste</small>
          </span>
        </button>

        <nav className="mobile-utility-nav" aria-label="İkincil menü">
          <button type="button" aria-label="Ayarlar" onClick={onOpenSettings}>
            <span aria-hidden="true">⚙</span>
          </button>
          <button type="button" aria-label="Kurulum ve önkoşullar" onClick={onOpenSetup}>
            <span aria-hidden="true">◇</span>
          </button>          <button type="button" aria-label={aboutControlAriaLabel} aria-expanded={updateAvailable ? undefined : aboutOpen} onClick={updateAvailable ? () => void installPendingUpdate() : () => setAboutOpen((open) => !open)}>
            <span aria-hidden="true">i</span>
          </button>
        </nav>

        <div className="sidebar-spacer" />
        <button className="setup-button settings-button" type="button" onClick={onOpenSettings}>
          <span className="nav-icon" aria-hidden="true">⚙</span>
          Ayarlar
          <kbd>Ctrl ,</kbd>
        </button>
        <button className="setup-button" type="button" onClick={onOpenSetup}>
          <span className="nav-icon" aria-hidden="true">
            ◇
          </span>
          Önkoşulları test et
        </button>
        <button className="setup-button diagnostic-button" type="button" onClick={() => void exportDiagnostics()} disabled={diagnosticBusy}>
          <span className="nav-icon" aria-hidden="true">+</span>
          {diagnosticBusy ? "Tanı paketi hazırlanıyor…" : "Tanı paketi oluştur"}
        </button>
        {diagnosticMessage ? <small className="sidebar-feedback" role="status" aria-live="polite">{diagnosticMessage}</small> : null}
        <section className="about-control" aria-label="OPE bilgileri">
          <button
            className={`about-toggle${updateAvailable ? " has-update" : ""}`}
            type="button"
            aria-label={aboutControlAriaLabel}
            aria-expanded={updateAvailable ? undefined : aboutOpen}
            aria-controls="blogbot-about-card"
            onClick={updateAvailable ? () => void installPendingUpdate() : () => setAboutOpen((open) => !open)}
          >
            <span aria-hidden="true">i</span>
            {aboutControlLabel}
          </button>
          {aboutOpen ? (
            <div className="about-card" id="blogbot-about-card">
              <div className="about-update-actions">
                <button type="button" onClick={() => void checkForUpdate()} disabled={updateBusy}>
                  {updateBusy ? "Denetleniyor…" : "Güncellemeleri denetle"}
                </button>
                {pendingUpdate ? (
                  <button type="button" onClick={() => void installPendingUpdate()} disabled={updateBusy}>
                    {pendingUpdate.version} indir ve kur
                  </button>
                ) : null}
              </div>
              {updatePhase !== "idle" ? (
                <div className={`update-progress update-progress-${updatePhase}`} role="status" aria-live="polite" aria-busy={updateBusy}>
                  <strong>Güncelleme adımları</strong>
                  <div className="update-progress-steps">
                    <span className={updatePhase === "checking" ? "is-current" : updatePhase === "error" ? "is-error" : "is-done"}>1 Kontrol</span>
                    <span className={updatePhase === "installing" ? "is-current" : updatePhase === "handoff" ? "is-done" : "is-waiting"}>2 İndirme + SHA-256</span>
                    <span className={updatePhase === "handoff" ? "is-current" : "is-waiting"}>3 Kurulum sihirbazı</span>
                  </div>
                </div>
              ) : null}              {updateMessage ? <small role="status" aria-live="polite">{updateMessage}</small> : null}
              <strong>OPE · OpenPostEditör</strong>
              <span>Sürüm {desktopPackage.version} · İmzasız HTTPS + SHA-256 · @ucsahinn</span>
              <a
                className="about-project-link"
                href="https://github.com/ucsahinn/blogbot"
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void openProjectPage();
                }}
              >
                GitHub’da projeyi görüntüle
              </a>
            </div>
          ) : null}
        </section>

        <div className="connection-card">
          <div className="connection-heading">
            <span
              className={`status-dot status-${snapshot.runtime.toLowerCase()}`}
              aria-hidden="true"
            />
            <strong>{runtimeLabel}</strong>
          </div>
          <span>
            {snapshot.connection.engineRunning
              ? "Yerel sistem çalışıyor"
              : "Yerel sistem çalışmıyor"}
          </span>
          <small>
            {snapshot.runtime === "OFFLINE_READ_ONLY"
              ? "Salt okunur görünüm · bağlantı gelince yeniden deneyin"
              : snapshot.connection.latencyMs
              ? `${snapshot.connection.latencyMs} ms · ${snapshot.connection.storageLabel}`
              : "Önkoşul testi bekleniyor"}
          </small>
        </div>

      </aside>

      <main className="workspace" id="main-workspace" tabIndex={-1}>{children}</main>
      {syncError ? (
        <div className="sync-error-banner" role="status" aria-live="polite">
          <strong>Yerel görünüm güncellenemedi.</strong>
          <span>{syncError}</span>
        </div>
      ) : null}
    </div>
  );
}
