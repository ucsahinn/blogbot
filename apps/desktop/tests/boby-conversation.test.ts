import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bobyGuidancePollDelay, describeBobyAvailability, isBobyRunnerUnavailable, resolveBobyGuidancePoll } from "../src/boby-conversation.ts";

test("Boby is ready as an immediate local guide in every runtime state", () => {
  for (const input of [
    { runtime: "ONLINE" as const, codexState: "READY" as const },
    { runtime: "ONLINE" as const, codexState: "BUSY" as const },
    { runtime: "OFFLINE_READ_ONLY" as const, codexState: "UNAVAILABLE" as const }
  ]) {
    assert.deepEqual(describeBobyAvailability(input), {
      tone: "ready",
      label: "Boby hazır",
      detail: "Luna Low ile yanıtlar; yalnızca soruna odaklanır ve ek kullanım başlatmaz."
    });
  }
});

test("Boby has no retained canned local reply path", async () => {
  const conversation = await readFile(new URL("../src/boby-conversation.ts", import.meta.url), "utf8");

  assert.doesNotMatch(conversation, /localBobyReply/u);
  assert.doesNotMatch(conversation, /shouldUseLocalBobyShortcut/u);
  assert.doesNotMatch(conversation, /OPE'nin yerel editöründesin/u);
});
test("Boby exposes a waiting runner as unavailable instead of a live reply", () => {
  assert.equal(isBobyRunnerUnavailable("WAITING_CODEX"), true);
  assert.equal(isBobyRunnerUnavailable("RUNNING"), false);
});
test("Boby checks a newly accepted reply quickly before backing off", () => {
  assert.equal(bobyGuidancePollDelay(0, true), 350);
  assert.equal(bobyGuidancePollDelay(5_000, true), 2_000);
  assert.equal(bobyGuidancePollDelay(120_000, true), 15_000);
  assert.equal(bobyGuidancePollDelay(120_000, false), 60_000);
});
test("Boby keeps a pending reply through the runner deadline before abandoning a stale request", () => {
  const guidanceId = "boby-late-reply";
  assert.deepEqual(resolveBobyGuidancePoll({
    guidanceId,
    elapsedMs: 30_000,
    isDocumentVisible: true,
    state: "RUNNING"
  }), { kind: "continue", guidanceId, nextPollMs: 2_000 });
  assert.deepEqual(resolveBobyGuidancePoll({
    guidanceId,
    elapsedMs: 330_001,
    isDocumentVisible: true,
    state: "RUNNING"
  }), { kind: "expired", guidanceId });
});
test("Boby panel uses the existing Luna conversation bridge when it is ready", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /requestBobyGuidance/u);
  assert.match(assistant, /getBobyGuidance/u);
  assert.match(assistant, /suggestedActions/u);
  assert.match(assistant, /const \[messages, setMessages\] = useState<BobyReply\[\]>\(\[\]\)/u);
  assert.match(assistant, /persistPendingBobyGuidance/u);
  assert.doesNotMatch(assistant, /localBobyReply/u);
  assert.doesNotMatch(assistant, /Yerel sırada/u);
});
test("Boby starts as a live conversation, not a pre-written page-specific answer", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(assistant, /function pageGuidance/u);
  assert.doesNotMatch(assistant, /boby-quick-actions/u);
  assert.match(assistant, /Boby yanıtı/u);
});

test("Boby renders a completed Luna message as a conversation reply, not a warning card", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /finish\(\{ text: result\.reply, actions, origin: "boby" \}\)/u);
});