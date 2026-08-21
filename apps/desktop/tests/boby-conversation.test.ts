import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describeBobyAvailability, localBobyReply, shouldUseLocalBobyShortcut } from "../src/boby-conversation.ts";

test("Boby is ready as an immediate local guide in every runtime state", () => {
  for (const input of [
    { runtime: "ONLINE" as const, codexState: "READY" as const },
    { runtime: "ONLINE" as const, codexState: "BUSY" as const },
    { runtime: "OFFLINE_READ_ONLY" as const, codexState: "UNAVAILABLE" as const }
  ]) {
    assert.deepEqual(describeBobyAvailability(input), {
      tone: "ready",
      label: "Boby hazır",
      detail: "Sorunu yaz; Boby bu ekrandaki sonraki adımı hemen açıklar."
    });
  }
});

test("Boby answers every non-empty editor question locally without waiting for a runner", () => {
  assert.equal(shouldUseLocalBobyShortcut("naber"), true);
  assert.equal(shouldUseLocalBobyShortcut("bu konu hakkında ne düşünüyorsun?"), true);
  assert.equal(shouldUseLocalBobyShortcut("kaynak nasıl eklenir?"), true);
  assert.equal(shouldUseLocalBobyShortcut("   "), false);
  assert.match(localBobyReply("Kaynak nasıl eklenir?", "content"), /Kaynak/iu);
  assert.doesNotMatch(localBobyReply("bu konu hakkında ne düşünüyorsun?", "content"), /canlı bağlantı/iu);
});

test("Boby panel has no login, queue, or durable-polling path", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /text: localBobyReply\(question, activePage\)/u);
  assert.match(assistant, /Merhaba, ben Boby/u);
  assert.doesNotMatch(assistant, /requestBobyGuidance|getBobyGuidance|testCodexRuntime|startCodexLogin|pendingGuidanceId|Yerel sırada/u);
});
