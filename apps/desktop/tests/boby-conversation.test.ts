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

test("Boby reserves local shortcuts for an unavailable Luna session", () => {
  assert.equal(shouldUseLocalBobyShortcut("naber"), false);
  assert.equal(shouldUseLocalBobyShortcut("bu konu hakkında ne düşünüyorsun?"), false);
  assert.equal(shouldUseLocalBobyShortcut("kaynak nasıl eklenir?"), false);
  assert.equal(shouldUseLocalBobyShortcut("   "), false);
  assert.match(localBobyReply("Kaynak nasıl eklenir?", "content"), /Kaynak/iu);
  assert.doesNotMatch(localBobyReply("bu konu hakkında ne düşünüyorsun?", "content"), /canlı bağlantı/iu);
});

test("Boby panel uses the existing Luna conversation bridge when it is ready", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /requestBobyGuidance/u);
  assert.match(assistant, /getBobyGuidance/u);
  assert.match(assistant, /suggestedActions/u);
  assert.match(assistant, /Merhaba, ben Boby/u);
  assert.match(assistant, /persistPendingBobyGuidance/u);
  assert.doesNotMatch(assistant, /localBobyReply/u);
  assert.doesNotMatch(assistant, /Yerel sırada/u);
});
