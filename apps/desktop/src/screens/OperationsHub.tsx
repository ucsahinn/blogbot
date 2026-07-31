import { useState } from "react";

import type { BlogbotBridge } from "../bridge.ts";
import type { BootstrapSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";
import { Operations } from "./Operations.tsx";

interface OperationsHubProps {
  bridge: BlogbotBridge;
  snapshot: BootstrapSnapshot;
  workspace: EditorialWorkspaceSnapshot;
  readOnly: boolean;
  onSnapshotChange: (snapshot: BootstrapSnapshot) => void;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
}

const codexRoleLabels = {
  FAST: "FAST · Hızlı işler",
  DEFAULT: "DEFAULT · Ana üretim",
  DEEP_REVIEW: "DEEP_REVIEW · Derin inceleme"
} as const;

const codexStateLabels = {
  READY: "Hazır",
  BUSY: "Çalışıyor",
  LIMITED: "Kota bekliyor",
  UNAVAILABLE: "Kullanılamıyor"
} as const;

function userFacingRetryError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : "";
  if (raw.includes("JOB_NOT_RETRYABLE")) return "Bu iş şu anda yeniden denenemez; önce hata ayrıntısını inceleyin.";
  if (raw.includes("ENGINE") || raw.includes("engine")) return "Yerel çalışma bileşeni hazır değil; Kurulum Merkezi'nden Önkoşul testi çalıştırın.";
  return "İş yeniden başlatılamadı. Teknik ayrıntılar işlem günlüğüne kaydedildi.";
}

export function OperationsHub(props: OperationsHubProps) {
  const [tab, setTab] = useState<"jobs" | "codex" | "health" | "activity">("jobs");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  const retry = async (jobId: string) => {
    setBusyId(jobId);
    setMessage("");
    try {
      await props.bridge.retryJob(jobId);
      props.onWorkspaceChange(await props.bridge.getEditorialWorkspace());
      setMessage("İş güvenli tekrar deneme kuyruğuna alındı.");
    } catch (reason) {
      setMessage(userFacingRetryError(reason));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="page hub-page">
      <header className="page-header">
        <div>
          <p className="section-kicker">OPERASYONLAR</p>
          <h1>İşler, Codex kapasitesi ve sistem sağlığı.</h1>
          <p>Belirsiz yayın işlemleri önce kontrol edilir; ücretli ek hizmetler siz açıkça etkinleştirmedikçe kapalıdır.</p>
        </div>
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="Operasyon bölümleri">
        {([
          ["jobs", `Hatalar · ${props.workspace.failures.filter((item) => item.state === "ACTION_REQUIRED").length}`],
          ["codex", "Codex kullanım ve limit"],
          ["health", "Yerel sistem ve bağlantılar"],
          ["activity", "İş günlüğü"]
        ] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === "activity" ? (
        <Operations
          bridge={props.bridge}
          snapshot={props.snapshot}
          readOnly={props.readOnly}
          onSnapshotChange={props.onSnapshotChange}
          embedded
        />
      ) : (
        <section className="hub-panel" role="tabpanel">
          {tab === "jobs" ? (
            <div className="data-list">
              {props.workspace.failures.map((failure) => (
                <article className="failure-row" key={failure.id}>
                  <div>
                    <span className={`state-pill state-${failure.state.toLowerCase()}`}>{failure.state}</span>
                    <h2>{failure.title}</h2>
                    <p>{failure.message}</p>
                    <small>{failure.jobType} · {failure.attempts} deneme · {failure.retryMode}</small>
                  </div>
                  <button className="button button-secondary" type="button" disabled={props.readOnly || busyId === failure.id || failure.retryMode === "MANUAL" || failure.state === "RETRYING"} onClick={() => void retry(failure.id)}>
                    {failure.retryMode === "RECONCILE_FIRST" ? "Uzlaştır ve tekrar dene" : failure.state === "RETRYING" ? "Kuyrukta" : "Tekrar dene"}
                  </button>
                </article>
              ))}
            </div>
          ) : null}
          {tab === "codex" ? (
            <>
              <div className="role-grid">
                {props.workspace.codexRoles.map((role) => (
                  <article className="role-card" key={role.role}>
                    <div>
                      <strong>{codexRoleLabels[role.role]}</strong>
                      <span className={`state-pill state-${role.state.toLowerCase()}`}>
                        {codexStateLabels[role.state]}
                      </span>
                    </div>
                    <p>{role.label}</p>
                    <dl><div><dt>Sırada</dt><dd>{role.queueDepth}</dd></div><div><dt>Bugün</dt><dd>{role.completedToday}</dd></div></dl>
                  </article>
                ))}
              </div>
              <aside className="setup-note"><strong>Ücret koruması etkin</strong><p>Codex limiti dolarsa işler bekler ve bildirim oluşturur. Ücretli OpenAI API adaptörü kullanıcı onayı olmadan çalışmaz.</p></aside>
            </>
          ) : null}
          {tab === "health" ? (
            <div className="health-list">
              {props.workspace.systemHealth.map((item) => (
                <article key={item.id}><span className={`status-dot status-${item.state.toLowerCase()}`} aria-hidden="true" /><div><strong>{item.label}</strong><p>{item.detail}</p><small>{new Date(item.checkedAt).toLocaleTimeString("tr-TR")}</small></div></article>
              ))}
            </div>
          ) : null}
          {message ? <p className="form-message" role="status" aria-live="polite">{message}</p> : null}
        </section>
      )}
    </div>
  );
}
