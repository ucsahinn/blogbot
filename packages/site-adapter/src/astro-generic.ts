import {
  DEFAULT_SITE_ADAPTER_ID,
  LOCAL_FOLDER_PATH_MODE_ID,
  SiteAdapterIdentityError,
  SiteAdapterRegistry,
  SiteAdapterResolutionError
} from "./index.ts";
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

/** Section path segments this adapter publishes, read from its own route templates. */
function publishedSectionPaths(locale: "tr" | "en"): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const section of sections) {
    const [first] = (section.routes[locale] ?? "").replace(/^\/+/u, "").split("/");
    if (first) paths.add(first);
  }
  return paths;
}

const sectionPaths = {
  tr: publishedSectionPaths("tr"),
  en: publishedSectionPaths("en")
} as const;
const articleTypes = new Set(sections.map((section) => section.articleType));

function safeSlug(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) throw new Error("adapter received an unsafe slug");
  return value;
}

function safeText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`adapter requires ${field}`);
  return value.trim();
}

/**
 * Optional frontmatter text is passed through unchanged: the value is part of
 * the approval-bound generated file, so normalizing it here would change the
 * digest of revisions that are already approved.
 */
function optionalText(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`adapter requires ${field} to be text`);
  return value;
}

/**
 * The adapter may only emit sections and article types it actually declares.
 * Without this, an unknown section became a published path and a published
 * `section:` value that no route on the site can serve, and nothing downstream
 * could catch it: the publisher's allowed path prefixes are derived from the
 * very file list produced here.
 */
function safeSectionPath(value: unknown, locale: "tr" | "en"): string {
  const section = safeSlug(safeText(value, `${locale}.section`));
  if (!sectionPaths[locale].has(section)) throw new Error(`adapter does not publish a ${locale} section named ${section}`);
  return section;
}

function sectionCapabilityForPath(value: unknown, locale: "tr" | "en"): {
  path: string;
  capability: SiteSectionCapability;
} {
  const path = safeSectionPath(value, locale);
  const capability = sections.find((candidate) => {
    const [first] = (candidate.routes[locale] ?? "").replace(/^\/+/u, "").split("/");
    return first === path;
  });
  if (!capability) throw new Error(`adapter does not publish a ${locale} section named ${path}`);
  return { path, capability };
}

function safeArticleType(value: unknown, locale: "tr" | "en"): string {
  const articleType = safeText(value, `${locale}.articleType`);
  if (!articleTypes.has(articleType)) throw new Error(`adapter does not support the article type ${articleType}`);
  return articleType;
}

function safeTagList(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error(`adapter requires ${field} to be a list of strings`);
  }
  return value as readonly string[];
}

function safeList(value: unknown, field: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`adapter requires ${field} to be a list`);
  return value as readonly unknown[];
}

/** Frontmatter timestamps must be machine-readable or the site cannot order or date the article. */
function safeTimestamp(value: unknown, field: string): string {
  const timestamp = safeText(value, field);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`adapter requires ${field} to be an exact UTC ISO timestamp`);
  }
  return timestamp;
}

/**
 * Published frontmatter may only reference assets that travel inside the
 * approval-bound bundle. A remote or absolute reference is an external asset,
 * which the visuals policy forbids and which no bundle hash can cover.
 */
function safeAssetPath(value: unknown, field: string): string {
  const path = safeText(value, field);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path) || path.startsWith("/") || path.startsWith("\\")) {
    throw new Error(`adapter requires ${field} to be a bundle-relative path`);
  }
  if (path.split(/[\\/]/u).some((part) => part === "." || part === ".." || part === "")) {
    throw new Error(`adapter requires ${field} to be a bundle-relative path`);
  }
  return path;
}

function localizedArticle(value: unknown, field: string): GenericAstroLocalizedArticle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`adapter requires ${field} to be a localized article object`);
  }
  // Every field read from here is validated individually below.
  return value as GenericAstroLocalizedArticle;
}

/**
 * YAML-safe scalar. `JSON.stringify` is a valid YAML double-quoted scalar for
 * almost everything, but it leaves U+2028/U+2029 raw and YAML 1.1 treats those
 * as line terminators, so one of them inside a title silently split the
 * frontmatter block.
 */
function yamlScalar(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

function articleDocument(article: GenericAstroLocalizedArticle, locale: "tr" | "en", revision: GenericAstroRevision): string {
  const section = safeSectionPath(article.section, locale);
  const type = safeArticleType(article.articleType, locale);
  const heroImage = article.heroImage === undefined || article.heroImage === null || article.heroImage === ""
    ? ""
    : safeAssetPath(article.heroImage, `${locale}.heroImage`);
  const publishedAt = article.publishedAt === undefined || article.publishedAt === null
    ? new Date(0).toISOString()
    : safeTimestamp(article.publishedAt, `${locale}.publishedAt`);
  const modifiedAt = article.modifiedAt === undefined || article.modifiedAt === null
    ? publishedAt
    : safeTimestamp(article.modifiedAt, `${locale}.modifiedAt`);
  const bodyMarkdown = safeText(article.bodyMarkdown, `${locale}.bodyMarkdown`);
  const markdown = validatePublishableMarkdown(bodyMarkdown);
  if (!markdown.valid) {
    throw new Error(`unsafe markdown in ${locale}: ${markdown.blockers.join(",")}`);
  }
  return [
    "---",
    `translationKey: ${yamlScalar(revision.translationKey)}`,
    `locale: ${locale}`,
    `section: ${yamlScalar(section)}`,
    `articleType: ${yamlScalar(type)}`,
    `title: ${yamlScalar(safeText(article.title, `${locale}.title`))}`,
    `description: ${yamlScalar(safeText(article.description, `${locale}.description`))}`,
    `authorId: ${yamlScalar(optionalText(article.authorId, `${locale}.authorId`) || "editorial")}`,
    `publishedAt: ${yamlScalar(publishedAt)}`,
    `modifiedAt: ${yamlScalar(modifiedAt)}`,
    `tags: ${yamlScalar(safeTagList(article.tags, `${locale}.tags`))}`,
    `heroImage: ${yamlScalar(heroImage)}`,
    `heroImageAlt: ${yamlScalar(optionalText(article.heroImageAlt, `${locale}.heroImageAlt`))}`,
    `sources: ${yamlScalar(safeList(article.sources, `${locale}.sources`))}`,
    "generatedWithAI: true",
    "---",
    "",
    bodyMarkdown,
    ""
  ].join("\n");
}

export const astroGenericAdapter: SiteAdapterV2 = {
  id: DEFAULT_SITE_ADAPTER_ID,
  version: "1",
  supportedLocales: ["tr", "en"],
  supportedArticleTypes: sections.map((section) => section.articleType),
  sections,
  detect(context: SiteAdapterContext): boolean {
    return context.adapterId === DEFAULT_SITE_ADAPTER_ID
      && context.repositoryPath.trim().length > 0;
  },
  dryRun(context: SiteAdapterContext): SiteAdapterDryRun {
    return {
      ok: context.adapterId === DEFAULT_SITE_ADAPTER_ID && context.repositoryPath.trim().length > 0,
      adapterId: DEFAULT_SITE_ADAPTER_ID,
      adapterVersion: "1",
      files: ["src/content/articles/tr/{section}/{slug}.md", "src/content/articles/en/{section}/{slug}.md"],
      errors: [],
      warnings: ["The selected Astro site's content schema must accept the generic frontmatter contract."]
    };
  },
  buildRevisionFiles(input: unknown): Readonly<Record<string, string>> {
    const revision = input as Partial<GenericAstroRevision>;
    if (!revision || typeof revision !== "object" || !revision.tr || !revision.en) throw new Error("adapter requires a bilingual revision");
    const tr = localizedArticle(revision.tr, "tr");
    const en = localizedArticle(revision.en, "en");
    const id = safeText(revision.id, "id");
    const translationKey = safeText(revision.translationKey, "translationKey");
    const revisionHash = safeText(revision.revisionHash, "revisionHash");
    // A section this adapter does not publish would become a live route that
    // no page can serve, and the publisher derives its allowed path prefixes
    // from this very file list, so nothing downstream could reject it.
    const trRoute = sectionCapabilityForPath(tr.section, "tr");
    const enRoute = sectionCapabilityForPath(en.section, "en");
    if (trRoute.capability.id !== enRoute.capability.id) {
      throw new Error("adapter requires both localized routes to use the same section capability");
    }
    const trType = safeArticleType(tr.articleType, "tr");
    const enType = safeArticleType(en.articleType, "en");
    if (trType !== trRoute.capability.articleType) {
      throw new Error(`adapter requires article type ${trRoute.capability.articleType} for tr section ${trRoute.path}`);
    }
    if (enType !== enRoute.capability.articleType) {
      throw new Error(`adapter requires article type ${enRoute.capability.articleType} for en section ${enRoute.path}`);
    }
    const trSection = trRoute.path;
    const enSection = enRoute.path;
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

/**
 * Resolves an adapter identity stamped on a revision to the adapter that
 * formats its files.
 *
 * `local-folder-v1` is a path mode of `astro-generic`, not a second adapter
 * implementation (see `LOCAL_FOLDER_PATH_MODE_ID`), so it resolves to the same
 * object rather than to a duplicate source of truth for the same generated
 * paths. Every other identity fails closed here instead of being silently
 * formatted as `astro-generic`, which is what happens wherever the concrete
 * adapter is imported and used directly.
 */
export function resolveSiteAdapter(
  adapterId: string,
  registry: SiteAdapterRegistry = createDefaultSiteAdapterRegistry()
): SiteAdapterV2 {
  const requested = adapterId.trim();
  const registryId = requested === LOCAL_FOLDER_PATH_MODE_ID ? DEFAULT_SITE_ADAPTER_ID : requested;
  const adapter = registry.get(registryId);
  if (!adapter) throw new SiteAdapterResolutionError(requested);
  return adapter;
}

export function assertSiteAdapterVersion(adapter: SiteAdapterV2, requestedVersion: string | undefined): void {
  const version = requestedVersion?.trim();
  if (requestedVersion !== undefined && !version) {
    throw new SiteAdapterIdentityError(
      "SITE_ADAPTER_VERSION_MISMATCH",
      `<empty> != ${adapter.id}@${adapter.version}`
    );
  }
  if (version && version !== adapter.version) {
    throw new SiteAdapterIdentityError(
      "SITE_ADAPTER_VERSION_MISMATCH",
      `${adapter.id}@${version} != ${adapter.id}@${adapter.version}`
    );
  }
}

/** Resolves the connector selection and binds it to the approval-stamped identity. */
export function resolveApprovedSiteAdapter(
  adapterId: string,
  approvedIdentity: string,
  registry: SiteAdapterRegistry = createDefaultSiteAdapterRegistry()
): SiteAdapterV2 {
  const selectedId = adapterId.trim();
  const adapter = resolveSiteAdapter(selectedId, registry);
  const identity = approvedIdentity.trim();
  const separator = identity.lastIndexOf("@");
  const approvedId = separator > 0 ? identity.slice(0, separator) : selectedId;
  const approvedVersion = separator > 0 ? identity.slice(separator + 1) : identity;
  if (approvedId !== selectedId) {
    throw new SiteAdapterIdentityError(
      "SITE_ADAPTER_IDENTITY_MISMATCH",
      `${approvedId} != ${selectedId}`
    );
  }
  assertSiteAdapterVersion(adapter, approvedVersion);
  return adapter;
}
