import assert from "node:assert/strict";
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
