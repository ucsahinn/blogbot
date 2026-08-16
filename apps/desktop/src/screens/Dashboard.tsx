import { useState } from "react";

import { summarizeWorkspace } from "../app-model.ts";
import { codexRuntimeLabel } from "../app-model.ts";
import type { BootstrapSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";
import type { PageId } from "../components/AppShell.tsx";

interface DashboardProps {
  snapshot: BootstrapSnapshot;
  workspace: EditorialWorkspaceSnapshot;
  onNavigate: (page: PageId) => void;
  onRefresh: () => Promise<void>;
}

export function Dashboard({ snapshot, workspace, onNavigate, onRefresh }: DashboardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const summary = summarizeWorkspace(workspace);
  const primaryToday = workspace.today.find((item) => item.state !== "DONE") ?? workspace.today[0];
  const formatTime = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "bekleniyor"
      : new Intl.DateTimeFormat("tr-TR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Istanbul"
        }).format(date);
  };
  const navigateToWork = (target: EditorialWorkspaceSnapshot["today"][number]["target"]) => {
    onNavigate(
      target === "candidates"
        ? "content-candidates"
        : target === "editorial"
          ? "editorial"
          : target
    );
  };
  const todayLabel = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "full",
    timeZone: "Europe/Istanbul"
  }).format(new Date());
  const scheduledBySection = workspace.scheduled.reduce<Record<string, number>>((counts, item) => {
    counts[item.section] = (counts[item.section] ?? 0) + 1;
    return counts;
  }, {});
  const sectionPulse = Object.entries(scheduledBySection).sort(([a], [b]) => a.localeCompare(b, "tr"));
  const maxSectionCount = Math.max(1, ...sectionPulse.map(([, count]) => count));
  const refresh = async () => {
    setRefreshing(true);
    setRefreshMessage("");
    try {
      await onRefresh();
      setRefreshMessage("Çalışma alanı yerel veriden yenilendi.");
    } catch {
      setRefreshMessage("Çalışma alanı yenilenemedi. Yerel sistem durumunu Operasyonlar ekranından inceleyin.");
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="page">
      <header className="page-header dashboard-header">
        <div>
          <p className="section-kicker">{todayLabel.toLocaleUpperCase("tr-TR")}</p>
          <h1>Yayın akışı kontrol altında.</h1>
          <p>
            Kaynaklar izleniyor, kanıt eksiği olan işler duruyor ve hiçbir
            revizyon insan onayı olmadan yayın hattına geçmiyor.
          </p>
        </div>
        <div className="header-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? "Yenileniyor…" : "Çalışma alanını yenile"}
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={() => onNavigate("instant")}
          >
            <span aria-hidden="true">+</span>
            Anlık içerik oluştur
          </button>
        </div>
      </header>

      {refreshMessage ? <div className="inline-notice" role="status" aria-live="polite">{refreshMessage}</div> : null}

      {snapshot.runtime === "OFFLINE_READ_ONLY" ? (
        <div className="offline-banner" role="status">
          <strong>Yerel sistem kurtarma modunda</strong>
          Son sağlam görünüm korunuyor. Önkoşul testi tamamlanana kadar değişiklik
          ve onay işlemleri güvenle bekletilir.
        </div>
      ) : null}

      {primaryToday ? (
        <section className="dashboard-next-action" aria-labelledby="dashboard-next-action-title">
          <div>
            <p className="section-kicker">ŞİMDİ YAPILACAK</p>
            <h2 id="dashboard-next-action-title">{primaryToday.title}</h2>
            <p>{primaryToday.detail}</p>
          </div>
          <button className="button button-primary" type="button" onClick={() => navigateToWork(primaryToday.target)}>
            {primaryToday.state === "DONE" ? "Sonucu görüntüle" : "Bu işi aç"}
          </button>
        </section>
      ) : null}

      <div className="automation-continuity" role="note">
        <span aria-hidden="true">↻</span>
        <p><strong>OPE bilgisayarınız açıkken tepside çalışmaya devam eder.</strong> Uygulama kapanırsa işler bekler; yeniden açıldığında güvenli şekilde devam eder.</p>
      </div>

      <section className="status-strip" aria-label="Sistem durumu">
        <div className="status-primary">
          <span className="status-orbit" aria-hidden="true">
            <span />
          </span>
          <div>
            <small>OTOMASYON</small>
            <strong>
              {snapshot.automation.mode === "PUBLISH_APPROVED"
                ? "Onaylı yayın etkin"
                : snapshot.automation.mode === "DRAFT_ONLY"
                  ? "Taslak üretimi etkin"
                  : "Kaynak izleme etkin"}
            </strong>
            <p>
              Sonraki tarama {formatTime(snapshot.automation.nextScanAt)} ·{" "}
              {snapshot.sourceCount} kaynak · İstanbul saati
            </p>
          </div>
        </div>
        <div className="compact-status">
          <span
            className={`status-dot ${snapshot.connection.engineRunning ? "status-online" : "status-offline_read_only"}`}
            aria-hidden="true"
          />
          <div>
              <small>YEREL MOTOR</small>
            <strong>
              {snapshot.connection.engineRunning
                ? "Yerel sistem çalışıyor"
                : "Yerel sistem çalışmıyor"}
            </strong>
            <p>{snapshot.connection.engineLabel}</p>
          </div>
        </div>
        <div className="compact-status">
          <span
            className={`status-dot ${snapshot.codex.state === "READY" ? "status-online" : "status-degraded"}`}
            aria-hidden="true"
          />
          <div>
            <small>YAZI ÜRETİMİ</small>
            <strong>
              {codexRuntimeLabel(snapshot.codex.state)}
            </strong>
            <p>{snapshot.codex.queueDepth} iş sırada · güvenli çalışma alanı</p>
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">BUGÜNKÜ AKIŞ</p>
            <h2>İçerik hattı</h2>
          </div>
          <button
            className="text-button"
            type="button"
            onClick={() => onNavigate("editorial-review")}
          >
            Tüm kuyruğu aç <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="pipeline">
          {snapshot.pipeline.map((stage, index) => (
            <div className={`pipeline-stage tone-${stage.tone}`} key={stage.label}>
              <div className="pipeline-number">{stage.count}</div>
              <div>
                <strong>{stage.label}</strong>
                <small>
                  {index === 0
                    ? "Yeni aday"
                    : index === 1
                      ? "Kanıt toplanıyor"
                      : index === 2
                        ? "Sizi bekliyor"
                        : "Yayına hazır"}
                </small>
              </div>
              {index < snapshot.pipeline.length - 1 ? (
                <span className="pipeline-arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="content-panel queue-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">ÖNCELİKLİ İŞLER</p>
              <h2>Bugünün işleri</h2>
            </div>
            <span className="count-label">{summary.openToday} açık iş</span>
          </div>
          <div className="queue-list">
            {workspace.today.map((item) => (
              <button
                className="queue-row"
                type="button"
                key={item.id}
                onClick={() => navigateToWork(item.target)}
              >
                <span
                  className={`queue-state queue-${item.priority === "HIGH" ? "review_required" : "approved"}`}
                  aria-hidden="true"
                />
                <span className="queue-copy">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
                <span className={item.priority === "HIGH" ? "due is-blocked" : "due"}>
                  {item.state === "DONE" ? "Tamamlandı" : item.dueLabel}
                </span>
                <span className="row-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
            {!workspace.today.length ? (
              <div className="empty-state">Bugün için açık editoryal iş yok.</div>
            ) : null}
          </div>
        </section>

        <section className="content-panel editorial-pulse">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">YAYIN NABZI</p>
              <h2>Bugünün özeti</h2>
            </div>
          </div>
          <div className="pulse-metric">
            <strong>{workspace.scheduled.length}</strong>
            <span>
              planlı içerik
              <small>{summary.scheduledReady} tanesi yayına hazır</small>
            </span>
          </div>
          <div className="pulse-bars" aria-label="Bölümlere göre planlanan içerikler">
            {sectionPulse.length ? sectionPulse.map(([section, count]) => (
              <div key={section}>
                <span>{section}</span>
                <span className="bar-track">
                  <i style={{ width: `${Math.max(8, Math.round((count / maxSectionCount) * 100))}%` }} />
                </span>
                <strong>{count}</strong>
              </div>
            )) : <div className="empty-state">Planlanmış içerik yok.</div>}
          </div>
          <button
            className="button button-secondary button-full"
            type="button"
            onClick={() => onNavigate("publishing")}
          >
            Yayın takvimini aç
          </button>
        </section>
      </div>

      <footer className="integrity-note">
        <span className="integrity-icon" aria-hidden="true">
          ⌁
        </span>
        <span>
          <strong>Onay bütünlüğü korunuyor</strong>
          Son görünüm {formatTime(workspace.sync.generatedAt)}’te üretildi.{" "}
          {workspace.sync.stale
            ? "Son sağlam yerel görünüm gösteriliyor."
            : "Revizyon hash’leri ve görünüm dizisi eşleşiyor."}
        </span>
        <button type="button" onClick={() => onNavigate("operations")}>
          Ayrıntılar
        </button>
      </footer>
    </div>
  );
}
