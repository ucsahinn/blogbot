import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describeBobyAvailability } from "../src/boby-conversation.ts";

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

test("Boby has no retained canned local reply path", async () => {
  const conversation = await readFile(new URL("../src/boby-conversation.ts", import.meta.url), "utf8");

  assert.doesNotMatch(conversation, /localBobyReply/u);
  assert.doesNotMatch(conversation, /shouldUseLocalBobyShortcut/u);
  assert.doesNotMatch(conversation, /OPE'nin yerel editöründesin/u);
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