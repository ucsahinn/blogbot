import type { RuntimeState } from "./types.ts";

export type BobyAvailabilityTone = "ready" | "attention" | "blocker";

export interface BobyAvailability {
  tone: BobyAvailabilityTone;
  label: string;
  detail: string;
}

export interface BobySessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const BOBY_PENDING_GUIDANCE_KEY = "blogbot.boby.pending-guidance-id";

export function restorePendingBobyGuidance(storage: BobySessionStorage): string | null {
  try {
    const value = storage.getItem(BOBY_PENDING_GUIDANCE_KEY);
    return value?.startsWith("boby-") ? value : null;
  } catch {
    return null;
  }
}

export function persistPendingBobyGuidance(storage: BobySessionStorage, guidanceId: string | null) {
  try {
    if (guidanceId) storage.setItem(BOBY_PENDING_GUIDANCE_KEY, guidanceId);
    else storage.removeItem(BOBY_PENDING_GUIDANCE_KEY);
  } catch {
    // The engine job remains authoritative if session storage is unavailable.
  }
}

export type BobyGuidancePollResolution =
  | { kind: "deliver"; guidanceId: string; reply: string }
  | { kind: "failed"; guidanceId: string }
  | { kind: "continue"; guidanceId: string; nextPollMs: number };

export function resolveBobyGuidancePoll(input: {
  guidanceId: string;
  elapsedMs: number;
  isDocumentVisible: boolean;
  state?: "QUEUED" | "RUNNING" | "WAITING_CODEX" | "SUCCEEDED" | "FAILED";
  reply?: string;
  didReadFail?: boolean;
}): BobyGuidancePollResolution {
  if (input.state === "SUCCEEDED" && input.reply) {
    return { kind: "deliver", guidanceId: input.guidanceId, reply: input.reply };
  }
  if (input.state === "FAILED") return { kind: "failed", guidanceId: input.guidanceId };
  return {
    kind: "continue",
    guidanceId: input.guidanceId,
    nextPollMs: bobyGuidancePollDelay(input.elapsedMs, input.isDocumentVisible)
  };
}

export function bobyGuidancePollDelay(
  elapsedMs: number,
  isDocumentVisible: boolean,
  initialPollMs = 2_000,
  visibleWaitPollMs = 15_000,
  hiddenWaitPollMs = 60_000
): number {
  if (elapsedMs < 120_000) return initialPollMs;
  return isDocumentVisible ? visibleWaitPollMs : hiddenWaitPollMs;
}

/**
 * A ready Boby always uses its Luna Low conversation session. Keeping keyword
 * routing here would turn editorial requests into repetitive menu hints.
 * Local guidance is a deliberately separate offline fallback in the panel.
 */
export function shouldUseLocalBobyShortcut(question: string): boolean {
  void question;
  return false;
}

/**
 * Safe, local-only guidance for the small set of questions Boby must answer
 * even before Luna Low is authenticated. It never pretends to run a job or
 * claims that an external connector is ready.
 */
export function localBobyReply(question: string, activePage: string): string {
  const normalized = question.trim().toLocaleLowerCase("tr-TR");
  if (/\b(naber|nasılsın|merhaba|selam)\b/u.test(normalized)) {
    return "İyiyim. OPE içinde kaynak bulma, taslak hazırlama ve yayın öncesi kontrollerde sana yol gösterebilirim.";
  }
  if (/kaynak|rss|akış|feed/u.test(normalized)) {
    return "Kaynak eklemek için İçerik Akışı'nı aç, Kaynak ekle'yi seç ve HTTPS adresini doğrula. Kaynak kaydedilince Tara ile yeni adayları çıkarabilirsin.";
  }
  if (/aday|araştır|tara/u.test(normalized)) {
    return "Önce İçerik Akışı'nda kaynak taramasını tamamla. Uygun adaylar listelenince birini seçip Taslak oluştur'a geç; kaynak kanıtı olmayan aday taslağa alınmaz.";
  }
  if (/taslak|post|makale|yazı|içerik oluştur/u.test(normalized)) {
    return "Taslak için adaydan Taslak oluştur'u seç veya Yeni Taslak ekranında kaynakları ve kısa editoryal talimatı gir. Taslak önce kaynak, iki dil, iddia ve görsel kontrollerinden geçer.";
  }
  if (/seo|arama|başlık|meta/u.test(normalized)) {
    return "SEO kontrolü Editoryal Masa ve Yayın önizlemesinde görünür. Başlık, açıklama, slug, bağlantılar ve kaynak/iddia bütünlüğü hazır olmadan onay düğmesi açılmaz.";
  }
  if (/incele|onay|iddia|kanıt|kanıt/u.test(normalized)) {
    return "İnceleme için Editoryal Masa'ya git. Her iddiayı kaynağıyla, Türkçe ve İngilizce metni ve görseli kontrol et; yalnızca değişmez revizyon hash'i doğruysa onay ver.";
  }
  if (/yayın|takvim|slot/u.test(normalized)) {
    return "Takvim ve Yayın ekranında yalnızca onaylanmış revizyonlar planlanır. Önce önizlemeyi ve hedefi doğrula; yayın işlemi onay hash'i değişirse yeniden bloke olur.";
  }
  if (/güncelle|update|sürüm/u.test(normalized)) {
    return "Güncellemeleri Hakkında bölümünden denetle. Yeni sürüm varsa indir ve kur'u sen başlat; kurulum açıldığında bootstrapper penceresi her aşamayı gösterir.";
  }
  if (/tanı|debug|hata|log/u.test(normalized)) {
    return "Hata için Operasyonlar ekranını açıp Tanı paketi oluştur'u seç. Paket klasörü otomatik açılır; engine, kuyruk, bridge ve updater loglarını birlikte içerir.";
  }
  return (activePage === "content" ? "İçerik Akışı'ndasın." : "OPE'nin yerel editöründesin.") + " Konuyu bir cümleyle yaz; kaynak, taslak, inceleme, SEO, yayın veya tanılama için doğrudan bir sonraki adımı söyleyeyim.";
}
export function describeBobyAvailability(input: {
  runtime: RuntimeState;
  codexState: "READY" | "BUSY" | "UNAVAILABLE";
}): BobyAvailability {
  void input;
  return {
    tone: "ready",
    label: "Boby hazır",
    detail: "Sorunu yaz; Boby bu ekrandaki sonraki adımı hemen açıklar."
  };
}
