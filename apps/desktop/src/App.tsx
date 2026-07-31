import { useEffect, useState } from "react";

import { AppShell, type PageId } from "./components/AppShell.tsx";
import { hasRuntimeCapability } from "./app-model.ts";
import type { BlogbotBridge } from "./bridge.ts";
import { createRuntimeBridge } from "./runtime-bridge.ts";
import { Dashboard } from "./screens/Dashboard.tsx";
import { ContentFlow } from "./screens/ContentFlow.tsx";
import { EditorialDesk } from "./screens/EditorialDesk.tsx";
import { OperationsHub } from "./screens/OperationsHub.tsx";
import { PublishingCenter } from "./screens/PublishingCenter.tsx";
import { SettingsCenter } from "./screens/SettingsCenter.tsx";
import { SetupCenter } from "./screens/SetupCenter.tsx";
import type { BootstrapSnapshot, EditorialWorkspaceSnapshot } from "./types.ts";

const pageIds: PageId[] = [
  "dashboard",
  "content",
  "instant",
  "editorial",
  "editorial-review",
  "publishing",
  "operations",
  "settings",
  "setup",
  "setup-guide"
];

function pageFromHash(): PageId {
  const candidate = window.location.hash.replace(/^#/u, "") as PageId;
  return pageIds.includes(candidate) ? candidate : "dashboard";
}

export function App() {
  const [bridge, setBridge] = useState<BlogbotBridge | null>(null);
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<EditorialWorkspaceSnapshot | null>(null);
  const [activePage, setActivePage] = useState<PageId>(pageFromHash);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void createRuntimeBridge()
      .then(async (runtimeBridge) => {
        const [initialSnapshot, initialWorkspace] = await Promise.all([
          runtimeBridge.getBootstrapSnapshot(),
          runtimeBridge.getEditorialWorkspace()
        ]);
        if (alive) {
          setBridge(runtimeBridge);
          setSnapshot(initialSnapshot);
          setWorkspace(initialWorkspace);
        }
      })
      .catch((reason) => {
        if (alive) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Blogbot çalışma alanı açılamadı."
          );
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const handleHashChange = () => setActivePage(pageFromHash());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (!bridge || typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlisten = await listen("blogbot-sync-requested", () => {
        void Promise.all([
          bridge.getBootstrapSnapshot(),
          bridge.getEditorialWorkspace()
        ]).then(([nextSnapshot, nextWorkspace]) => {
          setSnapshot(nextSnapshot);
          setWorkspace(nextWorkspace);
        });
      });
    });
    return () => unlisten?.();
  }, [bridge]);

  if (error) {
    return (
      <main className="fatal-state">
        <span className="brand-mark" aria-hidden="true">B</span>
        <p className="section-kicker">GÜVENLİ BAŞLATMA DURDU</p>
        <h1>Çalışma alanı açılamadı.</h1>
        <p>{error}</p>
        <small>
          Blogbot'un yerel çalışma bileşeni başlatılamadı. Uygulamayı yeniden başlatın veya Kurulum
          Merkezi'ndeki "Önkoşul testi"ni çalıştırın.
        </small>
      </main>
    );
  }

  if (!bridge || !snapshot || !workspace) {
    return (
      <main className="boot-state">
        <span className="brand-mark boot-mark" aria-hidden="true">B</span>
        <strong>Blogbot güvenli çalışma alanı hazırlanıyor</strong>
        <span>Yerel köprü ve şifreli önbellek doğrulanıyor…</span>
      </main>
    );
  }

  const refreshSnapshot = async () => {
    const refreshed = await bridge.getBootstrapSnapshot();
    setSnapshot(refreshed);
  };

  const readOnly =
    !snapshot.connection.engineRunning ||
    !snapshot.connection.bridgeReady ||
    !snapshot.capabilities.includes("MUTATIONS.CORE");
  const navigate = (page: PageId) => {
    window.location.hash = page;
    setActivePage(page);
  };

  return (
    <AppShell
        activePage={activePage}
        snapshot={snapshot}
        onNavigate={navigate}
        onOpenSetup={() => navigate("setup")}
        onOpenSettings={() => navigate("settings")}
      >
        {activePage === "dashboard" ? (
          <Dashboard snapshot={snapshot} workspace={workspace} onNavigate={navigate} />
        ) : null}
        {activePage === "content" || activePage === "instant" ? (
          <ContentFlow
            key={activePage}
            bridge={bridge}
            readOnly={readOnly}
            canTestSources={hasRuntimeCapability(snapshot.capabilities, "SOURCE.TEST")}
            canSaveSources={hasRuntimeCapability(snapshot.capabilities, "SOURCE.SAVE")}
            canScanSources={hasRuntimeCapability(snapshot.capabilities, "SOURCE.SCAN")}
            workspace={workspace}
            initialTab={activePage === "instant" ? "instant" : "sources"}
            onWorkspaceChange={setWorkspace}
            onOpenReview={() => navigate("editorial-review")}
          />
        ) : null}
        {activePage === "editorial" || activePage === "editorial-review" ? (
          <EditorialDesk
            key={activePage}
            bridge={bridge}
            snapshot={snapshot}
            workspace={workspace}
            readOnly={readOnly}
            initialTab={activePage === "editorial-review" ? "review" : "drafts"}
          />
        ) : null}
        {activePage === "publishing" ? (
          <PublishingCenter bridge={bridge} workspace={workspace} readOnly={readOnly} onWorkspaceChange={setWorkspace} />
        ) : null}
        {activePage === "operations" ? (
          <OperationsHub
            bridge={bridge}
            snapshot={snapshot}
            workspace={workspace}
            readOnly={readOnly}
            onSnapshotChange={setSnapshot}
            onWorkspaceChange={setWorkspace}
          />
        ) : null}
        {activePage === "settings" ? (
          <SettingsCenter bridge={bridge} workspace={workspace} readOnly={readOnly} onWorkspaceChange={setWorkspace} />
        ) : null}
        {activePage === "setup" || activePage === "setup-guide" ? (
          <SetupCenter
            bridge={bridge}
            onCompleted={refreshSnapshot}
            initialGuided={activePage === "setup-guide"}
          />
        ) : null}
      </AppShell>
  );
}
