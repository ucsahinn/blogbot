import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MEDIA_PREVIEW_LOADS,
  loadRevisionMediaPreviews,
  selectMediaPreviewAssets,
  type MediaPreviewAsset
} from "../src/screens/review-media-previews.ts";

const hero: MediaPreviewAsset = {
  role: "hero",
  sha256: "a".repeat(64),
  byteSize: 12
};

test("a failed preview read does not discard a valid hero and can succeed on retry", async () => {
  let failSecondary = true;
  const secondary: MediaPreviewAsset = { role: "inline", sha256: "b".repeat(64), byteSize: 12 };
  const readMedia = async ({ sha256 }: { revisionId: string; sha256: string }) => {
    if (sha256 === secondary.sha256 && failSecondary) throw new Error("temporary read failure");
    return { mimeType: "image/webp", contentBase64: Buffer.from(sha256).toString("base64") };
  };

  const first = await loadRevisionMediaPreviews({ revisionId: "review-1", media: [hero, secondary], readMedia });
  assert.match(first.urls[hero.sha256] ?? "", /^data:image\/webp;base64,/u);
  assert.equal(first.errors[secondary.sha256], true);

  failSecondary = false;
  const second = await loadRevisionMediaPreviews({ revisionId: "review-1", media: [hero, secondary], readMedia });
  assert.match(second.urls[hero.sha256] ?? "", /^data:image\/webp;base64,/u);
  assert.match(second.urls[secondary.sha256] ?? "", /^data:image\/webp;base64,/u);
  assert.deepEqual(second.errors, {});
});

test("preview reads prioritize hero media and remain bounded", async () => {
  const calls: string[] = [];
  const media: MediaPreviewAsset[] = [
    ...Array.from({ length: 10 }, (_, index) => ({ role: "inline" as const, sha256: String(index).padStart(64, "0"), byteSize: 12 })),
    hero
  ];
  const result = await loadRevisionMediaPreviews({
    revisionId: "review-2",
    media,
    readMedia: async ({ sha256 }) => {
      calls.push(sha256);
      return { mimeType: "image/webp", contentBase64: "image" };
    }
  });

  assert.equal(calls.length, MAX_MEDIA_PREVIEW_LOADS);
  assert.equal(calls[0], hero.sha256);
  assert.match(result.urls[hero.sha256] ?? "", /^data:image\/webp;base64,/u);
  assert.equal(result.selectedSha256.length, MAX_MEDIA_PREVIEW_LOADS);
  assert.equal(result.selectedSha256.includes(media[4]!.sha256), false);
  assert.equal(result.errors[media[4]!.sha256], undefined);
  assert.equal(selectMediaPreviewAssets(media).some((asset) => asset.sha256 === media[4]!.sha256), false);
});

test("media facts come from the asset, not a fixed 16:9 WebP label", async () => {
  const module = await import("../src/screens/review-media-previews.ts") as Record<string, unknown>;
  const aspect = module.mediaAspectLabel as ((width: number, height: number) => string) | undefined;
  const format = module.mediaFormatLabel as ((filename: string) => string) | undefined;
  assert.equal(typeof aspect, "function");
  assert.equal(typeof format, "function");
  assert.equal(aspect!(1600, 900), "16:9");
  assert.equal(aspect!(1200, 1200), "1:1");
  assert.equal(aspect!(1080, 1350), "4:5");
  assert.equal(aspect!(1000, 523), "1.91:1");
  assert.equal(aspect!(0, 0), "Bilinmiyor");
  assert.equal(format!("hero-1600x900.webp"), "WebP");
  assert.equal(format!("hero.PNG"), "PNG");
  assert.equal(format!("hero.jpeg"), "JPEG");
  assert.equal(format!("hero"), "Bilinmiyor");
});
