import { useEffect, useMemo, useRef, useState } from "react";

import {
  userFacingBridgeError,
  userFacingPublicationQueueError,
  type BlogbotBridge,
  type EditorialApprovalAttestationV3
} from "../bridge.ts";
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
type EditorialApprovalRequirement = "EDITORIAL_REVIEW" | "EXPERT_REVIEW" | "ETHICS_REVIEW";
export const MAX_MEDIA_PREVIEW_LOADS = 4;
const MEDIA_PREVIEW_CONCURRENCY = 2;
export type MediaPreviewAsset = Pick<ReviewRevision["media"][number], "role" | "sha256" | "byteSize" | "contentBase64">;

// eslint-disable-next-line react-refresh/only-export-components -- pure selection is tested with deterministic bridge fakes.
export function selectMediaPreviewAssets(media: MediaPreviewAsset[]): MediaPreviewAsset[] {
  return [...media]
    .sort((left, right) => Number(right.role === "hero") - Number(left.role === "hero"))
    .filter((asset, index, items) => items.findIndex((candidate) => candidate.sha256 === asset.sha256) === index)
    .slice(0, MAX_MEDIA_PREVIEW_LOADS);
}

// eslint-disable-next-line react-refresh/only-export-components -- pure preview reader is tested with deterministic bridge fakes.
export async function loadRevisionMediaPreviews({
  revisionId,
  media,
  readMedia
}: {
  revisionId: string;
  media: MediaPreviewAsset[];
  readMedia: (input: { revisionId: string; sha256: string }) => Promise<{ mimeType: string; contentBase64: string }>;
}): Promise<{ urls: Record<string, string>; errors: Record<string, true>; selectedSha256: string[] }> {
  const selected = selectMediaPreviewAssets(media);
  const urls: Record<string, string> = {};
  const errors: Record<string, true> = {};
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < selected.length) {
      const asset = selected[nextIndex++];
      if (!asset) continue;
      try {
        if (asset.contentBase64) {
          urls[asset.sha256] = `data:image/webp;base64,${asset.contentBase64}`;
          continue;
        }
        const byteSize = asset.byteSize;
        if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize < 1 || !/^[a-f0-9]{64}$/iu.test(asset.sha256)) {
          errors[asset.sha256] = true;
          continue;
        }
        const loaded = await readMedia({ revisionId, sha256: asset.sha256 });
        urls[asset.sha256] = `data:${loaded.mimeType};base64,${loaded.contentBase64}`;
      } catch {
        errors[asset.sha256] = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEDIA_PREVIEW_CONCURRENCY, selected.length) }, worker));
  return { urls, errors, selectedSha256: selected.map((asset) => asset.sha256) };
}

type ReviewRevisionV3 = ReviewRevision & {
  packageVersion: 3;
  publicationSources: NonNullable<ReviewRevision["publicationSources"]>;
  approvalRequirements: EditorialApprovalRequirement[];
};

function asReviewRevisionV3(revision: ReviewRevision | null): ReviewRevisionV3 | null {
  if (
    revision?.packageVersion !== 3 ||
    !Array.isArray(revision.publicationSources) ||
    revision.publicationSources.length === 0 ||
    !Array.isArray((revision as Partial<ReviewRevisionV3>).approvalRequirements)
  ) {
    return null;
  }
  return revision as ReviewRevisionV3;
}

function sourceRoleLabel(role: ReviewRevisionV3["publicationSources"][number]["role"]): string {
  if (role === "primary") return "birincil";
  if (role === "independent") return "bağımsız";
  return "destekleyici";
}

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
  { id: "claims", label: "Kaynak kontrolü" },
  { id: "media", label: "Medya" },
  { id: "gates", label: "Yayın kontrolü" },
  { id: "diff", label: "Değişiklikler" }
];

const acceptableWarningIds = new Set(["SINGLE_OFFICIAL_SOURCE_EXCEPTION", "contradictions", "seo", "media"]);

function isAcceptableWarning(gate: GateView): boolean {
  if (gate.policyVersion === "2") {
    return (gate.id === "seo" && gate.reasonCode === "SEO_POLISH") ||
      (gate.id === "contradictions" && gate.reasonCode === "DISCLOSED_SOURCE_DISAGREEMENT");
  }
  return gate.policyVersion === "1" && acceptableWarningIds.has(gate.id);
}

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

function readingTimeMinutes(value: string): number {
  return Math.max(1, Math.ceil(wordCount(value) / 200));
}

function scheduledAtLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Geçerli zaman seçilmedi";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function claimEvidenceLabel(claims: ReviewRevision["claims"]): string {
  const unresolved = claims.filter((claim) => claim.status !== "VERIFIED").length;
  return unresolved === 0 ? "Tüm iddialar kaynaklı" : `${unresolved} iddia kaynak bekliyor`;
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
      ...(gate.reasonCode ? { reasonCode: gate.reasonCode } : {}),
      state: gate.state
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(JSON.stringify(warnings));
}

function QueueCard({
  item,
  selected,
  onSelect,
  disabled = false
}: {
  item: QueueItem;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`review-queue-item ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      disabled={disabled}
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
  embedded = false,
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
  const [mediaDataUrls, setMediaDataUrls] = useState<Record<string, string>>({});
  const [mediaLoadErrors, setMediaLoadErrors] = useState<Record<string, true>>({});
  const [mediaPreviewRefreshNonce, setMediaPreviewRefreshNonce] = useState(0);
  const [mediaPreviewLoading, setMediaPreviewLoading] = useState(false);
  const mediaPreviewLoadInFlight = useRef(false);
  const mediaPreviewRequestId = useRef(0);
  const mediaPreviewLatestRequest = useRef<{
    id: number;
    revisionId: string;
    media: MediaPreviewAsset[];
    readMedia: BlogbotBridge["readRevisionMedia"];
  } | null>(null);
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
  const [revokeReason, setRevokeReason] = useState("");
  const [revokePanelOpen, setRevokePanelOpen] = useState(false);
  const [revokeConfirmationOpen, setRevokeConfirmationOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const [editorialReviewer, setEditorialReviewer] = useState("");
  const [sourceRoleAcknowledgements, setSourceRoleAcknowledgements] = useState<Record<string, boolean>>({});
  const [expertReviewer, setExpertReviewer] = useState("");
  const [expertQualifications, setExpertQualifications] = useState("");
  const [expertReviewScope, setExpertReviewScope] = useState("");
  const [ethicsReviewer, setEthicsReviewer] = useState("");
  const [ethicsReviewScope, setEthicsReviewScope] = useState("");
  const [ethicsRationale, setEthicsRationale] = useState("");

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
          setEditorialReviewer("");
          setSourceRoleAcknowledgements({});
          setExpertReviewer("");
          setExpertQualifications("");
          setExpertReviewScope("");
          setEthicsReviewer("");
          setEthicsReviewScope("");
          setEthicsRationale("");
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

  useEffect(() => {
    mediaPreviewLatestRequest.current = {
      id: ++mediaPreviewRequestId.current,
      revisionId: revision?.id ?? "",
      media: selectMediaPreviewAssets(revision?.media ?? []),
      readMedia: bridge.readRevisionMedia
    };
    const drainLatestPreviewRequest = async (): Promise<void> => {
      if (mediaPreviewLoadInFlight.current) return;
      const request = mediaPreviewLatestRequest.current;
      if (!request) return;
      mediaPreviewLatestRequest.current = null;
      mediaPreviewLoadInFlight.current = true;
      setMediaPreviewLoading(true);
      setMediaLoadErrors({});
      try {
        const { urls, errors } = await loadRevisionMediaPreviews(request);
        if (request.id === mediaPreviewRequestId.current) {
          setMediaDataUrls(urls);
          setMediaLoadErrors(errors);
        }
      } finally {
        mediaPreviewLoadInFlight.current = false;
        if (mediaPreviewLatestRequest.current) {
          void drainLatestPreviewRequest();
        } else {
          setMediaPreviewLoading(false);
        }
      }
    };
    void Promise.resolve().then(drainLatestPreviewRequest);
  }, [bridge, revision, mediaPreviewRefreshNonce]);

  const retryMediaPreviews = () => {
    if (mediaPreviewLoadInFlight.current) return;
    setMediaPreviewRefreshNonce((value) => value + 1);
  };

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
  const hasUnacceptableWarning = acceptedWarnings.some((gate) => !isAcceptableWarning(gate));
  const claimsBlocked = Boolean(revision?.gates.some((gate) => gate.id === "claims" && gate.state === "BLOCK"));
  const mediaGateState = revision?.gates.find((gate) => gate.id === "media")?.state;
  const activeContent = revision?.[locale];
  const previousContent = revision?.previous[locale];
  const heroMedia = revision?.media.find((media) => media.role === "hero");
  const heroDataUrl = heroMedia ? mediaDataUrls[heroMedia.sha256] ?? null : null;
  const heroLoadError = Boolean(heroMedia && mediaLoadErrors[heroMedia.sha256]);
  const mediaPreviewSelection = useMemo(() => Object.fromEntries(selectMediaPreviewAssets(revision?.media ?? []).map((asset) => [asset.sha256, true])), [revision]);
  const heroPreviewLoading = Boolean(heroMedia && !heroDataUrl && !heroLoadError && mediaPreviewSelection[heroMedia.sha256]);
  const v3Revision = asReviewRevisionV3(revision);
  const requiresExpertReview = Boolean(v3Revision?.approvalRequirements.includes("EXPERT_REVIEW"));
  const requiresEthicsReview = Boolean(v3Revision?.approvalRequirements.includes("ETHICS_REVIEW"));
  const sourceRolesAcknowledged = Boolean(
    v3Revision?.publicationSources.every((source) => sourceRoleAcknowledgements[source.id] === true)
  );
  const humanAttestationComplete = Boolean(
    v3Revision &&
      editorialReviewer.trim() &&
      sourceRolesAcknowledged &&
      (!requiresExpertReview || (
        expertReviewer.trim() && expertQualifications.trim() && expertReviewScope.trim()
      )) &&
      (!requiresEthicsReview || (
        ethicsReviewer.trim() && ethicsReviewScope.trim() && ethicsRationale.trim()
      ))
  );
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
      revision.gates.every((gate) => gate.state !== "WARN" || isAcceptableWarning(gate)) &&
      (revision.gates.every((gate) => gate.state !== "WARN") || warningsAcknowledged) &&
      revision.claims.every((claim) => claim.status === "VERIFIED")
  );
  const approvalReady = inspectionComplete && humanAttestationComplete;

  const actionBusy = approving || approvingHighRisk || requestingEdit || requestingComprehensiveRewrite || repairingMedia || enqueueingPublication || previewingPublication || materializingLocal;

  const selectRevision = (revisionId: string) => {
    if (actionBusy) return;
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
    const approvalRevision = asReviewRevisionV3(revision);
    if (!approvalRevision) {
      setNotice("Bu eski revizyon yalnızca okunabilir. İnsan inceleme beyanı içeren V3 paketini oluşturup yeni revizyonu açın.");
      return;
    }
    if (!humanAttestationComplete) {
      setNotice("Onaydan önce editör adını, her kaynağın rol onayını ve gerekli uzman veya etik inceleme alanlarını tamamlayın.");
      return;
    }
    setApproving(true);
    setNotice("");
    try {
      const acceptedWarningSetHash = await warningSetHash(approvalRevision.gates);
      const attestation: EditorialApprovalAttestationV3 = {
        editorialReview: {
          reviewer: editorialReviewer.trim(),
          sourceRoles: approvalRevision.publicationSources.map((source) => ({
            sourceId: source.id,
            role: source.role
          }))
        },
        expertReview: requiresExpertReview ? {
          reviewer: expertReviewer.trim(),
          qualifications: expertQualifications.trim(),
          reviewScope: expertReviewScope.trim()
        } : null,
        ethicsReview: requiresEthicsReview ? {
          reviewer: ethicsReviewer.trim(),
          reviewScope: ethicsReviewScope.trim(),
          rationale: ethicsRationale.trim()
        } : null
      };
      const result = await bridge.approveRevision({
        revisionId: approvalRevision.id,
        expectedHash: approvalRevision.revisionHash,
        warningSetHash: acceptedWarningSetHash,
        packageVersion: 3,
        attestation
      });
      setRevision((current) =>
        current ? { ...current, state: result.state, editorialApproved: true } : current
      );
      if (dispatchAfterApproval && result.state === "APPROVED") {
        const approvedRevision = { ...approvalRevision, state: "APPROVED" as const, editorialApproved: true };
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
      const result = await bridge.approveHighRiskRevision({
        revisionId: revision.id,
        expectedHash: revision.revisionHash,
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

  const revokeApproval = async () => {
    if (!revision || revision.state !== "APPROVED" || revokeReason.trim().length < 10) return;
    setRevoking(true);
    setNotice("");
    try {
      const result = await bridge.revokeApproval({
        revisionId: revision.id,
        expectedHash: revision.revisionHash,
        reason: revokeReason.trim()
      });
      setRevision((current) => current ? {
        ...current,
        state: "REVIEW_REQUIRED",
        editorialApproved: false,
        highRiskApproved: false
      } : current);
      setRevokeReason("");
      setRevokePanelOpen(false);
      setLastPreview(null);
      try {
        await onRevisionApproved?.();
        setNotice(`Revizyon onayı geri çekildi · ${result.revisionHash.slice(0, 12)}…`);
      } catch {
        setNotice(`Revizyon onayı geri çekildi · ${result.revisionHash.slice(0, 12)}… İnceleme kuyruğu henüz yenilenemedi; sayfayı yenileyin.`);
      }
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Onay geri çekilemedi."));
    } finally {
      setRevoking(false);
      setRevokeConfirmationOpen(false);
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
      setNotice(`${result.written} dosya yerel proje klasörüne yazıldı. ${result.backupDirectory ? "Eski dosyalar OPE yedeğine alındı." : ""}`);
    } catch (reason) {
      setNotice(userFacingBridgeError(reason, "Yerel proje klasörüne yazılamadı."));
    } finally { setMaterializingLocal(false); }
  };

  return (
    <div className={`review-page${embedded ? " review-page-embedded" : ""}`}>
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
              disabled={actionBusy}
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
                {revision.state === "APPROVED" ? (
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={readOnly || revoking}
                    aria-expanded={revokePanelOpen}
                    onClick={() => setRevokePanelOpen((current) => !current)}
                  >
                    Onayı geri çek
                  </button>
                ) : null}
                <button
                  className="button button-primary"
                  type="button"
                  disabled={
                    approving ||
                    readOnly ||
                    !approvalReady ||
                    revision.state === "APPROVED"
                  }
                  aria-describedby={
                    readOnly
                      ? "review-approval-read-only"
                      : !v3Revision
                        ? "review-v3-upgrade-required"
                        : !approvalReady
                          ? "review-approval-prerequisite"
                          : undefined
                  }
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

            {revokePanelOpen && revision.state === "APPROVED" ? (
              <section className="edit-request-panel" aria-label="Revizyon onayını geri çek">
                <label className="field">
                  <span>Onayı geri çekme gerekçesi</span>
                  <textarea
                    value={revokeReason}
                    maxLength={512}
                    rows={3}
                    autoFocus
                    onChange={(event) => setRevokeReason(event.target.value)}
                    placeholder="Örnek: Kaynak doğrulaması yeniden yapılacak."
                  />
                </label>
                <div className="review-actions">
                  <button className="button button-ghost" type="button" onClick={() => setRevokePanelOpen(false)}>Vazgeç</button>
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={revoking || revokeReason.trim().length < 10}
                    onClick={() => setRevokeConfirmationOpen(true)}
                  >
                    Geri çekmeyi onayla
                  </button>
                </div>
              </section>
            ) : null}

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
                  <strong>Onay kaydı</strong>
                  Bu onay, metin, kaynaklar, görseller, plan ve iki dil sürümü için geçerlidir.
                  Bir şey değişirse yeniden inceleme gerekir.
              </span>
            </div>
            <details className="revision-technical-record">
              <summary>Teknik kayıt</summary>
              <code title={revision.revisionHash}>
                sha256:{revision.revisionHash.slice(0, 16)}…
              </code>
            </details>
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
            {revision.state !== "APPROVED" && !v3Revision ? (
              <div id="review-v3-upgrade-required" className="inline-notice review-notice is-warning" role="status">
                <strong>Bu içerik eski kurallarla hazırlanmış. Onaylanamaz.</strong>
                <span>İstediğiniz değişikliği yazın; sistem güncel inceleme kopyasını hazırlasın. Eski içerik olduğu gibi korunur.</span>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={readOnly || requestingEdit}
                  onClick={() => setEditRequestOpen(true)}
                >
                  Yeni inceleme kopyası oluştur
                </button>
              </div>
            ) : null}
            {revision.state !== "APPROVED" && v3Revision ? (
              <section className="edit-request-panel" aria-label="İnsan editoryal inceleme beyanı">
                <div className="review-section-heading">
                  <div>
                    <p className="section-kicker">İNSAN İNCELEMESİ</p>
                    <h2>Onayı veren kişileri ve kaynak rollerini doğrulayın</h2>
                  </div>
                </div>
                <label className="field">
                  <span>Sorumlu editörün adı</span>
                  <input
                    value={editorialReviewer}
                    maxLength={256}
                    autoComplete="name"
                    onChange={(event) => setEditorialReviewer(event.target.value)}
                    placeholder="Ad ve soyad"
                  />
                </label>
                <div className="snapshot-list" aria-label="Kaynak rol onayları">
                  {v3Revision.publicationSources.map((source) => (
                    <label className="acknowledgement" key={source.id}>
                      <input
                        type="checkbox"
                        checked={sourceRoleAcknowledgements[source.id] === true}
                        onChange={(event) => setSourceRoleAcknowledgements((current) => ({
                          ...current,
                          [source.id]: event.target.checked
                        }))}
                      />
                      <span>
                        <strong>{source.title}</strong> kaynağının <strong>{sourceRoleLabel(source.role)}</strong> rolünü ve bu revizyonda atıf aldığını doğruladım.
                      </span>
                    </label>
                  ))}
                </div>
                {requiresExpertReview ? (
                  <div className="edit-request-panel" aria-label="Uzman incelemesi">
                    <strong>Maddi, sağlık veya hukuki etkili içerik için uzman incelemesi gerekli</strong>
                    <label className="field"><span>Uzmanın adı</span><input value={expertReviewer} maxLength={256} onChange={(event) => setExpertReviewer(event.target.value)} /></label>
                    <label className="field"><span>Uzmanlık ve yeterlilik</span><textarea value={expertQualifications} maxLength={1000} rows={2} onChange={(event) => setExpertQualifications(event.target.value)} /></label>
                    <label className="field"><span>İnceleme kapsamı</span><textarea value={expertReviewScope} maxLength={2000} rows={2} onChange={(event) => setExpertReviewScope(event.target.value)} /></label>
                  </div>
                ) : null}
                {requiresEthicsReview ? (
                  <div className="edit-request-panel" aria-label="Etik inceleme">
                    <strong>Hassas konu etik incelemesi gerekli</strong>
                    <label className="field"><span>Etik incelemeyi yapan kişi</span><input value={ethicsReviewer} maxLength={256} onChange={(event) => setEthicsReviewer(event.target.value)} /></label>
                    <label className="field"><span>İnceleme kapsamı</span><textarea value={ethicsReviewScope} maxLength={2000} rows={2} onChange={(event) => setEthicsReviewScope(event.target.value)} /></label>
                    <label className="field"><span>Gerekçe ve zarar azaltma değerlendirmesi</span><textarea value={ethicsRationale} maxLength={4000} rows={3} onChange={(event) => setEthicsRationale(event.target.value)} /></label>
                  </div>
                ) : null}
              </section>
            ) : null}
            {!approvalReady && v3Revision && revision.state !== "APPROVED" ? (
              <div id="review-approval-prerequisite" className="inline-notice review-notice is-warning" role="status">
                Onay kapalı: iddia, kaynak, medya ve kalite kontrolleri tamamlanmalı; izin verilen uyarılar kabul edilmeli ve insan inceleme beyanı eksiksiz doldurulmalıdır.
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
                          <div className="article-meta"><span>{sectionLabel(revision.section)}</span><span>{readingTimeMinutes(content.bodyMarkdown)} dk okuma</span><span>{revision.author}</span></div>
                          <h1>{content.title}</h1>
                          <p className="article-description">{content.description}</p>
                          {heroMedia && heroDataUrl ? (
                            <figure className="article-hero-media">
                              <img
                                src={heroDataUrl}
                                width={heroMedia.width}
                                height={heroMedia.height}
                                loading="lazy"
                                alt={contentLocale === "tr" ? heroMedia.altTr : heroMedia.altEn}
                              />
                              <figcaption>{heroMedia.filename} · {heroMedia.width} × {heroMedia.height} · {heroMedia.sha256.slice(0, 16)}…</figcaption>
                            </figure>
                          ) : heroMedia && heroLoadError ? (
                            <div className="article-no-media" role="status" aria-live="polite">
                              <strong>Hero görseli yüklenemedi.</strong>
                              <button type="button" className="secondary-button" onClick={retryMediaPreviews} disabled={mediaPreviewLoading}>
                                Önizlemeyi tekrar dene
                              </button>
                            </div>
                          ) : heroMedia && heroPreviewLoading ? (
                            <div className="article-no-media" role="status" aria-live="polite">
                              <strong>Hero görseli yükleniyor.</strong>
                            </div>
                          ) : !heroMedia ? (
                            <div className="article-no-media" role="note" aria-label="Hero medya durumu">
                              <strong>Bu taslakta hero medya yok.</strong>
                              <span>Metin değişmeden, onaylanmamış yeni bir revizyona içerikle uyumlu üç görsel oranı ekleyebilirsiniz.</span>
                              {!heroMedia && revision.state === "REVIEW_REQUIRED" && !readOnly ? (
                                <button type="button" className="secondary-button" onClick={() => void repairMedia()} disabled={repairingMedia}>
                                  {repairingMedia ? "Görsel paketi hazırlanıyor…" : "Görseli hazırla"}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
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
                          Kaynak kontrolünde eşleşmeleri incele
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
                          <dd>{scheduledAtLabel(revision.scheduledAt)}</dd>
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
                        <p className="section-kicker">İÇERİK KONTROLÜ</p>
                        <h2>{revision.claims.length} önemli nokta</h2>
                      </div>
                      <span className={revision.claims.every((claim) => claim.status === "VERIFIED") ? "pass-label" : "warning-label"}>{claimEvidenceLabel(revision.claims)}</span>
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
                        <p className="section-kicker">KAYNAKLAR</p>
                        <h2>{revision.sources.length} kaynak kaydı</h2>
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
                            <details className="snapshot-integrity">
                              <summary>Teknik kayıt</summary>
                              <code>{source.contentHash}</code>
                            </details>
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
                    <span className={mediaGateState === "PASS" ? "pass-label" : "warning-label"}>
                      {mediaGateState === "PASS"
                        ? `${revision.media.length} / ${revision.media.length} uygun`
                        : revision.media.length === 0 ? "Medya eksik" : `${revision.media.length} medya · kontrol gerekli`}
                    </span>
                  </div>
                  <div className="media-grid">
                    {revision.media.map((media) => (
                      <article className="media-card" key={media.id}>
                        <div className="media-thumbnail" style={{ aspectRatio: `${media.width} / ${media.height}`, overflow: "hidden" }}>
                          {mediaDataUrls[media.sha256] ? (
                            <img
                              src={mediaDataUrls[media.sha256]}
                              width={media.width}
                              height={media.height}
                              loading="lazy"
                              alt={locale === "tr" ? media.altTr : media.altEn}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : (
                            <span>{mediaLoadErrors[media.sha256] ? "Önizleme yüklenemedi" : mediaPreviewSelection[media.sha256] ? "Önizleme hazırlanıyor" : "Bu görünümde yüklenmedi"}</span>
                          )}
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
                          {mediaLoadErrors[media.sha256] ? (
                            <button type="button" className="text-button" onClick={retryMediaPreviews} disabled={mediaPreviewLoading}>
                              Önizlemeyi tekrar dene
                            </button>
                          ) : null}
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
                      {summary.blockers > 0
                        ? `Yayın paketi ${summary.blockers} engel nedeniyle onaya hazır değil.`
                        : summary.warnings > 0
                          ? `Yayın paketi ${summary.warnings} uyarıyla tamamlandı; onaydan önce uyarıları inceleyin.`
                          : "Yayın paketi editoryal, SEO ve güvenlik sınırlarından geçti."}
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
          detail="Onaylı paketin dosyaları seçtiğiniz yerel hedefe yazılacak. Mevcut OPE çıktıları güvenli bir yedeğe alınır; bu işlem yayınlama veya dış sisteme gönderim yapmaz."
          confirmLabel="Dosyaları yerel hedefe yaz"
          busy={materializingLocal}
          onCancel={() => setMaterializeConfirmationOpen(false)}
          onConfirm={() => {
            setMaterializeConfirmationOpen(false);
            void materializeLocal();
          }}
        />
      ) : null}
      {revokeConfirmationOpen ? (
        <ConfirmationDialog
          title="Revizyon onayını geri çek"
          detail="Bu revizyonun exact-hash onayı geçersiz kılınacak ve henüz başlamamış yayın etkileri geri çağrılacak. Yeniden yayınlamak için yeni bir revizyon ve yeni insan onayı gerekir."
          confirmLabel="Onayı geri çek"
          busy={revoking}
          onCancel={() => setRevokeConfirmationOpen(false)}
          onConfirm={() => void revokeApproval()}
        />
      ) : null}
    </div>
  );
}
