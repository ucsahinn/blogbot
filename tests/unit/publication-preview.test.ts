import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildPublicationPreview } from "../../apps/engine/src/publication-preview.ts";

test("publication preview hashes an immutable engine media reference without inlining bytes", () => {
  const tr = "Türkçe içerik";
  const en = "English content";
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const mediaHash = "c".repeat(64);
  const manifest = JSON.stringify({
    version: 1,
    revisionId: "revision-media-ref",
    revisionHash: "a".repeat(64),
    translationKey: "article-media-ref",
    adapterVersion: "astro-generic@1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    entries: [
      { path: "src/content/articles/tr/haberler/revision-media-ref.md", sha256: sha256(tr), bytes: Buffer.byteLength(tr) },
      { path: "src/content/articles/en/news/revision-media-ref.md", sha256: sha256(en), bytes: Buffer.byteLength(en) },
      { path: "public/images/hero.webp", sha256: mediaHash, bytes: 512 }
    ]
  });
  const preview = buildPublicationPreview({
    revisionId: "revision-media-ref",
    approvedRevisionHash: "a".repeat(64),
    currentRevisionHash: "a".repeat(64),
    targetRepository: "owner/site",
    baseBranch: "main",
    approvedBaseSha: "b".repeat(40),
    currentBaseSha: "b".repeat(40),
    siteOrigin: "https://example.test",
    contentRoot: "/site",
    requiredChecks: ["ci/test"],
    deployWorkflow: "deploy.yml",
    bundlePolicy: {
      adapterId: "astro-generic",
      manifestPath: ".blogbot/manifests/revision-media-ref.json",
      allowedPathPrefixes: ["src/content/articles/", "public/images/", ".blogbot/manifests/"],
      requiredLocalePrefixes: ["src/content/articles/tr/", "src/content/articles/en/"],
      requiredMediaPrefix: "public/images/"
    },
    now: "2026-08-11T00:00:00.000Z",
    files: [
      { path: "src/content/articles/tr/haberler/revision-media-ref.md", content: "Türkçe içerik" },
      { path: "src/content/articles/en/news/revision-media-ref.md", content: "English content" },
      {
        path: "public/images/hero.webp",
        content: {
          kind: "engine-media-ref",
          revisionId: "revision-media-ref",
          sha256: mediaHash,
          byteSize: 512
        }
      },
      { path: ".blogbot/manifests/revision-media-ref.json", content: manifest }
    ] as never
  });

  assert.match(preview.previewHash, /^[a-f0-9]{64}$/u);
});
