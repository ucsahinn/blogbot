import assert from "node:assert/strict";
import test from "node:test";

import {
  canSetAutomationMode,
  deriveAutomationCapabilities,
  type AutomationSettings
} from "../../packages/editorial/src/automation.ts";

test("pilot defaults allow ingestion but never drafting or publishing", () => {
  const settings: AutomationSettings = {
    mode: "INGEST_ONLY",
    onboardingComplete: false,
    ingestionPaused: false,
    publishingPaused: false,
    timezone: "Europe/Istanbul",
    scanIntervalMinutes: 30
  };

  assert.deepEqual(deriveAutomationCapabilities(settings), {
    canIngest: true,
    canDraft: false,
    canPublishApproved: false
  });
});

test("publish mode cannot be enabled before onboarding is complete", () => {
  assert.equal(canSetAutomationMode("PUBLISH_APPROVED", false), false);
  assert.equal(canSetAutomationMode("PUBLISH_APPROVED", true), true);
});

test("ingestion and publishing emergency pauses are independent", () => {
  const settings: AutomationSettings = {
    mode: "PUBLISH_APPROVED",
    onboardingComplete: true,
    ingestionPaused: true,
    publishingPaused: false,
    timezone: "Europe/Istanbul",
    scanIntervalMinutes: 30
  };

  assert.deepEqual(deriveAutomationCapabilities(settings), {
    canIngest: false,
    canDraft: true,
    canPublishApproved: true
  });
});
