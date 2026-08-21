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
  action?: { label: string; page: PageId };
  origin?: "local" | "system";
}

function pageGuidance(activePage: PageId): BobyReply {
  if (activePage === "content" || activePage === "content-candidates" || activePage === "instant") {
    return { text: "İçerik Akışı'ndasın. Kaynak, aday, araştırma ya da taslak konusunda ne yapmak istediğini yaz.", action: { label: "Yeni taslak aç", page: "instant" } };
  }
  if (activePage === "editorial" || activePage === "editorial-review") {
    return { text: "Editoryal Masa'dasın. İnceleme, görsel, SEO ya da yeni revizyon için hemen yol gösterebilirim.", action: { label: "İçerik Akışı'nı aç", page: "content" } };
  }
  if (activePage === "publishing") {
    return { text: "Takvim ve Yayın ekranındasın. Onaylı içeriği, zamanı veya yayın öncesi kontrolü sorabilirsin.", action: { label: "İncelemeyi aç", page: "editorial-review" } };
  }
  return { text: "Merhaba, ben Boby. Nerede kaldığını ya da ne üretmek istediğini yaz; birlikte netleştirelim.", action: { label: "İçerik Akışı'nı aç", page: "content" } };
}

export function BobyAssistant({ activePage, snapshot, open, onClose, onNavigate }: BobyAssistantProps) {
  const initialReply = useMemo(() => pageGuidance(activePage), [activePage]);
  const [messages, setMessages] = useState<BobyReply[]>([initialReply]);
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const availability = useMemo(() => describeBobyAvailability({ runtime: snapshot.runtime, codexState: snapshot.codex.state }), [snapshot.codex.state, snapshot.runtime]);

  useEffect(() => {
    if (!open) return;
    playFeedbackSound("boby-open");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const respond = (question: string) => {
    setMessages((current) => [...current, { text: "Sen: " + question }, { text: localBobyReply(question, activePage), origin: "local" }]);
    playFeedbackSound("boby-reply");
  };

  if (!open) return null;
  return (
    <section className="boby-panel" role="dialog" aria-label="Editör Boby" aria-modal="false" aria-describedby="boby-purpose">
      <header className="boby-panel-header">
        <img src={bobyAvatar} alt="" width="42" height="42" className="boby-mark-image" />
        <div><p className="section-kicker">BOBY · YEREL EDİTÖR REHBERİ</p><h2 id="boby-title">Ben Boby</h2></div>
        <button type="button" className="boby-close" aria-label="Editör Boby'yi kapat" onClick={onClose}>×</button>
      </header>
      <div className={"boby-availability boby-availability-" + availability.tone} role="status" aria-live="polite">
        <span aria-hidden="true">✓</span><div><strong>{availability.label}</strong><small>{availability.detail}</small></div>
      </div>
      <p id="boby-purpose" className="boby-purpose">Boby bu ekrandaki sonraki güvenli adımı hemen açıklar. Konuşma bu panelde kalır.</p>
      <div className="boby-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div key={message.text + "-" + index} className={(message.text.startsWith("Sen:") ? "boby-message boby-message-user" : "boby-message") + (message.origin ? " boby-message-" + message.origin : "")}>
            {message.origin ? <small className="boby-message-origin">Boby</small> : null}<p>{message.text}</p>
            {message.action ? <button type="button" onClick={() => { onNavigate(message.action!.page); onClose(); }}>{message.action.label}</button> : null}
          </div>
        ))}
      </div>
      <div className="boby-quick-actions" aria-label="Boby hızlı yardımları">
        <button type="button" onClick={() => respond("Kaynak nasıl eklenir?")}>Kaynak ekle</button>
        <button type="button" onClick={() => respond("Taslak nasıl oluşturulur?")}>Taslak oluştur</button>
        <button type="button" onClick={() => respond("Bu konu için post hazırla")}>Post hazırla</button>
        <button type="button" onClick={() => respond("Yayın ve SEO nasıl ilerler?")}>Yayın ve SEO</button>
      </div>
      <form className="boby-composer" onSubmit={(event) => { event.preventDefault(); const question = prompt.trim(); if (!question) return; respond(question); setPrompt(""); }}>
        <label htmlFor="boby-question">Boby'ye sor</label>
        <div><input ref={inputRef} id="boby-question" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Örn. taslağı nerede inceleyeceğim?" maxLength={320} /><button className="button button-primary" type="submit">Sor</button></div>
      </form>
    </section>
  );
}
