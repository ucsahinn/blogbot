import assert from "node:assert/strict";
import test from "node:test";

import { BOBY_GUIDE_SYSTEM_PROMPT, createBobyGuideTask } from "../src/boby-guide-task.ts";
import { resolveCodexRole } from "../src/role-policy.ts";
import { buildCodexExecArgs } from "../src/structured-runner.ts";

test("Boby guide uses the fast logical role and a closed action schema", () => {
  assert.equal(resolveCodexRole("BOBY_GUIDE").role, "FAST");
  const task = createBobyGuideTask({ question: "Taslagi nerede incelerim?", activePage: "content", runtimeState: "ONLINE", sessionId: "019fae00-0000-7000-8000-000000000001", safeWorkspaceSummary: { draftCount: 1, reviewCount: 0, sourceCount: 2 } });
  assert.equal(task.taskKind, "BOBY_GUIDE");
  assert.equal(task.persistSession, true);
  assert.equal(task.conversationSessionId, "019fae00-0000-7000-8000-000000000001");
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
    conversationSessionId: "019fae00-0000-7000-8000-000000000001"
  });

  assert.deepEqual(started.slice(0, 3), ["exec", "--sandbox", "read-only"]);
  assert.equal(started.includes("--ephemeral"), false);
  assert.deepEqual(resumed.slice(0, 5), ["exec", "--sandbox", "read-only", "resume", "019fae00-0000-7000-8000-000000000001"]);
  assert.equal(resumed.includes("--ephemeral"), false);
});

test("Boby never forwards a session name or path-like value as an app-owned Codex thread", () => {
  for (const sessionId of ["boby-luna-thread-1", "../thread", "-override", "019fae00-0000-7000-8000-00000000000z"]) {
    const task = createBobyGuideTask({
      question: "Taslağı nerede incelerim?",
      activePage: "content",
      runtimeState: "ONLINE",
      sessionId,
      safeWorkspaceSummary: { draftCount: 1, reviewCount: 0, sourceCount: 2 }
    });
    assert.equal(task.conversationSessionId, undefined, sessionId);
  }
});

test("Boby's scope guardrail reaches Codex as readable Turkish", () => {
  const task = createBobyGuideTask({
    question: "Kaynak nasıl eklenir?",
    activePage: "dashboard",
    runtimeState: "ONLINE",
    safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 }
  });
  const system = (task.input as { system: string }).system;

  // This instruction was stored as UTF-8 bytes decoded as Latin-1, so the
  // guardrail Codex actually received was mojibake ("dÄ±ÅŸÄ±ndaki").
  assert.match(system, /OPE dışındaki günlük işler/u);
  assert.match(system, /kısa ve nazikçe reddet/u);
  assert.doesNotMatch(
    system,
    /Ä±|ÅŸ|Ã¼|Ã§|Ã¶|ÄŸ/u,
    "the prompt must not contain Latin-1 mojibake"
  );
});
