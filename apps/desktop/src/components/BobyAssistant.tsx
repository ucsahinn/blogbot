import { useEffect, useMemo, useRef, useState } from "react";

import bobyAvatar from "../assets/boby-avatar-v3.webp";
import { describeBobyAvailability, localBobyReply } from "../boby-conversation.ts";
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
  origin?: "local" | "system";
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

function pageGuidance(activePage: PageId): BobyReply {
  if (activePage === "content" || activePage === "content-candidates" || activePage === "instant") {
    return { text: "İçerik Akışı'ndasın. Kaynak, aday, araştırma ya da taslak konusunda ne yapmak istediğini yaz.", actions: [{ label: "Yeni taslak aç", page: "instant" }] };
  }
  if (activePage === "editorial" || activePage === "editorial-review") {
    return { text: "Editoryal Masa'dasın. İnceleme, görsel, SEO ya da yeni revizyon için hemen yol gösterebilirim.", actions: [{ label: "İçerik Akışı'nı aç", page: "content" }] };
  }
  if (activePage === "publishing") {
    return { text: "Takvim ve Yayın ekranındasın. Onaylı içeriği, zamanı veya yayın öncesi kontrolü sorabilirsin.", actions: [{ label: "İncelemeyi aç", page: "editorial-review" }] };
  }
  return { text: "Merhaba, ben Boby. Nerede kaldığını ya da ne üretmek istediğini yaz; birlikte netleştirelim.", actions: [{ label: "İçerik Akışı'nı aç", page: "content" }] };
}

export function BobyAssistant({ activePage, snapshot, workspace, bridge, open, onClose, onNavigate }: BobyAssistantProps) {
  const initialReply = useMemo(() => pageGuidance(activePage), [activePage]);
  const [messages, setMessages] = useState<BobyReply[]>([initialReply]);
  const [prompt, setPrompt] = useState("");
  const [responding, setResponding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const availability = useMemo(() => describeBobyAvailability({ runtime: snapshot.runtime, codexState: snapshot.codex.state }), [snapshot.codex.state, snapshot.runtime]);

  useEffect(() => {
    if (!open) return;
    playFeedbackSound("boby-open");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const respond = async (question: string) => {
    if (responding) return;
    setResponding(true);
    setMessages((current) => [...current, { text: "Sen: " + question }, { text: "Boby düşünüyor…", origin: "system" }]);
    try {
      const guidance = await bridge.requestBobyGuidance({
        question,
        activePage,
        runtimeState: snapshot.runtime === "OFFLINE_READ_ONLY" ? "OFFLINE" : snapshot.runtime,
        safeWorkspaceSummary: { draftCount: workspace.drafts.length, reviewCount: workspace.drafts.filter((draft) => draft.reviewable).length, sourceCount: snapshot.sourceCount }
      });
      let result = await bridge.getBobyGuidance(guidance.id);
      for (let attempt = 0; attempt < 40 && result.state !== "SUCCEEDED" && result.state !== "FAILED"; attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
        result = await bridge.getBobyGuidance(guidance.id);
      }
      const actions = (result.suggestedActions ?? []).flatMap((action) => {
        const page = bobyActionPages[action.id];
        return page ? [{ label: action.label, page }] : [];
      });
      const reply = result.state === "SUCCEEDED" && result.reply
        ? { text: result.reply, actions, origin: "system" as const }
        : { text: localBobyReply(question, activePage), origin: "local" as const };
      setMessages((current) => [...current.filter((message) => message.text !== "Boby düşünüyor…"), reply]);
    } catch {
      setMessages((current) => [...current.filter((message) => message.text !== "Boby düşünüyor…"), { text: localBobyReply(question, activePage), origin: "local" }]);
    } finally {
      setResponding(false);
      playFeedbackSound("boby-reply");
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
      <p id="boby-purpose" className="boby-purpose">Ne yapmak istediğini yaz; Boby doğrudan yanıtlar ve gerekirse seni doğru yere götürür.</p>
      <div className="boby-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div key={message.text + "-" + index} className={(message.text.startsWith("Sen:") ? "boby-message boby-message-user" : "boby-message") + (message.origin ? " boby-message-" + message.origin : "")}>
            {message.origin ? <small className="boby-message-origin">Boby</small> : null}<p>{message.text}</p>
            {message.actions?.map((action) => <button key={action.page + action.label} type="button" onClick={() => { onNavigate(action.page); onClose(); }}>{action.label}</button>)}
          </div>
        ))}
      </div>
      <div className="boby-quick-actions" aria-label="Boby hızlı yardımları">
        <button type="button" disabled={responding} onClick={() => void respond("Kaynak eklemek istiyorum")}>Kaynak ekle</button>
        <button type="button" disabled={responding} onClick={() => void respond("Bu ekranda sıradaki en iyi iş ne?")}>Sıradaki iş</button>
        <button type="button" disabled={responding} onClick={() => void respond("Bu hafta yayın planımı düzenle")}>Planı düzenle</button>
        <button type="button" disabled={responding} onClick={() => void respond("Taslağı incelemeye nasıl hazırlarım?")}>İncelemeye hazırla</button>
      </div>
      <form className="boby-composer" onSubmit={(event) => { event.preventDefault(); const question = prompt.trim(); if (!question) return; void respond(question); setPrompt(""); }}>
        <label htmlFor="boby-question">Boby'ye sor</label>
        <div><input ref={inputRef} id="boby-question" value={prompt} disabled={responding} onChange={(event) => setPrompt(event.target.value)} placeholder="Örn. taslağı nerede inceleyeceğim?" maxLength={320} /><button className="button button-primary" type="submit" disabled={responding}>{responding ? "Yanıt hazırlanıyor…" : "Sor"}</button></div>
      </form>
    </section>
  );
}
