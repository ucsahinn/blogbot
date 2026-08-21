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
