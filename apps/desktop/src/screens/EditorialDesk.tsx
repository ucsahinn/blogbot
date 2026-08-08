import { useEffect, useState } from "react";

import { userFacingBridgeError, type BlogbotBridge } from "../bridge.ts";
import { handleTabListKeyDown } from "../components/tab-keyboard.ts";
import { draftStateLabel, sectionLabel } from "../app-model.ts";
import type { BootstrapSnapshot, ConnectorStateSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";
import { ReviewWorkspace } from "./ReviewWorkspace.tsx";

interface EditorialDeskProps {
  bridge: BlogbotBridge;
  snapshot: BootstrapSnapshot;
  workspace: EditorialWorkspaceSnapshot;
  readOnly: boolean;
  connectorState: ConnectorStateSnapshot;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
  onRefreshWorkspace: () => Promise<void>;
  onOpenOperations: () => void;
  initialTab?: "drafts" | "review";
  initialMessage?: string;
  pendingDraftId?: string;
  pendingDraftTitle?: string;
}

export function EditorialDesk({
  bridge,
  snapshot,
  workspace,
  readOnly,
  connectorState,
  onWorkspaceChange,
  onRefreshWorkspace,
  onOpenOperations,
  initialTab = "drafts",
  initialMessage = "",
  pendingDraftId,
  pendingDraftTitle
}: EditorialDeskProps) {
  const [tab, setTab] = useState<"drafts" | "review">(initialTab);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | undefined>();
  const [retryingDraftId, setRetryingDraftId] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState(initialMessage);
  const [queuedDraftId, setQueuedDraftId] = useState<string | undefined>();
  const hasPendingDraft = Boolean(pendingDraftId && !workspace.drafts.some((draft) => draft.id === pendingDraftId));
  const hasQueuedDraft = hasPendingDraft || workspace.drafts.some((draft) => !draft.reviewable);
  const draftIdToSync = pendingDraftId ?? queuedDraftId;
  const activeDraftSignature = workspace.drafts
    .filter((draft) => draft.state === "DRAFTING" || draft.state === "NEEDS_SOURCE")
    .map((draft) => `${draft.id}:${draft.state}:${draft.detail}:${draft.updatedAt}`)
    .join("|");

  useEffect(() => {
    if (!draftIdToSync) return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const nextWorkspace = await bridge.getEditorialWorkspace();
        if (cancelled) return;
        onWorkspaceChange(nextWorkspace);
        if (nextWorkspace.drafts.some((draft) => draft.id === draftIdToSync)) {
          setQueuedDraftId(undefined);
          setMessage("Yerel kuyruktaki taslak masa envanterine eklendi.");
          return;
        }
      } catch {
        // The initial accepted queue result remains visible. A later timeout
        // gives the user a truthful manual recovery path instead of erasing it.
      }
      if (attempts >= 10) {
        setMessage("Yerel kuyruk işi kabul edildi ancak taslak envanteri henüz güncellenmedi. Taslak envanterini yenileyin; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun.");
        return;
      }
      window.setTimeout(() => void poll(), 1_200);
    };
    void poll();
    return () => { cancelled = true; };
  }, [bridge, draftIdToSync, onWorkspaceChange]);

  useEffect(() => {
    if (!activeDraftSignature) return;
    let cancelled = false;
    const refreshActiveDrafts = async () => {
      try {
        const nextWorkspace = await bridge.getEditorialWorkspace();
        if (cancelled) return;
        const nextSignature = nextWorkspace.drafts
          .filter((draft) => draft.state === "DRAFTING" || draft.state === "NEEDS_SOURCE")
          .map((draft) => `${draft.id}:${draft.state}:${draft.detail}:${draft.updatedAt}`)
          .join("|");
        if (nextSignature !== activeDraftSignature) {
          onWorkspaceChange(nextWorkspace);
        }
      } catch {
        // Background refresh must not replace a visible, accepted job with a
        // false failure. Manual refresh and Operations remain available.
      }
    };
    // Workspace reads include the local candidate projection. Polling every
    // five seconds made a busy draft turn navigation into a stream of full
    // database reads. The engine now bounds and briefly caches that projection;
    // this calmer cadence keeps progress visible without competing with it.
    const timer = window.setInterval(() => void refreshActiveDrafts(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeDraftSignature, bridge, onWorkspaceChange]);

  const refreshDrafts = async () => {
    setRefreshing(true);
    setMessage("");
    try {
      onWorkspaceChange(await bridge.getEditorialWorkspace());
      setMessage("Taslak envanteri yerel veriden yenilendi.");
    } catch {
      setMessage("Taslak envanteri yenilenemedi. Yerel engine durumunu Operasyonlar ekranından inceleyin.");
    } finally {
      setRefreshing(false);
    }
  };

  const retryDraft = async (draftId: string) => {
    setRetryingDraftId(draftId);
    setMessage("");
    try {
      await bridge.retryJob(draftId);
      setMessage("Taslak yerel kuyruğa yeniden alındı. İlerlemeyi burada veya Operasyonlar ekranında takip edebilirsiniz.");
      await onRefreshWorkspace();
    } catch (reason) {
      setMessage(userFacingBridgeError(reason, "Taslak yeniden kuyruğa alınamadı."));
    } finally {
      setRetryingDraftId(undefined);
    }
  };

  return (
    <div className="page hub-page">
      <header className="page-header">
        <div>
          <p className="section-kicker">EDİTORYAL MASA</p>
          <h1>Taslak, iki dil ve kanıt paketi aynı masada.</h1>
          <p>
            Kaynak eksikleri görünür kalır. Onay yalnız metin, iddialar, medya,
            SEO, güvenlik, zaman ve adaptör sürümü birlikte doğrulandıysa açılır.
          </p>
        </div>
        <button className="button button-secondary" type="button" disabled={refreshing} onClick={() => void refreshDrafts()}>
          {refreshing ? "Yenileniyor…" : "Taslak envanterini yenile"}
        </button>
      </header>
      {message ? <div className="inline-notice" role="status" aria-live="polite">{message}</div> : null}
      <div className="workspace-tabs" role="tablist" aria-label="Editoryal masa bölümleri" onKeyDown={handleTabListKeyDown}>
        <button type="button" role="tab" id="editorial-tab-drafts" aria-controls="editorial-panel-drafts" aria-selected={tab === "drafts"} tabIndex={tab === "drafts" ? 0 : -1} className={tab === "drafts" ? "is-active" : ""} onClick={() => setTab("drafts")}>
          Taslaklar · {workspace.drafts.length}
        </button>
        <button type="button" role="tab" id="editorial-tab-review" aria-controls="editorial-panel-review" aria-selected={tab === "review"} tabIndex={tab === "review" ? 0 : -1} className={tab === "review" ? "is-active" : ""} onClick={() => setTab("review")}>
          TR / EN inceleme
        </button>
      </div>
      {tab === "drafts" ? (
        <section className="hub-panel" role="tabpanel" id="editorial-panel-drafts" aria-labelledby="editorial-tab-drafts">
          <div className="draft-list">
            {hasPendingDraft ? (
              <article className="draft-row pending-draft-card" aria-label="Araştırma kuyruğundaki taslak" aria-busy="true">
                <span className="progress-ring progress-indeterminate" aria-hidden="true">…</span>
                <span className="draft-copy">
                  <strong>{pendingDraftTitle ?? "Araştırma taslağı hazırlanıyor"}</strong>
                  <small>İngilizce yerelleştirme araştırma tamamlanınca hazırlanacak</small>
                  <span>Yerel kuyruk kaydı alındı · inceleme henüz kapalı</span>
                  <span>Taslak envanteri henüz güncellenmedi; yerel kuyruk işi kaydedildi.</span>
                  <span>İlerleme ölçümü henüz yok; işin durumunu Operasyonlar'dan takip edin.</span>
                </span>
                <span className="state-pill state-drafting">Araştırma kuyruğunda</span>
                <span aria-hidden="true">…</span>
              </article>
            ) : null}
            {workspace.drafts.map((draft) => {
              const canRetry = !draft.reviewable && draft.state === "DRAFTING";
              return <article className="draft-row-with-action" key={draft.id} aria-label={canRetry ? "Araştırma kuyruğundaki taslak" : undefined}>
              <button
                className="draft-row"
                type="button"
                aria-label={`${draft.titleTr} · ${draft.reviewable ? "İncelemeyi aç" : draft.state === "NEEDS_SOURCE" ? "Kaynak ekle" : "Operasyonlarda takip et"}`}
                aria-describedby={[`draft-detail-${draft.id}`, !draft.reviewable ? "queued-draft-guidance" : ""].filter(Boolean).join(" ")}
                onClick={() => {
                  setSelectedRevisionId(draft.id);
                  if (!draft.reviewable) {
                    setMessage("Bu taslak henüz incelemeye hazır değil. İlerlemeyi Operasyonlar ekranından takip edebilirsiniz.");
                    onOpenOperations();
                    return;
                  }
                  setTab("review");
                }}
              >
                {draft.completion === null ? (
                  <span className="progress-ring progress-indeterminate" aria-label="İlerleme yüzdesi henüz ölçülmedi">
                    …
                  </span>
                ) : (
                  <span className={`progress-ring progress-${Math.round(draft.completion / 10) * 10}`} aria-label={`Yüzde ${draft.completion} tamamlandı`}>
                    {draft.completion}
                  </span>
                )}
                <span className="draft-copy">
                  <strong>{draft.titleTr}</strong>
                  <small>{draft.titleEn}</small>
                  <span>{sectionLabel(draft.section)} · {draft.blockers ? `${draft.blockers} engel` : "engel yok"}</span>
                  <span id={`draft-detail-${draft.id}`}>{draft.detail}</span>
                </span>
                <span className={`state-pill state-${draft.state.toLowerCase()}`}>{draftStateLabel(draft.state)}</span>
                <span className="draft-next-action">{draft.reviewable ? "İncelemeyi aç" : draft.state === "NEEDS_SOURCE" ? "Kaynak ekle" : "Operasyonlarda takip et"}</span>
              </button>
              {canRetry ? (
                <button
                  className="draft-row-retry"
                  type="button"
                  disabled={retryingDraftId === draft.id}
                  onClick={() => void retryDraft(draft.id)}
                >
                  {retryingDraftId === draft.id ? "Kuyruğa alınıyor…" : "Tekrar dene"}
                </button>
              ) : null}
              </article>;
            })}
            {workspace.drafts.length === 0 ? (
              <div className="empty-state">
                <strong>Henüz taslak yok.</strong>
                <span>İçerik Akışı'ndan bir haber adayını araştırmaya alın veya Anlık Oluştur ile kanıta bağlı yeni bir iş başlatın.</span>
              </div>
            ) : null}
          </div>
          {hasQueuedDraft ? (
            <aside id="queued-draft-guidance" className="queued-draft-guidance" aria-label="İnceleme kilidi açıklaması">
              <strong>İnceleme neden kapalı?</strong>
              <p>Taslak üretimi sürüyor; hazır olduğunda inceleme açılır. İş ilerlemesini ve olası bekleme nedenini Operasyonlar ekranından takip edebilirsiniz.</p>
              <button className="button button-secondary" type="button" onClick={onOpenOperations}>Operasyonları aç</button>
            </aside>
          ) : null}
        </section>
      ) : (
        <div role="tabpanel" id="editorial-panel-review" aria-labelledby="editorial-tab-review"><ReviewWorkspace
          key={selectedRevisionId ?? "default-review"}
          bridge={bridge}
          snapshot={snapshot}
          readOnly={readOnly}
          connectorState={connectorState}
          onPublicationQueued={onRefreshWorkspace}
          onRevisionApproved={onRefreshWorkspace}
          onDraftQueued={async (queuedMessage, expectedDraftId) => {
            if (expectedDraftId) setQueuedDraftId(expectedDraftId);
            try {
              onWorkspaceChange(await bridge.getEditorialWorkspace());
            } catch {
              // The accepted job remains visible through the Desk-level poll.
            }
            setTab("drafts");
            setMessage(`${queuedMessage} Masa envanteri güncelleniyor.`);
          }}
          embedded
          {...(selectedRevisionId ? { initialRevisionId: selectedRevisionId } : {})}
        /></div>
      )}
    </div>
  );
}
