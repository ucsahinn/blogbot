import { safeConversationSessionId, type StructuredCodexTask } from "./structured-runner.ts";

export const BOBY_GUIDE_SYSTEM_PROMPT = `Sen Boby'sin: OPE'un Türkçe, yerel öncelikli editör rehberisin.
Luna Low senin hızlı sohbet ve muhakeme profilindir. Her zaman Boby olarak konuş; altyapı, model, oturum veya entegrasyon adını kendiliğinden anlatma.
Kullanıcının bulunduğu ekranda güvenli ve anlaşılır tek sonraki adımı bulmasına yardım et. Bir isteği netleştirmek için en fazla bir kısa soru sor; genel veya editoryal soruyu menü ezberiyle geçiştirme.
Sohbet yanıtı hiçbir işlemi yürütmez: yayınlama, onay, silme, ayar, bağlantı, dosya veya kimlik bilgisi değiştirme yetkin yoktur.
Sadece izin verilen önerilen eylemleri döndür. Kesin bilmediğin sistem durumunu olmuş gibi anlatma.
Kısa, doğal, yargılamayan Türkçe kullan; önce sonucu, sonra gerekirse en fazla üç kısa adımı yaz.
Sağlanan durum özeti dışındaki sistem gerçeğini varsayma. Sır, anahtar, çerez, özel dosya veya kaynak gövdesi isteme ya da tekrar etme.`;

export const BOBY_ACTION_IDS = [
  "OPEN_DASHBOARD",
  "OPEN_CONTENT",
  "OPEN_INSTANT",
  "OPEN_EDITORIAL",
  "OPEN_PUBLISHING",
  "OPEN_OPERATIONS",
  "OPEN_SETUP"
] as const;

export type BobyActionId = typeof BOBY_ACTION_IDS[number];

export interface BobyGuideInput {
  question: string;
  activePage: string;
  runtimeState: "ONLINE" | "DEGRADED" | "OFFLINE";
  sessionId?: string;
  safeWorkspaceSummary: { draftCount: number; reviewCount: number; sourceCount: number };
}

export interface BobyGuideOutput {
  reply: string;
  suggestedActions: Array<{ id: BobyActionId; label: string }>;
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "suggestedActions"],
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 900 },
    suggestedActions: {
      type: "array", maxItems: 2,
      items: {
        type: "object", additionalProperties: false, required: ["id", "label"],
        properties: {
          id: { enum: [...BOBY_ACTION_IDS] },
          label: { type: "string", minLength: 1, maxLength: 80 }
        }
      }
    }
  }
} as const;

export function createBobyGuideTask(input: BobyGuideInput): StructuredCodexTask<BobyGuideOutput> {
  const boundedQuestion = input.question.trim().slice(0, 600);
  const conversationSessionId = safeConversationSessionId(input.sessionId);
  if (!boundedQuestion) throw new Error("BOBY_QUESTION_REQUIRED");
  return {
    taskKind: "BOBY_GUIDE",
    persistSession: true,
    ...(conversationSessionId ? { conversationSessionId } : {}),
    input: { system: `${BOBY_GUIDE_SYSTEM_PROMPT}\nOPE dışındaki günlük işler, genel sohbet, kişisel tavsiye, kodlama veya başka uygulama istekleri bu rolün dışındadır. Bunları kısa ve nazikçe reddet; kullanıcıyı yalnızca OPE içindeki kaynak, araştırma, taslak, inceleme, SEO, takvim, yayın, ayar, tanılama veya Boby kullanımına yönlendir.`, question: boundedQuestion, activePage: input.activePage.slice(0, 64), runtimeState: input.runtimeState, safeWorkspaceSummary: input.safeWorkspaceSummary },
    outputSchema,
    validateOutput(value): value is BobyGuideOutput {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Record<string, unknown>;
      return typeof candidate.reply === "string" && candidate.reply.trim().length > 0 && candidate.reply.length <= 900
        && Array.isArray(candidate.suggestedActions) && candidate.suggestedActions.length <= 2
        && candidate.suggestedActions.every((action) => action && typeof action === "object" && !Array.isArray(action)
          && BOBY_ACTION_IDS.includes((action as { id?: BobyActionId }).id ?? "OPEN_DASHBOARD" as BobyActionId)
          && typeof (action as { label?: unknown }).label === "string" && (action as { label: string }).label.trim().length > 0 && (action as { label: string }).label.length <= 80);
    }
  };
}
