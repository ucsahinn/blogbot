import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { createInvokeBridge, type BlogbotBridge, type InvokeTransport } from "./bridge.ts";
import {
  createDemoTransport,
  DEMO_REVIEW_MEDIA_BYTES,
  DEMO_REVIEW_MEDIA_SHA256
} from "./demo-data.ts";
import "./styles.css";

async function createQaBridge(): Promise<BlogbotBridge> {
  const requestedState = new URLSearchParams(window.location.search).get("state");
  if (requestedState) window.sessionStorage.setItem("blogbot.qa.state", requestedState);
  const state = requestedState ?? window.sessionStorage.getItem("blogbot.qa.state") ?? "ready";
  if (state === "error") throw new Error("QA_SENTINEL: Yerel engine başlatılamadı.");
  if (state === "loading") return new Promise<BlogbotBridge>(() => undefined);
  const base = createDemoTransport();
  if (state === "materialization-ready" && window.sessionStorage.getItem("blogbot.qa.materialization-target") === "saved") {
    await base("save_setup_connector", {
      connector: "site",
      config: { repositoryPath: "C:\\OPE-Demo", publicSiteUrl: "", mode: "LOCAL_ONLY" }
    });
  }
  let bootstrapCompleted = false;
  let bootstrapCalls = 0;
  let setupTargetSaved = false;
  let setupTargetTested = false;
  let sourceScanAccepted = false;
  let localEngineTested = false;
  let codexTested = false;
  let localWorkspaceRecovered = false;
  let retryAccepted = false;
  let candidatePromoted = false;
  let delayedCandidateWorkspaceReads = 0;
  let instantDraftCreated = false;
  let delayedInstantWorkspaceReads = 0;
  let revisionEditCreated = false;
  let delayedRevisionEditWorkspaceReads = 0;
  let liveDraftWorkspaceReads = 0;
  let candidateDismissed = false;
  let sourceSaved = false;
  let sourceScanCompleted = false;
  let sourceCatalogReads = 0;
  let localDevStatusFailures = 0;
  let publicationEnqueued = false;
  let revisionApproved = false;
  const transport: InvokeTransport = async (command, args) => {
    if (state === "source-refresh-race" && command === "list_sources") {
      sourceCatalogReads += 1;
      if (sourceCatalogReads === 1) {
        document.documentElement.dataset.qaSourceRefreshStarted = "true";
        await new Promise((resolve) => window.setTimeout(resolve, 80));
        return { sources: [] };
      }
    }
    if (state === "source-idempotent-replay" && command === "save_sources") {
      const incoming = Array.isArray(args?.sources) ? args.sources : [];
      const url = (incoming[0] as { url?: unknown } | undefined)?.url;
      const catalog = await base("list_sources") as { sources: Array<{ url: string }> };
      const existing = typeof url === "string" ? catalog.sources.find((source) => source.url === url) : undefined;
      if (!existing) throw new Error("QA_SENTINEL: EXPECTED_EXISTING_SOURCE_MISSING");
      return { sources: [existing] };
    }
    if (state === "engine-diagnostics-failure" && command === "get_engine_diagnostics") {
      throw new Error("QA_SENTINEL: ENGINE_DIAGNOSTICS_UNAVAILABLE");
    }
    if (state === "operations-read-failure" && command === "get_operations") {
      throw new Error("QA_SENTINEL: OPERATIONS_UNAVAILABLE");
    }
    if (state === "autostart-status-failure" && command === "autostart_status") {
      throw new Error("QA_SENTINEL: AUTOSTART_STATUS_UNAVAILABLE");
    }
    if (state === "local-dev-status-failure" && command === "local_dev_status" && localDevStatusFailures++ === 0) {
      throw new Error("QA_SENTINEL: LOCAL_DEV_STATUS_UNAVAILABLE");
    }
    if (state === "local-dev-stop-failure" && command === "stop_local_dev") {
      throw new Error("QA_SENTINEL: LOCAL_DEV_STOP_UNAVAILABLE");
    }
    if ((state === "engine-timeout" || state === "recovery-postsuccess-refresh-failure") && command === "test_local_engine") {
      throw new Error("ENGINE_RESPONSE_TIMEOUT");
    }
    if (state === "operations-refresh-race" && command === "get_bootstrap_snapshot") {
      bootstrapCalls += 1;
      if (bootstrapCalls > 1) bootstrapCompleted = false;
    }
    const value = await base(command, args);
    if (state === "materialization-ready" && command === "save_setup_connector") {
      window.sessionStorage.setItem("blogbot.qa.materialization-target", "saved");
    }
    if (state === "missing-media" && command === "get_review_revision") {
      const revision = structuredClone(value) as { media: Array<Record<string, unknown>> };
      revision.media = [];
      return revision;
    }
    if (state === "materialization-ready" && command === "preview_publication") {
      const payload = args?.payload as { files?: Array<{ content?: unknown }> } | undefined;
      const files = payload?.files ?? [];
      const revisionId = String(args?.revisionId ?? "");
      const mediaReferences = files.filter((file) => {
        const content = file.content as { kind?: unknown; revisionId?: unknown; sha256?: unknown; byteSize?: unknown } | undefined;
        return content?.kind === "engine-media-ref" &&
          content.revisionId === revisionId &&
          revisionId === "rev-identity" &&
          content.sha256 === DEMO_REVIEW_MEDIA_SHA256 &&
          content.byteSize === DEMO_REVIEW_MEDIA_BYTES;
      });
      if (files.length !== 5 || mediaReferences.length !== 2) {
        throw new Error("QA_SENTINEL: MATERIALIZATION_BUNDLE_INCOMPLETE");
      }
      return value;
    }
    if (state === "materialization-ready" && command === "materialize_local_preview") {
      return { ...(value as Record<string, unknown>), written: 5 };
    }
    if (state === "publish-ready" && command === "enqueue_publication") {
      publicationEnqueued = true;
    }
    if ((state === "approval-refresh" || state === "high-risk-approval-refresh") && (command === "approve_revision" || command === "approve_high_risk_revision")) {
      revisionApproved = true;
    }
    if (state === "setup-postsave-refresh-failure" && command === "save_setup_connector") {
      setupTargetSaved = true;
    }
    if (state === "setup-posttest-refresh-failure" && command === "test_setup_connector") {
      setupTargetTested = true;
    }
    if (state === "scan-status-refresh-failure" && (command === "scan_all_sources" || command === "scan_source")) {
      sourceScanAccepted = true;
    }
    if (state === "engine-posttest-refresh-failure" && command === "test_local_engine") {
      localEngineTested = true;
    }
    if (state === "codex-posttest-refresh-failure" && command === "test_codex_runtime") {
      codexTested = true;
    }
    if (state === "recovery-postsuccess-refresh-failure" && command === "recover_local_workspace") {
      localWorkspaceRecovered = true;
    }
    if (state === "retry-postsave-refresh-failure" && command === "retry_job") {
      retryAccepted = true;
    }
    if (state === "candidate-postpromotion-summary-failure" && command === "promote_candidate") {
      candidatePromoted = true;
    }
    if ((state === "candidate-inventory-delay" || state === "candidate-inventory-unavailable" || state === "candidate-inventory-read-failure" || state === "candidate-inventory-retry-read-failure") && command === "promote_candidate") {
      candidatePromoted = true;
    }
    if (state === "instant-inventory-delay" && command === "create_instant_draft") {
      instantDraftCreated = true;
    }
    if (state === "revision-edit-inventory-delay" && command === "request_revision_edit") {
      revisionEditCreated = true;
    }
    if (state === "candidate-postdismiss-summary-failure" && command === "dismiss_candidate") {
      candidateDismissed = true;
    }
    if (state === "source-postsave-summary-failure" && command === "save_sources") {
      sourceSaved = true;
    }
    if (state === "scan-postcompletion-summary-failure" && (command === "scan_all_sources" || command === "scan_source")) {
      sourceScanCompleted = true;
    }
    if (
      ((state === "setup-postsave-refresh-failure" && setupTargetSaved) ||
        (state === "setup-posttest-refresh-failure" && setupTargetTested)) &&
      command === "get_connector_state"
    ) {
      throw new Error("QA_SENTINEL: CONNECTOR_STATE_REFRESH_UNAVAILABLE");
    }
    if (state === "scan-status-refresh-failure" && sourceScanAccepted && command === "get_source_scan_status") {
      throw new Error("QA_SENTINEL: SCAN_STATUS_REFRESH_UNAVAILABLE");
    }
    if (state === "engine-posttest-refresh-failure" && localEngineTested && command === "get_prerequisite_status") {
      throw new Error("QA_SENTINEL: PREREQUISITE_REFRESH_UNAVAILABLE");
    }
    if (state === "codex-posttest-refresh-failure" && codexTested && command === "get_prerequisite_status") {
      throw new Error("QA_SENTINEL: PREREQUISITE_REFRESH_UNAVAILABLE");
    }
    if (state === "recovery-postsuccess-refresh-failure" && localWorkspaceRecovered && command === "get_prerequisite_status") {
      throw new Error("QA_SENTINEL: PREREQUISITE_REFRESH_UNAVAILABLE");
    }
    if (state === "retry-postsave-refresh-failure" && retryAccepted && command === "get_editorial_workspace") {
      throw new Error("QA_SENTINEL: EDITORIAL_WORKSPACE_REFRESH_UNAVAILABLE");
    }
    if (state === "candidate-postpromotion-summary-failure" && candidatePromoted && command === "get_bootstrap_snapshot") {
      throw new Error("QA_SENTINEL: DASHBOARD_SUMMARY_REFRESH_UNAVAILABLE");
    }
    if ((state === "candidate-inventory-delay" || state === "candidate-inventory-unavailable") && candidatePromoted && command === "get_editorial_workspace") {
      delayedCandidateWorkspaceReads += 1;
      if (state === "candidate-inventory-unavailable" || delayedCandidateWorkspaceReads <= 4) {
        const workspace = structuredClone(value) as { drafts: Array<{ id: string }> };
        workspace.drafts = workspace.drafts.filter((draft) => !draft.id.startsWith("draft-candidate-"));
        return workspace;
      }
    }
    if (state === "candidate-inventory-read-failure" && candidatePromoted && command === "get_editorial_workspace") {
      throw new Error("QA_SENTINEL: EDITORIAL_WORKSPACE_REFRESH_UNAVAILABLE");
    }
    if (state === "candidate-inventory-retry-read-failure" && candidatePromoted && command === "get_editorial_workspace") {
      delayedCandidateWorkspaceReads += 1;
      if (delayedCandidateWorkspaceReads === 1) {
        const workspace = structuredClone(value) as { drafts: Array<{ id: string }> };
        workspace.drafts = workspace.drafts.filter((draft) => !draft.id.startsWith("draft-candidate-"));
        return workspace;
      }
      throw new Error("QA_SENTINEL: EDITORIAL_WORKSPACE_RETRY_UNAVAILABLE");
    }
    if (state === "instant-inventory-delay" && instantDraftCreated && command === "get_editorial_workspace") {
      delayedInstantWorkspaceReads += 1;
      if (delayedInstantWorkspaceReads <= 4) {
        const workspace = structuredClone(value) as { drafts: Array<{ id: string }> };
        workspace.drafts = workspace.drafts.filter((draft) => !draft.id.startsWith("draft-source-save-"));
        return workspace;
      }
    }
    if (state === "revision-edit-inventory-delay" && revisionEditCreated && command === "get_editorial_workspace") {
      delayedRevisionEditWorkspaceReads += 1;
      if (delayedRevisionEditWorkspaceReads <= 4) {
        const workspace = structuredClone(value) as { drafts: Array<{ id: string }> };
        workspace.drafts = workspace.drafts.filter((draft) => !draft.id.startsWith("draft-edit-"));
        return workspace;
      }
    }
    if (state === "live-draft-refresh" && command === "get_editorial_workspace") {
      liveDraftWorkspaceReads += 1;
      if (liveDraftWorkspaceReads >= 2) {
        const workspace = structuredClone(value) as {
          drafts: Array<{ id: string; completion: number | null; state: string; reviewable: boolean; detail: string; updatedAt: string }>;
        };
        const draft = workspace.drafts.find((item) => item.id === "draft-cloud-privilege");
        if (draft) {
          draft.completion = 100;
          draft.state = "REVIEW_REQUIRED";
          draft.reviewable = true;
          draft.detail = "TR / EN incelemesine hazır.";
          draft.updatedAt = new Date().toISOString();
        }
        return workspace;
      }
    }
    if (state === "candidate-postdismiss-summary-failure" && candidateDismissed && command === "get_bootstrap_snapshot") {
      throw new Error("QA_SENTINEL: DASHBOARD_SUMMARY_REFRESH_UNAVAILABLE");
    }
    if (state === "source-postsave-summary-failure" && sourceSaved && command === "get_bootstrap_snapshot") {
      throw new Error("QA_SENTINEL: DASHBOARD_SUMMARY_REFRESH_UNAVAILABLE");
    }
    if (state === "scan-postcompletion-summary-failure" && sourceScanCompleted && command === "get_bootstrap_snapshot") {
      throw new Error("QA_SENTINEL: DASHBOARD_SUMMARY_REFRESH_UNAVAILABLE");
    }
    if (state === "publish-ready" && publicationEnqueued && command === "get_editorial_workspace") {
      const workspace = structuredClone(value) as { scheduled: Array<Record<string, unknown>> };
      workspace.scheduled.push({
        id: "qa-publication-queued",
        title: "Kuyruğa alınan yayın paketi",
        section: "haberler",
        scheduledAt: "2026-08-10T09:00:00.000Z",
        targetPath: ".blogbot/generated/tr/kuyruga-alinan-yayin-paketi.md",
        state: "PUBLISHING",
        ciState: "NOT_STARTED"
      });
      return workspace;
    }
    if ((state === "approval-refresh" || state === "high-risk-approval-refresh") && revisionApproved && command === "get_bootstrap_snapshot") {
      const snapshot = structuredClone(value) as { queue: Array<{ id: string }> };
      snapshot.queue = snapshot.queue.filter((item) => item.id !== "rev-identity");
      return snapshot;
    }
    if (state === "truthful-review" && command === "get_review_revision") {
      const revision = structuredClone(value) as {
        scheduledAt: string;
        tr: { bodyMarkdown: string };
        en: { bodyMarkdown: string };
        claims: Array<{ status: string }>;
        media: unknown[];
        gates: Array<{ id: string; state: string }>;
      };
      revision.scheduledAt = "2031-12-24T18:45:00.000Z";
      revision.tr.bodyMarkdown = "Kısa doğrulanmış metin.";
      revision.en.bodyMarkdown = "Short verified copy.";
      if (revision.claims[0]) revision.claims[0].status = "NEEDS_SOURCE";
      revision.media = [];
      const mediaGate = revision.gates.find((gate) => gate.id === "media");
      if (mediaGate) mediaGate.state = "BLOCK";
      else if (revision.gates[0]) revision.gates[0].state = "BLOCK";
      return revision;
    }
    if (state === "high-risk-approval-refresh" && command === "get_review_revision") {
      const revision = structuredClone(value) as Record<string, unknown>;
      revision.riskLevel = "HIGH";
      revision.editorialApproved = true;
      revision.highRiskApproved = false;
      revision.state = "REVIEW_REQUIRED";
      return revision;
    }
    if (
      state === "review-selection-read-failure" &&
      command === "get_review_revision" &&
      (args as { revisionId?: unknown } | undefined)?.revisionId === "rev-followup"
    ) {
      throw new Error("QA_SENTINEL: REVIEW_REVISION_UNAVAILABLE");
    }
    if ((state === "bootstrap-race" || state === "operations-refresh-race") && command === "get_bootstrap_snapshot") {
      bootstrapCompleted = true;
    }
    if ((state === "bootstrap-race" || state === "operations-refresh-race") && command === "get_editorial_workspace" && !bootstrapCompleted) {
      const workspace = structuredClone(value) as Record<string, unknown>;
      workspace.drafts = [];
      return workspace;
    }
    if ((state === "offline" || state === "offline-engine") && command === "get_bootstrap_snapshot") {
      const snapshot = structuredClone(value) as Record<string, unknown>;
      snapshot.runtime = "OFFLINE_READ_ONLY";
      snapshot.connection = {
        engineRunning: false,
        engineLabel: "OPE Engine · bağlantı bekleniyor",
        bridgeReady: false,
        latencyMs: null,
        storageLabel: "PGlite · son doğrulanmış yerel veri",
        lastSyncAt: "2026-07-29T12:44:12.000Z"
      };
      return snapshot;
    }
    if (state === "empty" && command === "get_bootstrap_snapshot") {
      const snapshot = structuredClone(value) as Record<string, unknown>;
      snapshot.queue = [];
      return snapshot;
    }
    if (state === "empty" && command === "get_editorial_workspace") {
      const workspace = structuredClone(value) as Record<string, unknown>;
      for (const key of ["today", "candidates", "drafts", "queue", "scheduled", "history", "failures", "codexRoles", "systemHealth"]) {
        workspace[key] = [];
      }
      return workspace;
    }
    if (state === "manual-retry-required" && command === "get_editorial_workspace") {
      const workspace = structuredClone(value) as { failures: Array<Record<string, unknown>> };
      workspace.failures.unshift({
        id: "qa-manual-retry",
        title: "Elle inceleme gerektiren yayın denemesi",
        jobType: "PUBLISH",
        message: "Dış sistemdeki sonuç kesinleşmedi; otomatik tekrar güvenli değildir.",
        attempts: 1,
        lastAttemptAt: "2026-08-05T12:00:00.000Z",
        retryMode: "MANUAL",
        state: "ACTION_REQUIRED"
      });
      return workspace;
    }
    if (state === "candidate-draft-failed" && command === "get_editorial_workspace") {
      const workspace = structuredClone(value) as {
        candidates: Array<Record<string, unknown>>;
        failures: Array<Record<string, unknown>>;
      };
      const candidate = workspace.candidates.find((item) => item.id === "candidate-cisa-001");
      if (candidate) candidate.state = "RESEARCH_FAILED";
      workspace.failures.unshift({
        id: "draft-candidate-cisa-001",
        title: "Aday araştırma işi",
        jobType: "DRAFT",
        message: "Taslak üretimi tamamlanamadı; güvenli tekrar Operasyonlar ekranından başlatılabilir.",
        attempts: 1,
        lastAttemptAt: "2026-08-07T01:00:00.000Z",
        retryMode: "SAFE",
        state: "ACTION_REQUIRED"
      });
      return workspace;
    }
    if ((state === "engine-offline" || state === "offline-engine") && command === "get_editorial_workspace") {
      const workspace = structuredClone(value) as { systemHealth: Array<Record<string, unknown>> };
      workspace.systemHealth = workspace.systemHealth.map((item) => {
        if (item.id === "engine") {
          return {
            ...item,
            state: "OFFLINE",
            detail: "Yerel engine bağlantısı şu anda kullanılamıyor."
          };
        }
        if (item.id === "pglite") {
          return {
            ...item,
            state: "DEGRADED",
            detail: "PGlite durumu engine yeniden bağlanınca doğrulanacak."
          };
        }
        return item;
      });
      return workspace;
    }
    if (state === "github-unconfigured" && command === "github_device_flow_status") {
      return {
        status: "unconfigured",
        writes: false,
        network: false,
        detail: "GitHub App broker bu uygulama paketinde yapılandırılmadı; gerçek giriş ve yayın kapalı tutuluyor."
      };
    }
    if (state === "publish-ready" && command === "get_connector_state") {
      const connector = structuredClone(value) as Record<string, unknown>;
      connector.mode = "PUBLISH";
      connector.config = { ...(connector.config as Record<string, unknown>), site: { repositoryPath: "C:\\OPE-Demo", publicSiteUrl: "https://example.org", mode: "PUBLISH" } };
      connector.site = { ...(connector.site as Record<string, unknown>), repositoryPath: "C:\\OPE-Demo", publicSiteUrl: "https://example.org", adapterId: "astro-generic", adapterVersion: "1" };
      return connector;
    }
    return value;
  };
  return createInvokeBridge(transport, { readOnly: state === "offline" || state === "offline-engine" });
}

const root = document.getElementById("root");
if (!root) throw new Error("OPE QA uygulama kökü bulunamadı.");
createRoot(root).render(<StrictMode><App bridgeFactory={createQaBridge} /></StrictMode>);
