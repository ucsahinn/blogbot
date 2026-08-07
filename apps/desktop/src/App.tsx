import { useEffect, useState } from "react";

import { AppShell, type PageId } from "./components/AppShell.tsx";
import { canMutateLocally, hasRuntimeCapability } from "./app-model.ts";
import { userFacingBridgeError, type BlogbotBridge } from "./bridge.ts";
import { createRuntimeBridge } from "./runtime-bridge.ts";
import { Dashboard } from "./screens/Dashboard.tsx";
import { ContentFlow } from "./screens/ContentFlow.tsx";
import { EditorialDesk } from "./screens/EditorialDesk.tsx";
import { OperationsHub } from "./screens/OperationsHub.tsx";
import { PublishingCenter } from "./screens/PublishingCenter.tsx";
import { SettingsCenter } from "./screens/SettingsCenter.tsx";
import { SetupCenter } from "./screens/SetupCenter.tsx";
import type { BootstrapSnapshot, ConnectorStateSnapshot, EditorialWorkspaceSnapshot } from "./types.ts";

const pageIds: PageId[] = [
  "dashboard",
  "content",
  "content-candidates",
  "instant",
  "editorial",
  "editorial-review",
  "publishing",
  "operations",
  "settings",
  "setup",
  "setup-guide"
];

const fallbackConnectorState: ConnectorStateSnapshot = {
  sourceState: "ABSENT",
  mode: "LOCAL_ONLY",
  configured: false,
  config: {
    codex: { accountLabel: "" },
    github: { owner: "", repository: "" },
    site: { repositoryPath: "", publicSiteUrl: "", mode: "LOCAL_ONLY" },
    deploy: { workflowName: "" },
    backup: { folder: "" }
  },
  site: { repositoryPath: "", publicSiteUrl: "", adapterId: null, adapterVersion: null },
  checks: {},
  localReadiness: "NOT_CONFIGURED",
  externalReadiness: "NOT_CONFIGURED"
};

function pageFromHash(): PageId {
  const candidate = window.location.hash.replace(/^#/u, "") as PageId;
  return pageIds.includes(candidate) ? candidate : "dashboard";
}

interface AppProps {
  bridgeFactory?: () => Promise<BlogbotBridge>;
}

export function App({ bridgeFactory = createRuntimeBridge }: AppProps) {
  const [bridge, setBridge] = useState<BlogbotBridge | null>(null);
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<EditorialWorkspaceSnapshot | null>(null);
  const [connectorState, setConnectorState] = useState<ConnectorStateSnapshot | null>(null);
  const [activePage, setActivePage] = useState<PageId>(pageFromHash);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [editorialNotice, setEditorialNotice] = useState("");
  const [pendingEditorialDraft, setPendingEditorialDraft] = useState<{ id: string; title?: string } | undefined>();

  useEffect(() => {
    let alive = true;
    void bridgeFactory()
      .then(async (runtimeBridge) => {
        // Bootstrap performs the Doctor handshake that changes the native
        // runtime from fail-closed to online. Reading the desk in parallel can
        // therefore capture the temporary offline projection and leave an
        // otherwise ready desk empty on first launch.
        const initialSnapshot = await runtimeBridge.getBootstrapSnapshot();
        const initialWorkspace = await runtimeBridge.getEditorialWorkspace();
        const initialConnectorState = await runtimeBridge.getConnectorState().catch((reason) => {
          if (alive) {
            setSyncError(
              userFacingBridgeError(
                reason,
                "Bağlantı ayarları henüz okunamadı. Kurulum Merkezi'nden yeniden deneyin."
              )
            );
          }
          return fallbackConnectorState;
        });
        if (alive) {
          setBridge(runtimeBridge);
          setSnapshot(initialSnapshot);
          setWorkspace(initialWorkspace);
          setConnectorState(initialConnectorState);
        }
        // The sidecar can recover a durable queue claim immediately after the
        // first Doctor response. Keep the first truthful workspace visible,
        // then reconcile it in the background instead of holding the editor
        // on an artificial loading screen.
        setTimeout(() => {
          if (!alive) return;
          void Promise.all([
            runtimeBridge.getBootstrapSnapshot(),
            runtimeBridge.getEditorialWorkspace()
          ]).then(([settledSnapshot, settledWorkspace]) => {
            if (!alive) return;
            setSnapshot(settledSnapshot);
            setWorkspace(settledWorkspace);
          }).catch(() => undefined);
        }, 750);
      })
      .catch((reason) => {
        if (alive) {
          setError(
            userFacingBridgeError(reason, "Blogbot çalışma alanı açılamadı.")
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [bridgeFactory]);

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
          setSyncError("");
          void (async () => {
            const nextSnapshot = await bridge.getBootstrapSnapshot();
            const [nextWorkspace, nextConnectorState] = await Promise.all([
              bridge.getEditorialWorkspace(),
              bridge.getConnectorState()
            ]);
            setSnapshot(nextSnapshot);
            setWorkspace(nextWorkspace);
            setConnectorState(nextConnectorState);
          })().catch((reason) => {
            setSyncError(
              userFacingBridgeError(
                reason,
                "Yerel çalışma alanı yenilenemedi. Operasyonlar ekranından yeniden deneyin."
              )
            );
          });
        });
    }).catch((reason) => {
      setSyncError(
        userFacingBridgeError(reason, "Yerel güncelleme bildirimi dinlenemedi.")
      );
    });
    return () => unlisten?.();
  }, [bridge]);

  if (error) {
    return (
      <main className="fatal-state">
        <div role="alert" aria-live="assertive">
          <span className="brand-mark" aria-hidden="true">B</span>
          <p className="section-kicker">GÜVENLİ BAŞLATMA DURDU</p>
          <h1>Çalışma alanı açılamadı.</h1>
          <p>{error}</p>
          <small>
            Blogbot'un yerel çalışma bileşeni başlatılamadı. Uygulamayı yeniden başlatın veya Kurulum
            Merkezi'ndeki "Önkoşul testi"ni çalıştırın.
          </small>
        </div>
      </main>
    );
  }

  if (!bridge || !snapshot || !workspace || !connectorState) {
    return (
      <main className="boot-state" aria-busy="true">
        <span className="brand-mark boot-mark" aria-hidden="true">B</span>
        <h1>Blogbot güvenli çalışma alanı hazırlanıyor</h1>
        <p role="status" aria-live="polite" aria-busy="true">Yerel köprü ve şifreli önbellek doğrulanıyor…</p>
      </main>
    );
  }

  const refreshWorkspace = async () => {
    const nextSnapshot = await bridge.getBootstrapSnapshot();
    const [nextWorkspace, nextConnectorState] = await Promise.all([
      bridge.getEditorialWorkspace(),
      bridge.getConnectorState()
    ]);
    setSnapshot(nextSnapshot);
    setWorkspace(nextWorkspace);
    setConnectorState(nextConnectorState);
  };

  const readOnly =
    !canMutateLocally(snapshot.connection);
  const navigate = (page: PageId) => {
    if (page !== "editorial") {
      setEditorialNotice("");
      setPendingEditorialDraft(undefined);
    }
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
        syncError={syncError}
      >
        {activePage === "dashboard" ? (
          <Dashboard
            snapshot={snapshot}
            workspace={workspace}
            onNavigate={navigate}
            onRefresh={refreshWorkspace}
          />
        ) : null}
        {activePage === "content" || activePage === "content-candidates" || activePage === "instant" ? (
          <ContentFlow
            key={activePage}
            bridge={bridge}
            readOnly={readOnly}
            canTestSources={hasRuntimeCapability(snapshot.capabilities, "SOURCE.TEST")}
            canSaveSources={hasRuntimeCapability(snapshot.capabilities, "SOURCE.SAVE")}
            canScanSources={hasRuntimeCapability(snapshot.capabilities, "SOURCE.SCAN")}
            workspace={workspace}
            initialTab={activePage === "instant" ? "instant" : activePage === "content-candidates" ? "candidates" : "sources"}
            onWorkspaceChange={setWorkspace}
            onSourceCatalogChange={refreshWorkspace}
            onOpenEditorial={(notice, pendingDraftId, pendingDraftTitle) => {
              setEditorialNotice(notice ?? "");
              setPendingEditorialDraft(
                pendingDraftId
                  ? pendingDraftTitle
                    ? { id: pendingDraftId, title: pendingDraftTitle }
                    : { id: pendingDraftId }
                  : undefined
              );
              navigate("editorial");
            }}
            onOpenReview={() => navigate("editorial-review")}
            onOpenOperations={() => navigate("operations")}
          />
        ) : null}
        {activePage === "editorial" || activePage === "editorial-review" ? (
          <EditorialDesk
            key={activePage}
            bridge={bridge}
            snapshot={snapshot}
            workspace={workspace}
            readOnly={readOnly}
            connectorState={connectorState}
            onWorkspaceChange={setWorkspace}
            onRefreshWorkspace={refreshWorkspace}
            onOpenOperations={() => navigate("operations")}
            initialTab={activePage === "editorial-review" ? "review" : "drafts"}
            initialMessage={editorialNotice}
            {...(pendingEditorialDraft ? {
              pendingDraftId: pendingEditorialDraft.id,
              pendingDraftTitle: pendingEditorialDraft.title
            } : {})}
          />
        ) : null}
        {activePage === "publishing" ? (
          <PublishingCenter
            bridge={bridge}
            workspace={workspace}
            connectorState={connectorState}
            readOnly={readOnly}
            onWorkspaceChange={setWorkspace}
            onConnectorStateChange={setConnectorState}
          />
        ) : null}
        {activePage === "operations" ? (
          <OperationsHub
            bridge={bridge}
            snapshot={snapshot}
            workspace={workspace}
            readOnly={readOnly}
            connectorState={connectorState}
            onSnapshotChange={setSnapshot}
            onWorkspaceChange={setWorkspace}
            onConnectorStateChange={setConnectorState}
            onOpenSetup={() => navigate("setup")}
            onOpenEditorial={() => navigate("editorial")}
          />
        ) : null}
        {activePage === "settings" ? (
          <SettingsCenter bridge={bridge} workspace={workspace} readOnly={readOnly} onWorkspaceChange={setWorkspace} />
        ) : null}
        {activePage === "setup" || activePage === "setup-guide" ? (
          <SetupCenter
            bridge={bridge}
            connectorState={connectorState}
            readOnly={readOnly}
            startInGuide={activePage === "setup-guide"}
            onConnectorStateChange={setConnectorState}
            onCompleted={refreshWorkspace}
          />
        ) : null}
      </AppShell>
  );
}
