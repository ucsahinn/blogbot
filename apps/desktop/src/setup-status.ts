import type { PrerequisiteState } from "./types.ts";

export type SetupStatusTone = "ready" | "attention" | "blocker" | "running" | "not-tested";

export function describePrerequisiteState(state: PrerequisiteState): { tone: Extract<SetupStatusTone, "ready" | "attention" | "blocker">; label: string } {
  switch (state) {
    case "READY":
      return { tone: "ready", label: "Yapıldı" };
    case "MISSING":
      return { tone: "blocker", label: "Kurulum gerekli" };
    case "BLOCKED":
      return { tone: "attention", label: "Bağlantı bekliyor" };
    case "ATTENTION":
      return { tone: "attention", label: "İnceleme gerekli" };
  }
}

export function summarizeGuidedStates(states: ReadonlyArray<PrerequisiteState>, busy: boolean): SetupStatusTone {
  if (busy) return "running";
  if (states.length === 0) return "not-tested";
  if (states.includes("MISSING")) return "blocker";
  if (states.includes("BLOCKED") || states.includes("ATTENTION")) return "attention";
  return states.every((state) => state === "READY") ? "ready" : "not-tested";
}
