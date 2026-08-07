import { SiteAdapterRegistry } from "./index.ts";
import { validatePublishableMarkdown } from "../../security/src/markdown-policy.ts";
import type {
  SiteAdapterContext,
  SiteAdapterDryRun,
  SiteAdapterV2,
  SiteSectionCapability
} from "./index.ts";

export interface GenericAstroLocalizedArticle {
  slug: string;
  title: string;
  description: string;
  bodyMarkdown: string;
  section: string;
  articleType: string;
  tags?: readonly string[];
  authorId?: string;
  publishedAt?: string;
  modifiedAt?: string;
  heroImage?: string;
  heroImageAlt?: string;
  sources?: readonly unknown[];
}

export interface GenericAstroRevision {
  id: string;
  revisionHash: string;
  translationKey: string;
  tr: GenericAstroLocalizedArticle;
  en: GenericAstroLocalizedArticle;
}

const sections: readonly SiteSectionCapability[] = [
  { id: "news", articleType: "news", schemaType: "NewsArticle", routes: { tr: "haberler/{slug}", en: "news/{slug}" } },
  { id: "analysis", articleType: "analysis", schemaType: "Article", routes: { tr: "analiz/{slug}", en: "analysis/{slug}" } },
  { id: "guide", articleType: "guide", schemaType: "BlogPosting", routes: { tr: "rehberler/{slug}", en: "guides/{slug}" } },
  { id: "deep-dive", articleType: "deep_dive", schemaType: "Article", routes: { tr: "dosyalar/{slug}", en: "deep-dives/{slug}" } },
  { id: "technology", articleType: "news", schemaType: "NewsArticle", routes: { tr: "teknoloji/{slug}", en: "technology/{slug}" } },
  { id: "business", articleType: "news", schemaType: "NewsArticle", routes: { tr: "ekonomi/{slug}", en: "business/{slug}" } },
  { id: "culture", articleType: "analysis", schemaType: "Article", routes: { tr: "kultur/{slug}", en: "culture/{slug}" } },
  { id: "life", articleType: "guide", schemaType: "BlogPosting", routes: { tr: "yasam/{slug}", en: "life/{slug}" } }
];

function safeSlug(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) throw new Error("adapter received an unsafe slug");
  return value;
}

function safeText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`adapter requires ${field}`);
  return value.trim();
}

function articleDocument(article: GenericAstroLocalizedArticle, locale: "tr" | "en", revision: GenericAstroRevision): string {
  const section = safeText(article.section, `${locale}.section`);
  const type = safeText(article.articleType, `${locale}.articleType`);
  const bodyMarkdown = safeText(article.bodyMarkdown, `${locale}.bodyMarkdown`);
  const markdown = validatePublishableMarkdown(bodyMarkdown);
  if (!markdown.valid) {
    throw new Error(`unsafe markdown in ${locale}: ${markdown.blockers.join(",")}`);
  }
  return [
    "---",
    `translationKey: ${JSON.stringify(revision.translationKey)}`,
    `locale: ${locale}`,
    `section: ${JSON.stringify(section)}`,
    `articleType: ${JSON.stringify(type)}`,
    `title: ${JSON.stringify(safeText(article.title, `${locale}.title`))}`,
    `description: ${JSON.stringify(safeText(article.description, `${locale}.description`))}`,
    `authorId: ${JSON.stringify(article.authorId ?? "editorial")}`,
    `publishedAt: ${JSON.stringify(article.publishedAt ?? new Date(0).toISOString())}`,
    `modifiedAt: ${JSON.stringify(article.modifiedAt ?? article.publishedAt ?? new Date(0).toISOString())}`,
    `tags: ${JSON.stringify(article.tags ?? [])}`,
    `heroImage: ${JSON.stringify(article.heroImage ?? "")}`,
    `heroImageAlt: ${JSON.stringify(article.heroImageAlt ?? "")}`,
    `sources: ${JSON.stringify(article.sources ?? [])}`,
    "generatedWithAI: true",
    "---",
    "",
    bodyMarkdown,
    ""
  ].join("\n");
}

export const astroGenericAdapter: SiteAdapterV2 = {
  id: "astro-generic",
  version: "1",
  supportedLocales: ["tr", "en"],
  supportedArticleTypes: sections.map((section) => section.articleType),
  sections,
  detect(context: SiteAdapterContext): boolean {
    return context.adapterId === "astro-generic"
      && context.repositoryPath.trim().length > 0;
  },
  dryRun(context: SiteAdapterContext): SiteAdapterDryRun {
    return {
      ok: context.adapterId === "astro-generic" && context.repositoryPath.trim().length > 0,
      adapterId: "astro-generic",
      adapterVersion: "1",
      files: ["src/content/articles/tr/{section}/{slug}.md", "src/content/articles/en/{section}/{slug}.md"],
      errors: [],
      warnings: ["The selected Astro site's content schema must accept the generic frontmatter contract."]
    };
  },
  buildRevisionFiles(input: unknown): Readonly<Record<string, string>> {
    const revision = input as Partial<GenericAstroRevision>;
    if (!revision || typeof revision !== "object" || !revision.tr || !revision.en) throw new Error("adapter requires a bilingual revision");
    const tr = revision.tr as GenericAstroLocalizedArticle;
    const en = revision.en as GenericAstroLocalizedArticle;
    const id = safeText(revision.id, "id");
    const translationKey = safeText(revision.translationKey, "translationKey");
    const revisionHash = safeText(revision.revisionHash, "revisionHash");
    const trSection = safeSlug(safeText(tr.section, "tr.section"));
    const enSection = safeSlug(safeText(en.section, "en.section"));
    const trSlug = safeSlug(safeText(tr.slug, "tr.slug"));
    const enSlug = safeSlug(safeText(en.slug, "en.slug"));
    return {
      [`src/content/articles/tr/${trSection}/${trSlug}.md`]: articleDocument(tr, "tr", { id, revisionHash, translationKey, tr, en }),
      [`src/content/articles/en/${enSection}/${enSlug}.md`]: articleDocument(en, "en", { id, revisionHash, translationKey, tr, en })
    };
  }
};

export function createDefaultSiteAdapterRegistry() {
  const registry = new SiteAdapterRegistry();
  registry.register(astroGenericAdapter);
  return registry;
}
