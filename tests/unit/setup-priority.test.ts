import assert from "node:assert/strict";
import test from "node:test";

import { nextSetupPrerequisite } from "../../apps/desktop/src/app-model.ts";
import type { PrerequisiteCheck } from "../../apps/desktop/src/types.ts";

function check(
  id: PrerequisiteCheck["id"],
  state: PrerequisiteCheck["state"],
  scope: PrerequisiteCheck["scope"]
): PrerequisiteCheck {
  return { id, state, scope, label: id, detail: id, userAction: null };
}

test("local-only setup never makes optional publishing the next required action", () => {
  const result = nextSetupPrerequisite([
    check("local-engine", "READY", "WRITE"),
    check("local-database", "READY", "WRITE"),
    check("local-queue", "READY", "WRITE"),
    check("codex", "READY", "WRITE"),
    check("github", "BLOCKED", "PUBLISH"),
    check("site-adapter", "BLOCKED", "PUBLISH"),
    check("backup", "BLOCKED", "APP")
  ], "LOCAL_ONLY");

  assert.equal(result, undefined);
});

test("publish setup asks for its publishing prerequisites after local drafting is ready", () => {
  const github = check("github", "BLOCKED", "PUBLISH");
  const result = nextSetupPrerequisite([
    check("local-engine", "READY", "WRITE"),
    check("local-database", "READY", "WRITE"),
    check("local-queue", "READY", "WRITE"),
    check("codex", "READY", "WRITE"),
    github,
    check("site-adapter", "BLOCKED", "PUBLISH")
  ], "PUBLISH");

  assert.equal(result, github);
});
