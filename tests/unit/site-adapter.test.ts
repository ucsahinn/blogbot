import test from "node:test";
import assert from "node:assert/strict";
import { SiteAdapterRegistry } from "../../packages/site-adapter/src/index.ts";
import { astroGenericAdapter } from "../../packages/site-adapter/src/astro-generic.ts";
import { parseSiteArtifactManifest } from "../../packages/site-adapter/src/artifact.ts";

test("site adapter registry supports a user-selected adapter without SiberDergi coupling", async () => {
  const registry = new SiteAdapterRegistry();
  registry.register({
    id: "astro",
    version: "1.0.0",
    supportedLocales: ["tr", "en"],
    supportedArticleTypes: ["news", "guide"],
    sections: [
      {
        id: "stories",
        articleType: "story",
        schemaType: "Article",
        routes: {
          tr: "/stories/{slug}/",
          en: "/en/stories/{slug}/"
        }
      }
    ],
    detect: ({ repositoryPath }) => repositoryPath.endsWith("site"),
    dryRun: () => ({ ok: true, adapterId: "astro", adapterVersion: "1.0.0", files: [], errors: [], warnings: [] }),
    buildRevisionFiles: () => ({})
  });
  const adapter = await registry.detect({ adapterId: "astro", repositoryPath: "C:/projects/site", siteOrigin: "https://example.org" });
  assert.equal(adapter?.id, "astro");
  assert.deepEqual(adapter?.sections, [
    {
      id: "stories",
      articleType: "story",
      schemaType: "Article",
      routes: {
        tr: "/stories/{slug}/",
        en: "/en/stories/{slug}/"
      }
    }
  ]);
  assert.deepEqual(registry.list().map((item) => item.id), ["astro"]);
});

test("generic Astro adapter builds bilingual section-aware files without a legacy site name", async () => {
  const files = await astroGenericAdapter.buildRevisionFiles({
    id: "rev-1",
    revisionHash: "a".repeat(64),
    translationKey: "story-1",
    tr: { slug: "ornek-haber", title: "Örnek haber", description: "Açıklama", bodyMarkdown: "İçerik", section: "haberler", articleType: "news" },
    en: { slug: "example-news", title: "Example news", description: "Description", bodyMarkdown: "Content", section: "news", articleType: "news" }
  }, { siteOrigin: "https://example.org", repositoryPath: "C:/site", adapterId: "astro-generic" });
  assert.deepEqual(Object.keys(files), [
    "src/content/articles/tr/haberler/ornek-haber.md",
    "src/content/articles/en/news/example-news.md"
  ]);
  assert.match(files["src/content/articles/tr/haberler/ornek-haber.md"] ?? "", /translationKey/);
  assert.match(files["src/content/articles/tr/haberler/ornek-haber.md"] ?? "", /authorId/);
  assert.match(files["src/content/articles/tr/haberler/ornek-haber.md"] ?? "", /sources/);
  assert.doesNotMatch(Object.values(files).join("\n"), /SiberDergi/u);
});

test("generic Astro adapter advertises general-news and general-blog sections", () => {
  assert.deepEqual(
    astroGenericAdapter.sections.map((section) => section.id),
    ["news", "analysis", "guide", "deep-dive", "technology", "business", "culture", "life"]
  );
  assert.deepEqual(
    astroGenericAdapter.sections.find((section) => section.id === "technology")?.routes,
    { tr: "teknoloji/{slug}", en: "technology/{slug}" }
  );
});

test("generic Astro adapter rejects unsafe markdown before materialization", () => {
  assert.throws(() => astroGenericAdapter.buildRevisionFiles({
    id: "rev-unsafe",
    revisionHash: "a".repeat(64),
    translationKey: "story-unsafe",
    tr: { slug: "unsafe", title: "Unsafe", description: "desc", bodyMarkdown: "<script>alert(1)</script>", section: "news", articleType: "news" },
    en: { slug: "unsafe", title: "Unsafe", description: "desc", bodyMarkdown: "Safe", section: "news", articleType: "news" }
  }, { siteOrigin: "", repositoryPath: "C:\\site", adapterId: "astro-generic" }), /unsafe markdown/u);
});

test("artifact manifest rejects executable or unknown top-level fields", () => {
  assert.throws(() => parseSiteArtifactManifest(JSON.stringify({
    version: 1,
    revisionId: "rev-safe",
    revisionHash: "a".repeat(64),
    adapterVersion: "astro-generic@1",
    generatedAt: "2026-08-04T12:00:00.000Z",
    entries: [],
    scripts: { dev: "malicious-command" }
  })), /adapter-neutral schema/u);
});
