import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Boby stays available without a durable guidance queue or a timeout state", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /const respond = \(question: string\)/u);
  assert.match(assistant, /text: localBobyReply\(question, activePage\)/u);
  assert.doesNotMatch(assistant, /pendingGuidanceId|WAITING_CODEX|BOBY_GUIDANCE_TIMEOUT_MS|requestBobyGuidance|getBobyGuidance/u);
});
