import assert from "node:assert/strict";
import test from "node:test";

import { BOBY_GUIDE_SYSTEM_PROMPT, createBobyGuideTask } from "../src/boby-guide-task.ts";
import { resolveCodexRole } from "../src/role-policy.ts";
import { buildCodexExecArgs } from "../src/structured-runner.ts";

test("Boby guide uses the fast logical role and a closed action schema", () => {
  assert.equal(resolveCodexRole("BOBY_GUIDE").role, "FAST");
  const task = createBobyGuideTask({ question: "Taslagi nerede incelerim?", activePage: "content", runtimeState: "ONLINE", sessionId: "boby-luna-thread-1", safeWorkspaceSummary: { draftCount: 1, reviewCount: 0, sourceCount: 2 } });
  assert.equal(task.taskKind, "BOBY_GUIDE");
  assert.equal(task.persistSession, true);
  assert.equal(task.conversationSessionId, "boby-luna-thread-1");
  assert.match(BOBY_GUIDE_SYSTEM_PROMPT, /Luna Low/u);
  assert.match(BOBY_GUIDE_SYSTEM_PROMPT, /Boby olarak konuş/u);
  assert.doesNotMatch(BOBY_GUIDE_SYSTEM_PROMPT, /Codex'e bağlandım/u);
  assert.equal(task.validateOutput({ reply: "Editoryal Masa'yi ac.", suggestedActions: [{ id: "OPEN_EDITORIAL", label: "Editoryal Masa'yi ac" }] }), true);
  assert.equal(task.validateOutput({ reply: "x", suggestedActions: [{ id: "PUBLISH_NOW", label: "Yayinla" }] }), false);
  assert.throws(() => createBobyGuideTask({ question: " ", activePage: "content", runtimeState: "ONLINE", safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 } }), /BOBY_QUESTION_REQUIRED/u);
});

test("Boby starts a durable Luna Low thread then resumes the same local session", () => {
  const started = buildCodexExecArgs("default", "C:/safe/output.schema.json", { persistSession: true });
  const resumed = buildCodexExecArgs("default", "C:/safe/output.schema.json", {
    persistSession: true,
    conversationSessionId: "boby-luna-thread-1"
  });

  assert.deepEqual(started.slice(0, 3), ["exec", "--sandbox", "read-only"]);
  assert.equal(started.includes("--ephemeral"), false);
  assert.deepEqual(resumed.slice(0, 4), ["exec", "resume", "boby-luna-thread-1", "--sandbox"]);
  assert.equal(resumed.includes("--ephemeral"), false);
});
