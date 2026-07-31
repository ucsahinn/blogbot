export type AutomationMode = "OFF" | "INGEST_ONLY" | "DRAFT_ONLY" | "PUBLISH_APPROVED";

export interface AutomationSettings {
  mode: AutomationMode;
  onboardingComplete: boolean;
  ingestionPaused: boolean;
  publishingPaused: boolean;
  timezone: string;
  scanIntervalMinutes: number;
}

export interface AutomationCapabilities {
  canIngest: boolean;
  canDraft: boolean;
  canPublishApproved: boolean;
}

const modeRank: Readonly<Record<AutomationMode, number>> = {
  OFF: 0,
  INGEST_ONLY: 1,
  DRAFT_ONLY: 2,
  PUBLISH_APPROVED: 3
};

export function canSetAutomationMode(
  requestedMode: AutomationMode,
  onboardingComplete: boolean
): boolean {
  return requestedMode !== "PUBLISH_APPROVED" || onboardingComplete;
}

export function deriveAutomationCapabilities(
  settings: AutomationSettings
): AutomationCapabilities {
  if (!canSetAutomationMode(settings.mode, settings.onboardingComplete)) {
    return {
      canIngest: false,
      canDraft: false,
      canPublishApproved: false
    };
  }

  const rank = modeRank[settings.mode];
  return {
    canIngest: rank >= modeRank.INGEST_ONLY && !settings.ingestionPaused,
    canDraft: rank >= modeRank.DRAFT_ONLY,
    canPublishApproved:
      rank >= modeRank.PUBLISH_APPROVED && !settings.publishingPaused
  };
}

export function assertValidAutomationSettings(settings: AutomationSettings): void {
  if (!canSetAutomationMode(settings.mode, settings.onboardingComplete)) {
    throw new Error("PUBLISH_APPROVED requires completed onboarding");
  }
  if (!Number.isInteger(settings.scanIntervalMinutes) || settings.scanIntervalMinutes < 5) {
    throw new Error("scanIntervalMinutes must be an integer of at least 5");
  }
  if (settings.timezone !== "Europe/Istanbul") {
    throw new Error("V1 only supports the Europe/Istanbul editorial timezone");
  }
}
