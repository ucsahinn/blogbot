import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import bobyAvatar from "../assets/boby-avatar-v3.webp";
import { bobyGuidancePollDelay, describeBobyAvailability, localBobyReply, persistPendingBobyGuidance, resolveBobyGuidancePoll, restorePendingBobyGuidance, shouldUseLocalBobyShortcut } from "../boby-conversation.ts";
import { userFacingBridgeError, type BlogbotBridge, type BobyGuidanceStatus } from "../bridge.ts";
import { playFeedbackSound } from "../feedback-sounds.ts";
import type { BootstrapSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";

import type { PageId } from "./AppShell.tsx";

interface BobyAssistantProps {
  activePage: PageId;
  snapshot: BootstrapSnapshot;
  workspace: EditorialWorkspaceSnapshot;
  bridge: BlogbotBridge;
  open: boolean;
  onClose: () => void;
  onNavigate: (page: PageId) => void;
}

interface BobyReply {
  text: string;
  action?: { label: string; page: PageId };
  origin?: "local" | "boby" | "system";
}

const BOBY_GUIDANCE_POLL_MS = 2_000;
const BOBY_GUIDANCE_TIMEOUT_MS = 120_000;
const BOBY_GUIDANCE_VISIBLE_WAIT_POLL_MS = 15_000;
const BOBY_GUIDANCE_HIDDEN_WAIT_POLL_MS = 60_000;
function pageGuidance(activePage: PageId, snapshot: BootstrapSnapshot, workspace: EditorialWorkspaceSnapshot): BobyReply {
  if (snapshot.runtime !== "ONLINE") {
    return {
      text: "Yerel bileşen henüz hazır değil. Önkoşulları test et; sonuç gelene kadar içeriklerini görüntüleyebilir ve Boby'den yol tarifi alabilirsin.",
      action: { label: "Önkoşulları aç", page: "setup" }
    };
  }
  if (activePage === "content" || activePage === "content-candidates" || activePage === "instant") {
    return {
      text: "İçerik Akışı'ndasın. Bir kaynak ekle veya seçili kaynağı tara. Aday oluştuğunda yalnızca incelemeye değer olanı taslağa al.",
      action: { label: "Yeni taslak isteği aç", page: "instant" }
    };
  }
  if (activePage === "editorial" || activePage === "editorial-review") {
    const reviewQueueCount = workspace.drafts.filter((draft) => draft.state === "REVIEW_REQUIRED").length;
    return {
      text: reviewQueueCount > 0
        ? `İnceleme bekleyen ${reviewQueueCount} içerik var. Önce kaynak, iddia ve görsel kanıtını kontrol et; onay yalnız değişmez sürüme uygulanır.`
        : "Editoryal Masa hazır. Bir adaydan taslak üret, sonra Türkçe ve İngilizce paketini aynı ekranda gözden geçir.",
      action: { label: "İçerik Akışı'nı aç", page: "content" }
    };
  }
  if (activePage === "publishing") {
    return {
      text: "Takvim yalnız gelecekteki uygun slotları önerir. Onaylanmış bir içeriği seç, zamanını kontrol et ve yayın hedefini doğrulamadan dışarıya gönderme.",
      action: { label: "İncelemeyi aç", page: "editorial-review" }
    };
  }
  if (activePage === "operations") {
    return {
      text: "Operasyonlar ekranı hata ayıklama içindir. Takılan bir iş varsa yalnız ilgili işi yeniden dene; sorunu paylaşacaksan Tanı paketi oluştur.",
      action: { label: "Tanılamaya git", page: "setup" }
    };
  }
  return {
    text: "Merhaba, ben Boby. Nerede kaldığını ya da ne üretmek istediğini yaz; birlikte netleştirelim.",
    action: { label: "İçerik Akışı'nı aç", page: "content" }
  };
}

function actionForBobyId(id: string): BobyReply["action"] | undefined {
  const routes: Record<string, PageId> = {
    OPEN_DASHBOARD: "dashboard",
    OPEN_CONTENT: "content",
    OPEN_INSTANT: "instant",
    OPEN_EDITORIAL: "editorial",
    OPEN_PUBLISHING: "publishing",
    OPEN_OPERATIONS: "operations",
    OPEN_SETUP: "setup"
  };
  return routes[id] ? { label: "Bunu aç", page: routes[id]! } : undefined;
}

export function BobyAssistant({ activePage, snapshot, workspace, bridge, open, onClose, onNavigate }: BobyAssistantProps) {
  const initialReply = useMemo(() => pageGuidance(activePage, snapshot, workspace), [activePage, snapshot, workspace]);
  const [messages, setMessages] = useState<BobyReply[]>([initialReply]);
  const [prompt, setPrompt] = useState("");
  const [deliveryState, setDeliveryState] = useState<"idle" | "queued" | "waiting" | "failed">("idle");
  const [checkingBobyRuntime, setCheckingBobyRuntime] = useState(false);
  const [bobyLoginPending, setBobyLoginPending] = useState(false);
  const [pendingGuidanceId, setPendingGuidanceId] = useState<string | null>(() => restorePendingBobyGuidance(window.sessionStorage));
  const [waitingReason, setWaitingReason] = useState<string | null>(null);
  const [guidancePollEpoch, setGuidancePollEpoch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const availability = useMemo(
    () => describeBobyAvailability({ runtime: snapshot.runtime, codexState: snapshot.codex.state }),
    [snapshot.codex.state, snapshot.runtime]
  );
  const [liveStatus, setLiveStatus] = useState<{
    sourceRuntime: typeof snapshot.runtime;
    sourceCodexState: typeof snapshot.codex.state;
    runtime: typeof snapshot.runtime;
    availability: ReturnType<typeof describeBobyAvailability>;
  } | null>(null);
  // The native Codex probe is a fresher observation than the bootstrap snapshot
  // captured before the probe. Keep that live result until the parent snapshot
  // changes; otherwise a successful probe is immediately discarded as stale.
  const liveRuntime = liveStatus?.runtime ?? snapshot.runtime;
  const liveAvailability = liveStatus?.availability ?? availability;
  const canConnectBoby = liveRuntime === "ONLINE";
  const effectiveDeliveryState = pendingGuidanceId && deliveryState === "idle" ? "queued" : deliveryState;
  const visibleAvailability = effectiveDeliveryState === "queued"
    ? { tone: "attention" as const, label: "Boby düşünüyor · Luna Low", detail: "Yanıt hazır olduğunda bu sohbete eklenecek." }
    : effectiveDeliveryState === "waiting"
      ? { tone: "attention" as const, label: "Boby sırada · Luna Low", detail: waitingReason ?? "İstek yerel sırada güvenle bekliyor; hazır olduğunda bu konuşmaya eklenecek." }
    : effectiveDeliveryState === "failed"
      ? { tone: "blocker" as const, label: "Boby yanıt veremedi", detail: "Yerel rehberlik açık. Ayrıntıyı Operasyonlar'da görebilirsin." }
      : bobyLoginPending
        ? { tone: "attention" as const, label: "Boby bağlantısı bekleniyor", detail: "Açılan güvenli giriş penceresini tamamla; sonra bu panelden durumu yenile." }
      : checkingBobyRuntime
        ? { tone: "attention" as const, label: "Boby hazırlanıyor · Luna Low", detail: "Sohbetin yerel çalışma durumu kontrol ediliyor." }
      : liveAvailability;

  const refreshBobyRuntime = useCallback(async () => {
    setCheckingBobyRuntime(true);
    try {
      await bridge.testCodexRuntime();
      const current = await bridge.getBootstrapSnapshot();
      setLiveStatus({
        sourceRuntime: snapshot.runtime,
        sourceCodexState: snapshot.codex.state,
        runtime: current.runtime,
        availability: describeBobyAvailability({ runtime: current.runtime, codexState: current.codex.state })
      });
      if (current.runtime === "ONLINE" && current.codex.state === "READY") {
        setBobyLoginPending(false);
      }
    } finally {
      setCheckingBobyRuntime(false);
    }
  }, [bridge, snapshot.codex.state, snapshot.runtime]);

  useEffect(() => {
    persistPendingBobyGuidance(window.sessionStorage, pendingGuidanceId);
  }, [pendingGuidanceId]);

  useEffect(() => {
    if (!open) return;
    playFeedbackSound("boby-open");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    // The panel exposes the initial state immediately, then refreshes the
    // small bootstrap snapshot so its green/amber/red indicator is current
    // when the editor opens Boby after a login or recovery action.
    const publishStatus = (current: BootstrapSnapshot) => {
      if (disposed) return;
      setLiveStatus({
        sourceRuntime: snapshot.runtime,
        sourceCodexState: snapshot.codex.state,
        runtime: current.runtime,
        availability: describeBobyAvailability({ runtime: current.runtime, codexState: current.codex.state })
      });
    };
    void bridge.getBootstrapSnapshot().then(async (current) => {
      publishStatus(current);
      // Boby is the conversation surface, not a second setup wizard. When the
      // local engine is healthy but authentication has not been observed in
      // this desktop process yet, verify it once in the background and update
      // only this panel's live badge. The native command uses CREATE_NO_WINDOW
      // for its bounded Codex probe.
      if (current.runtime !== "ONLINE" || current.codex.state !== "UNAVAILABLE") return;
      try {
        await refreshBobyRuntime();
      } catch {
        // The existing red state remains truthful and exposes the recovery
        // action. A failed background check must never block the conversation
        // panel or replace a diagnostic with a guessed success.
      }
    }).catch((reason) => {
      if (disposed) return;
      setMessages((current) => [...current, {
        text: userFacingBridgeError(
          reason,
          "Boby'nin canlı durumu yenilenemedi. Mevcut durum korunuyor; ayrıntı için Operasyonlar'ı kontrol edebilirsin."
        ),
        origin: "system",
        action: { label: "Operasyonlar'ı aç", page: "operations" }
      }]);
    });
    return () => { disposed = true; };
  }, [bridge, open, refreshBobyRuntime, snapshot.codex.state, snapshot.runtime]);

  useEffect(() => {
    if (!open || !pendingGuidanceId) return;
    let cancelled = false;
    const startedAt = Date.now();
    let boundedWaitShown = false;
    let didReportReadFailure = false;
    const appendBoundedWait = () => {
      setDeliveryState("waiting");
      setWaitingReason("Boby isteği yerel sırada güvenle bekliyor.");
      setMessages((current) => [...current, {
        text: "Boby isteği sürüyor. Yerel sırada güvenle bekliyor; paneli kapatsan da geri döndüğünde yanıtı burada izleyebilirsin.",
        origin: "system",
        action: { label: "Operasyonları aç", page: "operations" }
      }]);
    };
    const poll = async () => {
      while (!cancelled) {
        const elapsedMs = Date.now() - startedAt;
        const pollDelay = bobyGuidancePollDelay(
          elapsedMs,
          document.visibilityState === "visible",
          BOBY_GUIDANCE_POLL_MS,
          BOBY_GUIDANCE_VISIBLE_WAIT_POLL_MS,
          BOBY_GUIDANCE_HIDDEN_WAIT_POLL_MS
        );
        await new Promise((resolve) => window.setTimeout(resolve, pollDelay));
        if (cancelled) return;
        try {
          const result: BobyGuidanceStatus = await bridge.getBobyGuidance(pendingGuidanceId);
          if (cancelled) return;
          const resolution = resolveBobyGuidancePoll({
            guidanceId: pendingGuidanceId,
            elapsedMs: Date.now() - startedAt,
            isDocumentVisible: document.visibilityState === "visible",
            state: result.state,
            ...(result.reply ? { reply: result.reply } : {})
          });
          if (resolution.kind === "deliver") {
            const action = result.suggestedActions?.map((item) => actionForBobyId(item.id)).find(Boolean);
            setPendingGuidanceId(null);
            setDeliveryState("idle");
            setWaitingReason(null);
            setMessages((current) => [...current, { text: resolution.reply, origin: "boby", ...(action ? { action } : {}) }]);
            playFeedbackSound("boby-reply");
            return;
          }
          if (resolution.kind === "failed") {
            setPendingGuidanceId(null);
            setDeliveryState("failed");
            setWaitingReason(null);
            setMessages((current) => [...current, {
              text: "Boby yanıtı tamamlanamadı. Yerel rehberlik açık; ayrıntı için Operasyonlar'ı kontrol edebilirsin.",
              origin: "system",
              action: { label: "Operasyonları aç", page: "operations" }
            }]);
            return;
          }
          if (result.state === "WAITING_CODEX") {
            setDeliveryState("waiting");
            setWaitingReason(result.waitReason ?? "Boby isteği yerel sırada güvenle bekliyor.");
          }
          if (result.state === "QUEUED" || result.state === "RUNNING") {
            if (!boundedWaitShown) setDeliveryState("queued");
          }
          if (Date.now() - startedAt >= BOBY_GUIDANCE_TIMEOUT_MS && !boundedWaitShown) {
            appendBoundedWait();
            boundedWaitShown = true;
          }
        } catch {
          if (cancelled) return;
          const resolution = resolveBobyGuidancePoll({
            guidanceId: pendingGuidanceId,
            elapsedMs: Date.now() - startedAt,
            isDocumentVisible: document.visibilityState === "visible",
            didReadFail: true
          });
          setDeliveryState("waiting");
          setWaitingReason("Boby isteği kaydedildi; durumu şu an okunamadı.");
          if (!didReportReadFailure) {
            didReportReadFailure = true;
            setMessages((current) => [...current, {
              text: "Boby isteği kaydedildi; durumu şu an okunamadı. Aynı iş kısa süre sonra yeniden kontrol edilecek.",
              origin: "system",
              action: { label: "Operasyonları aç", page: "operations" }
            }]);
          }
          if (resolution.kind === "continue") continue;
        }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [bridge, guidancePollEpoch, open, pendingGuidanceId]);

  const resumePendingBobyGuidance = () => {
    if (!pendingGuidanceId) return;
    setDeliveryState("queued");
    setWaitingReason(null);
    setGuidancePollEpoch((current) => current + 1);
  };

  const releasePendingBobyGuidance = () => {
    setPendingGuidanceId(null);
    setDeliveryState("idle");
    setWaitingReason(null);
    setMessages((current) => [...current, {
      text: "Bekleyen eski Boby isteği bu panelden ayrıldı. Yeni sorunu güvenle yazabilirsin.",
      origin: "system"
    }]);
  };

  const appendSystemFailure = (text: string) => {
    setDeliveryState("failed");
    setMessages((current) => [...current, {
      text,
      origin: "system",
      action: { label: "Operasyonları aç", page: "operations" }
    }]);
  };

  const startBobyLogin = async () => {
    setBobyLoginPending(true);
    try {
      await bridge.startCodexLogin();
      setMessages((current) => [...current, {
        text: "Boby için güvenli giriş penceresi açıldı. İşlemi bitirdiğinde bu panelden durumu yenileyebilirsin.",
        origin: "system"
      }]);
    } catch {
      setBobyLoginPending(false);
      appendSystemFailure("Boby bağlantısı başlatılamadı. Operasyonlar'dan tanı paketini kontrol edebilirsin.");
    }
  };

  const respond = async (question: string) => {
    setMessages((current) => [...current, { text: `Sen: ${question}` }]);
    playFeedbackSound("boby-reply");
    if (liveAvailability.tone === "blocker" || shouldUseLocalBobyShortcut(question)) {
      setDeliveryState("idle");
      setMessages((current) => [...current, {
        text: localBobyReply(question, activePage),
        origin: "local"
      }]);
      return;
    }
    setDeliveryState("queued");
    setWaitingReason(null);
    setMessages((current) => [...current, { text: "Boby düşünüyor; yanıtı burada hazırlıyorum.", origin: "system" }]);
    try {
      const queued = await bridge.requestBobyGuidance({
        question,
        activePage,
        runtimeState: liveRuntime === "OFFLINE_READ_ONLY" ? "OFFLINE" : liveRuntime,
        safeWorkspaceSummary: {
          draftCount: workspace.drafts.length,
          reviewCount: workspace.drafts.filter((draft) => draft.state === "REVIEW_REQUIRED").length,
          sourceCount: snapshot.sourceCount
        }
      });
      setMessages((current) => [...current, { text: "Boby isteğini aldı. Yanıt hazır olduğunda burada göstereceğim.", origin: "system" }]);
      setPendingGuidanceId(queued.id);
    } catch (reason) {
      appendSystemFailure(userFacingBridgeError(reason, "Boby isteği başlatılamadı. Yerel rehberlik açık; ayrıntı için Operasyonlar'ı kontrol edebilirsin."));
    }
  };

  if (!open) return null;
  return (
    <section className="boby-panel" role="dialog" aria-label="Editör Boby" aria-modal="false" aria-describedby="boby-purpose">
      <header className="boby-panel-header">
        <img src={bobyAvatar} alt="" width="42" height="42" className="boby-mark-image" />
        <div><p className="section-kicker">BOBY · YEREL EDİTÖR REHBERİ</p><h2 id="boby-title">Ben Boby</h2></div>
        <button type="button" className="boby-close" aria-label="Editör Boby'yi kapat" onClick={onClose}>×</button>
      </header>
      <div className={`boby-availability boby-availability-${visibleAvailability.tone}`} role="status" aria-live="polite">
        <span aria-hidden="true">{visibleAvailability.tone === "ready" ? "✓" : visibleAvailability.tone === "attention" ? "…" : "!"}</span>
        <div><strong>{visibleAvailability.label}</strong><small>{visibleAvailability.detail}</small></div>
      </div>
      {canConnectBoby && (visibleAvailability.tone === "blocker" || bobyLoginPending) ? (
        <div className="boby-prepare-actions">
          <button type="button" className="boby-prepare" disabled={bobyLoginPending || checkingBobyRuntime} onClick={() => void startBobyLogin()}>
            Boby'yi bağla
          </button>
          <button type="button" className="button button-quiet" disabled={checkingBobyRuntime} onClick={() => void refreshBobyRuntime().catch(() => {
            setMessages((current) => [...current, {
              text: "Boby durumu yenilenemedi. Yerel bileşen hazır olduğunda tekrar deneyebilirsin.",
              origin: "system"
            }]);
          })}>
            Durumu yenile
          </button>
        </div>
      ) : null}
      {!canConnectBoby && visibleAvailability.tone === "blocker" ? (
        <button type="button" className="boby-prepare" onClick={() => { onNavigate("setup"); onClose(); }}>
          Yerel bileşeni kontrol et
        </button>
      ) : null}
      {pendingGuidanceId && effectiveDeliveryState === "waiting" ? (
        <div className="boby-prepare-actions">
          <button type="button" className="boby-prepare" onClick={resumePendingBobyGuidance}>Yanıtı yeniden kontrol et</button>
          <button type="button" className="button button-quiet" onClick={releasePendingBobyGuidance}>Yeni soru sor</button>
        </div>
      ) : null}
      <p id="boby-purpose" className="boby-purpose">Boby bu ekrandaki bir sonraki güvenli adımı açıklar. Konuşma bu panelde aynı yerde kalır.</p>
      <div className="boby-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div key={`${message.text}-${index}`} className={`${message.text.startsWith("Sen:") ? "boby-message boby-message-user" : "boby-message"}${message.origin ? ` boby-message-${message.origin}` : ""}`}>
            {message.origin ? <small className="boby-message-origin">{message.origin === "boby" ? "Boby · Luna Low" : message.origin === "local" ? "Yerel rehber" : "Durum"}</small> : null}
            <p>{message.text}</p>
            {message.action ? <button type="button" onClick={() => { onNavigate(message.action!.page); onClose(); }}>{message.action.label}</button> : null}
          </div>
        ))}
      </div>
      <div className="boby-quick-actions" aria-label="Boby hızlı yardımları">
        <button type="button" disabled={effectiveDeliveryState !== "idle"} onClick={() => void respond("Kaynak nasıl eklenir?")}>Kaynak ekle</button>
        <button type="button" disabled={effectiveDeliveryState !== "idle"} onClick={() => void respond("Taslak nasıl oluşturulur?")}>Taslak oluştur</button>
        <button type="button" disabled={effectiveDeliveryState !== "idle"} onClick={() => void respond("Bu konu için post hazırla")}>Post hazırla</button>
        <button type="button" disabled={effectiveDeliveryState !== "idle"} onClick={() => void respond("Yayın ve SEO nasıl ilerler?")}>Yayın ve SEO</button>
      </div>
      <form className="boby-composer" onSubmit={(event) => { event.preventDefault(); const question = prompt.trim(); if (!question) return; void respond(question); setPrompt(""); }}>
        <label htmlFor="boby-question">Boby'ye sor</label>
        <div><input ref={inputRef} id="boby-question" value={prompt} disabled={effectiveDeliveryState !== "idle"} onChange={(event) => setPrompt(event.target.value)} placeholder="Örn. taslağı nerede inceleyeceğim?" maxLength={320} /><button className="button button-primary" type="submit" disabled={effectiveDeliveryState !== "idle"}>Sor</button></div>
      </form>
    </section>
  );
}
