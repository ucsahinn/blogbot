import { useEffect, useMemo, useRef, useState } from "react";

import { buildInstantCreateRequest, describeInstantDraftSubmission, parseUrlSources, sectionArticleType, sectionLabel } from "../app-model.ts";
import { userFacingBridgeError, type BlogbotBridge } from "../bridge.ts";
import type { ArticleType, EditorialWorkspaceSnapshot, InstantDraftSubmission, Section, SourceRecord } from "../types.ts";

interface InstantCreateProps {
  bridge: BlogbotBridge;
  readOnly: boolean;
  onOpenEditorial: (notice?: string, pendingDraftId?: string, pendingDraftTitle?: string) => void;
  onOpenReview: () => void;
  onWorkspaceChange: (snapshot: EditorialWorkspaceSnapshot) => void;
  embedded?: boolean;
  defaultSection?: Section;
}

const errorLabels = {
  INSTRUCTION_TOO_SHORT: "Ne üretileceğini en az 10 karakterle açıklayın.",
  SOURCE_EVIDENCE_REQUIRED: "En az bir kayıtlı kaynak veya URL ekleyin.",
  TARGET_SECTION_REQUIRED: "Site bölümünü seçin."
};

const toneLabels = {
  neutral: "Tarafsız",
  technical: "Teknik",
  accessible: "Sade"
} as const;

const lengthLabels = {
  standard: "Standart",
  deep: "Derin"
} as const;

export function InstantCreate({
  bridge,
  readOnly,
  onOpenEditorial,
  onOpenReview,
  onWorkspaceChange,
  embedded = false,
  defaultSection = "haberler"
}: InstantCreateProps) {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceLoadError, setSourceLoadError] = useState("");
  const [instruction, setInstruction] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [section, setSection] = useState<Section | "">(defaultSection);
  const [articleType, setArticleType] = useState<ArticleType>("news");
  const [urgency, setUrgency] = useState<"normal" | "urgent">("normal");
  const [tone, setTone] = useState<"neutral" | "technical" | "accessible">("neutral");
  const [length, setLength] = useState<"standard" | "deep">("standard");
  const [visualPolicy, setVisualPolicy] =
    useState<"GENERATE" | "LOCAL_RENDERER" | "NONE">("GENERATE");
  const [scheduleIntent, setScheduleIntent] =
    useState<"NEXT_SLOT" | "UNSCHEDULED">("NEXT_SLOT");
  const [submission, setSubmission] = useState<InstantDraftSubmission | null>(null);
  const [workspaceSyncError, setWorkspaceSyncError] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const sourceUrlRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    let alive = true;
    void bridge
      .listSources()
      .then((result) => {
        if (alive) setSources(result.sources);
      })
      .catch((reason) => {
        if (alive) {
          setSourceLoadError(
            userFacingBridgeError(reason, "Kaynaklar yüklenemedi.")
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const parsedUrls = useMemo(() => parseUrlSources(urlInput), [urlInput]);
  const selectedSourcesNeedingReview = useMemo(
    () => sources.filter((source) => selectedSourceIds.includes(source.id) && !source.canPublish),
    [selectedSourceIds, sources]
  );

  const toggleSource = (id: string) => {
    setSelectedSourceIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  };

  const submit = async () => {
    const result = buildInstantCreateRequest({
      instruction,
      sourceIds: selectedSourceIds,
      urls: parsedUrls.accepted,
      section,
      articleType,
      urgency,
      tone,
      length,
      visualPolicy,
      scheduleIntent
    });
    if (!result.valid) {
      setErrors(result.errors.map((error) => errorLabels[error]));
      const firstInvalid = result.errors[0];
      window.requestAnimationFrame(() => {
        if (firstInvalid === "INSTRUCTION_TOO_SHORT") instructionRef.current?.focus();
        else if (firstInvalid === "SOURCE_EVIDENCE_REQUIRED") sourceUrlRef.current?.focus();
        else sectionRef.current?.focus();
      });
      return;
    }
    setSubmitting(true);
    setErrors([]);
    setWorkspaceSyncError("");
    try {
      const created = await bridge.createInstantDraft(result.request);
      setSubmission(created);
      try {
        let nextWorkspace = await bridge.getEditorialWorkspace();
        for (let attempt = 0; attempt < 3 && !nextWorkspace.drafts.some((draft) => draft.id === created.id); attempt += 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          nextWorkspace = await bridge.getEditorialWorkspace();
        }
        if (nextWorkspace.drafts.some((draft) => draft.id === created.id)) {
          onWorkspaceChange(nextWorkspace);
        } else {
          setWorkspaceSyncError("İş güvenli yerel kuyruğa alındı ancak Editoryal Masa envanterinde henüz doğrulanamadı. Masaya gitmeden önce Taslak envanterini yenileyin; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun.");
        }
      } catch {
        setWorkspaceSyncError("İş güvenli yerel kuyruğa alındı ancak Editoryal Masa envanterinde henüz doğrulanamadı. Masaya gitmeden önce Taslak envanterini yenileyin; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun.");
      }
    } catch (reason) {
      setErrors([
        userFacingBridgeError(reason, "Taslak başlatılamadı.")
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  if (submission) {
    const feedback = describeInstantDraftSubmission(submission);
    return (
      <div className={embedded ? "embedded-page instant-success-page" : "page instant-success-page"}>
        <section className={`instant-success content-panel ${feedback.waitingForCodex ? "is-waiting" : ""}`}>
          <span className="success-emblem" aria-hidden="true">
            {feedback.waitingForCodex ? "…" : "✓"}
          </span>
          <p className="section-kicker">{feedback.kicker}</p>
          <h1>{feedback.title}</h1>
          <p>{feedback.detail}</p>
          <div className="created-job-id">
            <span>İş kimliği</span>
            <code>{submission.id}</code>
          </div>
          {workspaceSyncError ? <p className="form-message" role="status" aria-live="polite">{workspaceSyncError}</p> : null}
          <div className="success-actions">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setSubmission(null);
                setInstruction("");
              }}
            >
              Yeni iş oluştur
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => onOpenEditorial(
                "Yerel kuyruk işi kabul edildi; masa envanteri güncelleniyor. Taslak görünür olduğunda burada takip edebilirsiniz.",
                submission.id,
                instruction.trim() || "Yeni içerik araştırması"
              )}
            >
              Editoryal Masada gör
            </button>
            {feedback.waitingForCodex ? (
              <button className="button button-primary" type="button" onClick={() => { window.location.hash = "#setup"; }}>
                Yazı üretimi hesabını aç
              </button>
            ) : (
              <button className="button button-primary" type="button" onClick={onOpenReview}>
                İnceleme kuyruğunu aç
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={embedded ? "embedded-page instant-page" : "page instant-page"}>
      <header className="page-header">
        <div>
          <p className="section-kicker">AKILLI ANLIK OLUŞTUR</p>
          <h1>Niyeti anlatın; kanıt sınırını Blogbot korusun.</h1>
          <p>
            Bu akış doğrudan yayın yapmaz. Her sonuç kaynak, iddia, iki dil,
            medya ve güvenlik kontrolleriyle inceleme kuyruğuna gelir.
          </p>
        </div>
        <span className="review-only-seal">
          <span aria-hidden="true">⌁</span>
          <strong>Yalnızca inceleme</strong>
          <small>Doğrudan yayın kapalı</small>
        </span>
      </header>

      <div className="instant-layout">
        <section className="content-panel instant-form-panel">
          <div className="form-section">
            <div className="form-section-number">1</div>
            <div className="form-section-body">
              <label className="field field-wide prompt-field">
                <span>Ne oluşturmak istiyorsunuz?</span>
                <textarea
                  ref={instructionRef}
                  aria-invalid={errors.includes(errorLabels.INSTRUCTION_TOO_SHORT)}
                  aria-describedby={errors.includes(errorLabels.INSTRUCTION_TOO_SHORT) ? "instant-error-instruction" : undefined}
                  rows={6}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Örn. Seçtiğim kaynaklardaki yeni gelişmeleri karşılaştır, doğrulanabilir iddiaları kaynaklarıyla çıkar ve özgün bir analiz taslağı hazırla."
                />
              </label>
              <div className="prompt-suggestions">
                <span>Hızlı başlangıç</span>
                {[
                  "Son gelişmeyi 5N1K ile haberleştir",
                  "Teknik konuyu karar vericiler için analiz et",
                  "Adım adım uygulama rehberi hazırla"
                ].map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => setInstruction(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-number">2</div>
            <div className="form-section-body">
              <div className="field-heading">
                <span>Kanıt kaynaklarını seçin</span>
                <small>
                  Kayıtlı kaynak ve tekil URL birlikte kullanılabilir.
                </small>
              </div>
              <div className="source-picker">
                <label className="search-field source-picker-search">
                  <span className="sr-only">Kayıtlı kaynaklarda ara</span>
                  <input
                    type="search"
                    value={sourceQuery}
                    onChange={(event) => setSourceQuery(event.target.value)}
                    placeholder={`${sources.length} kayıtlı kaynakta ara`}
                  />
                </label>
                {sources
                  .filter((source) =>
                    `${source.name} ${source.url}`
                      .toLocaleLowerCase("tr-TR")
                      .includes(sourceQuery.trim().toLocaleLowerCase("tr-TR"))
                  )
                  .map((source) => (
                  <label
                    className={`source-option ${!source.canPublish ? "needs-review" : "is-ready"} ${
                      selectedSourceIds.includes(source.id) ? "is-selected" : ""
                    }`}
                    key={source.id}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSourceIds.includes(source.id)}
                      disabled={source.trustStatus === "REJECTED" || source.rightsStatus === "REJECTED"}
                      onChange={() => toggleSource(source.id)}
                    />
                    <span className="source-favicon" aria-hidden="true">
                      {source.name.slice(0, 1)}
                    </span>
                    <span>
                      <strong>{source.name}</strong>
                      <small>
                        {source.kind} · {source.section}
                      </small>
                      <small className={`source-evidence-state ${source.canPublish ? "is-ready" : "needs-review"}`}>
                        {source.canPublish
                          ? "Yayın kanıtına uygun"
                          : source.trustStatus === "REJECTED" || source.rightsStatus === "REJECTED"
                            ? "Yayın kanıtı olarak kullanılamaz"
                            : "Değerlendirme bekliyor; araştırmada kullanılabilir"}
                      </small>
                    </span>
                    <span className="option-check" aria-hidden="true">
                      ✓
                    </span>
                  </label>
                  ))}
                {selectedSourcesNeedingReview.length > 0 ? (
                  <p className="inline-notice source-selection-note" role="note">
                    Seçtiğiniz {selectedSourcesNeedingReview.length} kaynak yayın kanıtı olmadan önce değerlendirilmelidir. Blogbot bu kaynakları araştırma ipucu olarak kullanabilir; kalite kapıları tamamlanmadan içerik onaylanamaz.
                  </p>
                ) : null}
                {!sources.length && !sourceLoadError ? (
                  <div className="empty-state">
                    <strong>Henüz kayıtlı kaynak yok.</strong>
                    <span>Doğrudan URL ekleyebilir veya Kaynaklar bölümünden yeni kaynak kaydedebilirsiniz.</span>
                  </div>
                ) : null}
                {sourceLoadError ? <p className="form-message" role="alert">{sourceLoadError}</p> : null}
              </div>
              <label className="field field-wide">
                <span>Ek kaynak URL’leri</span>
                <textarea
                  ref={sourceUrlRef}
                  aria-invalid={errors.includes(errorLabels.SOURCE_EVIDENCE_REQUIRED)}
                  aria-describedby={errors.includes(errorLabels.SOURCE_EVIDENCE_REQUIRED) ? "instant-error-source" : undefined}
                  rows={3}
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="Her satıra bir güvenilir kaynak adresi"
                  spellCheck={false}
                />
                <small>
                  {parsedUrls.accepted.length} geçerli ·{" "}
                  {parsedUrls.rejected.length} reddedilen adres
                </small>
              </label>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-number">3</div>
            <div className="form-section-body">
              <div className="form-grid">
                <label className="field">
                  <span>Site bölümü</span>
                  <select
                    ref={sectionRef}
                    aria-invalid={errors.includes(errorLabels.TARGET_SECTION_REQUIRED)}
                    aria-describedby={errors.includes(errorLabels.TARGET_SECTION_REQUIRED) ? "instant-error-section" : undefined}
                    value={section}
                    onChange={(event) => {
                      const selected = event.target.value as Section | "";
                      setSection(selected);
                      if (selected) setArticleType(sectionArticleType(selected));
                    }}
                  >
                    <option value="">Bölüm seçin</option>
                    <option value="haberler">Haberler</option>
                    <option value="teknoloji">Teknoloji</option>
                    <option value="ekonomi">Ekonomi ve iş</option>
                    <option value="analiz">Analiz</option>
                    <option value="dosyalar">Dosyalar</option>
                    <option value="rehberler">Rehberler</option>
                    <option value="kultur">Kültür</option>
                    <option value="yasam">Yaşam</option>
                  </select>
                </label>
                <label className="field">
                  <span>İçerik türü</span>
                  <select
                    value={articleType}
                    disabled
                    aria-describedby="instant-section-type-hint"
                  >
                    <option value="news">Haber</option>
                    <option value="analysis">Analiz</option>
                    <option value="deep_dive">Derin dosya</option>
                    <option value="guide">Rehber</option>
                  </select>
                  <small id="instant-section-type-hint">{section ? `${sectionLabel(section)} bölümü için içerik türü otomatik seçilir.` : "Önce bölüm seçin; uygun içerik türü otomatik belirlenir."}</small>
                </label>
                <label className="field">
                  <span>Öncelik</span>
                  <select
                    value={urgency}
                    onChange={(event) =>
                      setUrgency(event.target.value as "normal" | "urgent")
                    }
                  >
                    <option value="normal">Normal sıra</option>
                    <option value="urgent">Acil araştırma</option>
                  </select>
                </label>
                <label className="field">
                  <span>Çıkış</span>
                  <select value="REVIEW" disabled>
                    <option value="REVIEW">İnceleme kuyruğu</option>
                  </select>
                </label>
              </div>
              <details className="optional-controls">
                <summary>İleri ayarlar <span>Ton, derinlik, görsel ve takvim</span></summary>
                <div className="form-grid">
                <label className="field">
                  <span>Anlatım tonu</span>
                  <select value={tone} onChange={(event) => setTone(event.target.value as typeof tone)}>
                    <option value="neutral">Tarafsız editoryal</option>
                    <option value="technical">Teknik ve ayrıntılı</option>
                    <option value="accessible">Sade ve erişilebilir</option>
                  </select>
                </label>
                <label className="field">
                  <span>Derinlik</span>
                  <select value={length} onChange={(event) => setLength(event.target.value as typeof length)}>
                    <option value="standard">Standart</option>
                    <option value="deep">Derin inceleme</option>
                  </select>
                </label>
                <label className="field">
                  <span>Görsel yaklaşımı</span>
                  <select value={visualPolicy} onChange={(event) => setVisualPolicy(event.target.value as typeof visualPolicy)}>
                    <option value="GENERATE">Özgün görsel dene</option>
                    <option value="LOCAL_RENDERER">Yalnız yerel kapak üret</option>
                    <option value="NONE">Görsel oluşturma</option>
                  </select>
                </label>
                <label className="field">
                  <span>Takvim niyeti</span>
                  <select value={scheduleIntent} onChange={(event) => setScheduleIntent(event.target.value as typeof scheduleIntent)}>
                    <option value="NEXT_SLOT">Onaydan sonra ilk uygun slot</option>
                    <option value="UNSCHEDULED">Takvimsiz taslak</option>
                  </select>
                </label>
                </div>
              </details>
            </div>
          </div>

          {errors.length > 0 ? (
            <div className="form-errors" role="alert">
              <strong>Başlamadan önce tamamlayın:</strong>
              <ul>
                {errors.map((error) => (
                  <li
                    id={
                      error === errorLabels.INSTRUCTION_TOO_SHORT
                        ? "instant-error-instruction"
                        : error === errorLabels.SOURCE_EVIDENCE_REQUIRED
                          ? "instant-error-source"
                          : error === errorLabels.TARGET_SECTION_REQUIRED
                            ? "instant-error-section"
                            : undefined
                    }
                    key={error}
                  >{error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <footer className="instant-footer">
            <span>
              <strong>Ücretli API yedeği kapalı.</strong>
              Yazı üretimi kullanılamazsa iş bekler; başka sağlayıcı çağrılmaz.
            </span>
            <button
              className="button button-primary button-large"
              type="button"
              disabled={submitting || readOnly}
              onClick={() => void submit()}
            >
              {submitting ? "Araştırma başlatılıyor…" : "Araştırmayı başlat"}
            </button>
          </footer>
        </section>

        <aside className="content-panel smart-brief">
          <p className="section-kicker">AKILLI ÖN KONTROL</p>
          <h2>İş paketi</h2>
          <div className="brief-row">
            <span>Niyet</span>
            <strong>
              {instruction.length >= 10 ? "Yeterince açık" : "Açıklama bekliyor"}
            </strong>
          </div>
          <div className="brief-row">
            <span>Kanıt</span>
            <strong>
              {selectedSourceIds.length + parsedUrls.accepted.length} kaynak
            </strong>
          </div>
          <div className="brief-row">
            <span>Rota</span>
            <strong>{section || "Seçilmedi"}</strong>
          </div>
          <div className="brief-row">
            <span>Dil</span>
            <strong>TR özgün · EN yerelleştirme</strong>
          </div>
          <div className="brief-row">
            <span>Biçim</span>
            <strong>{toneLabels[tone]} · {lengthLabels[length]}</strong>
          </div>
          <div className="brief-row">
            <span>Takvim / görsel</span>
            <strong>{scheduleIntent === "NEXT_SLOT" ? "İlk uygun slot" : "Takvimsiz"} · {visualPolicy === "NONE" ? "Görselsiz" : "Görselli"}</strong>
          </div>
          <div className="brief-checks">
            <p><span>✓</span> Kaynak metni kopyalanmaz</p>
            <p><span>✓</span> İddia defteri oluşturulur</p>
            <p><span>✓</span> Medya oranları doğrulanır</p>
            <p><span>✓</span> Onay revizyon hash’ine bağlanır</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
