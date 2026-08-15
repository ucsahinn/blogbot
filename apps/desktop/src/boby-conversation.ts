import type { RuntimeState } from "./types.ts";

export type BobyAvailabilityTone = "ready" | "attention" | "blocker";

export interface BobyAvailability {
  tone: BobyAvailabilityTone;
  label: string;
  detail: string;
}

/**
 * A ready Boby always uses its Luna Low conversation session. Keeping keyword
 * routing here would turn editorial requests into repetitive menu hints.
 * Local guidance is a deliberately separate offline fallback in the panel.
 */
export function shouldUseLocalBobyShortcut(_question: string): boolean {
  return false;
}

export function describeBobyAvailability(input: {
  runtime: RuntimeState;
  codexState: "READY" | "BUSY" | "UNAVAILABLE";
}): BobyAvailability {
  if (input.runtime !== "ONLINE") {
    return {
      tone: "blocker",
      label: "Yerel bileşen çevrimdışı",
      detail: "Boby yalnız kayıtlı yerel rehberliği gösterebilir."
    };
  }
  if (input.codexState === "READY") {
    return {
      tone: "ready",
      label: "Boby hazır · Luna Low",
      detail: "Sorunu yaz; Boby bağlamı anlayıp yanıtlasın."
    };
  }
  if (input.codexState === "BUSY") {
    return {
      tone: "attention",
      label: "Boby düşünüyor · Luna Low",
      detail: "Yanıt hazırlanıyor; uygulamayı kullanmaya devam edebilirsin."
    };
  }
  return {
    tone: "blocker",
    label: "Boby henüz hazır değil",
    detail: "Boby'yi bağla düğmesiyle güvenli girişi başlat; hazır olduğunda aynı konuşmadan devam et."
  };
}
