import assert from "node:assert/strict";
import test from "node:test";

import { BOBY_GUIDE_SYSTEM_PROMPT, createBobyGuideTask } from "../src/boby-guide-task.ts";
import { resolveCodexRole } from "../src/role-policy.ts";
import { buildCodexExecArgs } from "../src/structured-runner.ts";

test("Boby guide uses the fast logical role and a closed action schema", () => {
  const selection = resolveCodexRole("BOBY_GUIDE");
  assert.equal(selection.role, "FAST");
  assert.equal(selection.model, "gpt-5.6-luna");
  const task = createBobyGuideTask({ question: "Taslagi nerede incelerim?", activePage: "content", runtimeState: "ONLINE", sessionId: "019fae00-0000-7000-8000-000000000001", safeWorkspaceSummary: { draftCount: 1, reviewCount: 0, sourceCount: 2 } });
  assert.equal(task.taskKind, "BOBY_GUIDE");
  assert.equal(task.persistSession, false);
  assert.equal(task.conversationSessionId, undefined);
  assert.match(BOBY_GUIDE_SYSTEM_PROMPT, /Luna Low/u);
  assert.match(BOBY_GUIDE_SYSTEM_PROMPT, /Boby olarak konuş/u);
  assert.doesNotMatch(BOBY_GUIDE_SYSTEM_PROMPT, /Codex'e bağlandım/u);
  assert.equal(task.validateOutput({ reply: "Editoryal Masa'yi ac.", suggestedActions: [{ id: "OPEN_EDITORIAL", label: "Editoryal Masa'yi ac" }] }), true);
  assert.equal(task.validateOutput({ reply: "x", suggestedActions: [{ id: "PUBLISH_NOW", label: "Yayinla" }] }), false);
  assert.throws(() => createBobyGuideTask({ question: " ", activePage: "content", runtimeState: "ONLINE", safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 } }), /BOBY_QUESTION_REQUIRED/u);
});

test("Boby's fast role passes the configured Luna model to Codex", () => {
  const args = buildCodexExecArgs(resolveCodexRole("BOBY_GUIDE").model, "C:/safe/output.schema.json");
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-luna");
});

test("Boby uses a fresh ephemeral Luna Low turn even when an old session id exists", () => {
  const args = buildCodexExecArgs("default", "C:/safe/output.schema.json", {
    persistSession: false,
    conversationSessionId: "019fae00-0000-7000-8000-000000000001"
  });

  assert.deepEqual(args.slice(0, 4), ["exec", "--ephemeral", "--sandbox", "read-only"]);
  assert.equal(args.includes("resume"), false);
});

test("Boby never forwards any previous app-owned Codex thread", () => {
  for (const sessionId of ["boby-luna-thread-1", "../thread", "-override", "019fae00-0000-7000-8000-00000000000z", "019fae00-0000-7000-8000-000000000001"]) {
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

test("Boby accepts light chat and keeps non-editorial requests inside a friendly boundary", () => {
  const task = createBobyGuideTask({
    question: "Kaynak nasıl eklenir?",
    activePage: "dashboard",
    runtimeState: "ONLINE",
    safeWorkspaceSummary: { draftCount: 0, reviewCount: 0, sourceCount: 0 }
  });
  const system = (task.input as { system: string }).system;

  // This instruction was stored as UTF-8 bytes decoded as Latin-1, so the
  // guardrail Codex actually received was mojibake ("dÄ±ÅŸÄ±ndaki").
  assert.match(system, /Kısa selamlaşma ve gündelik cümlelere doğal, sıcak ve kısa yanıt ver/u);
  assert.match(system, /kısa ve nazikçe sınırlandır/u);
  assert.doesNotMatch(
    system,
    /Ä±|ÅŸ|Ã¼|Ã§|Ã¶|ÄŸ/u,
    "the prompt must not contain Latin-1 mojibake"
  );
});
