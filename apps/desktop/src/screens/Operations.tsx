import { useEffect, useMemo, useState } from "react";

import type { BlogbotBridge } from "../bridge.ts";
import type { BootstrapSnapshot, OperationsSnapshot } from "../types.ts";

interface OperationsProps {
  bridge: BlogbotBridge;
  snapshot: BootstrapSnapshot;
  readOnly: boolean;
  onSnapshotChange: (snapshot: BootstrapSnapshot) => void;
  embedded?: boolean;
}

const eventStateLabel = {
  SUCCESS: "Tamamlandı",
  RUNNING: "Çalışıyor",
  WAITING: "Bekliyor",
  BLOCKED: "Durduruldu"
};

const dayLabels = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"] as const;
const localDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function getOperationWeek(now = new Date()): ReadonlyArray<readonly [string, string, string]> {
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(now.getDate() + mondayOffset + index);
    const iso = localDateKey(date);
    return [dayLabels[date.getDay()] ?? "Gün", String(date.getDate()).padStart(2, "0"), iso] as const;
  });
}

function selectedSiteMode(): "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH" {
  try {
    const value = JSON.parse(localStorage.getItem("blogbot.setup.connector-draft.v1") ?? "null") as { site?: { mode?: string } } | null;
    return value?.site?.mode === "PUBLISH" || value?.site?.mode === "LOCAL_DEV" ? value.site.mode : "LOCAL_ONLY";
  } catch {
    return "LOCAL_ONLY";
  }
}

export function Operations({
  bridge,
  snapshot,
  readOnly,
  onSnapshotChange,
  embedded = false
}: OperationsProps) {
  const [operations, setOperations] = useState<OperationsSnapshot | null>(null);
  const [busyTarget, setBusyTarget] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [engineDiagnostics, setEngineDiagnostics] = useState<{ path: string | null; lines: string[] }>({ path: null, lines: [] });
  const [localDevDiagnostics, setLocalDevDiagnostics] = useState<{ path: string | null; lines: string[] }>({ path: null, lines: [] });
  const [diagnosticExportBusy, setDiagnosticExportBusy] = useState(false);
  const [diagnosticExportPath, setDiagnosticExportPath] = useState("");
  const [logFilter, setLogFilter] = useState<"all" | "errors" | "changes" | "debug">("all");
  const [selectedDate, setSelectedDate] = useState(() =>
    getOperationWeek().find(([, , value]) => value === localDateKey(new Date()))?.[2]
      ?? getOperationWeek()[0]?.[2]
      ?? new Date().toISOString().slice(0, 10)
  );
  const [notice, setNotice] = useState("");
  const operationWeek = useMemo(() => getOperationWeek(), []);
  const siteMode = selectedSiteMode();
  const scheduleDateKey = (value: string) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : localDateKey(parsed);
  };

  useEffect(() => {
    let alive = true;
    void bridge
      .getOperations()
      .then((value) => {
        if (alive) {
          setOperations(value);
        }
      })
      .catch((reason) => {
        if (alive) {
          setNotice(reason instanceof Error ? reason.message : "Operasyon günlüğü okunamadı.");
        }
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (!diagnosticsOpen) return;
    void Promise.all([bridge.getEngineDiagnostics(), bridge.getLocalDevLogs()])
      .then(([engine, localDev]) => { setEngineDiagnostics(engine); setLocalDevDiagnostics(localDev); })
      .catch(() => { setEngineDiagnostics({ path: null, lines: [] }); setLocalDevDiagnostics({ path: null, lines: [] }); });
  }, [bridge, diagnosticsOpen]);

  const refreshOperations = async () => {
    setBusyTarget("logs");
    try {
      setOperations(await bridge.getOperations());
      setNotice("Günlük yenilendi.");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Günlük okunamadı.");
    } finally {
      setBusyTarget("");
    }
  };

  const exportDiagnostics = async () => {
    setDiagnosticExportBusy(true);
    setNotice("");
    try {
      const result = await bridge.exportDiagnostics();
      setDiagnosticExportPath(result.path);
      setDiagnosticsOpen(true);
      setNotice(`Tanılama paketi hazırlandı (${result.bytes} bayt).`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Tanılama paketi oluşturulamadı.");
    } finally {
      setDiagnosticExportBusy(false);
    }
  };

  const visibleEvents = (operations?.events ?? []).filter((event) => {
    if (logFilter === "errors") return event.level === "ERROR" || event.state === "BLOCKED";
    if (logFilter === "changes") return event.id.startsWith("change-");
    if (logFilter === "debug") return event.level === "DEBUG";
    return true;
  });

  const togglePause = async (target: "ingestion" | "publishing") => {
    const current =
      target === "ingestion"
        ? snapshot.automation.ingestionPaused
        : snapshot.automation.publishingPaused;
    setBusyTarget(target);
    setNotice("");
    try {
      const result = await bridge.setRuntimePause({
        target,
        paused: !current
      });
      onSnapshotChange({
        ...snapshot,
        automation: {
          ...snapshot.automation,
          ...(target === "ingestion"
            ? { ingestionPaused: result.paused }
            : { publishingPaused: result.paused })
        }
      });
      setNotice(
        `${target === "ingestion" ? "Kaynak taraması" : "Yayın"} ${
          result.paused ? "duraklatıldı" : "devam ettirildi"
        }.`
      );
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Durum değiştirilemedi."
      );
    } finally {
      setBusyTarget("");
    }
  };

  return (
    <div className={embedded ? "embedded-page operations-page" : "page operations-page"}>
      <header className="page-header">
        <div>
          <p className="section-kicker">TAKVİM VE OPERASYON</p>
          <h1>Otomasyon görünür, sınırlar açık.</h1>
          <p>
            Kaynak taraması, Codex işleri, onaylı yayınlar ve dış etki
            mutabakatı tek operasyon günlüğünde izlenir.
          </p>
        </div>
        <div className="header-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={readOnly || busyTarget.length > 0}
            onClick={() => void togglePause("ingestion")}
          >
            {snapshot.automation.ingestionPaused
              ? "Taramayı sürdür"
              : "Taramayı duraklat"}
          </button>
          {siteMode === "PUBLISH" ? (
            <button
              className={`button ${
                snapshot.automation.publishingPaused
                  ? "button-primary"
                  : "button-danger"
              }`}
              type="button"
              disabled={readOnly || busyTarget.length > 0}
              onClick={() => void togglePause("publishing")}
            >
              {snapshot.automation.publishingPaused
                ? "Yayını sürdür"
                : "Yayını duraklat"}
            </button>
          ) : null}
        </div>
      </header>

      {notice ? <div className="inline-notice" role="status">{notice}</div> : null}

      <section className="runtime-grid">
        <article className="runtime-card">
          <div className="runtime-card-top">
            <span className="runtime-symbol engine-symbol" aria-hidden="true">
              E
            </span>
            <span
              className={`status-dot ${
                snapshot.connection.engineRunning
                  ? "status-online"
                  : "status-offline_read_only"
              }`}
            />
          </div>
            <p className="section-kicker">YEREL SİSTEM</p>
          <h2>
              {snapshot.connection.engineRunning
                ? "Blogbot çalışıyor"
                : "Blogbot çalışmıyor"}
          </h2>
          <dl>
            <div>
              <dt>Çalışma zamanı</dt>
              <dd>{snapshot.connection.engineLabel}</dd>
            </div>
            <div>
              <dt>Gecikme</dt>
              <dd>{snapshot.connection.latencyMs ?? "Bilinmiyor"} ms</dd>
            </div>
            <div>
              <dt>Yerel uygulama bağlantısı</dt>
              <dd>{snapshot.connection.bridgeReady ? "Doğrulandı" : "Bekliyor"}</dd>
            </div>
          </dl>
        </article>

        <article className="runtime-card">
          <div className="runtime-card-top">
            <span className="runtime-symbol codex-symbol" aria-hidden="true">
              C
            </span>
            <span
              className={`status-dot ${
                snapshot.codex.state === "READY"
                  ? "status-online"
                  : "status-degraded"
              }`}
            />
          </div>
          <p className="section-kicker">YAZI ÜRETİMİ</p>
          <h2>{snapshot.codex.state === "READY" ? "Yazı üretimi hazır" : "Yazı üretimi bekliyor"}</h2>
          <dl>
            <div>
              <dt>Yetki</dt>
              <dd>Yalnızca şemalı görev</dd>
            </div>
            <div>
              <dt>Sıra</dt>
              <dd>{snapshot.codex.queueDepth} araştırma</dd>
            </div>
            <div>
              <dt>Erişim</dt>
              <dd>Repo, DB ve yayın anahtarı yok</dd>
            </div>
          </dl>
        </article>

        <article className="runtime-card">
          <div className="runtime-card-top">
            <span className="runtime-symbol worker-symbol" aria-hidden="true">
              Q
            </span>
            <span className="status-dot status-online" />
          </div>
          <p className="section-kicker">İŞ KUYRUĞU</p>
          <h2>
            {operations?.worker.state === "HEALTHY"
              ? "İşler normal ilerliyor"
              : "İşler gecikiyor"}
          </h2>
          <dl>
            <div>
              <dt>Bekleyen</dt>
              <dd>{operations?.worker.queueDepth ?? "Bilinmiyor"} iş</dd>
            </div>
            <div>
              <dt>En eski</dt>
              <dd>{operations?.worker.oldestJobMinutes ?? "Bilinmiyor"} dk</dd>
            </div>
            <div>
              <dt>Tarama</dt>
              <dd>
                {snapshot.automation.ingestionPaused
                  ? "Duraklatıldı"
                  : `${snapshot.automation.scanIntervalMinutes} dakikada bir`}
              </dd>
            </div>
          </dl>
        </article>

        <article className="runtime-card">
          <div className="runtime-card-top">
            <span className="runtime-symbol publish-symbol" aria-hidden="true">
              P
            </span>
            <span
              className={`status-dot ${
                snapshot.automation.publishingPaused
                  ? "status-degraded"
                  : "status-online"
              }`}
            />
          </div>
          <p className="section-kicker">{siteMode === "PUBLISH" ? "YAYINCI" : "YEREL ÇIKTI"}</p>
          <h2>
            {siteMode === "PUBLISH"
              ? (snapshot.automation.publishingPaused ? "Yayın duraklatıldı" : "Onaylı yayın hazır")
              : "Onaylı çıktı hazır"}
          </h2>
          <dl>
            <div>
              <dt>{siteMode === "PUBLISH" ? "Yayın bekleyenleri" : "Çıktı bekleyenleri"}</dt>
              <dd>{operations?.publisher.outboxPending ?? "Bilinmiyor"} bekleyen</dd>
            </div>
            <div>
              <dt>{siteMode === "PUBLISH" ? "Mutabakat" : "Son işlem"}</dt>
              <dd>
                {operations?.publisher.lastReconciledAt
                  ? new Intl.DateTimeFormat("tr-TR", {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "Europe/Istanbul"
                    }).format(new Date(operations.publisher.lastReconciledAt))
                  : "Bilinmiyor"}{" "}
                · eşleşiyor
              </dd>
            </div>
            <div>
              <dt>Sınır</dt>
              <dd>{siteMode === "PUBLISH" ? "Yalnızca onaylı hash" : "Yalnızca onaylı paket"}</dd>
            </div>
          </dl>
        </article>
      </section>

      <div className="operations-layout">
        <section className="content-panel schedule-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">YAYIN TAKVİMİ</p>
              <h2>Sıradaki içerikler</h2>
            </div>
            <span className="count-label">Europe/Istanbul</span>
          </div>
          <div className="day-strip">
            {operationWeek.map(([day, date, value]) => (
              <button
                type="button"
                className={selectedDate === value ? "is-selected" : ""}
                key={`${day}-${date}`}
                aria-pressed={selectedDate === value}
                onClick={() => setSelectedDate(value)}
              >
                <span>{day}</span>
                <strong>{date}</strong>
                {operations?.schedule.some(
                  (item) => scheduleDateKey(item.at) === value
                ) ? <i aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          <div className="schedule-list">
            {operations?.schedule
              .filter((item) => scheduleDateKey(item.at) === selectedDate)
              .map((item) => {
              const time = new Intl.DateTimeFormat("tr-TR", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Europe/Istanbul"
              }).format(new Date(item.at));
              return (
                <div className="schedule-row" key={item.id}>
                  <time>{time}</time>
                  <span className={`schedule-marker state-${item.state.toLowerCase()}`} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.section}</small>
                  </span>
                  <em className={`schedule-state state-${item.state.toLowerCase()}`}>
                    {item.state === "APPROVED"
                      ? "Onaylı"
                      : item.state === "SCHEDULED"
                        ? "Planlandı"
                        : "Engelli"}
                  </em>
                </div>
              );
            })}
            {!operations ? (
              <div className="empty-state">Takvim yükleniyor…</div>
            ) : operations.schedule.every(
                (item) => scheduleDateKey(item.at) !== selectedDate
              ) ? (
              <div className="empty-state">Bu gün için planlanmış içerik yok.</div>
            ) : null}
          </div>
        </section>

        <section className="content-panel operation-log">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">OPERASYON GÜNLÜĞÜ</p>
              <h2>Son hareketler</h2>
            </div>
            <button
              className="text-button"
              type="button"
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen((current) => !current)}
            >
              {diagnosticsOpen ? "Tanılamayı kapat" : "Tanılama özeti"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={diagnosticExportBusy}
              onClick={() => void exportDiagnostics()}
            >
              {diagnosticExportBusy ? "Paket hazırlanıyor…" : "Tanılama paketi oluştur"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={busyTarget === "logs"}
              onClick={() => void refreshOperations()}
            >
              {busyTarget === "logs" ? "Yenileniyor…" : "Günlüğü yenile"}
            </button>
          </div>
          {diagnosticsOpen ? (
            <div className="diagnostic-summary" role="region" aria-label="Tanılama özeti">
              <dl>
                <div><dt>Çalışma modu</dt><dd>{snapshot.runtime}</dd></div>
                <div>
                    <dt>Yerel sistem / bağlantı</dt>
                  <dd>
                    {snapshot.connection.engineRunning ? "çalışıyor" : "kapalı"} /{" "}
                    {snapshot.connection.bridgeReady ? "doğrulandı" : "doğrulanmadı"}
                  </dd>
                </div>
                <div><dt>Bekleyen işler</dt><dd>{operations?.worker.queueDepth ?? 0} bekleyen · en eski {operations?.worker.oldestJobMinutes ?? 0} dk</dd></div>
                <div><dt>Yayın bekleyenleri</dt><dd>{operations?.publisher.outboxPending ?? 0} bekleyen</dd></div>
              </dl>
              <small>Bu özet sır, anahtar, kaynak metni veya kullanıcı verisi içermez.</small>
              {diagnosticExportPath ? <small className="diagnostic-export-path">Son paket: {diagnosticExportPath}</small> : null}
              <details className="engine-diagnostics">
                <summary>Engine hata günlüğü</summary>
                <small>{engineDiagnostics.path ?? "Henüz günlük oluşmadı."}</small>
                <pre>{engineDiagnostics.lines.join("\n") || "Kayıt yok."}</pre>
              </details>
              <details className="engine-diagnostics">
                <summary>Yerel proje (npm run dev) günlüğü</summary>
                <small>{localDevDiagnostics.path ?? "Yerel proje henüz başlatılmadı."}</small>
                <pre>{localDevDiagnostics.lines.join("\n") || "Kayıt yok."}</pre>
              </details>
            </div>
          ) : null}
          <div className="log-toolbar" aria-label="Günlük filtresi">
            <span>Filtre</span>
            {(["all", "errors", "changes", "debug"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className={logFilter === filter ? "is-active" : ""}
                aria-pressed={logFilter === filter}
                onClick={() => setLogFilter(filter)}
              >
                {filter === "all" ? "Tümü" : filter === "errors" ? "Hatalar" : filter === "changes" ? "Değişiklikler" : "Debug"}
              </button>
            ))}
            <small>{visibleEvents.length} kayıt</small>
          </div>
          <div className="event-list" aria-live="polite">
            {visibleEvents.map((event) => (
              <div className="event-row" key={event.id}>
                <time>{event.at}</time>
                <span className={`event-marker state-${event.state.toLowerCase()}`} />
                <span>
                  <strong>{event.title}</strong>
                  <small className={`log-level log-level-${(event.level ?? "INFO").toLowerCase()}`}>
                    {event.level === "ERROR" ? "Hata" : event.level === "WARN" ? "Uyarı" : event.level === "DEBUG" ? "Tanılama" : "Bilgi"}
                  </small>
                  <details className="event-technical-detail">
                    <summary>Teknik ayrıntı</summary>
                    <small>{event.detail}</small>
                    <code>{event.correlationId}</code>
                  </details>
                </span>
                <em className={`event-state state-${event.state.toLowerCase()}`}>
                  {eventStateLabel[event.state]}
                </em>
              </div>
            ))}
            {!operations ? (
              <div className="empty-state">Operasyon günlüğü yükleniyor…</div>
            ) : visibleEvents.length === 0 ? (
              <div className="empty-state">Bu filtrede henüz kayıt yok.</div>
            ) : null}
          </div>
        </section>
      </div>

      <footer className="safety-footer">
        <div>
          <span className="integrity-icon" aria-hidden="true">⌁</span>
          <span>
            <strong>Görev ayrılığı etkin</strong>
                    Kaynak alma, yazı üretimi, yayın ve yerel veri bileşenleri ayrı yetki
            sınırlarında çalışıyor.
          </span>
        </div>
        <span>Ücretli ek hizmetler: <strong>KAPALI</strong></span>
      </footer>
    </div>
  );
}
