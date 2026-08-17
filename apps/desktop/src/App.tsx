import { useEffect, useState } from "react";

import bobyAvatar from "./assets/boby-avatar-v3.webp";
import { AppShell, type PageId } from "./components/AppShell.tsx";
import { BobyAssistant } from "./components/BobyAssistant.tsx";
import { canMutateLocally, hasRuntimeCapability } from "./app-model.ts";
import { createCoalescingBridge, userFacingBridgeError, type BlogbotBridge } from "./bridge.ts";
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
    deploy: { workflowName: "", requiredChecks: [] },
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

const BOOTSTRAP_TIMEOUT_MS = 20_000;

async function withBootstrapTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("BOOTSTRAP_TIMEOUT")), BOOTSTRAP_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const [bobyOpen, setBobyOpen] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let reconciliationTimer: number | undefined;
    void withBootstrapTimeout(bridgeFactory())
      .then(async (runtimeBridge) => {
        // Bootstrap performs the Doctor handshake that changes the native
        // runtime from fail-closed to online. Reading the desk in parallel can
        // therefore capture the temporary offline projection and leave an
        // otherwise ready desk empty on first launch.
        const coalescingBridge = createCoalescingBridge(runtimeBridge);
        const initialSnapshot = await withBootstrapTimeout(coalescingBridge.getBootstrapSnapshot());
        const initialWorkspace = await withBootstrapTimeout(coalescingBridge.getEditorialWorkspace());
        if (alive) {
          setBridge(coalescingBridge);
          setSnapshot(initialSnapshot);
          setWorkspace(initialWorkspace);
          // Connector state is useful only on setup/publishing surfaces. It
          // must not keep the full local workspace behind a slow or broken
          // external-configuration read at startup.
          setConnectorState(fallbackConnectorState);
        }
        if (!alive) return;
        if (initialSnapshot.runtime === "ONLINE") {
          void coalescingBridge.getConnectorState().then((initialConnectorState) => {
            if (alive) {
              setConnectorState(initialConnectorState);
              setSyncError("");
            }
          }).catch((reason) => {
            if (alive) {
              setSyncError(
                userFacingBridgeError(
                  reason,
                  "Bağlantı ayarları henüz okunamadı. Kurulum Merkezi'nden yeniden deneyin."
                )
              );
            }
          });
        }
        // The sidecar can recover a durable queue claim immediately after the
        // first Doctor response. Keep the first truthful workspace visible,
        // then reconcile it in the background instead of holding the editor
        // on an artificial loading screen.
        reconciliationTimer = window.setTimeout(() => {
          if (!alive) return;
          void Promise.all([
            coalescingBridge.getBootstrapSnapshot(),
            coalescingBridge.getEditorialWorkspace()
          ]).then(([settledSnapshot, settledWorkspace]) => {
            if (!alive) return;
            setSnapshot(settledSnapshot);
            setWorkspace(settledWorkspace);
            setSyncError("");
          }).catch((reason) => {
            if (!alive) return;
            setSyncError(
              userFacingBridgeError(
                reason,
                "Çalışma alanı arka planda yenilenemedi. Operasyonlar ekranından yerel durumu kontrol edin."
              )
            );
          });
        }, 750);
      })
      .catch((reason) => {
        if (alive) {
          setError(
            userFacingBridgeError(reason, "OPE çalışma alanı açılamadı.")
          );
        }
      });
    return () => {
      alive = false;
      if (reconciliationTimer !== undefined) {
        window.clearTimeout(reconciliationTimer);
      }
    };
  }, [bridgeFactory, bootstrapAttempt]);

  useEffect(() => {
    const handleHashChange = () => setActivePage(pageFromHash());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (!bridge || typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const registerSyncListener = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (disposed) return;
      const cleanup = await listen("blogbot-sync-requested", () => {
          if (disposed) return;
          setSyncError("");
          void (async () => {
            const nextSnapshot = await bridge.getBootstrapSnapshot();
            const nextWorkspace = await bridge.getEditorialWorkspace();
            const nextConnectorState = nextSnapshot.runtime === "ONLINE"
              ? await bridge.getConnectorState()
              : fallbackConnectorState;
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
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    };
    void registerSyncListener().catch((reason) => {
      if (!disposed) {
        setSyncError(
          userFacingBridgeError(reason, "Yerel güncelleme bildirimi dinlenemedi.")
        );
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [bridge]);

  if (error) {
    return (
      <main className="fatal-state">
        <div role="alert" aria-live="assertive">
          <img className="boot-avatar" src={bobyAvatar} alt="" width="64" height="64" />
          <p className="section-kicker">GÜVENLİ BAŞLATMA DURDU</p>
          <h1>Çalışma alanı açılamadı.</h1>
          <p>{error}</p>
                    <button type="button" className="button button-primary" onClick={() => { setError(""); setBridge(null); setSnapshot(null); setWorkspace(null); setConnectorState(null); setBootstrapAttempt((attempt) => attempt + 1); }}>Yeniden dene</button>
          <small>
            OPE'nin yerel çalışma bileşeni başlatılamadı. Uygulamayı yeniden başlatın veya Kurulum
            Merkezi'ndeki "Önkoşul testi"ni çalıştırın.
          </small>
        </div>
      </main>
    );
  }

  if (!bridge || !snapshot || !workspace || !connectorState) {
    return (
      <main className="boot-state" aria-busy="true">
        <img className="boot-avatar boot-mark" src={bobyAvatar} alt="" width="64" height="64" />
        <h1>OPE güvenli çalışma alanı hazırlanıyor</h1>
        <p role="status" aria-live="polite" aria-busy="true">Yerel köprü ve şifreli önbellek doğrulanıyor…</p>
      </main>
    );
  }

  const refreshWorkspace = async () => {
    try {
      const nextSnapshot = await bridge.getBootstrapSnapshot();
      const nextWorkspace = await bridge.getEditorialWorkspace();
      const nextConnectorState = nextSnapshot.runtime === "ONLINE"
        ? await bridge.getConnectorState()
        : fallbackConnectorState;
      setSnapshot(nextSnapshot);
      setWorkspace(nextWorkspace);
      setConnectorState(nextConnectorState);
      setSyncError("");
    } catch (reason) {
      setSyncError(userFacingBridgeError(reason, "Çalışma alanı yenilenemedi. Operasyonlar ekranından yerel durumu kontrol edin."));
    }
  };

  // Source/candidate mutations need to distinguish a durable local success
  // from a failed follow-up projection refresh so their own notice can explain
  // the degraded state. Keep the general refresh action fail-soft, but let
  // mutation callers observe the failure and preserve the accepted result.
  const refreshWorkspaceForMutation = async () => {
    const nextSnapshot = await bridge.getBootstrapSnapshot();
    const nextWorkspace = await bridge.getEditorialWorkspace();
    const nextConnectorState = nextSnapshot.runtime === "ONLINE"
      ? await bridge.getConnectorState()
      : fallbackConnectorState;
    setSnapshot(nextSnapshot);
    setWorkspace(nextWorkspace);
    setConnectorState(nextConnectorState);
    setSyncError("");
  };  const readOnly =
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
    <>
    <AppShell
        activePage={activePage}
        snapshot={snapshot}
        bridge={bridge}
        onNavigate={navigate}
        onOpenSetup={() => navigate("setup")}
        onOpenSettings={() => navigate("settings")}
        onOpenBoby={() => setBobyOpen(true)}
        onExportDiagnostics={() => bridge.exportDiagnostics()}
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
            onSourceCatalogChange={refreshWorkspaceForMutation}
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
            onOpenBoby={() => setBobyOpen(true)}
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
            onOpenSetup={() => navigate("setup-guide")}
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
      <BobyAssistant activePage={activePage} snapshot={snapshot} workspace={workspace} bridge={bridge} open={bobyOpen} onClose={() => setBobyOpen(false)} onNavigate={navigate} />
    </>
  );
}
