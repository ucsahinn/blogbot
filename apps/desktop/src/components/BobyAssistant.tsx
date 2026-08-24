import { useEffect, useMemo, useRef, useState } from "react";

import bobyAvatar from "../assets/boby-avatar-v3.webp";
import { bobyGuidancePollDelay, describeBobyAvailability, isBobyRunnerUnavailable, persistPendingBobyGuidance, resolveBobyGuidancePoll, restorePendingBobyGuidance } from "../boby-conversation.ts";
import { playFeedbackSound } from "../feedback-sounds.ts";
import type { BlogbotBridge } from "../bridge.ts";
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
  actions?: Array<{ label: string; page: PageId }>;
  origin?: "boby" | "system";
  kind?: "pending";
}

const bobyActionPages: Record<string, PageId> = {
  OPEN_DASHBOARD: "dashboard",
  OPEN_CONTENT: "content",
  OPEN_INSTANT: "instant",
  OPEN_EDITORIAL: "editorial",
  OPEN_PUBLISHING: "publishing",
  OPEN_OPERATIONS: "operations",
  OPEN_SETUP: "setup"
};

export function BobyAssistant({ activePage, snapshot, workspace, bridge, open, onClose, onNavigate }: BobyAssistantProps) {
  const [messages, setMessages] = useState<BobyReply[]>([]);
  const [prompt, setPrompt] = useState("");
  const [responding, setResponding] = useState(false);
  const [pendingGuidanceId, setPendingGuidanceId] = useState<string | null>(() => restorePendingBobyGuidance(window.sessionStorage));
  const inputRef = useRef<HTMLInputElement>(null);
  const availability = useMemo(() => describeBobyAvailability({ runtime: snapshot.runtime, codexState: snapshot.codex.state }), [snapshot.codex.state, snapshot.runtime]);

  useEffect(() => {
    if (!open) return;
    playFeedbackSound("boby-open");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!pendingGuidanceId) return;
    let cancelled = false;
    const startedAt = Date.now();
    let timer: number | undefined;
    const finish = (reply: BobyReply) => {
      if (cancelled) return;
      persistPendingBobyGuidance(window.sessionStorage, null);
      setPendingGuidanceId(null);
      setMessages((current) => [...current.filter((message) => message.kind !== "pending"), reply]);
      playFeedbackSound("boby-reply");
    };
    const poll = async () => {
      const pollResolution = resolveBobyGuidancePoll({
        guidanceId: pendingGuidanceId,
        elapsedMs: Date.now() - startedAt,
        isDocumentVisible: document.visibilityState === "visible"
      });
      try {
        const result = await bridge.getBobyGuidance(pendingGuidanceId);
        if (cancelled) return;
        if (result.state === "SUCCEEDED" && result.reply) {
          const actions = (result.suggestedActions ?? []).flatMap((action) => {
            const page = bobyActionPages[action.id];
            return page ? [{ label: action.label, page }] : [];
          });
          finish({ text: result.reply, actions, origin: "boby" });
          return;
        }
        if (isBobyRunnerUnavailable(result.state)) {
          finish({ text: "Boby şu an yanıt altyapısına ulaşamıyor. Birkaç saniye sonra yeniden deneyebilirsin.", origin: "system" });
          return;
        }
        if (result.state === "FAILED") {
          finish({ text: "Boby bu yanıtı tamamlayamadı. Birkaç saniye sonra yeniden sorabilirsin.", origin: "system" });
          return;
        }
      } catch {
        // A transient bridge read must not replace a live Luna answer with a canned menu response.
      }
      if (pollResolution.kind === "expired") {
        finish({ text: "Boby bu yanıtı zamanında tamamlayamadı. Aynı soruyu yeniden gönderebilirsin.", origin: "system" });
        return;
      }
      timer = window.setTimeout(() => void poll(), bobyGuidancePollDelay(Date.now() - startedAt, document.visibilityState === "visible"));
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [bridge, pendingGuidanceId]);

  const respond = async (question: string) => {
    if (responding || pendingGuidanceId) return;
    setResponding(true);
    setMessages((current) => [...current, { text: "Sen: " + question }, { text: "Boby yanıtını hazırlıyor…", origin: "system", kind: "pending" }]);
    try {
      const guidance = await bridge.requestBobyGuidance({
        question,
        activePage,
        runtimeState: snapshot.runtime === "OFFLINE_READ_ONLY" ? "OFFLINE" : snapshot.runtime,
        safeWorkspaceSummary: { draftCount: workspace.drafts.length, reviewCount: workspace.drafts.filter((draft) => draft.reviewable).length, sourceCount: snapshot.sourceCount }
      });
      persistPendingBobyGuidance(window.sessionStorage, guidance.id);
      setPendingGuidanceId(guidance.id);
    } catch {
      setMessages((current) => [...current.filter((message) => message.kind !== "pending"), { text: "Boby şu an yanıt bağlantısına ulaşamadı. Birkaç saniye sonra yeniden deneyebilirsin.", origin: "system" }]);
    } finally {
      setResponding(false);
    }
  };
  if (!open) return null;
  return (
    <section className="boby-panel" role="dialog" aria-label="Editör Boby" aria-modal="false" aria-describedby="boby-purpose">
      <header className="boby-panel-header">
        <img src={bobyAvatar} alt="" width="42" height="42" className="boby-mark-image" />
        <div><p className="section-kicker">BOBY · EDİTÖR ASİSTANI</p><h2 id="boby-title">Ben Boby</h2></div>
        <button type="button" className="boby-close" aria-label="Editör Boby'yi kapat" onClick={onClose}>×</button>
      </header>
      <div className={"boby-availability boby-availability-" + availability.tone} role="status" aria-live="polite">
        <span aria-hidden="true">✓</span><div><strong>{availability.label}</strong><small>{availability.detail}</small></div>
      </div>
      <p id="boby-purpose" className="boby-purpose">Ne yapmak istediğini yaz. Boby yanıtı bu konuşmada kalır; uygun olduğunda doğrudan ilgili ekranı da açabilir.</p>
      <div className="boby-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div key={message.text + "-" + index} className={(message.text.startsWith("Sen:") ? "boby-message boby-message-user" : "boby-message") + (message.origin ? " boby-message-" + message.origin : "")}>
            {message.origin ? <small className="boby-message-origin">Boby</small> : null}<p>{message.text}</p>
            {message.actions?.map((action) => <button key={action.page + action.label} type="button" onClick={() => { onNavigate(action.page); onClose(); }}>{action.label}</button>)}
          </div>
        ))}
      </div>
      <form className="boby-composer" onSubmit={(event) => { event.preventDefault(); const question = prompt.trim(); if (!question) return; void respond(question); setPrompt(""); }}>
        <label htmlFor="boby-question">Boby'ye sor</label>
        <div><input ref={inputRef} id="boby-question" value={prompt} disabled={responding || !!pendingGuidanceId} onChange={(event) => setPrompt(event.target.value)} placeholder="Örn. taslağı nerede inceleyeceğim?" maxLength={320} /><button className="button button-primary" type="submit" disabled={responding || !!pendingGuidanceId}>{responding || pendingGuidanceId ? "Yanıt hazırlanıyor…" : "Sor"}</button></div>
      </form>
    </section>
  );
}
