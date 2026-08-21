import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_FOLDER_PATH_MODE_ID, SiteAdapterRegistry, writesSiteNativePaths } from "../../packages/site-adapter/src/index.ts";
import { generatedPackageFiles } from "../../apps/engine/src/codex-draft.ts";
import { astroGenericAdapter, createDefaultSiteAdapterRegistry, resolveSiteAdapter } from "../../packages/site-adapter/src/astro-generic.ts";
import { parseSiteArtifactManifest } from "../../packages/site-adapter/src/artifact.ts";

test("site adapter registry supports a user-selected generic adapter", async () => {
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
  assert.doesNotMatch(Object.values(files).join("\n"), /legacy site name/u);
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
    tr: { slug: "unsafe", title: "Unsafe", description: "desc", bodyMarkdown: "<script>alert(1)</script>", section: "haberler", articleType: "news" },
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

test("the generated-path rule is shared, so a manifest can never disagree with its own bundle", () => {
  // Site-native paths are only safe where the adapter knows the layout.
  assert.equal(writesSiteNativePaths("PUBLISH", "astro-generic"), true);
  assert.equal(writesSiteNativePaths("PUBLISH", "custom-site-v2"), true);
  assert.equal(writesSiteNativePaths("LOCAL_DEV", "astro-generic"), true);
  assert.equal(writesSiteNativePaths("LOCAL_DEV", "custom-site-v2"), false);
  assert.equal(writesSiteNativePaths("LOCAL_ONLY", "astro-generic"), false);
  assert.equal(writesSiteNativePaths(undefined, undefined), false);
});

test("the engine materializer fails closed when connector config selects an unregistered adapter", () => {
  const revision = {
    id: "revision-local-dev",
    translationKey: "story-local-dev",
    state: "REVIEW_REQUIRED" as const,
    tr: { title: "Başlık", slug: "baslik", description: "Açıklama", bodyMarkdown: "Gövde", heroImageAlt: "Görsel" },
    en: { title: "Title", slug: "title", description: "Description", bodyMarkdown: "Body", heroImageAlt: "Image" },
    section: "haberler" as const,
    articleType: "news" as const,
    author: "Ada",
    tags: [],
    claims: [],
    sources: [],
    media: [],
    scheduledAt: "2026-08-19T10:00:00.000Z",
    adapterVersion: "1"
  };

  assert.throws(
    () => generatedPackageFiles(revision, { mode: "PUBLISH", adapterId: "custom-site-v2" }),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "SITE_ADAPTER_UNKNOWN" &&
      error.message === "SITE_ADAPTER_UNKNOWN: custom-site-v2"
  );
});

test("the engine refuses a connector adapter version that is not the registered implementation", () => {
  const revision = {
    id: "revision-adapter-version",
    translationKey: "story-adapter-version",
    state: "REVIEW_REQUIRED" as const,
    tr: { title: "Baslik", slug: "baslik", description: "Aciklama", bodyMarkdown: "Govde", heroImageAlt: "Gorsel" },
    en: { title: "Title", slug: "title", description: "Description", bodyMarkdown: "Body", heroImageAlt: "Image" },
    section: "haberler" as const,
    articleType: "news" as const,
    author: "Ada",
    tags: [],
    claims: [],
    sources: [],
    media: [],
    scheduledAt: "2026-08-19T10:00:00.000Z",
    adapterVersion: "1"
  };

  assert.throws(
    () => generatedPackageFiles(revision, { mode: "PUBLISH", adapterId: "astro-generic", adapterVersion: "999" }),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "SITE_ADAPTER_VERSION_MISMATCH"
  );
});

test("the adapter refuses to publish a section or article type it does not declare", () => {
  const revision = (overrides: Record<string, unknown>) => ({
    id: "rev-section",
    revisionHash: "a".repeat(64),
    translationKey: "story-section",
    tr: { slug: "ornek", title: "Örnek", description: "Açıklama", bodyMarkdown: "İçerik", section: "haberler", articleType: "news" },
    en: { slug: "example", title: "Example", description: "Description", bodyMarkdown: "Content", section: "news", articleType: "news" },
    ...overrides
  });
  const context = { siteOrigin: "", repositoryPath: "C:/site", adapterId: "astro-generic" };

  // A section the adapter does not publish would become a live route no page can
  // serve, and the publisher derives its allowed path prefixes from this very
  // file list, so nothing downstream could reject it.
  assert.throws(
    () => astroGenericAdapter.buildRevisionFiles(revision({
      tr: { slug: "ornek", title: "Örnek", description: "Açıklama", bodyMarkdown: "İçerik", section: "gizli", articleType: "news" }
    }), context),
    /does not publish a tr section named gizli/u
  );
  // The English route set is separate: a Turkish path is not a valid English one.
  assert.throws(
    () => astroGenericAdapter.buildRevisionFiles(revision({
      en: { slug: "example", title: "Example", description: "Description", bodyMarkdown: "Content", section: "haberler", articleType: "news" }
    }), context),
    /does not publish an? en section named haberler/u
  );
  assert.throws(
    () => astroGenericAdapter.buildRevisionFiles(revision({
      tr: { slug: "ornek", title: "Örnek", description: "Açıklama", bodyMarkdown: "İçerik", section: "haberler", articleType: "editorial" }
    }), context),
    /does not support the article type editorial/u
  );
});

test("the adapter refuses frontmatter that points outside the approved bundle", () => {
  const context = { siteOrigin: "", repositoryPath: "C:/site", adapterId: "astro-generic" };
  const withHero = (heroImage: string) => ({
    id: "rev-hero",
    revisionHash: "a".repeat(64),
    translationKey: "story-hero",
    tr: { slug: "ornek", title: "Örnek", description: "Açıklama", bodyMarkdown: "İçerik", section: "haberler", articleType: "news", heroImage },
    en: { slug: "example", title: "Example", description: "Description", bodyMarkdown: "Content", section: "news", articleType: "news" }
  });

  // A remote or absolute hero reference is an external asset: the visuals policy
  // forbids it and no bundle hash can cover it.
  for (const unsafe of ["https://cdn.example/hero.webp", "/var/hero.webp", "../hero.webp"]) {
    assert.throws(() => astroGenericAdapter.buildRevisionFiles(withHero(unsafe), context), /bundle-relative path/u);
  }
  const files = astroGenericAdapter.buildRevisionFiles(withHero("public/images/hero.webp"), context);
  assert.ok(Object.values(files).some((content) => content.includes("public/images/hero.webp")));
});

test("frontmatter escapes Unicode line terminators that YAML would treat as newlines", async () => {
  const lineSeparator = String.fromCodePoint(0x2028);
  const files = await astroGenericAdapter.buildRevisionFiles({
    id: "rev-yaml",
    revisionHash: "a".repeat(64),
    translationKey: "story-yaml",
    tr: { slug: "ornek", title: `Bir${lineSeparator}baslik`, description: "Aciklama", bodyMarkdown: "Icerik", section: "haberler", articleType: "news" },
    en: { slug: "example", title: "Example", description: "Description", bodyMarkdown: "Content", section: "news", articleType: "news" }
  }, { siteOrigin: "", repositoryPath: "C:/site", adapterId: "astro-generic" });

  const turkish = files["src/content/articles/tr/haberler/ornek.md"] ?? "";
  assert.ok(turkish, Object.keys(files).join(","));
  // A raw U+2028 inside a double-quoted scalar ends the line under YAML 1.1 and
  // silently splits the frontmatter block. JSON.stringify leaves it raw.
  assert.ok(!turkish.includes(lineSeparator), "frontmatter must not carry a raw U+2028");
  assert.ok(
    turkish.includes(`title: "Bir\\u2028baslik"`),
    turkish.split("\n").find((line: string) => line.startsWith("title:")) ?? turkish
  );
});

test("every adapter identity a revision can be stamped with resolves to a registered adapter", () => {
  const registry = createDefaultSiteAdapterRegistry();
  // `local-folder-v1` is the identity LOCAL_ONLY revisions carry. It is a path
  // mode of the one adapter that exists, not a second implementation, so it has
  // to resolve rather than leave the mode with no adapter policy at all.
  assert.equal(resolveSiteAdapter("astro-generic", registry).id, astroGenericAdapter.id);
  assert.equal(resolveSiteAdapter(LOCAL_FOLDER_PATH_MODE_ID, registry).id, astroGenericAdapter.id);
  // An unknown identity must fail closed instead of being formatted as the
  // generic Astro adapter behind the operator's back.
  assert.throws(
    () => resolveSiteAdapter("custom-site-v2", registry),
    (error: unknown) => error instanceof Error &&
      (error as Error & { code?: string }).code === "SITE_ADAPTER_UNKNOWN"
  );
});

test("artifact manifest normalizes hex case so a valid bundle is never reported as tampered", () => {
  const manifest = parseSiteArtifactManifest(JSON.stringify({
    version: 1,
    revisionId: "rev-case",
    revisionHash: "A".repeat(64),
    translationKey: "story-case",
    adapterVersion: "astro-generic@1",
    generatedAt: "2026-08-04T12:00:00.000Z",
    entries: [{ path: "src/content/articles/tr/haberler/ornek.md", sha256: "B".repeat(64), bytes: 12 }]
  }));

  // Every value these are compared against downstream is lowercase hex.
  assert.equal(manifest.revisionHash, "a".repeat(64));
  assert.deepEqual(manifest.entries.map((entry) => entry.sha256), ["b".repeat(64)]);
});

test("artifact manifest rejects a non-string translation key and empty path segments", () => {
  const manifest = (overrides: Record<string, unknown>) => JSON.stringify({
    version: 1,
    revisionId: "rev-safe",
    revisionHash: "a".repeat(64),
    adapterVersion: "astro-generic@1",
    generatedAt: "2026-08-04T12:00:00.000Z",
    entries: [{ path: "src/content/articles/tr/haberler/ornek.md", sha256: "b".repeat(64), bytes: 12 }],
    ...overrides
  });

  // The parser returns a typed manifest, so an unvalidated field would reach
  // every consumer as a `string` it is not.
  assert.throws(() => parseSiteArtifactManifest(manifest({ translationKey: 42 })), /adapter-neutral schema/u);
  // `a//b` is the same file as `a/b` for the publisher but a different manifest
  // entry, so it must not parse.
  assert.throws(
    () => parseSiteArtifactManifest(manifest({ entries: [{ path: "a//b.md", sha256: "b".repeat(64), bytes: 12 }] })),
    /adapter-neutral schema/u
  );
});
