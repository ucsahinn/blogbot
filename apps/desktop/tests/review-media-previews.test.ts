import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import test from "node:test";

type MediaPreviewAsset = { role: "hero" | "inline"; sha256: string; byteSize?: number; contentBase64?: string };
type PreviewModule = {
  MAX_MEDIA_PREVIEW_LOADS: number;
  loadRevisionMediaPreviews(input: {
    revisionId: string;
    media: MediaPreviewAsset[];
    readMedia(input: { revisionId: string; sha256: string }): Promise<{ mimeType: string; contentBase64: string }>;
  }): Promise<{ urls: Record<string, string>; errors: Record<string, true>; selectedSha256: string[] }>;
  selectMediaPreviewAssets(media: MediaPreviewAsset[]): MediaPreviewAsset[];
};

let previewModule: Promise<PreviewModule> | undefined;

function loadPreviewModule(): Promise<PreviewModule> {
  previewModule ??= build({
    entryPoints: [fileURLToPath(new URL("../src/screens/ReviewWorkspace.tsx", import.meta.url))],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false
  }).then((result) => {
    const compiled = result.outputFiles[0]?.text;
    if (!compiled) throw new Error("REVIEW_WORKSPACE_BUNDLE_MISSING");
    const module = { exports: {} as PreviewModule };
    new Function("module", "exports", "require", compiled)(module, module.exports, createRequire(import.meta.url));
    return module.exports;
  });
  return previewModule;
}

const hero: MediaPreviewAsset = {
  role: "hero",
  sha256: "a".repeat(64),
  byteSize: 12
};

test("a failed preview read does not discard a valid hero and can succeed on retry", async () => {
  const { loadRevisionMediaPreviews } = await loadPreviewModule();
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
  const { MAX_MEDIA_PREVIEW_LOADS, loadRevisionMediaPreviews, selectMediaPreviewAssets } = await loadPreviewModule();
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
