import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Boby presents live Luna replies without exposing durable queue terminology", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /const respond = async \(question: string\)/u);
  assert.match(assistant, /requestBobyGuidance/u);
  assert.match(assistant, /getBobyGuidance/u);
  assert.match(assistant, /Boby düşünüyor/u);
  assert.doesNotMatch(assistant, /Yerel sırada|WAITING_CODEX/u);
});
test("Boby stops immediately when the local answer runner is unavailable", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /isBobyRunnerUnavailable\(result\.state\)/u);
  assert.match(assistant, /Boby şu an yanıt altyapısına ulaşamıyor/u);
});
test("Boby clears a stale unanswered request instead of polling forever", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /BOBY_REPLY_TIMEOUT_MS/u);
  assert.match(assistant, /Boby bu yanıtı zamanında tamamlayamadı/u);
  assert.match(assistant, /persistPendingBobyGuidance/u);
  assert.match(assistant, /restorePendingBobyGuidance/u);
});