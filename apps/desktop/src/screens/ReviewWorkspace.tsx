import { useEffect, useMemo, useState } from "react";

import type { BlogbotBridge } from "../bridge.ts";
import { astroGenericAdapter } from "../../../../packages/site-adapter/src/astro-generic.ts";
import type {
  BootstrapSnapshot,
  GateView,
  QueueItem,
  ReviewRevision
} from "../types.ts";

interface ReviewWorkspaceProps {
  bridge: BlogbotBridge;
  snapshot: BootstrapSnapshot;
  readOnly: boolean;
  embedded?: boolean;
  initialRevisionId?: string;
}

type ReviewTab = "content" | "claims" | "media" | "gates" | "diff";
type Locale = "tr" | "en";

type PublicationFile = { path: string; content: string | Uint8Array };
type PublicationPreviewRequest = {
  revisionId: string;
  revisionHash: string;
  payload: Record<string, unknown>;
};
type PublicationPreviewResult = { previewHash: string; adapterId: string; plan?: unknown };
type PreviewCapableBridge = BlogbotBridge & {
  previewPublication?: (input: PublicationPreviewRequest) => Promise<PublicationPreviewResult>;
  enqueuePublication: (input: { revisionId: string; revisionHash: string; previewHash: string }) => Promise<{ id: string; state: string; revisionId: string; revisionHash: string }>;
};

const tabLabels: Array<{ id: ReviewTab; label: string }> = [
  { id: "content", label: "İçerik" },
  { id: "claims", label: "İddialar ve kaynaklar" },
  { id: "media", label: "Medya" },
  { id: "gates", label: "SEO ve güvenlik" },
  { id: "diff", label: "Değişiklikler" }
];

function gateSummary(gates: GateView[]) {
  return {
    passed: gates.filter((gate) => gate.state === "PASS").length,
    warnings: gates.filter((gate) => gate.state === "WARN").length,
    blockers: gates.filter((gate) => gate.state === "BLOCK").length
  };
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

type SiteWorkMode = "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH";

function selectedSiteMode(): SiteWorkMode {
  try {
    const value = JSON.parse(localStorage.getItem("blogbot.setup.connector-draft.v1") ?? "null") as { site?: { mode?: string } } | null;
    return value?.site?.mode === "PUBLISH" || value?.site?.mode === "LOCAL_DEV" ? value.site.mode : "LOCAL_ONLY";
  } catch {
    return "LOCAL_ONLY";
  }
}

function selectedSiteAdapter(): string {
  try {
    const value = JSON.parse(localStorage.getItem("blogbot.setup.site-adapter.v1") ?? "null") as { ok?: boolean; adapterId?: string } | null;
    return value?.ok === true && value.adapterId ? value.adapterId : "local-folder-v1";
  } catch {
    return "local-folder-v1";
  }
}

async function buildPublicationFiles(revision: ReviewRevision, mode: SiteWorkMode): Promise<PublicationFile[]> {
  const mediaPath = (filename: string) => mode === "LOCAL_ONLY" ? `.blogbot/generated/media/${filename}` : `public/images/${filename}`;
  const mediaFiles: PublicationFile[] = (revision.media ?? []).flatMap((media) => {
    if (!media.contentBase64) return [];
    const binary = Uint8Array.from(atob(media.contentBase64), (character) => character.charCodeAt(0));
    return [{ path: mediaPath(media.filename), content: binary }];
  });
  const hero = revision.media?.find((media) => media.role === "hero");
  const generated = astroGenericAdapter.buildRevisionFiles({
    id: revision.id,
    revisionHash: revision.revisionHash,
    translationKey: revision.articleId,
    tr: {
      ...revision.tr,
      section: revision.section,
      articleType: revision.articleType,
      authorId: revision.author,
      publishedAt: revision.scheduledAt,
      tags: revision.tags,
      sources: revision.sources,
      ...(hero ? { heroImage: mediaPath(hero.filename), heroImageAlt: hero.altTr } : {})
    },
    en: {
      ...revision.en,
      section: ({ haberler: "news", analiz: "analysis", dosyalar: "deep-dives", rehberler: "guides" } as Record<string, string>)[revision.section] ?? revision.section,
      articleType: revision.articleType,
      authorId: revision.author,
      publishedAt: revision.scheduledAt,
      tags: revision.tags,
      sources: revision.sources,
      ...(hero ? { heroImage: mediaPath(hero.filename), heroImageAlt: hero.altEn } : {})
    }
  }, { siteOrigin: "", repositoryPath: "", adapterId: astroGenericAdapter.id });
  const contentEntries = Object.entries(generated).map(([path, content]) => {
    if (mode === "PUBLISH" || (mode === "LOCAL_DEV" && selectedSiteAdapter() === "astro-generic")) return [path, content] as const;
    const localPath = path.startsWith("src/content/articles/")
      ? path.replace(/^src\/content\/articles\//u, ".blogbot/generated/")
      : path;
    return [localPath, content] as const;
  });
  const entries = await Promise.all(contentEntries.map(async ([path, content]) => ({ path, sha256: await sha256(content), bytes: new TextEncoder().encode(content).byteLength })));
  const manifestPath = `.blogbot/manifests/${revision.id}.json`;
  const manifest = JSON.stringify({
    version: 1,
    revisionId: revision.id,
    revisionHash: revision.revisionHash,
    translationKey: revision.articleId,
    adapterVersion: astroGenericAdapter.version,
    generatedAt: "1970-01-01T00:00:00.000Z",
    entries
  });
  return [
    ...mediaFiles,
    ...contentEntries.map(([path, content]) => ({ path, content })),
    { path: manifestPath, content: manifest }
  ];
}

function QueueCard({
  item,
  selected,
  onSelect
}: {
  item: QueueItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`review-queue-item ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
    >
      <span className={`queue-state queue-${item.state.toLowerCase()}`} />
      <span>
        <strong>{item.title}</strong>
        <small>
          {item.section} · {item.sourceCount} kaynak
        </small>
      </span>
      {item.blockers > 0 ? (
        <em>{item.blockers} engel</em>
      ) : (
        <em>{item.dueLabel}</em>
      )}
    </button>
  );
}

export function ReviewWorkspace({
  bridge,
  snapshot,
  readOnly,
  initialRevisionId
}: ReviewWorkspaceProps) {
  const siteMode = selectedSiteMode();
  const localMaterializeLabel = siteMode === "LOCAL_DEV"
    ? "Onaylı paketi yerel projeye yaz"
    : "Onaylı paketi seçili klasöre yaz";
  const [selectedId, setSelectedId] = useState(
    initialRevisionId || snapshot.queue[0]?.id || ""
  );
  const [query, setQuery] = useState("");
  const [queueFilter, setQueueFilter] = useState<"pending" | "approved">("pending");
  const [revision, setRevision] = useState<ReviewRevision | null>(null);
  const [locale, setLocale] = useState<Locale>("tr");
  const [tab, setTab] = useState<ReviewTab>("content");
  const [loading, setLoading] = useState(snapshot.queue.length > 0);
  const [approving, setApproving] = useState(false);
  const [approvingHighRisk, setApprovingHighRisk] = useState(false);
  const [reauthenticated, setReauthenticated] = useState(false);
  const [requestingEdit, setRequestingEdit] = useState(false);
  const [enqueueingPublication, setEnqueueingPublication] = useState(false);
  const [previewingPublication, setPreviewingPublication] = useState(false);
  const [lastPreviewHash, setLastPreviewHash] = useState("");
  const [materializingLocal, setMaterializingLocal] = useState(false);
  const [editRequestOpen, setEditRequestOpen] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    let alive = true;
    void bridge
      .getReviewRevision(selectedId)
      .then((value) => {
        if (alive) {
          setRevision(value);
        }
      })
      .catch((reason) => {
        if (alive) {
          setNotice(
            reason instanceof Error ? reason.message : "Revizyon açılamadı."
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
  }, [bridge, selectedId]);

  const summary = useMemo(
    () => gateSummary(revision?.gates ?? []),
    [revision]
  );
  const activeContent = revision?.[locale];
  const previousContent = revision?.previous[locale];
  const visibleQueue = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("tr-TR");
    return snapshot.queue.filter((item) => {
      const stateMatch =
        queueFilter === "approved"
          ? item.state === "APPROVED"
          : item.state !== "APPROVED";
      return (
        stateMatch &&
        (!normalized ||
          item.title.toLocaleLowerCase("tr-TR").includes(normalized))
      );
    });
  }, [query, queueFilter, snapshot.queue]);
  const inspectionComplete = Boolean(
    revision &&
      revision.gates.length > 0 &&
      revision.claims.length > 0 &&
      revision.sources.length > 0 &&
      revision.gates.every((gate) => gate.state !== "BLOCK") &&
      revision.claims.every((claim) => claim.status === "VERIFIED")
  );

  const selectRevision = (revisionId: string) => {
    setLoading(true);
    setNotice("");
    setSelectedId(revisionId);
  };

  const approve = async () => {
    if (!revision) {
      return;
    }
    setApproving(true);
    setNotice("");
    try {
      const result = await bridge.approveRevision({
        revisionId: revision.id,
        expectedHash: revision.revisionHash
      });
      setRevision((current) =>
        current ? { ...current, state: result.state, editorialApproved: true } : current
      );
      setNotice(
        result.state === "APPROVED"
          ? `Revizyon onaylandı · ${result.revisionHash.slice(0, 12)}…`
          : `Editoryal onay kaydedildi; yüksek risk ikinci onayı bekleniyor · ${result.revisionHash.slice(0, 12)}…`
      );
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Onay kaydedilemedi."
      );
    } finally {
      setApproving(false);
    }
  };

  const approveHighRisk = async () => {
    if (!revision || revision.riskLevel !== "HIGH" || !reauthenticated) return;
    setApprovingHighRisk(true);
    setNotice("");
    try {
      const checklist = revision.gates
        .filter((gate) => gate.group === "security")
        .map((gate) => ({ id: gate.id, state: gate.state, detail: gate.detail }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const bytes = new TextEncoder().encode(JSON.stringify(checklist));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const riskChecklistHash = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const result = await bridge.approveHighRiskRevision({
        revisionId: revision.id,
        expectedHash: revision.revisionHash,
        riskChecklistHash,
        confirmReauthenticated: true
      });
      setRevision((current) => current ? { ...current, highRiskApproved: true, state: "APPROVED" } : current);
      setNotice(`Yüksek risk onayı kaydedildi · ${result.revisionHash.slice(0, 12)}…`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Yüksek risk onayı kaydedilemedi.");
    } finally {
      setApprovingHighRisk(false);
    }
  };

  const requestEdit = async () => {
    if (!revision || editInstruction.trim().length < 10) {
      return;
    }
    setRequestingEdit(true);
    setNotice("");
    try {
      await bridge.requestRevisionEdit({
        revisionId: revision.id,
        instruction: editInstruction.trim()
      });
      setEditInstruction("");
      setEditRequestOpen(false);
      setNotice(
        "Düzenleme talebi araştırma kuyruğuna alındı. Yeni revizyon ayrı bir hash ile gelecek."
      );
    } catch (reason) {
      setNotice(
        reason instanceof Error
          ? reason.message
          : "Düzenleme talebi kaydedilemedi."
      );
    } finally {
      setRequestingEdit(false);
    }
  };

  const enqueuePublication = async () => {
    if (!revision || revision.state !== "APPROVED") return;
    const previewBridge = bridge as PreviewCapableBridge;
    if (typeof previewBridge.previewPublication !== "function") {
      setNotice("Yayın kuyruğu için önce değişmez yayın önizlemesi gerekir; yerel köprü bu özelliği sunmuyor.");
      return;
    }
    setPreviewingPublication(true);
    setNotice("");
    try {
      setNotice("Yayın paketi önizlemesi hazırlanıyor…");
      const preview = await createPublicationPreview(revision, previewBridge);
      if (!preview.previewHash) {
        throw new Error("Yayın önizlemesi geçerli bir hash döndürmedi.");
      }
      setLastPreviewHash(preview.previewHash);
      setNotice(`Önizleme doğrulandı · ${preview.previewHash.slice(0, 12)}… Kuyruğa alınıyor…`);
      setEnqueueingPublication(true);
      await previewBridge.enqueuePublication({ revisionId: revision.id, revisionHash: revision.revisionHash, previewHash: preview.previewHash });
      setNotice("Onaylı revizyon yerel yayın kuyruğuna alındı. GitHub bağlantısı hazır değilse güvenle beklemede kalır.");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Yayın kuyruğuna alınamadı.");
    } finally {
      setPreviewingPublication(false);
      setEnqueueingPublication(false);
    }
  };

  const createPublicationPreview = async (currentRevision: ReviewRevision, previewBridge: PreviewCapableBridge) => {
    if (typeof previewBridge.previewPublication !== "function") throw new Error("Yerel köprü yayın önizlemesini desteklemiyor.");
    const mode = selectedSiteMode();
    const astroOutput = mode === "PUBLISH" || (mode === "LOCAL_DEV" && selectedSiteAdapter() === "astro-generic");
    const files = await buildPublicationFiles(currentRevision, mode);
    const manifestPath = `.blogbot/manifests/${currentRevision.id}.json`;
    return previewBridge.previewPublication({
      revisionId: currentRevision.id,
      revisionHash: currentRevision.revisionHash,
      payload: {
        files,
        bundlePolicy: {
          adapterId: astroOutput ? "astro-generic" : "local-folder-v1",
          manifestPath,
          allowedPathPrefixes: astroOutput ? ["src/content/articles/", "public/images/", ".blogbot/manifests/"] : [".blogbot/generated/", ".blogbot/manifests/"],
          requiredLocalePrefixes: astroOutput ? ["src/content/articles/tr/", "src/content/articles/en/"] : [".blogbot/generated/tr/", ".blogbot/generated/en/"]
        },
        now: "1970-01-01T00:00:00.000Z"
      }
    });
  };

  const materializeLocal = async () => {
    if (!revision || readOnly) return;
    let targetDirectory = "";
    try {
      const saved = JSON.parse(localStorage.getItem("blogbot.setup.connector-draft.v1") ?? "null") as { site?: { repositoryPath?: string } } | null;
      targetDirectory = saved?.site?.repositoryPath?.trim() ?? "";
    } catch { /* best effort */ }
    if (!targetDirectory) {
      setNotice("Önce Kurulum Merkezi'nden site klasörünü seçin.");
      return;
    }
    if (!window.confirm("Onaylı paketin dosyaları seçtiğiniz proje klasörüne yazılacak. Mevcut dosyalar güvenli yedeğe alınacak. Devam edilsin mi?")) return;
    setMaterializingLocal(true);
    try {
      let previewHash = lastPreviewHash;
      if (!previewHash) {
        const preview = await createPublicationPreview(revision, bridge as PreviewCapableBridge);
        previewHash = preview.previewHash;
        setLastPreviewHash(previewHash);
      }
      const result = await bridge.materializeLocalPreview({ revisionId: revision.id, revisionHash: revision.revisionHash, previewHash, targetDirectory });
      setNotice(`${result.written} dosya yerel proje klasörüne yazıldı. ${result.backupDirectory ? "Eski dosyalar Blogbot yedeğine alındı." : ""}`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Yerel proje klasörüne yazılamadı.");
    } finally { setMaterializingLocal(false); }
  };

  return (
    <div className="review-page">
      <aside className="review-queue">
        <header>
          <p className="section-kicker">İNCELEME</p>
          <h1>Yayın kuyruğu</h1>
          <span>{snapshot.queue.length} açık revizyon</span>
        </header>
        <label className="search-field review-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Başlık ara"
            aria-label="İnceleme kuyruğunda ara"
          />
        </label>
        <div className="queue-filter-row">
          <button type="button" className={queueFilter === "pending" ? "is-selected" : ""} onClick={() => setQueueFilter("pending")}>
            Bekleyenler
          </button>
          <button type="button" className={queueFilter === "approved" ? "is-selected" : ""} onClick={() => setQueueFilter("approved")}>Onaylı</button>
        </div>
        <div className="review-queue-list">
          {visibleQueue.map((item) => (
            <QueueCard
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              onSelect={() => selectRevision(item.id)}
            />
          ))}
          {!visibleQueue.length ? <div className="queue-empty"><strong>Bu görünümde revizyon yok.</strong><span>Filtreyi veya aramayı değiştirin.</span></div> : null}
        </div>
        <footer>
          <span className="status-dot status-online" aria-hidden="true" />
          Yerel kuyruk güncel
        </footer>
      </aside>

      <main className="review-workspace">
        {loading ? (
          <div className="review-loading">Değişmez revizyon yükleniyor…</div>
        ) : !revision || !activeContent || !previousContent ? (
          <div className="review-loading">
            <strong>Revizyon gösterilemiyor.</strong>
            {notice}
          </div>
        ) : (
          <>
            <header className="review-topbar">
              <div className="review-title">
                <div className="review-breadcrumb">
                  <span>{revision.section}</span>
                  <span aria-hidden="true">/</span>
                  <span>{revision.articleType}</span>
                  <span className={`review-state state-${revision.state.toLowerCase()}`}>
                    {revision.state === "APPROVED"
                      ? "Onaylandı"
                      : "İnceleme bekliyor"}
                  </span>
                </div>
                <h2>{revision.tr.title}</h2>
              </div>
              <div className="review-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={readOnly || revision.state === "APPROVED"}
                  aria-expanded={editRequestOpen}
                  onClick={() => setEditRequestOpen((current) => !current)}
                >
                  Düzenleme iste
                </button>
                {siteMode !== "PUBLISH" ? (
                  <button
                    className="button button-ghost"
                    type="button"
                    disabled={readOnly || revision.state !== "APPROVED" || materializingLocal}
                    onClick={() => void materializeLocal()}
                  >
                    {materializingLocal ? "Klasöre yazılıyor…" : localMaterializeLabel}
                  </button>
                ) : null}
                {revision.riskLevel === "HIGH" && revision.editorialApproved && !revision.highRiskApproved ? (
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={readOnly || approvingHighRisk || !reauthenticated}
                    onClick={() => void approveHighRisk()}
                  >
                    {approvingHighRisk ? "Risk onayı kaydediliyor…" : "Yüksek risk onayını ver"}
                  </button>
                ) : null}
                <button
                  className="button button-primary"
                  type="button"
                  disabled={
                    approving ||
                    readOnly ||
                    !inspectionComplete ||
                    revision.state === "APPROVED"
                  }
                  onClick={() => void approve()}
                >
                  {approving
                    ? "Onay bağlanıyor…"
                    : revision.state === "APPROVED"
                      ? "Revizyon onaylı"
                      : "Bu revizyonu onayla"}
                </button>
                {siteMode === "PUBLISH" ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={readOnly || revision.state !== "APPROVED" || enqueueingPublication || previewingPublication}
                    onClick={() => void enqueuePublication()}
                  >
                    {previewingPublication ? "Yayın önizlemesi hazırlanıyor…" : enqueueingPublication ? "Kuyruğa alınıyor…" : "Yayın kuyruğuna al"}
                  </button>
                ) : null}
              </div>
            </header>

            {editRequestOpen ? (
              <section className="edit-request-panel" aria-label="Düzenleme isteği">
                <label className="field">
                  <span>Değişmesini istediğiniz noktayı açıkça yazın</span>
                  <textarea
                    value={editInstruction}
                    onChange={(event) => setEditInstruction(event.target.value)}
                    placeholder="Örnek: İkinci iddiayı birincil kaynakla yeniden doğrula ve TR/EN metinlerde aynı kanıtı kullan."
                    rows={3}
                    autoFocus
                  />
                </label>
                <div className="review-actions">
                  <button
                    className="button button-ghost"
                    type="button"
                    onClick={() => setEditRequestOpen(false)}
                  >
                    Vazgeç
                  </button>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={requestingEdit || editInstruction.trim().length < 10}
                    onClick={() => void requestEdit()}
                  >
                    {requestingEdit ? "Kuyruğa alınıyor…" : "Yeni revizyon iste"}
                  </button>
                </div>
              </section>
            ) : null}

            <div className="revision-integrity-bar">
              <div>
                <span className="integrity-icon" aria-hidden="true">
                  ⌁
                </span>
                <span>
                  <strong>Değişmez revizyon</strong>
                  Onay bu hash’e, iki dile, kanıtlara, medyaya ve takvime
                  bağlanır.
                </span>
              </div>
              <code title={revision.revisionHash}>
                sha256:{revision.revisionHash.slice(0, 16)}…
              </code>
            </div>

            {notice ? <div className="inline-notice review-notice" role="status" aria-live="polite">{notice}</div> : null}
            {!inspectionComplete ? (
              <div className="inline-notice review-notice is-warning" role="status">
                Onay kapalı: iddia, kaynak, medya ve kalite kontrollerinin tamamı çalışmış ve engelsiz olmalıdır.
              </div>
            ) : null}
            {revision.riskLevel === "HIGH" && revision.editorialApproved && !revision.highRiskApproved ? (
              <label className="acknowledgement high-risk-reauth">
                <input type="checkbox" checked={reauthenticated} onChange={(event) => setReauthenticated(event.target.checked)} />
                <span>Güvenlik kontrol listesini yeniden okudum ve ikinci yüksek risk onayını bilinçli olarak veriyorum.</span>
              </label>
            ) : null}

            <div className="review-tabs-row">
              <div className="review-tabs" role="tablist" aria-label="İnceleme bölümleri">
                {tabLabels.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === item.id}
                    className={tab === item.id ? "is-selected" : ""}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                    {item.id === "claims" ? (
                      <span>{revision.claims.length}</span>
                    ) : null}
                    {item.id === "gates" && summary.blockers > 0 ? (
                      <span className="is-blocker">{summary.blockers}</span>
                    ) : null}
                  </button>
                ))}
              </div>
              {tab === "diff" && (
                <div className="locale-switch" aria-label="Dil seçimi">
                  <button
                    type="button"
                    className={locale === "tr" ? "is-selected" : ""}
                    onClick={() => setLocale("tr")}
                  >
                    TR <small>Özgün</small>
                  </button>
                  <button
                    type="button"
                    className={locale === "en" ? "is-selected" : ""}
                    onClick={() => setLocale("en")}
                  >
                    EN <small>Yerelleştirme</small>
                  </button>
                </div>
              )}
            </div>

            <div className="review-content-scroll">
              {tab === "content" ? (
                <div className="article-review-layout dual-review-layout">
                  <div className="dual-locale-grid">
                    {(["tr", "en"] as const).map((contentLocale) => {
                      const content = revision[contentLocale];
                      return (
                        <article className="article-preview" key={contentLocale} lang={contentLocale}>
                          <div className="locale-heading"><strong>{contentLocale.toUpperCase()}</strong><span>{contentLocale === "tr" ? "Özgün editoryal sürüm" : "Doğal yerelleştirme"}</span></div>
                          <div className="article-meta"><span>{revision.section}</span><span>8 dk okuma</span><span>{revision.author}</span></div>
                          <h1>{content.title}</h1>
                          <p className="article-description">{content.description}</p>
                          <div className="article-hero-placeholder" role="img" aria-label={`${contentLocale.toUpperCase()} hero medya önizlemesi`}>
                            <span>1600 × 900</span><strong>Hero medya güvenli önizlemesi</strong><small>İçerik hash’i doğrulandı</small>
                          </div>
                          <div className="markdown-preview">
                            {content.bodyMarkdown.split("\n\n").map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  <aside className="article-metadata">
                    <div className="metadata-section">
                      <p className="section-kicker">YAYIN PAKETİ</p>
                      <dl>
                        <div>
                          <dt>Slug</dt>
                          <dd>{activeContent.slug}</dd>
                        </div>
                        <div>
                          <dt>Takvim</dt>
                          <dd>29 Temmuz · 16:30</dd>
                        </div>
                        <div>
                          <dt>Adaptör</dt>
                          <dd>{revision.adapterVersion}</dd>
                        </div>
                      </dl>
                    </div>
                    <div className="metadata-section">
                      <p className="section-kicker">ETİKETLER</p>
                      <div className="tag-list">
                        {revision.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div className="metadata-section quality-mini">
                      <p className="section-kicker">KALİTE ÖZETİ</p>
                      <p><span className="gate-icon pass">✓</span> {summary.passed} kontrol geçti</p>
                      <p><span className="gate-icon warn">!</span> {summary.warnings} uyarı</p>
                      <p><span className="gate-icon block">×</span> {summary.blockers} yayın engeli</p>
                    </div>
                  </aside>
                </div>
              ) : null}

              {tab === "claims" ? (
                <div className="evidence-layout">
                  <section>
                    <div className="review-section-heading">
                      <div>
                        <p className="section-kicker">İDDİA DEFTERİ</p>
                        <h2>{revision.claims.length} doğrulanabilir iddia</h2>
                      </div>
                      <span className="pass-label">Tümü kaynaklı</span>
                    </div>
                    <div className="claim-list">
                      {revision.claims.map((claim, index) => (
                        <div className="claim-row" key={claim.id}>
                          <span className="claim-number">{index + 1}</span>
                          <span className="claim-copy">
                            <strong>{claim.text}</strong>
                            <small>
                              {claim.locale === "both"
                                ? "TR + EN"
                                : claim.locale.toUpperCase()}{" "}
                              · {claim.sourceIds.length} kanıt
                            </small>
                          </span>
                          <span className={`claim-state state-${claim.status.toLowerCase()}`}>
                            {claim.status === "VERIFIED"
                              ? "Doğrulandı"
                              : "Kaynak gerekli"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section>
                    <div className="review-section-heading">
                      <div>
                        <p className="section-kicker">KAYNAK ANLIK GÖRÜNTÜLERİ</p>
                        <h2>{revision.sources.length} değişmez kanıt</h2>
                      </div>
                    </div>
                    <div className="snapshot-list">
                      {revision.sources.map((source) => (
                        <div className="snapshot-row" key={source.id}>
                          <span className="source-favicon" aria-hidden="true">
                            {source.title.slice(0, 1)}
                          </span>
                          <span>
                            <strong>{source.title}</strong>
                            <small>{source.url}</small>
                          </span>
                          <span className="snapshot-meta">
                            {source.primary ? <em>Birincil</em> : null}
                            <code>{source.contentHash}</code>
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="evidence-note">
                      Kaynak bağlantıları burada yalnızca kanıt kimliği olarak
                      gösterilir. İçerik yerel engine tarafından alınmış anlık
                      görüntüden doğrulanır; webview doğrudan ağ çağrısı yapmaz.
                    </p>
                  </section>
                </div>
              ) : null}

              {tab === "media" ? (
                <div className="media-review">
                  <div className="review-section-heading">
                    <div>
                      <p className="section-kicker">MEDYA PAKETİ</p>
                      <h2>Oran, alt metin ve hash kontrolleri</h2>
                    </div>
                    <span className="pass-label">2 / 2 uygun</span>
                  </div>
                  <div className="media-grid">
                    {revision.media.map((media) => (
                      <article className="media-card" key={media.id}>
                        <div className="media-placeholder">
                          <span>{media.role === "hero" ? "HERO" : "İÇ GÖRSEL"}</span>
                          <strong>{media.width} × {media.height}</strong>
                        </div>
                        <div className="media-card-body">
                          <h3>{media.filename}</h3>
                          <div className="media-facts">
                            <span><strong>Oran</strong> 16:9</span>
                            <span><strong>Biçim</strong> WebP</span>
                            <span><strong>Hash</strong> {media.sha256.slice(0, 16)}…</span>
                          </div>
                          <div className="alt-copy">
                            <p><span>TR</span>{media.altTr}</p>
                            <p><span>EN</span>{media.altEn}</p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              {tab === "gates" ? (
                <div className="gate-review">
                  <div className="gate-summary">
                    <div className="gate-score">
                      <strong>{summary.passed}/{revision.gates.length}</strong>
                      <span>kontrol geçti</span>
                    </div>
                    <p>
                      Yayın paketi editoryal, SEO ve güvenlik sınırlarından
                      geçti. Engel oluşursa onay düğmesi otomatik kapanır.
                    </p>
                  </div>
                  {(["editorial", "seo", "security"] as const).map((group) => (
                    <section className="gate-group" key={group}>
                      <div className="gate-group-heading">
                        <p className="section-kicker">
                          {group === "editorial"
                            ? "EDİTORYAL"
                            : group === "seo"
                              ? "SEO VE YAPI"
                              : "GÜVENLİK"}
                        </p>
                        <strong>
                          {
                            revision.gates.filter((gate) => gate.group === group)
                              .length
                          }{" "}
                          kontrol
                        </strong>
                      </div>
                      <div className="gate-list">
                        {revision.gates
                          .filter((gate) => gate.group === group)
                          .map((gate) => (
                            <div className="gate-row" key={gate.id}>
                              <span className={`gate-icon ${gate.state.toLowerCase()}`}>
                                {gate.state === "PASS"
                                  ? "✓"
                                  : gate.state === "WARN"
                                    ? "!"
                                    : "×"}
                              </span>
                              <span>
                                <strong>{gate.label}</strong>
                                <small>{gate.detail}</small>
                              </span>
                              <em>
                                {gate.state === "PASS"
                                  ? "Geçti"
                                  : gate.state === "WARN"
                                    ? "Uyarı"
                                    : "Engel"}
                              </em>
                            </div>
                          ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : null}

              {tab === "diff" ? (
                <div className="diff-review">
                  <div className="review-section-heading">
                    <div>
                      <p className="section-kicker">REVİZYON FARKI</p>
                      <h2>Önceki taslaktan değişenler</h2>
                    </div>
                    <span className="count-label">Revizyon 7 → 8</span>
                  </div>
                  <div className="diff-block">
                    <header>
                      <strong>Başlık</strong>
                      <span>{locale.toUpperCase()}</span>
                    </header>
                    <p className="diff-removed">
                      <span>−</span>{previousContent.title}
                    </p>
                    <p className="diff-added">
                      <span>+</span>{activeContent.title}
                    </p>
                  </div>
                  <div className="diff-block">
                    <header>
                      <strong>Açıklama</strong>
                      <span>{locale.toUpperCase()}</span>
                    </header>
                    <p className="diff-removed">
                      <span>−</span>{previousContent.description}
                    </p>
                    <p className="diff-added">
                      <span>+</span>{activeContent.description}
                    </p>
                  </div>
                  <div className="diff-block">
                    <header>
                      <strong>Gövde</strong>
                      <span>Kanıt sentezi genişletildi</span>
                    </header>
                    <p className="diff-removed">
                      <span>−</span>{previousContent.bodyMarkdown}
                    </p>
                    {activeContent.bodyMarkdown
                      .split("\n\n")
                      .map((paragraph) => (
                        <p className="diff-added" key={paragraph}>
                          <span>+</span>{paragraph}
                        </p>
                      ))}
                  </div>
                  <div className="diff-impact">
                    <span aria-hidden="true">!</span>
                    <p>
                      <strong>Onay etkisi</strong>
                      Bu değişiklikler revizyon hash’ini değiştirdi. Önceki
                      onay varsa artık geçersizdir.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
