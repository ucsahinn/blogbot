import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiImageGenerator, imageGeneratorFromEnvironment } from "../../apps/engine/src/imagegen-provider.ts";

test("ImageGen creates a bounded editorial request and returns only decoded image bytes", async () => {
  let request: Request | undefined;
  const generator = createOpenAiImageGenerator({
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }), { status: 200 });
    }
  });

  const bytes = await generator.generate({
    title: "Güvenlik güncellemesi",
    articleType: "news",
    section: "haberler",
    sourceTitles: ["Birincil kaynak"]
  });

  assert.equal(Buffer.from(bytes).toString("utf8"), "image-bytes");
  assert.equal(request?.headers.get("authorization"), "Bearer test-key");
  const body = await request?.json() as { prompt?: string; size?: string; model?: string };
  assert.equal(body.size, "1536x1024");
  assert.equal(body.model, "gpt-image-1");
  assert.match(body.prompt ?? "", /Güvenlik güncellemesi/u);
  assert.doesNotMatch(body.prompt ?? "", /test-key/u);
});

test("ImageGen uses the article's editorial brief instead of guessing from a title alone", async () => {
  let request: Request | undefined;
  const generator = createOpenAiImageGenerator({
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }), { status: 200 });
    }
  });

  await generator.generate({
    title: "Kent ulaşımında yeni düzenleme",
    articleType: "analysis",
    section: "gundem",
    sourceTitles: ["Belediye karar metni"],
    summary: "Düzenleme, aktarma noktalarındaki yolcu akışını yeniden organize ediyor.",
    keyClaims: ["Karar 1 Eylül'de yürürlüğe girecek.", "Aktarma noktaları yeniden düzenlenecek."],
    visualIntent: "İnsan yüzü kullanmadan, şehir içi aktarma akışını soyut ama anlaşılır biçimde göster."
  });

  const body = await request?.json() as { prompt?: string };
  assert.match(body.prompt ?? "", /Düzenleme, aktarma noktalarındaki yolcu akışını/u);
  assert.match(body.prompt ?? "", /Karar 1 Eylül'de yürürlüğe girecek/u);
  assert.match(body.prompt ?? "", /şehir içi aktarma akışını/u);
  assert.match(body.prompt ?? "", /Do not include readable text, logos, watermarks/u);
});

test("ImageGen remains disabled until the host explicitly supplies a local environment key", () => {
  assert.equal(imageGeneratorFromEnvironment({}), undefined);
});
