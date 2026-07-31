import { useEffect, type ReactNode } from "react";

import type { BootstrapSnapshot } from "../types.ts";

export type PageId =
  | "dashboard"
  | "content"
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
}

export function AppShell({
  activePage,
  snapshot,
  children,
  onNavigate,
  onOpenSetup,
  onOpenSettings
}: AppShellProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
    (page === "editorial" && activePage === "editorial-review");

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-workspace">Ana içeriğe geç</a>
      <aside className="sidebar">
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
            {snapshot.connection.latencyMs
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
    </div>
  );
}
