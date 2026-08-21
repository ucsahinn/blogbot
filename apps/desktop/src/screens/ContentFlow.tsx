import { useMemo, useState } from "react";

import { userFacingBridgeError, type BlogbotBridge } from "../bridge.ts";
import { handleTabListKeyDown } from "../components/tab-keyboard.ts";
import { contentCategoryLabel } from "../app-model.ts";
import type { CandidateView, EditorialWorkspaceSnapshot } from "../types.ts";
import { InstantCreate } from "./InstantCreate.tsx";
import { SourceCenter } from "./SourceCenter.tsx";

type ContentTab = "sources" | "candidates" | "instant";

interface ContentFlowProps {
  bridge: BlogbotBridge;
  readOnly: boolean;
  canTestSources: boolean;
  canSaveSources: boolean;
  canScanSources: boolean;
  workspace: EditorialWorkspaceSnapshot;
  initialTab?: ContentTab;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
  onSourceCatalogChange: () => Promise<void>;
  onOpenEditorial: (notice?: string, pendingDraftId?: string, pendingDraftTitle?: string) => void;
  onOpenReview: () => void;
  onOpenOperations: () => void;
}

const candidateStateLabels: Record<CandidateView["state"], string> = {
  NEW: "Yeni aday",
  NEEDS_SOURCE: "Kaynak gerekli",
  ROUTING_REQUIRED: "Yönlendirme gerekli",
  DISMISSED: "Kapatıldı",
  PROMOTED: "Taslağa alındı",
  RESEARCH_QUEUED: "Araştırma kuyruğunda",
  RESEARCH_FAILED: "Araştırma başarısız"
};

function candidateScoreLabel(score: number | undefined): string {
  if (typeof score !== "number" || !Number.isFinite(score)) return "Ölçülmedi";
  return `${Math.max(0, Math.min(100, Math.round(score)))}%`;
}

function candidatePublicationLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Kaynak tarihi alınamadı";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function ContentFlow({
  bridge,
  readOnly,
  canTestSources,
  canSaveSources,
  canScanSources,
  workspace,
  initialTab = "sources",
  onWorkspaceChange,
  onSourceCatalogChange,
  onOpenEditorial,
  onOpenReview,
  onOpenOperations
}: ContentFlowProps) {
  const [tab, setTab] = useState<ContentTab>(initialTab);
  const [previousInitialTab, setPreviousInitialTab] = useState(initialTab);
  if (initialTab !== previousInitialTab) {
    setPreviousInitialTab(initialTab);
    setTab(initialTab);
  }
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const candidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("tr-TR");
    return workspace.candidates.filter(
      (item) =>
        item.state !== "DISMISSED" &&
        (!normalized ||
          `${item.title} ${item.summary} ${item.primarySource}`
            .toLocaleLowerCase("tr-TR")
            .includes(normalized))
    );
  }, [query, workspace.candidates]);

  const selectedCandidates = useMemo(
    () => workspace.candidates.filter((candidate) => candidate.state !== "DISMISSED" && selectedIds.has(candidate.id)),
    [selectedIds, workspace.candidates]
  );

  const toggleCandidateSelection = (candidateId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(candidateId);
      else next.delete(candidateId);
      return next;
    });
  };

  const selectVisibleCandidates = () => {
    setSelectedIds((current) => new Set([...current, ...candidates.map((candidate) => candidate.id)]));
  };

  const clearCandidateSelection = () => setSelectedIds(new Set());

  const candidateActionUnavailableReason = (
    candidate: CandidateView,
    action: "promote" | "dismiss"
  ): string => {
    if (readOnly) {
      return action === "promote"
        ? "Yerel çalışma alanı yeniden bağlanana kadar araştırma başlatılamaz."
        : "Yerel çalışma alanı yeniden bağlanana kadar aday kapatılamaz.";
    }
    if (busyId === candidate.id) {
      return "Bu aday için önceki işlem tamamlanana kadar bekleyin.";
    }
    if (action === "promote" && candidate.state === "PROMOTED") {
      return "Bu aday zaten taslak akışına alındı.";
    }
    if (action === "promote" && candidate.state === "RESEARCH_QUEUED") {
      return "Bu adayın araştırması zaten yerel kuyrukta takip ediliyor.";
    }
    if (action === "promote" && candidate.state === "RESEARCH_FAILED") {
      return "Bu adayın araştırması tamamlanamadı. Nedeni ve güvenli tekrar seçeneğini Operasyonlar’dan açın.";
    }
    return "";
  };

  const mutate = async (
    candidateId: string,
    action: "promote" | "dismiss"
  ) => {
    setBusyId(candidateId);
    setMessage("");
    try {
      if (action === "promote") {
        const candidateTitle = workspace.candidates.find((item) => item.id === candidateId)?.title ?? "Seçilen aday";
        const promotion = await bridge.promoteCandidate(candidateId);
        const expectedDraftId = typeof promotion.job?.id === "string" && promotion.job.id.trim()
          ? promotion.job.id
          : `draft-candidate-${candidateId}`;
        let nextWorkspace: EditorialWorkspaceSnapshot;
        try {
          nextWorkspace = await bridge.getEditorialWorkspace();
          // The engine persists the durable job before this action resolves.
          // A short bounded read retry avoids navigating to a stale Editorial
          // Desk snapshot while still refusing to show a false success state.
          for (let attempt = 0; attempt < 4 && !nextWorkspace.drafts.some((draft) => draft.id === expectedDraftId); attempt += 1) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
            nextWorkspace = await bridge.getEditorialWorkspace();
          }
        } catch {
          // The command response is the durable acceptance boundary. Never
          // turn an accepted local queue job into a false failure merely
          // because any immediate inventory read is unavailable.
          onOpenEditorial(
            `${candidateTitle} için yerel kuyruk işi kabul edildi; taslak envanteri henüz okunamadı. Editoryal Masa’dan yenileyin; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun.`,
            expectedDraftId,
            candidateTitle
          );
          return;
        }
        if (!nextWorkspace.drafts.some((draft) => draft.id === expectedDraftId)) {
          onWorkspaceChange(nextWorkspace);
          onOpenEditorial(`${candidateTitle} için yerel kuyruk işi kabul edildi; masa envanteri güncelleniyor. Taslak görünür olduğunda burada takip edebilirsiniz.`, expectedDraftId, candidateTitle);
          return;
        }
        onWorkspaceChange(nextWorkspace);
        let summaryRefreshNotice = "";
        try {
          await onSourceCatalogChange();
        } catch {
          summaryRefreshNotice = " Genel Bakış sayaçları henüz yenilenemedi; Genel Bakış ekranından yeniden deneyin.";
        }
        onOpenEditorial(`${candidateTitle} araştırma için yerel kuyruğa alındı; taslak masa envanterine eklendi. Editoryal Masa’da takip edebilirsiniz.${summaryRefreshNotice}`);
        return;
      }
      await bridge.dismissCandidate(candidateId);
      try {
        onWorkspaceChange(await bridge.getEditorialWorkspace());
        try {
          await onSourceCatalogChange();
          setMessage("Aday bu akıştan kapatıldı.");
        } catch {
          setMessage("Aday bu akıştan kapatıldı; Genel Bakış sayaçları henüz yenilenemedi. Genel Bakış ekranından yeniden deneyin.");
        }
      } catch {
        setMessage("Aday bu akıştan kapatıldı; envanter henüz yenilenemedi. Aday listesini yenileyin.");
      }
    } catch (reason) {
      setMessage(userFacingBridgeError(reason, "İşlem tamamlanamadı."));
    } finally {
      setBusyId("");
    }
  };

  const mutateSelected = async (action: "promote" | "dismiss") => {
    const targets = selectedCandidates.filter((candidate) =>
      action === "dismiss"
        ? candidate.state !== "DISMISSED"
        : candidate.state !== "PROMOTED" && candidate.state !== "RESEARCH_QUEUED" && candidate.state !== "RESEARCH_FAILED"
    );
    if (!targets.length) {
      setMessage(action === "promote" ? "Araştırmaya alınabilecek seçili aday yok." : "Kapatılabilecek seçili aday yok.");
      return;
    }
    setBusyId("batch");
    setMessage("");
    const completed = new Set<string>();
    const failed: string[] = [];
    try {
      // The bridge is deliberately serialized: a 50-item selection must not
      // launch 50 simultaneous native/engine mutations or stale-version races.
      for (const candidate of targets) {
        try {
          if (action === "promote") await bridge.promoteCandidate(candidate.id);
          else await bridge.dismissCandidate(candidate.id);
          completed.add(candidate.id);
        } catch {
          failed.push(candidate.title);
        }
      }
      const nextWorkspace = await bridge.getEditorialWorkspace();
      onWorkspaceChange(nextWorkspace);
      try {
        await onSourceCatalogChange();
      } catch {
        // The durable candidate action succeeded; only the optional dashboard
        // summary refresh needs another attempt.
      }
      setSelectedIds((current) => new Set([...current].filter((id) => !completed.has(id))));
      const actionLabel = action === "promote" ? "Araştırma kuyruğuna alındı" : "Akıştan kapatıldı";
      setMessage(
        failed.length
          ? `${completed.size} aday ${actionLabel.toLocaleLowerCase("tr-TR")}. ${failed.length} aday değişmedi: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}.`
          : `${completed.size} aday ${actionLabel.toLocaleLowerCase("tr-TR")}.`
      );
    } catch (reason) {
      setMessage(userFacingBridgeError(reason, "Toplu işlem tamamlanamadı."));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="page hub-page">
      <header className="page-header">
        <div>
          <p className="section-kicker">İÇERİK AKIŞI</p>
          <h1>Kaynaklardan yayın fikrine tek çalışma alanı.</h1>
          <p>
            Sınırsız kaynak kataloğunu yönetin, bulunan olayları ayıklayın veya
            seçtiğiniz kanıtlardan hemen yeni bir taslak başlatın.
          </p>
        </div>
        <button className="button button-primary" type="button" onClick={() => setTab("instant")}>
          <span aria-hidden="true">+</span> Anlık oluştur
        </button>
      </header>

      <div className="workspace-tabs" role="tablist" aria-label="İçerik akışı bölümleri" onKeyDown={handleTabListKeyDown}>
        {([
          ["sources", "Kaynaklar"],
          ["candidates", `Haber adayları · ${workspace.candidates.filter((item) => item.state !== "DISMISSED").length}`],
          ["instant", "Anlık oluştur"]
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`content-flow-tab-${id}`}
            aria-controls={`content-flow-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "is-active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "sources" ? (
        <section role="tabpanel" id="content-flow-panel-sources" aria-labelledby="content-flow-tab-sources"><SourceCenter
          bridge={bridge}
          canTest={canTestSources && !readOnly}
          canSave={canSaveSources && !readOnly}
          canScan={canScanSources && !readOnly}
          onSourceCatalogChange={onSourceCatalogChange}
          embedded
        /></section>
      ) : null}
      {tab === "instant" ? (
        <section role="tabpanel" id="content-flow-panel-instant" aria-labelledby="content-flow-tab-instant"><InstantCreate
          bridge={bridge}
          readOnly={readOnly}
          defaultSection={workspace.preferences.defaultSection}
          onOpenEditorial={onOpenEditorial}
          onOpenReview={onOpenReview}
          onWorkspaceChange={onWorkspaceChange}
          embedded
        /></section>
      ) : null}
      {tab === "candidates" ? (
        <section className="hub-panel" role="tabpanel" id="content-flow-panel-candidates" aria-labelledby="content-flow-tab-candidates">
          <div className="hub-toolbar">
            <label className="search-field">
              <span className="sr-only">Haber adaylarında ara</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Başlık, kaynak veya olay ara"
              />
            </label>
            <span>{candidates.length} etkin aday</span>
          </div>
          <div className="candidate-bulk-actions" aria-label="Seçili aday işlemleri">
            <span>{selectedCandidates.length} aday seçildi</span>
            <button className="button button-secondary" type="button" disabled={!candidates.length || Boolean(busyId)} onClick={selectVisibleCandidates}>Görünenleri seç</button>
            <button className="button button-ghost" type="button" disabled={!selectedCandidates.length || Boolean(busyId)} onClick={clearCandidateSelection}>Seçimi temizle</button>
            <button className="button button-secondary" type="button" disabled={readOnly || !selectedCandidates.length || Boolean(busyId)} onClick={() => void mutateSelected("dismiss")}>Seçilenleri kapat</button>
            <button className="button button-primary" type="button" disabled={readOnly || !selectedCandidates.length || Boolean(busyId)} onClick={() => void mutateSelected("promote")}>Seçilenleri araştırmaya al</button>
          </div>
          <div className="candidate-action-guidance" role="note">
            <strong>Araştırmaya almak yerel kuyruğu başlatır; hemen yayın yapmaz.</strong>
            <span>Yayın yalnızca hazır taslağı inceledikten sonra başlar; insan onayı olmadan hiçbir içerik gönderilmez.</span>
          </div>
          {candidates.length ? (
            <div className="candidate-grid">
              {candidates.map((candidate) => {
                const dismissReason = candidateActionUnavailableReason(candidate, "dismiss");
                const researchReason = candidateActionUnavailableReason(candidate, "promote");
                const isAlreadyQueued = candidate.state === "PROMOTED" || candidate.state === "RESEARCH_QUEUED";
                const hasFailedResearch = candidate.state === "RESEARCH_FAILED";
                return (
                <article className="candidate-card" key={candidate.id}>
                  <div className="candidate-meta">
                    <label className="candidate-select">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(candidate.id)}
                        disabled={readOnly || Boolean(busyId)}
                        onChange={(event) => toggleCandidateSelection(candidate.id, event.target.checked)}
                      />
                      <span className="sr-only">{candidate.title} adayını seç</span>
                    </label>
                    <span className={`state-pill state-${candidate.state.toLowerCase()}`}>
                      {candidateStateLabels[candidate.state]}
                    </span>
                    <span>{contentCategoryLabel(candidate.section, candidate.articleType)}</span>
                  </div>
                  <h2>{candidate.title}</h2>
                  <p>{candidate.summary}</p>
                  <div className="candidate-source">
                    <small>İnceleme önceliği: {candidateScoreLabel(candidate.rankingScore)}</small>{" · "}
                    <small>{candidate.sourceCount} kaynak · {candidatePublicationLabel(candidate.publishedAt)}</small>{" · "}
                    <small>Kaynak: {candidate.primarySource}</small>
                  </div>
                  {dismissReason || researchReason ? (
                    <div className="candidate-action-reasons">
                      {dismissReason ? <small id={`candidate-dismiss-unavailable-${candidate.id}`} className="action-unavailable-reason">{dismissReason}</small> : null}
                      {researchReason ? <small id={`candidate-action-unavailable-${candidate.id}`} className="action-unavailable-reason">{researchReason}</small> : null}
                    </div>
                  ) : null}
                  <div className="card-actions">
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={readOnly || Boolean(busyId)}
                      aria-describedby={dismissReason ? `candidate-dismiss-unavailable-${candidate.id}` : undefined}
                      onClick={() => void mutate(candidate.id, "dismiss")}
                    >
                      Adayı kapat
                    </button>
                    {hasFailedResearch ? (
                      <button className="button button-danger" type="button" onClick={onOpenOperations}>
                        Operasyonlarda hatayı aç
                      </button>
                    ) : isAlreadyQueued ? (
                      <button
                        className="button button-primary"
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => onOpenEditorial(
                          `${candidate.title} için araştırma işi zaten yerel kuyrukta. Durumunu Editoryal Masa’da takip edebilirsiniz.`,
                          `draft-candidate-${candidate.id}`,
                          candidate.title
                        )}
                      >
                        Editoryal Masa’da takip et
                      </button>
                    ) : (
                      <button
                        className="button button-primary"
                        type="button"
                        disabled={readOnly || Boolean(busyId)}
                        aria-describedby={researchReason ? `candidate-action-unavailable-${candidate.id}` : undefined}
                        onClick={() => void mutate(candidate.id, "promote")}
                      >
                        Araştırmaya al
                      </button>
                    )}
                  </div>
                </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <strong>Eşleşen etkin aday yok.</strong>
              <span>Aramayı temizleyin veya sonraki kaynak taramasını bekleyin.</span>
            </div>
          )}
          {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
