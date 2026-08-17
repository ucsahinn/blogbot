import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describeBobyAvailability, localBobyReply, shouldUseLocalBobyShortcut } from "../src/boby-conversation.ts";

test("Boby presents its Luna Low mind as ready without exposing a Codex integration step", () => {
  assert.deepEqual(describeBobyAvailability({ runtime: "ONLINE", codexState: "READY" }), {
    tone: "ready",
    label: "Boby hazır · Luna Low",
    detail: "Sorunu yaz; Boby bağlamı anlayıp yanıtlasın."
  });
});

test("Boby exposes a human status instead of a technical Codex queue", () => {
  assert.deepEqual(describeBobyAvailability({ runtime: "ONLINE", codexState: "BUSY" }), {
    tone: "attention",
    label: "Boby düşünüyor · Luna Low",
    detail: "Yanıt hazırlanıyor; uygulamayı kullanmaya devam edebilirsin."
  });
  assert.deepEqual(describeBobyAvailability({ runtime: "ONLINE", codexState: "UNAVAILABLE" }), {
    tone: "blocker",
    label: "Boby henüz hazır değil",
      detail: "Boby'yi bağla düğmesiyle güvenli girişi başlat; hazır olduğunda aynı konuşmadan devam et."
  });
});

test("Boby never reports itself ready while the local engine is unavailable", () => {
  assert.deepEqual(describeBobyAvailability({ runtime: "OFFLINE_READ_ONLY", codexState: "READY" }), {
    tone: "blocker",
    label: "Yerel bileşen çevrimdışı",
    detail: "Boby yalnız kayıtlı yerel rehberliği gösterebilir."
  });
});

test("offline Boby gives distinct app guidance instead of repeating one failure message", () => {
  const source = localBobyReply("Kaynak nasıl eklenir?", "content");
  const draft = localBobyReply("Taslak nasıl oluşturulur?", "content");
  const seo = localBobyReply("SEO kontrolü nerede?", "publishing");

  assert.notEqual(source, draft);
  assert.match(source, /Kaynak/iu);
  assert.match(source, /İçerik Akışı/iu);
  assert.match(draft, /taslak/iu);
  assert.match(seo, /SEO/iu);
});
test("Boby does not intercept editorial requests with a generic local answer", () => {
  assert.equal(shouldUseLocalBobyShortcut("naber"), false);
  assert.equal(shouldUseLocalBobyShortcut("bu konu hakkında ne düşünüyorsun?"), false);
  assert.equal(shouldUseLocalBobyShortcut("kaynak nasıl eklenir?"), false);
  assert.equal(shouldUseLocalBobyShortcut("bu konu için post hazırla"), false);
});

test("Boby panel uses the Boby and Luna Low voice for its visible handoff", async () => {
  const assistant = await readFile(new URL("../src/components/BobyAssistant.tsx", import.meta.url), "utf8");

  assert.match(assistant, /Boby düşünüyor; yanıtı burada hazırlıyorum\./u);
  assert.match(assistant, /Boby'yi bağla/u);
  assert.match(assistant, /Durumu yenile/u);
  assert.match(assistant, /Boby · Luna Low/u);
  assert.doesNotMatch(assistant, /Codex'e ilettim/u);
  assert.match(assistant, /Merhaba, ben Boby\./u);
  assert.match(assistant, /bridge\.getBootstrapSnapshot\(\)/u);
  assert.match(assistant, /Boby'nin canlı durumu yenilenemedi/u);
  assert.match(assistant, /getBootstrapSnapshot\(\)[\s\S]*\.catch\(\(reason\) =>/u);
  assert.match(assistant, /bridge\.testCodexRuntime\(\)/u);
  assert.match(assistant, /bridge\.startCodexLogin\(\)/u);
  assert.match(assistant, /Boby'yi bağla/u);
  assert.match(assistant, /liveRuntime === "ONLINE"/u);
  const quickActions = assistant.match(/<div className="boby-quick-actions"[^>]*>([\s\S]*?)<\/div>/u)?.[1] ?? "";
  assert.equal((quickActions.match(/disabled=\{deliveryState === "queued"\}/gu) ?? []).length, 4);
  assert.match(assistant, /Boby hazırlanıyor · Luna Low/u);
  assert.match(assistant, /setLiveStatus\(\{/u);
  assert.match(
    assistant,
    /BOBY_GUIDANCE_TIMEOUT_MS\s*=\s*120_000/u,
    "Boby guidance polling must stop after a bounded wait instead of staying pending forever"
  );
  assert.match(assistant, /Boby yanıtı zaman aşımına uğradı/u);
  assert.doesNotMatch(assistant, /Codex'e ilettim/u);
});
