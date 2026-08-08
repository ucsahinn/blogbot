import { useEffect, useState, type ReactNode } from "react";

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

interface AppShellProps {
  activePage: PageId;
  snapshot: BootstrapSnapshot;
  children: ReactNode;
  onNavigate: (page: PageId) => void;
  onOpenSetup: () => void;
  onOpenSettings: () => void;
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
  onExportDiagnostics,
  bridge,
  syncError = ""
}: AppShellProps) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<UnsignedDesktopUpdate | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticMessage, setDiagnosticMessage] = useState("");

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

  const checkForUpdate = async () => {
    if (!window.__TAURI_INTERNALS__) {
      setUpdateMessage("Güncelleme denetimi yalnız paketlenmiş Blogbot uygulamasında yapılır.");
      return;
    }
    setUpdateBusy(true);
    setPendingUpdate(null);
    setUpdateMessage("Güncellemeler güvenli bağlantıyla denetleniyor…");
    try {
      const update = await bridge.checkUnsignedUpdate();
      if (!update) {
        setUpdateMessage("Bu bilgisayardaki Blogbot güncel.");
        return;
      }
      setPendingUpdate(update);
      setUpdateMessage(`Blogbot ${update.version} hazır. İndirmeyi ve kurulumu siz başlatın.`);
    } catch (reason) {
      setUpdateMessage(userFacingUpdateError(reason));
    } finally {
      setUpdateBusy(false);
    }
  };

  const installPendingUpdate = async () => {
    if (!pendingUpdate) return;
    setUpdateBusy(true);
    try {
      setUpdateMessage("Güncelleme indiriliyor ve SHA-256 ile doğrulanıyor…");
      await bridge.installUnsignedUpdate(pendingUpdate);
      setUpdateMessage("Güncelleme kurulumu başlatılıyor…");
    } catch {
      setUpdateMessage("Güncelleme indirilemedi veya SHA-256 doğrulaması başarısız oldu. Kurulum başlatılmadı.");
    } finally {
      setUpdateBusy(false);
    }
  };

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

  const runtimeLabel =
    snapshot.runtime === "ONLINE"
      ? "Yerel sistem hazır"
      : snapshot.runtime === "DEGRADED"
        ? "Bazı özellikler bekliyor"
        : "Yerel kurtarma modu";
  const isNavigationActive = (page: PageId) =>
    activePage === page ||
    (page === "content" && activePage === "instant") ||
    (page === "content" && activePage === "content-candidates") ||
    (page === "editorial" && activePage === "editorial-review");

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-workspace">Ana içeriğe geç</a>
      <aside className="sidebar" aria-label="Uygulama araçları">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <span>
            <strong>Blogbot</strong>
            <small>Yerel yayın sistemi</small>
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
                {item.icon}
              </span>
              <span>{item.label}</span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              {item.id === "editorial" && snapshot.pipeline[2]?.count ? (
                <span className="nav-count">{snapshot.pipeline[2].count}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <nav className="mobile-utility-nav" aria-label="İkincil menü">
          <button type="button" aria-label="Ayarlar" onClick={onOpenSettings}>
            <span aria-hidden="true">⚙</span>
          </button>
          <button type="button" aria-label="Kurulum ve önkoşullar" onClick={onOpenSetup}>
            <span aria-hidden="true">◇</span>
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
        <section className="about-control" aria-label="Blogbot bilgileri">
          <button
            className="about-toggle"
            type="button"
            aria-label="Blogbot hakkında"
            aria-expanded={aboutOpen}
            aria-controls="blogbot-about-card"
            onClick={() => setAboutOpen((open) => !open)}
          >
            <span aria-hidden="true">i</span>
            Hakkında
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
              {updateMessage ? <small role="status" aria-live="polite">{updateMessage}</small> : null}
              <strong>Blogbot · yerel yayın uygulaması</strong>
              <span>Sürüm 0.1.7 · İmzasız HTTPS + SHA-256 · @ucsahinn</span>
              <a href="https://github.com/ucsahinn/blogbot" target="_blank" rel="noreferrer">
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

        <div className="operator-card">
          <span className="operator-avatar" aria-hidden="true">
            B
          </span>
          <span>
            <strong>Editör çalışma alanı</strong>
            <small>İnsan onayı zorunlu</small>
          </span>
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
