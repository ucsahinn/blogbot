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
