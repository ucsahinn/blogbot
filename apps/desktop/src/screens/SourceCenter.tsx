import { useEffect, useMemo, useState } from "react";

import { parseOpmlSources, parseUrlSources } from "../app-model.ts";
import type { BlogbotBridge } from "../bridge.ts";
import type {
  ArticleType,
  Section,
  SourceInput,
  SourceRecord,
  SourceTestResult
} from "../types.ts";

interface SourceCenterProps {
  bridge: BlogbotBridge;
  canTest: boolean;
  canSave: boolean;
  canScan: boolean;
  embedded?: boolean;
}

type InputMode = "single" | "bulk" | "opml";

interface Candidate extends SourceInput {
  test?: SourceTestResult;
  testing: boolean;
}

const sectionLabels: Record<Section, string> = {
  haberler: "Haberler",
  analiz: "Analiz",
  dosyalar: "Dosyalar",
  rehberler: "Rehberler"
};

const typeLabels: Record<ArticleType, string> = {
  news: "Haber",
  analysis: "Analiz",
  deep_dive: "Derin dosya",
  guide: "Rehber"
};

const languageLabels: Record<SourceRecord["language"], string> = {
  tr: "Türkçe",
  en: "İngilizce",
  other: "Diğer dil",
  unknown: "Dil belirlenmedi"
};

const reviewStatusLabels: Record<
  SourceRecord["trustStatus"] | SourceRecord["rightsStatus"],
  string
> = {
  PENDING: "Bekliyor",
  APPROVED: "Onaylı",
  REJECTED: "Reddedildi"
};

const healthLabels: Record<SourceRecord["health"], string> = {
  HEALTHY: "Tarama sağlıklı",
  WARNING: "Tarama uyarısı",
  TESTING: "Tarama test ediliyor",
  DISABLED: "Tarama kapalı"
};

const blockerLabels: Record<string, string> = {
  TRUST_REVIEW_REQUIRED: "Kaynak güven incelemesi bekliyor.",
  RIGHTS_REVIEW_REQUIRED: "Kullanım hakkı incelemesi bekliyor.",
  SOURCE_DISABLED: "Kaynak devre dışı.",
  SOURCE_UNREACHABLE: "Kaynağa erişilemiyor."
};

function sourceBlockerText(blockers: readonly string[]): string {
  return blockers
    .map(
      (blocker) =>
        blockerLabels[blocker] ?? "Yayın politikası incelemesi gerekiyor."
    )
    .join(" ");
}

function relativeCheck(value: string | null): string {
  if (!value) return "Henüz kontrol edilmedi";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "Az önce";
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(new Date(value));
}

export function SourceCenter({
  bridge,
  canTest,
  canSave,
  canScan,
  embedded = false
}: SourceCenterProps) {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [inputMode, setInputMode] = useState<InputMode>("single");
  const [input, setInput] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scanningId, setScanningId] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    void bridge
      .listSources()
      .then((result) => {
        if (alive) {
          setSources(result.sources);
        }
      })
      .catch((reason) => {
        if (alive) {
          setNotice(
            reason instanceof Error ? reason.message : "Kaynak envanteri yüklenemedi."
          );
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const filteredSources = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("tr");
    if (!normalized) {
      return sources;
    }
    return sources.filter(
      (source) =>
        source.name.toLocaleLowerCase("tr").includes(normalized) ||
        source.url.toLocaleLowerCase("tr").includes(normalized)
    );
  }, [query, sources]);

  const refreshSources = async () => {
    const result = await bridge.listSources();
    setSources(result.sources);
  };

  const scan = async (sourceId?: string) => {
    if (!canScan) {
      setNotice(
        "Kaynak tarama bileşeni henüz hazır değil. Kurulum Merkezi'nde Önkoşul testi çalıştırdıktan sonra yeniden deneyin."
      );
      return;
    }
    setScanningId(sourceId ?? "all");
    setNotice("");
    try {
      const result = sourceId
        ? await bridge.scanSource(sourceId)
        : await bridge.scanAllSources();
      if (!result.accepted) {
        setNotice(result.detail);
        return;
      }
      setNotice(result.detail);
      let lastStatus = await bridge.getSourceScanStatus(result.operationId);
      for (let attempt = 0; attempt < 20 && !lastStatus.complete; attempt += 1) {
        setNotice(lastStatus.detail);
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        lastStatus = await bridge.getSourceScanStatus(result.operationId);
      }
      setNotice(
        lastStatus.complete
          ? lastStatus.detail
          : `${lastStatus.detail} Tarama arka planda devam ediyor; kaynak kartını daha sonra yenileyebilirsiniz.`
      );
      await refreshSources();
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Kaynak taraması başlatılamadı."
      );
    } finally {
      setScanningId("");
    }
  };

  const analyzeInput = async () => {
    setBusy(true);
    setNotice("");
    try {
      let result =
        inputMode === "opml"
          ? parseOpmlSources(input)
          : parseUrlSources(input);
      if (inputMode === "opml" && /^https?:\/\//iu.test(input.trim())) {
        const preview = await bridge.previewOpml(input.trim());
        result = { accepted: preview.urls, rejected: [] };
      }
      setRejected(result.rejected);
      setCandidates(
        result.accepted.map((url) => ({
          url,
          section: "haberler",
          articleType: "news",
          testing: false
        }))
      );
      if (result.accepted.length === 0) {
        setNotice("Eklenebilir bir kaynak bulunamadı.");
      }
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Kaynaklar çözümlenemedi."
      );
    } finally {
      setBusy(false);
    }
  };

  const testCandidate = async (index: number) => {
    const candidate = candidates[index];
    if (!candidate) {
      return;
    }
    setCandidates((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, testing: true } : item
      )
    );
    try {
      const test = await bridge.testSource(candidate.url);
      setCandidates((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                test,
                testing: false,
                kind: test.kind,
                language: item.language ?? "unknown",
                title: test.title
              }
            : item
        )
      );
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Kaynak testi tamamlanamadı."
      );
      setCandidates((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index ? { ...item, testing: false } : item
        )
      );
    }
  };

  const saveCandidates = async () => {
    setBusy(true);
    setNotice("");
    try {
      const result = await bridge.saveSources(
        candidates.map(
          ({ url, section, articleType, kind, language, title, version }) => ({
          url,
          section,
          articleType,
          ...(kind ? { kind } : {}),
          ...(language ? { language } : {}),
          ...(title ? { title } : {}),
          ...(version !== undefined ? { version } : {})
        }))
      );
      setSources((current) => [...result.sources, ...current]);
      setNotice(`${result.sources.length} kaynak izlemeye alındı.`);
      setCandidates([]);
      setInput("");
      setRejected([]);
    } catch (reason) {
      try {
        const current = await bridge.listSources();
        setSources(current.sources);
      } catch {
        // Keep the last known catalog when recovery refresh is unavailable.
      }
      setNotice(
        `${
          reason instanceof Error ? reason.message : "Kaynaklar kaydedilemedi."
        } Katalog olası kısmi kayıtları göstermek için yenilendi.`
      );
    } finally {
      setBusy(false);
    }
  };

  const updateCandidate = (
    index: number,
    field: "section" | "articleType",
    value: string
  ) => {
    setCandidates((current) =>
      current.map((candidate, itemIndex) =>
        itemIndex === index
          ? {
              ...candidate,
              [field]: value
            }
          : candidate
      )
    );
  };

  return (
    <div className={embedded ? "embedded-page source-page" : "page source-page"}>
      <header className="page-header">
        <div>
          <p className="section-kicker">AKILLI KAYNAK MERKEZİ</p>
          <h1>Kanıt akışını tek yerden yönetin.</h1>
          <p>
            RSS, Atom, sitemap, site ve tekil makaleleri aynı girişten
            tanımlar. Ön yüz hiçbir adresi doğrudan çağırmaz; test ve keşif
            güvenli yerel çalışma bileşeni sınırında yapılır.
          </p>
        </div>
        <span className="header-stat">
          <strong>{sources.length}</strong>
          <small>aktif kaynak</small>
        </span>
      </header>

      <section className="source-composer content-panel">
        <div className="composer-sidebar">
          <p className="section-kicker">YENİ KAYNAK</p>
          <h2>Adresleri bırakın, türünü Blogbot bulsun.</h2>
          <p>
            Uygulama düzeyinde kaynak sınırı yoktur. Yerel çalışma kapasitesi ve yayın
            politikası ayrı olarak izlenir.
          </p>
          <div className="detection-legend">
            {["RSS", "ATOM", "SITEMAP", "SITE", "ARTICLE"].map((kind) => (
              <span key={kind}>{kind}</span>
            ))}
          </div>
        </div>
        <div className="composer-main">
          <div className="segmented-control" role="tablist" aria-label="Kaynak giriş türü">
            {[
              { id: "single" as const, label: "Tek URL" },
              { id: "bulk" as const, label: "Toplu URL" },
              { id: "opml" as const, label: "OPML" }
            ].map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="tab"
                aria-selected={inputMode === mode.id}
                className={inputMode === mode.id ? "is-selected" : ""}
                onClick={() => {
                  setInputMode(mode.id);
                  setCandidates([]);
                  setRejected([]);
                  setNotice("");
                }}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <label className="field field-wide source-input">
            <span>
              {inputMode === "single"
                ? "Kaynak adresi"
                : inputMode === "bulk"
                  ? "Her satıra bir adres"
                  : "OPML adresi veya XML içeriği"}
            </span>
            <textarea
              rows={inputMode === "single" ? 2 : 6}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                inputMode === "single"
                  ? "https://example.com/security"
                  : inputMode === "bulk"
                    ? "https://example.com/feed.xml\nhttps://example.org/sitemap.xml\nhttps://example.net/article"
                    : "https://example.com/sources.opml veya <opml>…</opml>"
              }
              spellCheck={false}
            />
          </label>
          <div className="composer-actions">
            <span>
              Site adresleri RSS/Atom ipuçları için otomatik taranır. Özel ağ
              adresleri reddedilir.
            </span>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || !canTest || input.trim().length === 0}
              onClick={() => void analyzeInput()}
            >
              {busy ? "Çözümleniyor…" : "Kaynakları çözümle"}
            </button>
          </div>
        </div>
      </section>

      {notice ? <div className="inline-notice" role="status">{notice}</div> : null}
      {rejected.length > 0 ? (
        <div className="inline-notice is-warning" role="alert">
          <strong>{rejected.length} adres güvenlik veya biçim kontrolünden geçmedi.</strong>
          <span>{rejected.slice(0, 3).join(" · ")}</span>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <section className="candidate-panel content-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">EŞLEME ÖNİZLEMESİ</p>
              <h2>{candidates.length} kaynak eklenmeye hazır</h2>
            </div>
            <button
              className="button button-primary"
              type="button"
              disabled={busy || !canSave}
              onClick={() => void saveCandidates()}
            >
              Tümünü izlemeye al
            </button>
          </div>
          <div className="candidate-list">
            {candidates.map((candidate, index) => (
              <div className="candidate-row" key={`${candidate.url}-${index}`}>
                <div className="candidate-identity">
                  <span
                    className={`source-kind kind-${candidate.test?.kind.toLowerCase() ?? "unknown"}`}
                  >
                    {candidate.test?.kind ?? "AUTO"}
                  </span>
                  <span>
                    <strong>{candidate.test?.title ?? new URL(candidate.url).hostname}</strong>
                    <small>{candidate.url}</small>
                    {candidate.test ? (
                      <em>{candidate.test.recommendation}</em>
                    ) : null}
                  </span>
                </div>
                <label className="compact-field">
                  <span>Bölüm</span>
                  <select
                    value={candidate.section}
                    onChange={(event) =>
                      updateCandidate(index, "section", event.target.value)
                    }
                  >
                    {Object.entries(sectionLabels).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compact-field">
                  <span>İçerik türü</span>
                  <select
                    value={candidate.articleType}
                    onChange={(event) =>
                      updateCandidate(index, "articleType", event.target.value)
                    }
                  >
                    {Object.entries(typeLabels).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={candidate.testing || !canTest}
                  onClick={() => void testCandidate(index)}
                >
                  {candidate.testing
                    ? "Test ediliyor…"
                    : candidate.test
                      ? "Yeniden test et"
                      : "Test et"}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="page-section">
        <div className="section-heading source-list-heading">
          <div>
            <p className="section-kicker">İZLENEN KAYNAKLAR</p>
            <h2>Kaynak envanteri</h2>
          </div>
          <div className="source-list-actions">
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Kaynak veya adres ara"
                aria-label="Kaynak ara"
              />
            </label>
            <button
              className="button button-secondary"
              type="button"
              disabled={!canScan || scanningId.length > 0 || sources.length === 0}
              aria-describedby={!canScan ? "source-scan-unavailable" : undefined}
              title={
                canScan
                  ? "Etkin kaynakların tümünü yerel kuyruğa al"
                  : "Kaynak tarama bileşeni bu sürümde kullanılamıyor"
              }
              onClick={() => void scan()}
            >
              {scanningId === "all" ? "Taranıyor…" : "Tümünü tara"}
            </button>
          </div>
        </div>
        {!canScan ? (
          <p
            className="source-capability-note"
            id="source-scan-unavailable"
            role="note"
          >
            <strong>Kaynak taraması şu anda hazır değil.</strong> Kaynakları test
            edebilir ve kaydedebilirsiniz; “Şimdi tara” işlemi yerel kaynak
            tarama bileşeni hazır olduğunda açılır. Kurulum Merkezi'nden
            bileşen durumunu yeniden test edebilirsiniz.
          </p>
        ) : null}
        <details className="optional-controls source-policy-details">
          <summary>Kaynak güvenliği ve yayın izni <span>Teknik erişim, güven ve kullanım hakkı ayrı değerlendirilir</span></summary>
          <p className="source-policy-explainer" role="note">
            <strong>Tarama sağlığı yayın izni değildir.</strong> “Sağlıklı”,
            kaynağa teknik olarak erişilebildiğini gösterir. İçerik ancak kaynak
            güveni ve kullanım hakkı ayrı ayrı onaylandığında yayında kullanılabilir.
          </p>
        </details>
        <div className="source-list content-panel">
          <div className="source-list-labels" aria-hidden="true">
            <span>Kaynak</span>
            <span>Tür</span>
            <span>Site eşlemesi</span>
            <span>Son kontrol</span>
            <span>Teknik ve yayın durumu</span>
          </div>
          {loading ? (
            <div className="empty-state">Kaynak envanteri yükleniyor…</div>
          ) : filteredSources.length === 0 ? (
            <div className="empty-state">
              <strong>Eşleşen kaynak yok.</strong>
              Arama ifadesini değiştirin veya yeni bir adres ekleyin.
            </div>
          ) : (
            filteredSources.map((source) => (
              <div className="source-row" key={source.id}>
                <span className="source-name">
                  <span className="source-favicon" aria-hidden="true">
                    {source.name.slice(0, 1)}
                  </span>
                  <span>
                    <strong>{source.name}</strong>
                    <small>{source.url}</small>
                    <span
                      className="source-record-meta"
                      aria-label={`Sürüm ${source.version}; dil ${languageLabels[source.language]}`}
                    >
                      <span>v{source.version}</span>
                      <span>{languageLabels[source.language]}</span>
                    </span>
                    <span className="source-policy-statuses">
                      <span
                        className={`source-policy-pill is-${source.trustStatus.toLowerCase()}`}
                      >
                        Güven: {reviewStatusLabels[source.trustStatus]}
                      </span>
                      <span
                        className={`source-policy-pill is-${source.rightsStatus.toLowerCase()}`}
                      >
                        Kullanım hakkı: {reviewStatusLabels[source.rightsStatus]}
                      </span>
                    </span>
                    {!source.canPublish && source.blockers.length > 0 ? (
                      <em className="source-blockers">
                        {sourceBlockerText(source.blockers)}
                      </em>
                    ) : null}
                  </span>
                </span>
                <span>
                  <span className={`source-kind kind-${source.kind.toLowerCase()}`}>
                    {source.kind}
                  </span>
                </span>
                <span className="mapping-value">
                  <strong>{sectionLabels[source.section]}</strong>
                  <small>{typeLabels[source.articleType]}</small>
                </span>
                <span className="last-check">
                  <strong>{relativeCheck(source.lastCheckedAt)}</strong>
                  <small>
                    {source.lastItemAt ? "Yeni içerik bulundu" : "Değişiklik yok"}
                  </small>
                </span>
                <span className="health-cell">
                  <span className="source-health-summary">
                    <span>
                      <span
                        className={`status-dot ${
                          source.health === "HEALTHY"
                            ? "status-online"
                            : "status-degraded"
                        }`}
                        aria-hidden="true"
                      />
                      {healthLabels[source.health]}
                    </span>
                    <strong className={source.canPublish ? "can-publish" : "cannot-publish"}>
                      {source.canPublish
                        ? "Yayında kullanılabilir"
                        : "Yayın onayı bekliyor"}
                    </strong>
                  </span>
                  <span className="source-row-actions">
                    <button
                      className="button button-quiet"
                      type="button"
                      disabled={!canScan || scanningId.length > 0}
                      aria-describedby={!canScan ? "source-scan-unavailable" : undefined}
                      title={
                        canScan
                          ? `${source.name} kaynağını şimdi tara`
                          : "Kaynak tarama bileşeni bu sürümde kullanılamıyor"
                      }
                      onClick={() => void scan(source.id)}
                    >
                      {scanningId === source.id ? "Taranıyor…" : "Şimdi tara"}
                    </button>
                    <button
                      className="row-menu"
                      type="button"
                      aria-label={`${source.name} kaynak ayrıntılarını göster`}
                      onClick={() =>
                        setNotice(
                          `${source.name}: ${source.url} · ${sectionLabels[source.section]} / ${typeLabels[source.articleType]} · ${source.canPublish ? "yayında kullanılabilir" : sourceBlockerText(source.blockers)}`
                        )
                      }
                    >
                      ···
                    </button>
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
