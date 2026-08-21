import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Boby keeps a durable guidance job recoverable instead of reporting a false timeout", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /sessionStorage/u);
  assert.match(assistant, /Boby isteği sürüyor/u);
  assert.match(assistant, /WAITING_CODEX/u);
  assert.match(assistant, /BOBY_GUIDANCE_VISIBLE_WAIT_POLL_MS/u);
  assert.match(assistant, /document\.visibilityState/u);
  assert.match(assistant, /resumePendingBobyGuidance/u);
  assert.match(assistant, /releasePendingBobyGuidance/u);
  assert.doesNotMatch(assistant, /Boby yanıtı zaman aşımına uğradı/u);
});
