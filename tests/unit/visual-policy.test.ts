import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  buildSafeCoverSvg,
  planRasterVariants,
  renderCoverVariants,
  validateArtDirection
} from "../../packages/visuals/src/index.ts";

test("fallback renderer always plans the three public raster ratios", () => {
  assert.deepEqual(planRasterVariants("identity-shift"), [
    { ratio: "16:9", width: 1600, height: 900, path: "identity-shift-16x9.webp" },
    { ratio: "4:3", width: 1200, height: 900, path: "identity-shift-4x3.webp" },
    { ratio: "1:1", width: 1200, height: 1200, path: "identity-shift-1x1.webp" }
  ]);
});

test("art direction blocks remote assets and unsupported brand or person depictions", () => {
  assert.deepEqual(
    validateArtDirection({
      title: "Identity shift",
      palette: ["#08131f", "#32d3a6"],
      motifs: ["network", "shield"],
      externalAssets: ["https://example.com/logo.svg"],
      depictsRealPerson: false,
      depictsBrandLogo: true
    }),
    {
      valid: false,
      blockers: ["EXTERNAL_ASSET_FORBIDDEN", "BRAND_LOGO_REQUIRES_HUMAN_REVIEW"],
      warnings: []
    }
  );
});

test("SVG intermediate escapes injected markup and contains no remote references", () => {
  const svg = buildSafeCoverSvg({
    title: '<script src="https://evil.example/x.js">x</script>',
    palette: ["#08131f", "#32d3a6"],
    motifs: ["network"],
    externalAssets: [],
    depictsRealPerson: false,
    depictsBrandLogo: false
  }, { width: 1600, height: 900 });

  assert.doesNotMatch(svg, /<script|(?:href|src)=["']https?:\/\//i);
  assert.match(svg, /&lt;script/);
});

test("local renderer emits metadata-free WebP files for every required ratio", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "blogbot-visuals-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const artifacts = await renderCoverVariants(
    {
      title: "Kimlik güvenliği yeni çevre",
      palette: ["#08131f", "#32d3a6"],
      motifs: ["network", "shield"],
      externalAssets: [],
      depictsRealPerson: false,
      depictsBrandLogo: false
    },
    outputDirectory,
    "kimlik-guvenligi"
  );

  assert.equal(artifacts.length, 3);
  for (const artifact of artifacts) {
    const metadata = await sharp(await readFile(artifact.absolutePath)).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, artifact.width);
    assert.equal(metadata.height, artifact.height);
    assert.equal(metadata.exif, undefined);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  }
});
