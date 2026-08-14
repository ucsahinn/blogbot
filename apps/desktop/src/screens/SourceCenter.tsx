import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseOpmlSources, parseUrlSources, sectionArticleType } from "../app-model.ts";
import { userFacingBridgeError, type BlogbotBridge } from "../bridge.ts";
import { describeSourcePublicationReadiness } from "../source-publication-readiness.ts";
import type {
  ArticleType,
  Section,
  SourceInput,
  SourceRecord,
  SourceScanStatus,
  SourceTestResult
} from "../types.ts";

interface SourceCenterProps {
  bridge: BlogbotBridge;
  canTest: boolean;
  canSave: boolean;
  canScan: boolean;
  onSourceCatalogChange?: () => Promise<void>;
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
  rehberler: "Rehberler",
  teknoloji: "Teknoloji",
  ekonomi: "Ekonomi ve iş",
  kultur: "Kültür",
  yasam: "Yaşam"
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
  PENDING: "İnceleme yapılmadı",
  APPROVED: "Değerlendirildi",
  REJECTED: "Reddedildi"
};

const healthLabels: Record<SourceRecord["health"], string> = {
  HEALTHY: "Tarama sağlıklı",
  WARNING: "Tarama uyarısı",
  TESTING: "Tarama test ediliyor",
  DISABLED: "Tarama kapalı"
};

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
  onSourceCatalogChange,
  embedded = false
}: SourceCenterProps) {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [inputMode, setInputMode] = useState<InputMode>("single");
  const [input, setInput] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanningId, setScanningId] = useState("");
  const [scanStatus, setScanStatus] = useState<SourceScanStatus | null>(null);
  const [reviewTarget, setReviewTarget] = useState<SourceRecord | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewRationale, setReviewRationale] = useState("");
  const [reviewTrust, setReviewTrust] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [reviewRights, setReviewRights] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const latestRefreshId = useRef(0);

  useEffect(() => {
    if (!reviewTarget) return;
    window.requestAnimationFrame(() => {
      reviewHeadingRef.current?.scrollIntoView({ block: "center" });
      reviewHeadingRef.current?.focus();
    });
  }, [reviewTarget]);

  const refreshSources = useCallback(async (options: { silent?: boolean } = {}) => {
    const refreshId = latestRefreshId.current + 1;
    latestRefreshId.current = refreshId;
    setRefreshing(true);
    try {
      const result = await bridge.listSources();
      if (refreshId !== latestRefreshId.current) return;
      setSources(result.sources);
      setLastRefreshedAt(Date.now());
      if (!options.silent) setNotice("Kaynak envanteri yenilendi.");
    } catch (reason) {
      if (refreshId !== latestRefreshId.current) return;
      setNotice(userFacingBridgeError(reason, "Kaynak envanteri yenilenemedi."));
    } finally {
      if (refreshId === latestRefreshId.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [bridge]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshSources({ silent: true }), 0);
    return () => {
      window.clearTimeout(initialRefresh);
    };
  }, [refreshSources]);

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

  const addressCheckUnavailableReason = busy
    ? "Adres kontrolü sürüyor; sonuç gelene kadar bekleyin."
    : !canTest
      ? "Yerel engine hazır olmadığı için adres kontrolü şu anda başlatılamaz."
      : input.trim().length === 0
        ? "Önce kontrol etmek istediğiniz herkese açık kaynak adresini girin."
        : "";

  const scan = async (sourceId?: string) => {
    if (!canScan) {
      setNotice(
        "Kaynak tarama bileşeni henüz hazır değil. Kurulum Merkezi'nde Önkoşul testi çalıştırdıktan sonra yeniden deneyin."
      );
      return;
    }
    setScanningId(sourceId ?? "all");
    setScanStatus(null);
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
      try {
        let lastStatus = await bridge.getSourceScanStatus(result.operationId);
        setScanStatus(lastStatus);
        for (let attempt = 0; attempt < 20 && !lastStatus.complete; attempt += 1) {
          setNotice(lastStatus.detail);
          await new Promise((resolve) => window.setTimeout(resolve, 750));
          lastStatus = await bridge.getSourceScanStatus(result.operationId);
          setScanStatus(lastStatus);
        }
        setNotice(
          lastStatus.complete
            ? lastStatus.detail
            : `${lastStatus.detail} Tarama arka planda devam ediyor; kaynak kartını daha sonra yenileyebilirsiniz.`
        );
        await refreshSources({ silent: true });
        if (lastStatus.complete) {
          try {
            await onSourceCatalogChange?.();
          } catch {
            setNotice(`${lastStatus.detail} Genel Bakış sayaçları henüz yenilenemedi; Genel Bakış ekranından yeniden deneyin.`);
          }
        }
      } catch (reason) {
        setNotice(
          `Tarama yerel kuyruğa alındı; ancak durumu henüz okunamadı. Sonraki adım: Kaynak envanterini veya Operasyonlar ekranını yenileyin. (${userFacingBridgeError(reason, "Ayrıntı alınamadı.")})`
        );
      }
    } catch (reason) {
      setNotice(
        userFacingBridgeError(reason, "Kaynak taraması başlatılamadı.")
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
      const nextCandidates: Candidate[] = result.accepted.map((url) => ({
          url,
          section: "haberler",
          articleType: "news",
          testing: false
        }));
      setCandidates(nextCandidates);

      // The singular action is deliberately named "Adresi kontrol et". Do
      // the real, bounded technical check here so its result matches the
      // user's expectation before the source can be saved. Bulk and OPML
      // inputs remain an explicit preview to avoid an unexpected fan-out of
      // external source requests.
      if (inputMode === "single" && nextCandidates.length === 1 && canTest) {
        const [candidate] = nextCandidates;
        if (candidate) {
          setCandidates([{ ...candidate, testing: true }]);
          try {
            const test = await bridge.testSource(candidate.url);
            setCandidates([{
              ...candidate,
              testing: false,
              test,
              kind: test.kind,
              language: "unknown",
              title: test.title
            }]);
          } catch (reason) {
            setCandidates([{ ...candidate, testing: false }]);
            setNotice(userFacingBridgeError(reason, "Kaynak teknik olarak doğrulanamadı. Yeniden deneyin veya kaydetmeden önce aday satırındaki ‘Test et’ düğmesini kullanın."));
          }
        }
      }
      if (result.accepted.length === 0) {
        setNotice("Eklenebilir bir kaynak bulunamadı.");
      }
    } catch (reason) {
      setNotice(
        userFacingBridgeError(reason, "Kaynaklar çözümlenemedi.")
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
        userFacingBridgeError(reason, "Kaynak testi tamamlanamadı.")
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
      setSources((current) => {
        const savedById = new Map(result.sources.map((source) => [source.id, source]));
        const saved = Array.from(savedById.values());
        return [...saved, ...current.filter((source) => !savedById.has(source.id))];
      });
      let summaryRefreshNotice = "";
      try {
        await onSourceCatalogChange?.();
      } catch {
        summaryRefreshNotice = " Genel Bakış sayaçları henüz yenilenemedi; Genel Bakış ekranından yeniden deneyin.";
      }
      setNotice(`${result.sources.length} kaynak izlemeye alındı.${summaryRefreshNotice}`);
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
          userFacingBridgeError(reason, "Kaynaklar kaydedilemedi.")
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
          ? field === "section"
            ? {
                ...candidate,
                section: value as Section,
                articleType: sectionArticleType(value as Section)
              }
            : {
                ...candidate,
                articleType: value as ArticleType
              }
          : candidate
      )
    );
  };

  const openReview = (source: SourceRecord) => {
    setReviewTarget(source);
    setReviewTrust(source.trustStatus === "REJECTED" ? "REJECTED" : "APPROVED");
    setReviewRights(source.rightsStatus === "REJECTED" ? "REJECTED" : "APPROVED");
    setReviewRationale(source.trustReview?.rationale ?? source.rightsReview?.rationale ?? "");
    setNotice("");
  };

  const saveReview = async () => {
    if (!reviewTarget) return;
    setReviewBusy(true);
    setNotice("");
    try {
      await bridge.reviewSource({
        sourceId: reviewTarget.id,
        expectedVersion: reviewTarget.version,
        trustStatus: reviewTrust,
        rightsStatus: reviewRights,
        rationale: reviewRationale
      });
      setReviewTarget(null);
      try {
        const current = await bridge.listSources();
        setSources(current.sources);
        setLastRefreshedAt(Date.now());
        setNotice("Kaynak incelemesi yerel kayda işlendi. Bu işlem revizyon veya yayın onayı vermez.");
      } catch {
        setNotice("Kaynak incelemesi yerel kayda işlendi; envanter henüz yenilenemedi. Bu işlem revizyon veya yayın onayı vermez.");
      }
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Kaynak incelemesi kaydedilemedi."));
    } finally {
      setReviewBusy(false);
    }
  };

  return (
    <div className={embedded ? "embedded-page source-page" : "page source-page"}>
      <header className="page-header">
        <div>
          <p className="section-kicker">AKILLI KAYNAK MERKEZİ</p>
          <h1>Kanıt akışını tek yerden yönetin.</h1>
          <p>
            Genel bloglar, haber siteleri, RSS/Atom akışları, sitemap'ler ve tekil
            makaleler için tek giriş noktası. Önce adresin çalışıp çalışmadığını
            kontrol eder, sonra içerik alanına yönlendirirsiniz.
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
          <h2>Önce adresi ekleyin, sonra nereye ait olduğunu seçin.</h2>
          <p>
            “Adresi kontrol et” yalnız sitenin güvenli biçimde erişilebilir olup
            olmadığını sınar. Bu işlem yayın izni vermez ve hiçbir şey yayınlamaz.
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
              Blogbot ev/ofis ağınızdaki cihazlara bağlanmamak için yalnız herkese açık
              web adreslerini kabul eder.
            </span>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || !canTest || input.trim().length === 0}
              aria-describedby={addressCheckUnavailableReason ? "source-address-action-reason" : undefined}
              onClick={() => void analyzeInput()}
            >
              {busy ? "Adres kontrol ediliyor…" : "Adresi kontrol et"}
            </button>
          </div>
          {addressCheckUnavailableReason ? (
            <small id="source-address-action-reason" className="action-unavailable-reason">
              {addressCheckUnavailableReason}
            </small>
          ) : null}
        </div>
      </section>

      <section className="source-workflow-guide" role="region" aria-label="Kaynak ekleme adımları">
        <div>
          <span aria-hidden="true">1</span>
          <strong>Kaynak ekle</strong>
          <p>Site, RSS, Atom, sitemap veya OPML adresini ekleyin.</p>
        </div>
        <div>
          <span aria-hidden="true">2</span>
          <strong>Tara</strong>
          <p>Blogbot erişimi kontrol eder ve bulunan başlıkları listeler.</p>
        </div>
        <div>
          <span aria-hidden="true">3</span>
          <strong>Taslak hazırla</strong>
          <p>Beğendiğiniz başlık için yerel araştırma ve taslak işi başlatın.</p>
        </div>
        <div>
          <span aria-hidden="true">4</span>
          <strong>İncele ve onayla</strong>
          <p>Yayın yalnızca hazır taslağı inceledikten sonra başlar.</p>
        </div>
      </section>

      {notice ? <div className="inline-notice" role="status">{notice}</div> : null}
      {scanStatus ? (() => {
        const total = Math.max(
          1,
          scanStatus.queued + scanStatus.running + scanStatus.succeeded + scanStatus.failed + scanStatus.rejected
        );
        const completed = scanStatus.succeeded + scanStatus.failed + scanStatus.rejected;
        return (
          <section className="source-scan-progress" aria-label="Kaynak tarama durumu">
            <div>
              <strong>{scanStatus.complete ? "Tarama tamamlandı" : "Tarama sürüyor"}</strong>
              <span>{scanStatus.succeeded} başarılı · {scanStatus.failed} hata · {scanStatus.rejected} reddedildi · {scanStatus.queued + scanStatus.running} bekliyor</span>
            </div>
            <div
              className="source-scan-progress-track"
              role="progressbar"
              aria-label="Kaynak tarama ilerlemesi"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={completed}
              aria-valuetext={`${completed} / ${total} kaynak işlendi`}
            >
              <span style={{ width: `${(completed / total) * 100}%` }} />
            </div>
          </section>
        );
      })() : null}
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
            <span className="source-refresh-state" role="status" aria-live="polite">
              {refreshing ? "Envanter yenileniyor…" : lastRefreshedAt ? `Son yenileme ${relativeCheck(new Date(lastRefreshedAt).toISOString())}` : "İlk yenileme bekleniyor"}
            </span>
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
              disabled={refreshing}
              onClick={() => void refreshSources()}
            >
              {refreshing ? "Yenileniyor…" : "Yenile"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={!canScan || refreshing || scanningId.length > 0 || sources.length === 0}
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
          <summary>Kaynak güveni ve kullanım hakkı <span>Tarama, güven ve kullanım hakkı ayrı değerlendirilir</span></summary>
          <p className="source-policy-explainer" role="note">
            <strong>Tarama sağlığı makale onayı değildir.</strong> “Sağlıklı”,
            kaynağa teknik olarak erişilebildiğini gösterir. Güven ve kullanım hakkı
            değerlendirmesi yalnız kaynağın makalede kanıt olarak kullanılabilirliğini belirler.
            Makale onayı yalnız Editoryal Masa &gt; TR / EN inceleme ekranında tam revizyon için verilir.
          </p>
        </details>
        {reviewTarget ? (
          <section className="source-review-panel" role="region" aria-label={`${reviewTarget.name} kaynak incelemesi`}>
            <div>
              <p className="section-kicker">ARAŞTIRMA KULLANIM KARARI</p>
              <h3 ref={reviewHeadingRef} tabIndex={-1}>{reviewTarget.name}</h3>
              <p>Bu tek karar, kaynağın araştırmada kanıt olarak kullanılıp kullanılamayacağını belirler: güvenilir mi ve kullanım hakkı yeterli mi? Makale onayı değildir; yayın için daha sonra Editoryal Masa&apos;nda tam revizyonu onaylarsınız.</p>
            </div>
            <div className="source-review-fields">
              <label className="field">
                <span>Güven değerlendirmesi</span>
                <select value={reviewTrust} disabled={reviewBusy} onChange={(event) => setReviewTrust(event.target.value as "APPROVED" | "REJECTED")}>
                  <option value="APPROVED">Kanıt güveni yeterli</option>
                  <option value="REJECTED">Kanıt güveni reddedildi</option>
                </select>
              </label>
              <label className="field">
                <span>Kullanım hakkı değerlendirmesi</span>
                <select value={reviewRights} disabled={reviewBusy} onChange={(event) => setReviewRights(event.target.value as "APPROVED" | "REJECTED")}>
                  <option value="APPROVED">Kullanım hakkı yeterli</option>
                  <option value="REJECTED">Kullanım hakkı reddedildi</option>
                </select>
              </label>
              <label className="field field-wide">
                <span>İnceleme gerekçesi</span>
                <textarea aria-label="İnceleme gerekçesi" rows={3} value={reviewRationale} disabled={reviewBusy} onChange={(event) => setReviewRationale(event.target.value)} placeholder="Örneğin: Yayıncının koşulları ve kaynak sahipliği kontrol edildi." />
              </label>
            </div>
            <div className="source-review-actions">
              <button className="button button-secondary" type="button" disabled={reviewBusy} onClick={() => setReviewTarget(null)}>İptal</button>
              <button className="button button-primary" type="button" disabled={reviewBusy || reviewRationale.trim().length < 10} onClick={() => void saveReview()}>{reviewBusy ? "Kaydediliyor…" : "Araştırma kullanım kararını kaydet"}</button>
              <small>Bu karar hem güveni hem kullanım hakkını kaydeder. Gerekçe 10-1000 karakter olmalıdır; kaynak değişirse yeniden doğrulayın.</small>
            </div>
          </section>
        ) : null}
        <div className="source-list content-panel">
          <div className="source-list-labels" aria-hidden="true">
            <span>Kaynak</span>
            <span>Tür</span>
            <span>Site eşlemesi</span>
            <span>Son kontrol</span>
            <span>Teknik ve kanıt durumu</span>
          </div>
          {loading ? (
            <div className="empty-state" role="status" aria-live="polite" aria-busy="true">Kaynak envanteri yükleniyor…</div>
          ) : filteredSources.length === 0 ? (
            <div className="empty-state">
              <strong>Eşleşen kaynak yok.</strong>
              Arama ifadesini değiştirin veya yeni bir adres ekleyin.
            </div>
          ) : (
            filteredSources.map((source) => (
              <article className="source-row" aria-label={`${source.name} kaynak durumu`} key={source.id}>
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
                    <em className="source-blockers">{describeSourcePublicationReadiness(source).detail}</em>
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
                    <strong className={`source-readiness source-readiness-${describeSourcePublicationReadiness(source).tone}`}>
                      {describeSourcePublicationReadiness(source).label}
                    </strong>
                  </span>
                  <span className="source-row-actions">
                    <button
                      className="button button-quiet"
                      type="button"
                      disabled={!canScan || refreshing || scanningId.length > 0}
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
                    <button className="button button-quiet" type="button" disabled={reviewBusy || refreshing} onClick={() => openReview(source)}>
                      {source.trustStatus === "PENDING" || source.rightsStatus === "PENDING" ? "Araştırma kullanımını değerlendir" : "Kullanım kararını güncelle"}
                    </button>
                    <button
                      className="row-menu"
                      type="button"
                      aria-label={`${source.name} kaynak ayrıntılarını göster`}
                      onClick={() =>
                        setNotice(
                          `${source.name}: ${source.url} · ${sectionLabels[source.section]} / ${typeLabels[source.articleType]} · ${describeSourcePublicationReadiness(source).detail}`
                        )
                      }
                    >
                      ···
                    </button>
                  </span>
                </span>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
