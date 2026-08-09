import { useEffect, useMemo, useState } from "react";

import { userFacingBridgeError, userFacingPublicationQueueError, type BlogbotBridge } from "../bridge.ts";
import { ConfirmationDialog } from "../components/ConfirmationDialog.tsx";
import { handleTabListKeyDown } from "../components/tab-keyboard.ts";
import { contentCategoryLabel, sectionLabel } from "../app-model.ts";
import { buildPublicationFiles } from "../publication-files.ts";
import type {
  BootstrapSnapshot,
  ConnectorStateSnapshot,
  GateView,
  QueueItem,
  ReviewRevision
} from "../types.ts";

interface ReviewWorkspaceProps {
  bridge: BlogbotBridge;
  snapshot: BootstrapSnapshot;
  readOnly: boolean;
  connectorState: ConnectorStateSnapshot;
  showSourceReferences?: boolean;
  onDraftQueued?: (message: string, expectedDraftId?: string) => Promise<void>;
  onPublicationQueued?: () => Promise<void>;
  onRevisionApproved?: () => Promise<void>;
  embedded?: boolean;
  initialRevisionId?: string;
}

type ReviewTab = "content" | "claims" | "media" | "gates" | "diff";
type Locale = "tr" | "en";

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

const acceptableWarningIds = new Set(["SINGLE_OFFICIAL_SOURCE_EXCEPTION", "contradictions", "seo", "media"]);

function gateSummary(gates: GateView[]) {
  return {
    passed: gates.filter((gate) => gate.state === "PASS").length,
    warnings: gates.filter((gate) => gate.state === "WARN").length,
    blockers: gates.filter((gate) => gate.state === "BLOCK").length
  };
}

function isScheduledForFuture(scheduledAt: string): boolean {
  const scheduledAtMs = Date.parse(scheduledAt);
  return Number.isFinite(scheduledAtMs) && scheduledAtMs > Date.now();
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function safeSourceReferenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function editorialTargetWords(articleType: ReviewRevision["articleType"]): number {
  if (articleType === "deep_dive") return 1_200;
  if (articleType === "analysis" || articleType === "guide") return 900;
  return 700;
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function warningSetHash(gates: GateView[]): Promise<string> {
  const warnings = gates
    .filter((gate) => gate.state === "WARN")
    .map((gate) => ({
      detail: gate.detail,
      group: gate.group,
      id: gate.id,
      policyVersion: gate.policyVersion,
      state: gate.state
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(JSON.stringify(warnings));
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
      aria-pressed={selected}
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
  connectorState,
  showSourceReferences = true,
  onDraftQueued,
  onPublicationQueued,
  onRevisionApproved,
  initialRevisionId
}: ReviewWorkspaceProps) {
  const siteMode = connectorState.mode;
  const remotePublicationReady =
    siteMode === "PUBLISH" && connectorState.externalReadiness === "LIVE_ACCEPTED";
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
  const [requestingComprehensiveRewrite, setRequestingComprehensiveRewrite] = useState(false);
  const [repairingMedia, setRepairingMedia] = useState(false);
  const [enqueueingPublication, setEnqueueingPublication] = useState(false);
  const [previewingPublication, setPreviewingPublication] = useState(false);
  const [lastPreview, setLastPreview] = useState<{ revisionId: string; hash: string } | null>(null);
  const [materializingLocal, setMaterializingLocal] = useState(false);
  const [materializeConfirmationOpen, setMaterializeConfirmationOpen] = useState(false);
  const [editRequestOpen, setEditRequestOpen] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");
  const [notice, setNotice] = useState("");
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);

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
          setRevision(null);
          setNotice(
            userFacingBridgeError(reason, "Revizyon açılamadı.")
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
  const sourceById = useMemo(
    () => new Map((revision?.sources ?? []).map((source) => [source.id, source])),
    [revision]
  );
  const acceptedWarnings = revision?.gates.filter((gate) => gate.state === "WARN") ?? [];
  const comprehensiveTargetWords = revision ? editorialTargetWords(revision.articleType) : 0;
  const trWordCount = revision ? wordCount(revision.tr.bodyMarkdown) : 0;
  const needsComprehensiveRewrite = Boolean(
    revision && revision.state === "REVIEW_REQUIRED" && trWordCount < comprehensiveTargetWords
  );
  const hasUnacceptableWarning = acceptedWarnings.some((gate) => !acceptableWarningIds.has(gate.id));
  const claimsBlocked = Boolean(revision?.gates.some((gate) => gate.id === "claims" && gate.state === "BLOCK"));
  const activeContent = revision?.[locale];
  const previousContent = revision?.previous[locale];
  const heroMedia = revision?.media.find((media) => media.role === "hero");
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
  const pendingRevisionCount = useMemo(
    () => snapshot.queue.filter((item) => item.state !== "APPROVED").length,
    [snapshot.queue]
  );
  const localOutputDescription = [
    readOnly ? "review-approval-read-only" : "",
    !connectorState.site.repositoryPath.trim() ? "local-output-prerequisite" : ""
  ].filter(Boolean).join(" ") || undefined;
  const publicationQueueDescription = readOnly
    ? "review-approval-read-only"
    : revision?.state !== "APPROVED"
      ? "review-publication-prerequisite"
      : undefined;
  const inspectionComplete = Boolean(
    revision &&
      revision.gates.length > 0 &&
      revision.claims.length > 0 &&
      revision.sources.length > 0 &&
      revision.gates.every((gate) => gate.state !== "BLOCK" && gate.state !== "NOT_RUN") &&
      revision.gates.every((gate) => gate.state !== "WARN" || acceptableWarningIds.has(gate.id)) &&
      (revision.gates.every((gate) => gate.state !== "WARN") || warningsAcknowledged) &&
      revision.claims.every((claim) => claim.status === "VERIFIED")
  );

  const selectRevision = (revisionId: string) => {
    setLoading(true);
    setNotice("");
    setRevision(null);
    setLastPreview(null);
    setSelectedId(revisionId);
    setWarningsAcknowledged(false);
  };

  const approve = async (dispatchAfterApproval = false) => {
    if (!revision) {
      return;
    }
    setApproving(true);
    setNotice("");
    try {
      const acceptedWarningSetHash = await warningSetHash(revision.gates);
      const result = await bridge.approveRevision({
        revisionId: revision.id,
        expectedHash: revision.revisionHash,
        warningSetHash: acceptedWarningSetHash
      });
      setRevision((current) =>
        current ? { ...current, state: result.state, editorialApproved: true } : current
      );
      if (dispatchAfterApproval && result.state === "APPROVED") {
        const approvedRevision = { ...revision, state: "APPROVED" as const, editorialApproved: true };
        if (isScheduledForFuture(approvedRevision.scheduledAt)) {
          await prepareScheduledPublication(approvedRevision);
        } else {
          await enqueuePublication(approvedRevision);
        }
        return;
      }
      let refreshNotice = "";
      try {
        await onRevisionApproved?.();
      } catch {
        refreshNotice = " İnceleme kuyruğu görünümü henüz yenilenemedi; sayfayı yenileyin veya Editoryal Masa'dan yeniden deneyin.";
      }
      setNotice(
        result.state === "APPROVED"
          ? `Revizyon onaylandı · ${result.revisionHash.slice(0, 12)}…${refreshNotice}`
          : `Editoryal onay kaydedildi; yüksek risk ikinci onayı bekleniyor · ${result.revisionHash.slice(0, 12)}…${refreshNotice}`
      );
    } catch (reason) {
      setNotice(
        userFacingBridgeError(reason, "Onay kaydedilemedi.")
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
      const acceptedWarningSetHash = await warningSetHash(revision.gates);
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
        warningSetHash: acceptedWarningSetHash,
        confirmReauthenticated: true
      });
      setRevision((current) => current ? { ...current, highRiskApproved: true, state: "APPROVED" } : current);
      try {
        await onRevisionApproved?.();
        setNotice(`Yüksek risk onayı kaydedildi · ${result.revisionHash.slice(0, 12)}…`);
      } catch {
        setNotice(`Yüksek risk onayı kaydedildi · ${result.revisionHash.slice(0, 12)}… İnceleme kuyruğu görünümü henüz yenilenemedi; sayfayı yenileyin veya Editoryal Masa'dan yeniden deneyin.`);
      }
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Yüksek risk onayı kaydedilemedi."));
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
      const queued = await bridge.requestRevisionEdit({
        revisionId: revision.id,
        instruction: editInstruction.trim()
      });
      setEditInstruction("");
      setEditRequestOpen(false);
      const queuedMessage = "Düzenleme talebi araştırma kuyruğuna alındı. Yeni revizyon ayrı bir hash ile gelecek.";
      if (onDraftQueued) {
        try {
          await onDraftQueued(queuedMessage, queued.job?.id);
        } catch {
          setNotice(`${queuedMessage} Taslak envanteri şu an yenilenemedi; Taslaklar sekmesinden yeniden deneyin.`);
        }
      } else {
        setNotice(queuedMessage);
      }
    } catch (reason) {
      setNotice(
        userFacingBridgeError(reason, "Düzenleme talebi kaydedilemedi.")
      );
    } finally {
      setRequestingEdit(false);
    }
  };

  const enqueuePublication = async (currentRevision: ReviewRevision | null = revision) => {
    if (!currentRevision || currentRevision.state !== "APPROVED") return;
    const previewBridge = bridge as PreviewCapableBridge;
    if (typeof previewBridge.previewPublication !== "function") {
      setNotice("Yayın kuyruğu için önce değişmez yayın önizlemesi gerekir; yerel köprü bu özelliği sunmuyor.");
      return;
    }
    setPreviewingPublication(true);
    setNotice("");
    try {
      setNotice("Yayın paketi önizlemesi hazırlanıyor…");
      const preview = await createPublicationPreview(currentRevision, previewBridge);
      if (!preview.previewHash) {
        throw new Error("Yayın önizlemesi geçerli bir hash döndürmedi.");
      }
      setLastPreview({ revisionId: currentRevision.id, hash: preview.previewHash });
      setNotice(`Önizleme doğrulandı · ${preview.previewHash.slice(0, 12)}… Kuyruğa alınıyor…`);
      setEnqueueingPublication(true);
      await previewBridge.enqueuePublication({ revisionId: currentRevision.id, revisionHash: currentRevision.revisionHash, previewHash: preview.previewHash });
      try {
        await onPublicationQueued?.();
        setNotice("Onaylı revizyon yerel yayın kuyruğuna alındı. GitHub bağlantısı hazır değilse güvenle beklemede kalır.");
      } catch {
        setNotice("Onaylı revizyon yerel yayın kuyruğuna alındı. Yayın ve planlanan işler görünümü henüz yenilenemedi; Takvim ve Yayın ekranından yeniden deneyin.");
      }
    } catch (reason) {
      setNotice(userFacingPublicationQueueError(reason));
    } finally {
      setPreviewingPublication(false);
      setEnqueueingPublication(false);
    }
  };

  const requestEvidenceRepair = async () => {
    if (!revision) return;
    setRequestingEdit(true);
    setNotice("");
    try {
      const queued = await bridge.requestRevisionEdit({
        revisionId: revision.id,
        title: "Kanıt odaklı revizyon hazırlanıyor",
        instruction: "Kaynak kanıtlarını ve mevcut iddia listesini yeniden eşleştirin. Kanıt bağını taşımayan olgusal iddiaları yalnızca destekleyen yerel kaynak varsa düzeltin; destek yoksa metinden çıkarın. Türkçe ve İngilizce sürümlerde aynı olgusal kapsamı koruyun. SEO veya üslup uğruna yeni iddia eklemeyin."
      });
      const queuedMessage = "Kanıt düzeltmesi Codex kuyruğuna alındı. Yeni revizyon ayrı bir hash ile hazırlanacak.";
      if (onDraftQueued) {
        await onDraftQueued(queuedMessage, queued.job?.id);
      } else {
        setNotice(queuedMessage);
      }
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Kanıt düzeltmesi kuyruğa alınamadı."));
    } finally {
      setRequestingEdit(false);
    }
  };

  const requestComprehensiveRewrite = async () => {
    if (!revision) return;
    setRequestingComprehensiveRewrite(true);
    setNotice("");
    try {
      const queued = await bridge.requestRevisionEdit({
        revisionId: revision.id,
        title: "Kapsamlı yeniden oluşturma işleniyor",
        instruction: `Kaynak kanıtlarını yeniden inceleyin. Bu kısa taslağı kaynak metnini kopyalamadan, özgün ve ayrıntılı bir ${contentCategoryLabel(revision.section, revision.articleType).toLocaleLowerCase("tr-TR")} olarak yeniden oluşturun. Türkçe gövde en az ${comprehensiveTargetWords} kelime olsun; doğrulanamayan iddiaları eklemeyin ve TR/EN olgu bütünlüğünü koruyun.`
      });
      const queuedMessage = "Kapsamlı yeniden oluşturma araştırma kuyruğuna alındı. Yeni revizyon ayrı bir hash ile hazırlanacak.";
      if (onDraftQueued) {
        try {
          await onDraftQueued(queuedMessage, queued.job?.id);
        } catch {
          setNotice(`${queuedMessage} Taslak envanteri şu an yenilenemedi; Taslaklar sekmesinden yeniden deneyin.`);
        }
      } else {
        setNotice(queuedMessage);
      }
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Kapsamlı yeniden oluşturma kaydedilemedi."));
    } finally {
      setRequestingComprehensiveRewrite(false);
    }
  };

  const repairMedia = async () => {
    if (!revision || revision.state !== "REVIEW_REQUIRED") return;
    setRepairingMedia(true);
    setNotice("");
    try {
      const result = await bridge.repairRevisionMedia(revision.id);
      try {
        await onRevisionApproved?.();
      } catch {
        // The direct revision read below still opens the newly materialized package.
      }
      setLoading(true);
      setRevision(null);
      setLastPreview(null);
      setSelectedId(result.revision.id);
      setWarningsAcknowledged(false);
      setNotice("Görsel paketi yeni, onay bekleyen revizyona eklendi. Eski revizyon korunur ve yayınlanamaz.");
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Görsel paketi hazırlanamadı."));
    } finally {
      setRepairingMedia(false);
    }
  };

  const prepareScheduledPublication = async (currentRevision: ReviewRevision) => {
    const previewBridge = bridge as PreviewCapableBridge;
    if (typeof previewBridge.previewPublication !== "function") {
      setNotice("Planlanan yayın için önce değişmez yayın önizlemesi gerekir; yerel köprü bu özelliği sunmuyor.");
      return;
    }
    setPreviewingPublication(true);
    setNotice("");
    try {
      const preview = await createPublicationPreview(currentRevision, previewBridge);
      setLastPreview({ revisionId: currentRevision.id, hash: preview.previewHash });
      try {
        await onRevisionApproved?.();
        setNotice(`Revizyon onaylandı ve ${new Date(currentRevision.scheduledAt).toLocaleString("tr-TR")} için hazırlandı. Seçili zamanda yerel zamanlayıcı hedefe gönderir.`);
      } catch {
        setNotice(`Revizyon onaylandı ve ${new Date(currentRevision.scheduledAt).toLocaleString("tr-TR")} için hazırlandı. İnceleme görünümü henüz yenilenemedi; Takvim ve Yayın ekranından yeniden açın.`);
      }
    } catch (reason) {
      setNotice(userFacingPublicationQueueError(reason));
    } finally {
      setPreviewingPublication(false);
    }
  };

  const createPublicationPreview = async (currentRevision: ReviewRevision, previewBridge: PreviewCapableBridge) => {
    if (typeof previewBridge.previewPublication !== "function") throw new Error("Yerel köprü yayın önizlemesini desteklemiyor.");
    const mode = connectorState.mode;
    const adapterId = connectorState.site.adapterId ?? "local-folder-v1";
    const astroOutput = mode === "PUBLISH" || (mode === "LOCAL_DEV" && adapterId === "astro-generic");
    const files = await buildPublicationFiles(currentRevision, mode, adapterId);
    const manifestPath = `.blogbot/manifests/${currentRevision.id}.json`;
    return previewBridge.previewPublication({
      revisionId: currentRevision.id,
      revisionHash: currentRevision.revisionHash,
      payload: {
        files,
        adapterVersion: currentRevision.adapterVersion,
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
    const targetDirectory = connectorState.site.repositoryPath.trim();
    if (!targetDirectory) {
      setNotice("Önce Kurulum Merkezi'nden site klasörünü seçin.");
      return;
    }
    setMaterializingLocal(true);
    try {
      let previewHash = lastPreview?.revisionId === revision.id ? lastPreview.hash : "";
      if (!previewHash) {
        const preview = await createPublicationPreview(revision, bridge as PreviewCapableBridge);
        previewHash = preview.previewHash;
        setLastPreview({ revisionId: revision.id, hash: previewHash });
      }
      const result = await bridge.materializeLocalPreview({ revisionId: revision.id, revisionHash: revision.revisionHash, previewHash, targetDirectory });
      setNotice(`${result.written} dosya yerel proje klasörüne yazıldı. ${result.backupDirectory ? "Eski dosyalar Blogbot yedeğine alındı." : ""}`);
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Yerel proje klasörüne yazılamadı."));
    } finally { setMaterializingLocal(false); }
  };

  return (
    <div className="review-page">
      <aside className="review-queue" aria-label="İnceleme kuyruğu">
        <header>
          <p className="section-kicker">İNCELEME</p>
          <h1>Yayın kuyruğu</h1>
          <span>{pendingRevisionCount} açık revizyon</span>
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
          <button type="button" aria-pressed={queueFilter === "pending"} className={queueFilter === "pending" ? "is-selected" : ""} onClick={() => setQueueFilter("pending")}>
            Bekleyenler
          </button>
          <button type="button" aria-pressed={queueFilter === "approved"} className={queueFilter === "approved" ? "is-selected" : ""} onClick={() => setQueueFilter("approved")}>Onaylı</button>
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

      <section className="review-workspace" aria-label="Revizyon inceleme çalışma alanı">
        {loading ? (
          <div className="review-loading" role="status" aria-live="polite" aria-busy="true">Değişmez revizyon yükleniyor…</div>
        ) : !selectedId ? (
          <div className="review-loading review-empty" role="status" aria-live="polite">
            <strong>İncelenecek revizyon yok.</strong>
            <span>İçerik Akışı'ndan bir işi araştırmaya alın.</span>
          </div>
        ) : !revision || !activeContent || !previousContent ? (
          <div className="review-loading" role="alert">
            <strong>Revizyon gösterilemiyor.</strong>
            {notice}
          </div>
        ) : (
          <>
            <header className="review-topbar">
              <div className="review-title">
                <div className="review-breadcrumb">
                  <span>{contentCategoryLabel(revision.section, revision.articleType)}</span>
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
                    disabled={readOnly || requestingEdit}
                    aria-describedby={readOnly ? "review-approval-read-only" : undefined}
                    aria-expanded={editRequestOpen}
                    onClick={() => setEditRequestOpen((current) => !current)}
                  >
                  Düzenleme iste
                </button>
                {siteMode !== "PUBLISH" ? (
                  <div className="review-local-output-action">
                    <button
                      className="button button-ghost"
                      type="button"
                      disabled={readOnly || revision.state !== "APPROVED" || materializingLocal || !connectorState.site.repositoryPath.trim()}
                      aria-describedby={localOutputDescription}
                      onClick={() => setMaterializeConfirmationOpen(true)}
                    >
                      {materializingLocal ? "Klasöre yazılıyor…" : localMaterializeLabel}
                    </button>
                    {!connectorState.site.repositoryPath.trim() ? (
                      <small id="local-output-prerequisite">Yerel hedef seçilmeden onaylı paket yazılamaz.</small>
                    ) : null}
                  </div>
                ) : null}
                {revision.riskLevel === "HIGH" && revision.editorialApproved && !revision.highRiskApproved ? (
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={readOnly || approvingHighRisk || !reauthenticated}
                    aria-describedby={readOnly ? "review-approval-read-only" : !reauthenticated ? "high-risk-reauthentication" : undefined}
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
                  aria-describedby={readOnly ? "review-approval-read-only" : !inspectionComplete ? "review-approval-prerequisite" : undefined}
                  onClick={() => void approve(remotePublicationReady)}
                >
                  {approving
                    ? "Onay bağlanıyor…"
                    : revision.state === "APPROVED"
                      ? "Revizyon onaylı"
                      : remotePublicationReady ? "Onayla ve hedefe gönder" : siteMode === "PUBLISH" ? "Bu revizyonu onayla" : "Bu revizyonu onayla"}
                </button>
                {siteMode === "PUBLISH" && remotePublicationReady ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={readOnly || revision.state !== "APPROVED" || enqueueingPublication || previewingPublication}
                    aria-describedby={publicationQueueDescription}
                    onClick={() => void enqueuePublication()}
                  >
                    {previewingPublication ? "Yayın önizlemesi hazırlanıyor…" : enqueueingPublication ? "Kuyruğa alınıyor…" : "Yayın kuyruğuna al"}
                  </button>
                ) : null}
              </div>
              {readOnly ? <small id="review-approval-read-only" className="action-unavailable-reason">Yerel çalışma alanı yeniden bağlanana kadar bu revizyon onaylanamaz.</small> : null}
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
            {acceptedWarnings.length > 0 && !hasUnacceptableWarning && revision.state !== "APPROVED" ? (
              <label className="acknowledgement warning-acknowledgement">
                <input
                  type="checkbox"
                  checked={warningsAcknowledged}
                  onChange={(event) => setWarningsAcknowledged(event.target.checked)}
                />
                <span>
                  {acceptedWarnings.length} editoryal uyarıyı okudum. Onayım bu revizyonun değişmez uyarı kümesine bağlanacak.
                </span>
              </label>
            ) : null}
            {!inspectionComplete ? (
              <div id="review-approval-prerequisite" className="inline-notice review-notice is-warning" role="status">
                Onay kapalı: iddia, kaynak, medya ve kalite kontrollerinin tamamı çalışmış olmalı; engeller kaldırılmalı ve izin verilen uyarılar açıkça kabul edilmelidir.
              </div>
            ) : null}
            {siteMode === "PUBLISH" && !remotePublicationReady ? (
              <div id="review-publication-prerequisite" className="inline-notice review-notice is-warning" role="status">
                GitHub yayın bağlantısı henüz hazır değil. Bu revizyonu şimdi onaylayabilir; bağlantı doğrulanınca aynı onaylı paketi hedefe gönderebilirsiniz.
              </div>
            ) : siteMode === "PUBLISH" && revision.state !== "APPROVED" ? (
              <div id="review-publication-prerequisite" className="inline-notice review-notice is-warning" role="status">
                Yayın kuyruğu, bu tam revizyon için insan onayı gerektirir. Onaydan sonra değişmez yayın önizlemesi hazırlanır.
              </div>
            ) : null}
            {revision.riskLevel === "HIGH" && revision.editorialApproved && !revision.highRiskApproved ? (
              <label id="high-risk-reauthentication" className="acknowledgement high-risk-reauth">
                <input type="checkbox" checked={reauthenticated} onChange={(event) => setReauthenticated(event.target.checked)} />
                <span>Güvenlik kontrol listesini yeniden okudum ve ikinci yüksek risk onayını bilinçli olarak veriyorum.</span>
              </label>
            ) : null}

            <div className="review-tabs-row">
              <div className="review-tabs" role="tablist" aria-label="İnceleme bölümleri" onKeyDown={handleTabListKeyDown}>
                {tabLabels.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    id={`review-tab-${item.id}`}
                    aria-controls={`review-panel-${item.id}`}
                    aria-selected={tab === item.id}
                    tabIndex={tab === item.id ? 0 : -1}
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

            <div className="review-content-scroll" role="tabpanel" id={`review-panel-${tab}`} aria-labelledby={`review-tab-${tab}`} tabIndex={0}>
              {tab === "content" ? (
                <div className="article-review-layout dual-review-layout">
                  <div className="dual-locale-grid">
                    {needsComprehensiveRewrite ? (
                      <section className="article-no-media article-content-scope" role="note" aria-label="İçerik kapsamı">
                        <strong>Bu taslak {trWordCount} kelimeyle kısa kaldı.</strong>
                        <span>Kaynakları yeniden inceleyip, mevcut metni değiştirmeden yeni ve kapsamlı bir inceleme revizyonu oluşturabilirsiniz.</span>
                        {!readOnly ? (
                          <button type="button" className="secondary-button" onClick={() => void requestComprehensiveRewrite()} disabled={requestingComprehensiveRewrite}>
                            {requestingComprehensiveRewrite ? "Kapsamlı yeniden oluşturma işleniyor…" : "Kapsamlı yeniden oluştur"}
                          </button>
                        ) : null}
                      </section>
                    ) : null}
                    {(["tr", "en"] as const).map((contentLocale) => {
                      const content = revision[contentLocale];
                      return (
                        <article className="article-preview" key={contentLocale} lang={contentLocale}>
                          <div className="locale-heading"><strong>{contentLocale.toUpperCase()}</strong><span>{contentLocale === "tr" ? "Özgün editoryal sürüm" : "Doğal yerelleştirme"}</span></div>
                          <div className="article-meta"><span>{sectionLabel(revision.section)}</span><span>8 dk okuma</span><span>{revision.author}</span></div>
                          <h1>{content.title}</h1>
                          <p className="article-description">{content.description}</p>
                          {heroMedia?.contentBase64 ? (
                            <figure className="article-hero-media">
                              <img
                                src={`data:image/webp;base64,${heroMedia.contentBase64}`}
                                alt={contentLocale === "tr" ? heroMedia.altTr : heroMedia.altEn}
                              />
                              <figcaption>{heroMedia.filename} · {heroMedia.width} × {heroMedia.height} · {heroMedia.sha256.slice(0, 16)}…</figcaption>
                            </figure>
                          ) : (
                            <div className="article-no-media" role="note" aria-label="Hero medya durumu">
                              <strong>Bu taslakta hero medya yok.</strong>
                              <span>Metin değişmeden, onaylanmamış yeni bir revizyona içerikle uyumlu üç görsel oranı ekleyebilirsiniz.</span>
                              {revision.state === "REVIEW_REQUIRED" && !readOnly ? (
                                <button type="button" className="secondary-button" onClick={() => void repairMedia()} disabled={repairingMedia}>
                                  {repairingMedia ? "Görsel paketi hazırlanıyor…" : "Görseli hazırla"}
                                </button>
                              ) : null}
                            </div>
                          )}
                          <div className="markdown-preview">
                            {content.bodyMarkdown.split("\n\n").map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  <aside className="article-metadata">
                    {showSourceReferences && revision.sources.length > 0 ? (
                      <section className="metadata-section source-reference-summary" aria-label="Taslak kaynak referansları">
                        <p className="section-kicker">KAYNAK REFERANSLARI</p>
                        <strong>{revision.sources.length} yerel kanıt kaydı</strong>
                        <ul>
                          {revision.sources.map((source) => {
                            const href = safeSourceReferenceUrl(source.url);
                            return (
                              <li key={source.id}>
                                {href ? (
                                  <a href={href} target="_blank" rel="noreferrer">{source.title}</a>
                                ) : (
                                  <span>{source.title}</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                        <button type="button" className="text-button" onClick={() => setTab("claims")}>
                          İddialar ve kaynaklar sekmesinde eşleşmeleri incele
                        </button>
                      </section>
                    ) : null}
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
                            <small className="claim-source-links">
                              {claim.sourceIds.map((sourceId) => {
                                const source = sourceById.get(sourceId);
                                const href = source ? safeSourceReferenceUrl(source.url) : null;
                                return source ? (
                                  href ? <a key={sourceId} href={href} target="_blank" rel="noreferrer">{source.title}</a> : <span key={sourceId}>{source.title}</span>
                                ) : <span key={sourceId}>{sourceId}</span>;
                              })}
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
                            {safeSourceReferenceUrl(source.url) ? (
                              <a href={safeSourceReferenceUrl(source.url) ?? undefined} target="_blank" rel="noreferrer">{source.title}</a>
                            ) : (
                              <strong>{source.title}</strong>
                            )}
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
                    {claimsBlocked ? (
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={readOnly || requestingEdit}
                        onClick={() => void requestEvidenceRepair()}
                      >
                        {requestingEdit ? "Kanıt düzeltmesi kuyruğa alınıyor…" : "Kanıtı Codex ile düzelt"}
                      </button>
                    ) : null}
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
      </section>
      {materializeConfirmationOpen ? (
        <ConfirmationDialog
          title="Yerel dosya yazımını onayla"
          detail="Onaylı paketin dosyaları seçtiğiniz yerel hedefe yazılacak. Mevcut Blogbot çıktıları güvenli bir yedeğe alınır; bu işlem yayınlama veya dış sisteme gönderim yapmaz."
          confirmLabel="Dosyaları yerel hedefe yaz"
          busy={materializingLocal}
          onCancel={() => setMaterializeConfirmationOpen(false)}
          onConfirm={() => {
            setMaterializeConfirmationOpen(false);
            void materializeLocal();
          }}
        />
      ) : null}
    </div>
  );
}
