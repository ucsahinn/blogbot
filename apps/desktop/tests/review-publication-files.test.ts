import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildPublicationFiles } from "../src/publication-files.ts";
import type { ReviewRevision } from "../src/types.ts";

test("review publication manifest names the exact approved revision and adapter", async () => {
  const revision: ReviewRevision = {
    id: "revision-review-package",
    revisionHash: "a".repeat(64),
    articleId: "article-review-package",
    state: "APPROVED",
    section: "haberler",
    articleType: "news",
    author: "Yerel Editorya",
    tags: ["örnek"],
    scheduledAt: "2026-08-04T12:00:00.000Z",
    adapterVersion: "local-folder-v1@1",
    tr: { title: "Türkçe başlık", description: "Türkçe açıklama", slug: "turkce-baslik", bodyMarkdown: "Türkçe içerik" },
    en: { title: "English title", description: "English description", slug: "english-title", bodyMarkdown: "English content" },
    previous: {
      tr: { title: "Türkçe başlık", description: "Türkçe açıklama", slug: "turkce-baslik", bodyMarkdown: "Türkçe içerik" },
      en: { title: "English title", description: "English description", slug: "english-title", bodyMarkdown: "English content" }
    },
    claims: [],
    sources: [],
    gates: [],
    media: []
  };

  const files = await buildPublicationFiles(revision, "LOCAL_ONLY", "local-folder-v1");
  const manifestFile = files.find((file) => file.path === `.blogbot/manifests/${revision.id}.json`);
  assert.equal(typeof manifestFile?.content, "string");
  const manifest = JSON.parse(String(manifestFile?.content)) as { revisionHash: string; adapterVersion: string };
  assert.equal(manifest.revisionHash, revision.revisionHash);
  assert.equal(manifest.adapterVersion, revision.adapterVersion);
});

test("review publication manifest binds engine-owned media by immutable reference", async () => {
  const revision: ReviewRevision = {
    id: "revision-with-media",
    revisionHash: "b".repeat(64),
    articleId: "article-with-media",
    state: "APPROVED",
    section: "haberler",
    articleType: "news",
    author: "Yerel Editorya",
    tags: ["örnek"],
    scheduledAt: "2026-08-04T12:00:00.000Z",
    adapterVersion: "local-folder-v1@1",
    tr: { title: "Türkçe başlık", description: "Türkçe açıklama", slug: "turkce-baslik", bodyMarkdown: "Türkçe içerik" },
    en: { title: "English title", description: "English description", slug: "english-title", bodyMarkdown: "English content" },
    previous: {
      tr: { title: "Türkçe başlık", description: "Türkçe açıklama", slug: "turkce-baslik", bodyMarkdown: "Türkçe içerik" },
      en: { title: "English title", description: "English description", slug: "english-title", bodyMarkdown: "English content" }
    },
    claims: [],
    sources: [],
    gates: [],
    media: [{
      id: "hero-media",
      role: "hero",
      filename: "hero.webp",
      width: 1600,
      height: 900,
      sha256: createHash("sha256").update(Buffer.from([0, 1, 2, 3, 255])).digest("hex"),
      byteSize: 5,
      altTr: "Türkçe kapak",
      altEn: "English cover"
    }]
  };

  const files = await buildPublicationFiles(revision, "LOCAL_ONLY", "local-folder-v1");
  const manifestFile = files.find((file) => file.path === `.blogbot/manifests/${revision.id}.json`);
  assert.equal(typeof manifestFile?.content, "string");
  const manifest = JSON.parse(String(manifestFile?.content)) as {
    entries: Array<{ path: string; sha256: string; bytes: number }>;
  };
  const media = files.find((file) => file.path === ".blogbot/generated/media/hero.webp");
  assert.ok(media && typeof media.content === "object" && !(media.content instanceof Uint8Array));
  assert.deepEqual(media.content, {
    kind: "engine-media-ref",
    revisionId: revision.id,
    sha256: revision.media[0]!.sha256,
    byteSize: 5
  });
  const mediaEntry = manifest.entries.find((entry) => entry.path === media.path);
  assert.deepEqual(mediaEntry, {
    path: media.path,
    sha256: revision.media[0]!.sha256,
    bytes: 5
  });
});
