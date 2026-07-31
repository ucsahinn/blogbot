import { useMemo, useState } from "react";

import type { BlogbotBridge } from "../bridge.ts";
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
  onOpenReview: () => void;
}

const candidateStateLabels: Record<CandidateView["state"], string> = {
  NEW: "Yeni aday",
  NEEDS_SOURCE: "Kaynak gerekli",
  ROUTING_REQUIRED: "Yönlendirme gerekli",
  DISMISSED: "Kapatıldı",
  PROMOTED: "Taslağa alındı",
  RESEARCH_QUEUED: "Araştırma kuyruğunda"
};

export function ContentFlow({
  bridge,
  readOnly,
  canTestSources,
  canSaveSources,
  canScanSources,
  workspace,
  initialTab = "sources",
  onWorkspaceChange,
  onOpenReview
}: ContentFlowProps) {
  const [tab, setTab] = useState<ContentTab>(initialTab);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

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

  const mutate = async (
    candidateId: string,
    action: "promote" | "dismiss"
  ) => {
    setBusyId(candidateId);
    setMessage("");
    try {
      if (action === "promote") await bridge.promoteCandidate(candidateId);
      else await bridge.dismissCandidate(candidateId);
      onWorkspaceChange(await bridge.getEditorialWorkspace());
      setMessage(
        action === "promote"
          ? "Aday araştırma ve taslak akışına alındı."
          : "Aday bu akıştan kapatıldı."
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "İşlem tamamlanamadı.");
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

      <div className="workspace-tabs" role="tablist" aria-label="İçerik akışı bölümleri">
        {([
          ["sources", "Kaynaklar"],
          ["candidates", `Haber adayları · ${workspace.candidates.filter((item) => item.state !== "DISMISSED").length}`],
          ["instant", "Anlık oluştur"]
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "is-active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "sources" ? (
        <SourceCenter
          bridge={bridge}
          canTest={canTestSources}
          canSave={canSaveSources}
          canScan={canScanSources}
          embedded
        />
      ) : null}
      {tab === "instant" ? (
        <InstantCreate
          bridge={bridge}
          readOnly={readOnly}
          onOpenReview={onOpenReview}
          embedded
        />
      ) : null}
      {tab === "candidates" ? (
        <section className="hub-panel" role="tabpanel">
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
          {candidates.length ? (
            <div className="candidate-grid">
              {candidates.map((candidate) => (
                <article className="candidate-card" key={candidate.id}>
                  <div className="candidate-meta">
                    <span className={`state-pill state-${candidate.state.toLowerCase()}`}>
                      {candidateStateLabels[candidate.state]}
                    </span>
                    <span>{candidate.section} · {candidate.articleType}</span>
                  </div>
                  <h2>{candidate.title}</h2>
                  <p>{candidate.summary}</p>
                  <dl className="signal-grid">
                    <div><dt>Güven</dt><dd>{candidate.confidence}%</dd></div>
                    <div><dt>Benzerlik</dt><dd>{candidate.duplicateScore}%</dd></div>
                    <div><dt>Kanıt</dt><dd>{candidate.sourceCount} kaynak</dd></div>
                  </dl>
                  <small>Birincil kaynak: {candidate.primarySource}</small>
                  <div className="card-actions">
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={readOnly || busyId === candidate.id}
                      onClick={() => void mutate(candidate.id, "dismiss")}
                    >
                      Kapat
                    </button>
                    <button
                      className="button button-primary"
                      type="button"
                      disabled={readOnly || busyId === candidate.id || candidate.state === "PROMOTED" || candidate.state === "RESEARCH_QUEUED"}
                      onClick={() => void mutate(candidate.id, "promote")}
                    >
                      {candidate.state === "PROMOTED" || candidate.state === "RESEARCH_QUEUED" ? candidateStateLabels[candidate.state] : "Araştırmaya al"}
                    </button>
                  </div>
                </article>
              ))}
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
