import { useEffect, useMemo, useRef, useState } from "react";

import bobyMark from "../assets/boby-mark.png";
import { playFeedbackSound } from "../feedback-sounds.ts";

import type { PageId } from "./AppShell.tsx";
import type { BootstrapSnapshot, EditorialWorkspaceSnapshot } from "../types.ts";

interface BobyAssistantProps {
  activePage: PageId;
  snapshot: BootstrapSnapshot;
  workspace: EditorialWorkspaceSnapshot;
  open: boolean;
  onClose: () => void;
  onNavigate: (page: PageId) => void;
}

interface BobyReply {
  text: string;
  action?: { label: string; page: PageId };
}

function pageGuidance(activePage: PageId, snapshot: BootstrapSnapshot, workspace: EditorialWorkspaceSnapshot): BobyReply {
  if (snapshot.runtime !== "ONLINE") {
    return {
      text: "Yerel bileşen henüz hazır değil. Önce Önkoşulları test et; sonuç gelene kadar içeriklerini görüntüleyebilir ve Boby'den yol tarifi alabilirsin.",
      action: { label: "Önkoşulları aç", page: "setup" }
    };
  }
  if (activePage === "content" || activePage === "content-candidates" || activePage === "instant") {
    return {
      text: "İçerik Akışı'ndasın. Bir kaynak ekle veya seçili kaynağı tara. Aday oluştuğunda yalnızca incelemeye değer olanı taslağa al.",
      action: { label: "Taslak masasına git", page: "editorial" }
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
      action: { label: "Tanıma git", page: "setup" }
    };
  }
  return {
    text: "Bugün için tek bir sonraki adımı seçelim: kaynak ekle, aday tara veya incelemeyi tamamla. Hangi aşamada kaldığını yazarsan sana kısa bir yol göstereceğim.",
    action: { label: "İçerik Akışı'nı aç", page: "content" }
  };
}

export function BobyAssistant({ activePage, snapshot, workspace, open, onClose, onNavigate }: BobyAssistantProps) {
  const initialReply = useMemo(() => pageGuidance(activePage, snapshot, workspace), [activePage, snapshot, workspace]);
  const [messages, setMessages] = useState<BobyReply[]>([initialReply]);
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    playFeedbackSound("boby-open");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const respond = (question: string) => {
    const normalized = question.toLocaleLowerCase("tr-TR");
    const reply = normalized.includes("kaynak")
      ? { text: "Kaynak eklemek için İçerik Akışı'nda Kaynaklar sekmesini aç. Adresi test et, kaynak güvenini ve kullanım hakkını ayrı değerlendir, sonra tara.", action: { label: "Kaynakları aç", page: "content" as PageId } }
      : normalized.includes("taslak") || normalized.includes("makale")
        ? { text: "Taslak, seçilmiş aday ve kanıtlarla başlar. Adayı taslağa al, Editoryal Masa'da Türkçe ve İngilizce metni, iddiaları ve görseli birlikte incele.", action: { label: "Editoryal Masa", page: "editorial" as PageId } }
        : normalized.includes("yayın") || normalized.includes("seo") || normalized.includes("takvim")
          ? { text: "Önce değişmez sürümü onayla. Sonra Takvim ve Yayın ekranında uygun slotu seç, hedef önizlemesini kontrol et; bağlantı hazır değilse yayın butonu açık kalmaz.", action: { label: "Takvimi aç", page: "publishing" as PageId } }
          : normalized.includes("hata") || normalized.includes("takıl") || normalized.includes("yavaş")
            ? { text: "Bir ekran takılırsa Operasyonlar'da ilgili işi ve Yerel sistem durumunu kontrol et. Tanı paketi sır içermeyen günlükleri klasöre çıkarır; paketi paylaşmadan önce yeniden üret.", action: { label: "Operasyonları aç", page: "operations" as PageId } }
            : pageGuidance(activePage, snapshot, workspace);
    setMessages((current) => [...current, { text: `Sen: ${question}` }, reply]);
    playFeedbackSound("boby-reply");
  };

  if (!open) return null;
  return (
    <section className="boby-panel" role="dialog" aria-modal="false" aria-labelledby="boby-title" aria-describedby="boby-purpose">
      <header className="boby-panel-header">
        <img src={bobyMark} alt="" className="boby-mark-image" />
        <div><p className="section-kicker">YEREL EDİTÖR REHBERİ</p><h2 id="boby-title">Editör Boby</h2></div>
        <button type="button" className="boby-close" aria-label="Editör Boby'yi kapat" onClick={onClose}>×</button>
      </header>
      <p id="boby-purpose" className="boby-purpose">Boby bu ekrandaki bir sonraki güvenli adımı açıklar. Konuşmalar cihazında kalır; dışarıya gönderilmez.</p>
      <div className="boby-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div key={`${message.text}-${index}`} className={message.text.startsWith("Sen:") ? "boby-message boby-message-user" : "boby-message"}>
            <p>{message.text}</p>
            {message.action ? <button type="button" onClick={() => { onNavigate(message.action!.page); onClose(); }}>{message.action.label}</button> : null}
          </div>
        ))}
      </div>
      <div className="boby-quick-actions" aria-label="Boby hızlı yardımları">
        <button type="button" onClick={() => respond("Kaynak nasıl eklenir?")}>Kaynak ekle</button>
        <button type="button" onClick={() => respond("Taslak nasıl oluşturulur?")}>Taslak oluştur</button>
        <button type="button" onClick={() => respond("Yayın ve SEO nasıl ilerler?")}>Yayın ve SEO</button>
      </div>
      <form className="boby-composer" onSubmit={(event) => { event.preventDefault(); const question = prompt.trim(); if (!question) return; respond(question); setPrompt(""); }}>
        <label htmlFor="boby-question">Boby'ye sor</label>
        <div><input ref={inputRef} id="boby-question" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Örn. taslağı nerede inceleyeceğim?" maxLength={320} /><button className="button button-primary" type="submit">Sor</button></div>
      </form>
    </section>
  );
}
