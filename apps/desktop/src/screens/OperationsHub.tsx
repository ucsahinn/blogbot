import { useState } from "react";

import { userFacingBridgeError, type BlogbotBridge } from "../bridge.ts";
import { handleTabListKeyDown } from "../components/tab-keyboard.ts";
import { failureStateLabel, jobTypeLabel, retryModeLabel } from "../app-model.ts";
import type { BootstrapSnapshot, ConnectorStateSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";
import { Operations } from "./Operations.tsx";

interface OperationsHubProps {
  bridge: BlogbotBridge;
  snapshot: BootstrapSnapshot;
  workspace: EditorialWorkspaceSnapshot;
  readOnly: boolean;
  connectorState: ConnectorStateSnapshot;
  onSnapshotChange: (snapshot: BootstrapSnapshot) => void;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
  onConnectorStateChange: (snapshot: ConnectorStateSnapshot) => void;
  onOpenSetup: () => void;
  onOpenEditorial: () => void;
}

const codexRoleLabels = {
  FAST: "Hızlı işler",
  DEFAULT: "Ana üretim",
  DEEP_REVIEW: "Derin inceleme"
} as const;

const codexStateLabels = {
  READY: "Hazır",
  BUSY: "Çalışıyor",
  LIMITED: "Kota bekliyor",
  UNAVAILABLE: "Kullanılamıyor"
} as const;

const healthStateLabels = {
  HEALTHY: "Hazır",
  DEGRADED: "Dikkat gerekli",
  OFFLINE: "Sorun var",
  NOT_CONFIGURED: "Kurulmadı"
} as const;

const healthStateIcons = {
  HEALTHY: "✓",
  DEGRADED: "!",
  OFFLINE: "×",
  NOT_CONFIGURED: "–"
} as const;

const MAX_INITIAL_OPERATION_JOBS = 50;

function formatObservedTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "Ölçülmedi" : new Date(timestamp).toLocaleString("tr-TR");
}

function retryUnavailableReason(
  failure: EditorialWorkspaceSnapshot["failures"][number],
  readOnly: boolean,
  busyId: string
): string | undefined {
  if (readOnly) return "Yerel çalışma alanı yeniden bağlanana kadar işler yeniden başlatılamaz.";
  if (busyId === failure.id || failure.state === "RETRYING") return "İş zaten tekrar deneme kuyruğunda.";
  if (failure.retryMode === "MANUAL") return "Bu iş otomatik tekrar için güvenli değil; önce hata ayrıntısını inceleyin.";
  return undefined;
}

function userFacingRetryError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : "";
  if (raw.includes("JOB_NOT_RETRYABLE")) return "Bu iş şu anda yeniden denenemez; önce hata ayrıntısını inceleyin.";
  return userFacingBridgeError(
    reason,
    "İş yeniden başlatılamadı. Teknik ayrıntılar işlem günlüğüne kaydedildi."
  );
}

export function OperationsHub(props: OperationsHubProps) {
  const [tab, setTab] = useState<"jobs" | "codex" | "health" | "activity">("jobs");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [diagnosticsRequested, setDiagnosticsRequested] = useState(false);
  const [showAllJobs, setShowAllJobs] = useState(false);
  const engineOffline = props.workspace.systemHealth.some(
    (item) => item.id === "engine" && item.state === "OFFLINE"
  );
  const activeDrafts = props.workspace.drafts.filter((draft) => !draft.reviewable && draft.state === "DRAFTING");
  const codexAccountLabel = props.connectorState.config.codex.accountLabel.trim() || "Henüz seçilmedi";
  const activeCodexRole = props.workspace.codexRoles.find((role) => role.state === "BUSY");
  const automationUnavailableReason = props.readOnly
    ? "Yerel çalışma alanı yeniden bağlanana kadar otomasyon değiştirilemez."
    : automationBusy
      ? "Devam eden otomasyon işlemi tamamlanana kadar bu kontrol kullanılamaz."
      : undefined;
  const visibleActiveDrafts = showAllJobs ? activeDrafts : activeDrafts.slice(0, MAX_INITIAL_OPERATION_JOBS);
  const visibleFailures = showAllJobs
    ? props.workspace.failures
    : props.workspace.failures.slice(0, Math.max(0, MAX_INITIAL_OPERATION_JOBS - visibleActiveDrafts.length));
  const hiddenJobCount = Math.max(
    0,
    activeDrafts.length + props.workspace.failures.length - visibleActiveDrafts.length - visibleFailures.length
  );
  const refreshUnavailableReason = refreshing
    ? "Yerel durum yenileniyor; işlem tamamlanana kadar yeniden yenileme yapılamaz."
    : automationBusy
      ? "Devam eden otomasyon işlemi tamamlanana kadar durum yenilenemez."
      : undefined;

  const refresh = async () => {
    setRefreshing(true);
    setMessage("");
    try {
      const snapshot = await props.bridge.getBootstrapSnapshot();
      const [workspace, connectorState] = await Promise.all([
        props.bridge.getEditorialWorkspace(),
        props.bridge.getConnectorState()
      ]);
      props.onSnapshotChange(snapshot);
      props.onWorkspaceChange(workspace);
      props.onConnectorStateChange(connectorState);
      setMessage("Operasyon durumu yerel veriden yenilendi.");
    } catch {
      setMessage("Operasyon durumu yenilenemedi. Yerel engine ve bağlantıları Kurulum Merkezi'nden denetleyin.");
    } finally {
      setRefreshing(false);
    }
  };

  const retry = async (jobId: string) => {
    setBusyId(jobId);
    setMessage("");
    try {
      await props.bridge.retryJob(jobId);
      try {
        props.onWorkspaceChange(await props.bridge.getEditorialWorkspace());
        setMessage("İş güvenli tekrar deneme kuyruğuna alındı.");
      } catch {
        setMessage("İş güvenli tekrar deneme kuyruğuna alındı; ancak envanter henüz yenilenemedi. Operasyon durumunu yenileyin.");
      }
    } catch (reason) {
      setMessage(userFacingRetryError(reason));
    } finally {
      setBusyId("");
    }
  };

  const togglePause = async (target: "ingestion" | "publishing") => {
    const current = target === "ingestion"
      ? props.snapshot.automation.ingestionPaused
      : props.snapshot.automation.publishingPaused;
    const label = target === "ingestion" ? "Kaynak taraması" : "Yayın";
    setAutomationBusy(true);
    setMessage("");
    try {
      const result = await props.bridge.setRuntimePause({
        target,
        paused: !current
      });
      props.onSnapshotChange({
        ...props.snapshot,
        automation: {
          ...props.snapshot.automation,
          ...(target === "ingestion"
            ? { ingestionPaused: result.paused }
            : { publishingPaused: result.paused })
        }
      });
      setMessage(result.paused ? `${label} duraklatıldı.` : `${label} devam ettirildi.`);
    } catch (reason) {
      setMessage(userFacingBridgeError(reason, `${label} durumu değiştirilemedi.`));
    } finally {
      setAutomationBusy(false);
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
        <div className="header-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={Boolean(automationUnavailableReason)}
            aria-describedby={automationUnavailableReason ? "operations-automation-unavailable" : undefined}
            onClick={() => void togglePause("ingestion")}
          >
            {props.snapshot.automation.ingestionPaused ? "Taramayı sürdür" : "Taramayı duraklat"}
          </button>
          {props.connectorState.mode === "PUBLISH" ? (
            <button
              className={`button ${props.snapshot.automation.publishingPaused ? "button-primary" : "button-danger"}`}
              type="button"
              disabled={Boolean(automationUnavailableReason)}
              aria-describedby={automationUnavailableReason ? "operations-automation-unavailable" : undefined}
              onClick={() => void togglePause("publishing")}
            >
              {props.snapshot.automation.publishingPaused ? "Yayını sürdür" : "Yayını duraklat"}
            </button>
          ) : null}
          <button className="button button-secondary" type="button" disabled={Boolean(refreshUnavailableReason)} aria-describedby={refreshUnavailableReason ? "operations-refresh-unavailable" : undefined} onClick={() => void refresh()}>
            {refreshing ? "Yenileniyor…" : "Operasyon durumunu yenile"}
          </button>
          {automationUnavailableReason ? <small id="operations-automation-unavailable" className="action-unavailable-reason">{automationUnavailableReason}</small> : null}
          {refreshUnavailableReason ? <small id="operations-refresh-unavailable" className="action-unavailable-reason">{refreshUnavailableReason}</small> : null}
        </div>
      </header>
      {message ? <div className="inline-notice" role="status" aria-live="polite">{message}</div> : null}
      <aside className="automation-continuity" aria-label="Yerel otomasyon durumu">
        <span aria-hidden="true">{props.snapshot.automation.ingestionPaused ? "Ⅱ" : "●"}</span>
        <div>
          <strong>Kaynak taraması: <span className={`automation-state ${props.snapshot.automation.ingestionPaused ? "is-paused" : "is-running"}`}>{props.snapshot.automation.ingestionPaused ? "Duraklatıldı" : "Çalışıyor"}</span></strong>
          <p>{props.snapshot.automation.ingestionPaused
            ? "Yeni kaynak alma durdu; mevcut yerel içerikler ve inceleme ekranları kullanılabilir."
            : "Yeni kaynaklar yerel plana göre taranabilir; yayın onayı ayrı tutulur."}</p>
        </div>
      </aside>
      <div className="workspace-tabs" role="tablist" aria-label="Operasyon bölümleri" onKeyDown={handleTabListKeyDown}>
        {([
          ["jobs", `Hatalar · ${props.workspace.failures.filter((item) => item.state === "ACTION_REQUIRED").length}`],
          ["codex", "Codex kullanım ve limit"],
          ["health", "Yerel sistem ve bağlantılar"],
          ["activity", "İş günlüğü"]
        ] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`operations-tab-${id}`} aria-controls={`operations-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === "activity" ? (
        <div role="tabpanel" id="operations-panel-activity" aria-labelledby="operations-tab-activity"><Operations
          bridge={props.bridge}
          snapshot={props.snapshot}
          readOnly={props.readOnly}
          connectorState={props.connectorState}
          onSnapshotChange={props.onSnapshotChange}
          embedded
          diagnosticsRequested={diagnosticsRequested}
          onDiagnosticsRequestHandled={() => setDiagnosticsRequested(false)}
        /></div>
      ) : (
        <section className="hub-panel" role="tabpanel" id={`operations-panel-${tab}`} aria-labelledby={`operations-tab-${tab}`}>
          {tab === "jobs" ? (
            <div className="data-list">
              {visibleActiveDrafts.map((draft) => (
                <article className="failure-row active-job-row" key={draft.id} aria-label="Devam eden taslak işi">
                  <div>
                    <span className="state-pill state-drafting">Taslak hazırlanıyor</span>
                    <h2>{draft.titleTr}</h2>
                    <p>{draft.detail}</p>
                    <small>İnceleme, taslak ve kanıt paketi hazır olduğunda açılır.</small>
                  </div>
                  <div className="row-actions">
                    <button className="button button-primary" type="button" onClick={props.onOpenEditorial}>
                      Editoryal Masa’da aç
                    </button>
                    {draft.blockers > 0 || draft.state === "DRAFTING" ? (
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={props.readOnly || busyId === draft.id}
                        aria-describedby={props.readOnly ? "active-draft-retry-unavailable" : undefined}
                        onClick={() => void retry(draft.id)}
                      >
                        {busyId === draft.id ? "Kuyruğa alınıyor" : "Tekrar dene"}
                      </button>
                    ) : null}
                    {(draft.blockers > 0 || draft.state === "DRAFTING") && props.readOnly ? (
                      <small id="active-draft-retry-unavailable" className="action-unavailable-reason">
                        Yerel çalışma alanı yeniden bağlanana kadar iş yeniden başlatılamaz.
                      </small>
                    ) : null}
                  </div>
                </article>
              ))}
              {visibleFailures.map((failure) => {
                const unavailableReason = retryUnavailableReason(failure, props.readOnly, busyId);
                const unavailableReasonId = `retry-unavailable-${failure.id}`;
                return (
                  <article className="failure-row" key={failure.id}>
                    <div>
                      <span className={`state-pill state-${failure.state.toLowerCase()}`}>{failureStateLabel(failure.state)}</span>
                      <h2>{failure.title}</h2>
                      <p>{failure.message}</p>
                      <small>{jobTypeLabel(failure.jobType)} · {failure.attempts} deneme · {retryModeLabel(failure.retryMode)}</small>
                      {unavailableReason ? <small id={unavailableReasonId} className="action-unavailable-reason">{unavailableReason}</small> : null}
                    </div>
                    <button className="button button-secondary" type="button" disabled={Boolean(unavailableReason)} title={unavailableReason} aria-describedby={unavailableReason ? unavailableReasonId : undefined} onClick={() => void retry(failure.id)}>
                      {failure.retryMode === "RECONCILE_FIRST" ? "Uzlaştır ve tekrar dene" : failure.state === "RETRYING" ? "Kuyrukta" : "Tekrar dene"}
                    </button>
                  </article>
                );
              })}
              {hiddenJobCount > 0 ? (
                <button className="button button-secondary" type="button" onClick={() => setShowAllJobs(true)}>
                  Tüm {hiddenJobCount} işi göster
                </button>
              ) : null}
              {props.workspace.failures.length === 0 && activeDrafts.length === 0 ? (
                <div className="empty-state"><strong>Müdahale bekleyen iş yok.</strong><span>Yeni bir hata oluşursa nedeni, deneme sayısı ve güvenli sonraki adım burada görünür.</span></div>
              ) : null}
            </div>
          ) : null}
          {tab === "codex" ? (
            <>
              <section className="codex-usage-summary" aria-label="Yerel Codex görev özeti">
                <div>
                  <p className="section-kicker">YEREL GÖREV GÖRÜNÜMÜ</p>
                  <h2>{activeCodexRole ? `${codexRoleLabels[activeCodexRole.role]} çalışıyor` : "Codex işi beklemiyor"}</h2>
                  <p>Hesap etiketi: <strong>{codexAccountLabel}</strong></p>
                </div>
                <dl>
                  <div><dt>Aktif görev</dt><dd>{activeCodexRole?.queueDepth ?? 0}</dd></div>
                  <div><dt>Son yenileme</dt><dd>{formatObservedTime(props.workspace.sync.generatedAt)}</dd></div>
                </dl>
              </section>
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
                    <dl><div><dt>Sırada</dt><dd>{role.queueDepth}</dd></div><div><dt>Bugün</dt><dd>{role.completedToday ?? "Ölçülmedi"}</dd></div><div><dt>Son başarı</dt><dd>{role.lastSuccessAt ? formatObservedTime(role.lastSuccessAt) : "Ölçülmedi"}</dd></div></dl>
                  </article>
                ))}
                {props.workspace.codexRoles.length === 0 ? (
                  <div className="empty-state"><strong>Codex kapasite verisi alınamadı.</strong><span>Yerel engine bağlantısını ve Codex önkoşulunu Kurulum Merkezi'nden yeniden denetleyin.</span></div>
                ) : null}
              </div>
              <aside className="setup-note"><strong>Token ve kota ölçümü yok</strong><p>Sadece kalıcı yerel iş kaydından türetilen veriler gösterilir. Yerel Codex çalışma zamanı token, abonelik limiti veya hesap bakiyesi vermediğinde tahmini sayaç gösterilmez. Ücretli OpenAI API adaptörü kullanıcı onayı olmadan çalışmaz.</p></aside>
            </>
          ) : null}
          {tab === "health" ? (
            <div className="health-list">
              {engineOffline ? (
                <aside className="engine-recovery-callout" role="alert">
                  <div>
                    <strong>Yerel engine yeniden bağlanmayı bekliyor.</strong>
                    <p>İçerik ve yayın işlemleri güvenle durduruldu. Önce yerel durumu yeniden deneyin; sorun sürerse günlüklerden sır içermeyen tanılama paketi oluşturun.</p>
                  </div>
                  <div className="engine-recovery-actions">
                    <button className="button button-secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>
                      {refreshing ? "Yerel durum yenileniyor…" : "Yerel durumu yeniden dene"}
                    </button>
                    <button className="button button-secondary" type="button" onClick={() => { setDiagnosticsRequested(true); setTab("activity"); }}>
                      Tanılama ve günlükleri aç
                    </button>
                    <button className="text-button" type="button" onClick={props.onOpenSetup}>
                      Kurulum Merkezi'nde engine'i test et
                    </button>
                  </div>
                </aside>
              ) : null}
              {props.workspace.systemHealth.map((item) => (
                <article key={item.id} data-state={item.state}>
                  <span className={`status-dot status-${item.state.toLowerCase()}`} aria-hidden="true" />
                  <div>
                    <div className="health-row-heading">
                      <strong>{item.label}</strong>
                      <span className={`health-state health-state-${item.state.toLowerCase()}`}>
                        <span aria-hidden="true">{healthStateIcons[item.state]}</span>
                        {healthStateLabels[item.state]}
                      </span>
                    </div>
                    <p>{item.detail}</p>
                    <small>{new Date(item.checkedAt).toLocaleTimeString("tr-TR")}</small>
                  </div>
                </article>
              ))}
              {props.workspace.systemHealth.length === 0 ? (
                <div className="empty-state"><strong>Sistem sağlık kontrolü çalıştırılmadı.</strong><span>Durumu yenileyin; çalıştırılmayan kontrol başarılı sayılmaz.</span></div>
              ) : null}
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
