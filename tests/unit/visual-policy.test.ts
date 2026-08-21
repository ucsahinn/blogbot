import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  buildSafeCoverSvg,
  planRasterVariants,
  renderCoverVariants,
  renderGeneratedImageVariants,
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

test("generated raster input is normalized into every local publication ratio", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "blogbot-generated-visuals-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const source = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: "#2456a6" }
  }).png().toBuffer();

  const artifacts = await renderGeneratedImageVariants(source, outputDirectory, "article-imagegen");
  assert.equal(artifacts.length, 3);
  for (const artifact of artifacts) {
    const metadata = await sharp(await readFile(artifact.absolutePath)).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, artifact.width);
    assert.equal(metadata.height, artifact.height);
  }
});

test("both renderers report the byte size they hashed and which renderer produced it", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "blogbot-visual-metadata-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const generated = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: "#2456a6" }
  }).png().toBuffer();

  const local = await renderCoverVariants(
    {
      title: "Kimlik güvenliği yeni çevre",
      palette: ["#08131f", "#32d3a6"],
      motifs: ["network", "shield"],
      externalAssets: [],
      depictsRealPerson: false,
      depictsBrandLogo: false
    },
    join(outputDirectory, "local"),
    "kimlik-guvenligi"
  );
  const provider = await renderGeneratedImageVariants(generated, join(outputDirectory, "provider"), "article-imagegen");

  // The digest and the size of one hash-bound media record must describe the
  // same read of the same file, so the size travels with the artifact instead
  // of being read back from disk by every caller.
  for (const artifact of [...local, ...provider]) {
    assert.equal(artifact.byteSize, (await stat(artifact.absolutePath)).size);
    assert.equal(artifact.byteSize, (await readFile(artifact.absolutePath)).byteLength);
  }
  // A provider bitmap cannot be checked against the art-direction policy, so
  // the caller must be able to tell it apart from the local cover.
  assert.deepEqual(local.map((artifact) => artifact.source), ["LOCAL_RENDERER", "LOCAL_RENDERER", "LOCAL_RENDERER"]);
  assert.deepEqual(provider.map((artifact) => artifact.source), ["IMAGEGEN", "IMAGEGEN", "IMAGEGEN"]);
});

test("a render that fails part-way through leaves no orphaned variants behind", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "blogbot-visual-partial-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const generated = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: "#2456a6" }
  }).png().toBuffer();
  // A directory in place of the second variant makes that single write fail
  // after the first one already succeeded.
  await mkdir(join(outputDirectory, "article-imagegen-4x3.webp"), { recursive: true });

  await assert.rejects(renderGeneratedImageVariants(generated, outputDirectory, "article-imagegen"));

  // The caller records no media for a failed render, so anything left here
  // would never be referenced or deleted again.
  assert.deepEqual(
    (await readdir(outputDirectory)).filter((entry) => entry !== "article-imagegen-4x3.webp"),
    []
  );
});

test("both renderers preserve pre-existing valid variants when a complete commit is impossible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-visual-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: "#2456a6" }
  }).png().toBuffer();
  const existing = await sharp({
    create: { width: 1600, height: 900, channels: 3, background: "#7a2f48" }
  }).webp().toBuffer();
  const direction = {
    title: "Kimlik guvenligi yeni cevre",
    palette: ["#08131f", "#32d3a6"],
    motifs: ["network", "shield"],
    externalAssets: [],
    depictsRealPerson: false,
    depictsBrandLogo: false
  };

  for (const renderer of [
    (directory: string) => renderCoverVariants(direction, directory, "retry-safe"),
    (directory: string) => renderGeneratedImageVariants(generated, directory, "retry-safe")
  ]) {
    const outputDirectory = await mkdtemp(join(root, "attempt-"));
    const existingPath = join(outputDirectory, "retry-safe-16x9.webp");
    await writeFile(existingPath, existing);
    await mkdir(join(outputDirectory, "retry-safe-4x3.webp"));

    await assert.rejects(renderer(outputDirectory));

    assert.deepEqual(await readFile(existingPath), existing);
    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      "retry-safe-16x9.webp",
      "retry-safe-4x3.webp"
    ]);
  }
});
