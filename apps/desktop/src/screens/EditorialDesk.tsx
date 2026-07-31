import { useState } from "react";

import type { BlogbotBridge } from "../bridge.ts";
import type { BootstrapSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";
import { ReviewWorkspace } from "./ReviewWorkspace.tsx";

interface EditorialDeskProps {
  bridge: BlogbotBridge;
  snapshot: BootstrapSnapshot;
  workspace: EditorialWorkspaceSnapshot;
  readOnly: boolean;
  initialTab?: "drafts" | "review";
}

export function EditorialDesk({
  bridge,
  snapshot,
  workspace,
  readOnly,
  initialTab = "drafts"
}: EditorialDeskProps) {
  const [tab, setTab] = useState<"drafts" | "review">(initialTab);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | undefined>();

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
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="Editoryal masa bölümleri">
        <button type="button" role="tab" aria-selected={tab === "drafts"} className={tab === "drafts" ? "is-active" : ""} onClick={() => setTab("drafts")}>
          Taslaklar · {workspace.drafts.length}
        </button>
        <button type="button" role="tab" aria-selected={tab === "review"} className={tab === "review" ? "is-active" : ""} onClick={() => setTab("review")}>
          TR / EN inceleme
        </button>
      </div>
      {tab === "drafts" ? (
        <section className="hub-panel" role="tabpanel">
          <div className="draft-list">
            {workspace.drafts.map((draft) => (
              <button className="draft-row" type="button" key={draft.id} onClick={() => { setSelectedRevisionId(draft.id); setTab("review"); }}>
                <span className={`progress-ring progress-${Math.round(draft.completion / 10) * 10}`} aria-label={`Yüzde ${draft.completion} tamamlandı`}>
                  {draft.completion}
                </span>
                <span className="draft-copy">
                  <strong>{draft.titleTr}</strong>
                  <small>{draft.titleEn}</small>
                  <span>{draft.section} · {draft.blockers ? `${draft.blockers} engel` : "engel yok"}</span>
                </span>
                <span className={`state-pill state-${draft.state.toLowerCase()}`}>{draft.state}</span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <ReviewWorkspace
          key={selectedRevisionId ?? "default-review"}
          bridge={bridge}
          snapshot={snapshot}
          readOnly={readOnly}
          embedded
          {...(selectedRevisionId ? { initialRevisionId: selectedRevisionId } : {})}
        />
      )}
    </div>
  );
}
