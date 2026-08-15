import assert from "node:assert/strict";
import test from "node:test";

import { describePrerequisiteState, summarizeGuidedStates } from "../src/setup-status.ts";

test("prerequisite labels separate an actual missing component from an external connection that is waiting", () => {
  assert.deepEqual(describePrerequisiteState("READY"), { tone: "ready", label: "Yapıldı" });
  assert.deepEqual(describePrerequisiteState("MISSING"), { tone: "blocker", label: "Kurulum gerekli" });
  assert.deepEqual(describePrerequisiteState("BLOCKED"), { tone: "attention", label: "Bağlantı bekliyor" });
  assert.deepEqual(describePrerequisiteState("ATTENTION"), { tone: "attention", label: "İnceleme gerekli" });
});

test("wizard uses red only for a missing required component and amber for work that is waiting", () => {
  assert.equal(summarizeGuidedStates(["READY", "BLOCKED"], false), "attention");
  assert.equal(summarizeGuidedStates(["READY", "MISSING"], false), "blocker");
  assert.equal(summarizeGuidedStates(["READY"], true), "running");
});
