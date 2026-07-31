import { createHash } from "node:crypto";

import { validatePublishableMarkdown } from "../../security/src/markdown-policy.ts";

const SITE_ORIGIN = "https://siberdergi.net";
const AI_DISCLOSURE =
  "AI destekli üretim; kaynaklar doğrulandı ve nihai yayın insan onayından geçti.";
const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;

const SECTION_CONTRACT = {
  haberler: {
    articleType: "news",
    trRoute: "haberler",
    enRoute: "news",
    schemaType: "NewsArticle"
  },
  analiz: {
    articleType: "analysis",
    trRoute: "analiz",
    enRoute: "analysis",
    schemaType: "Article"
  },
  dosyalar: {
    articleType: "deep_dive",
    trRoute: "dosyalar",
    enRoute: "deep-dives",
    schemaType: "Article"
  },
  rehberler: {
    articleType: "guide",
    trRoute: "rehberler",
    enRoute: "guides",
    schemaType: "BlogPosting"
  }
} as const;

export type SiberDergiSection = keyof typeof SECTION_CONTRACT;
export type SiberDergiArticleType =
  (typeof SECTION_CONTRACT)[SiberDergiSection]["articleType"];
export type SiberDergiSchemaType =
  (typeof SECTION_CONTRACT)[SiberDergiSection]["schemaType"];
export type SiberDergiLocale = "tr" | "en";

export interface SiberDergiLocalizedArticle {
  title: string;
  slug: string;
  description: string;
  bodyMarkdown: string;
}

export interface SiberDergiSource {
  title: string;
  url: string;
  accessedAt: string;
}

export interface SiberDergiPublicationInput {
  revisionId: string;
  revisionHash: string;
  approval: {
    revisionHash: string;
    approvedAt: string;
  };
  translationKey: string;
  section: SiberDergiSection;
  articleType: SiberDergiArticleType;
  author: string;
  tags: string[];
  publishedAt: string;
  modifiedAt: string;
  tr: SiberDergiLocalizedArticle;
  en: SiberDergiLocalizedArticle;
  sources: SiberDergiSource[];
}

export interface VirtualSiteFixture {
  files: Readonly<Record<string, string>>;
}

export interface SiberDergiFrontmatter {
  schemaVersion: 1;
  locale: SiberDergiLocale;
  title: string;
  description: string;
  slug: string;
  translationKey: string;
  section: SiberDergiSection;
  routeSection: string;
  articleType: SiberDergiArticleType;
  schemaType: SiberDergiSchemaType;
  canonical: string;
  hreflang: {
    tr: string;
    en: string;
  };
  datePublished: string;
  dateModified: string;
  author: string;
  tags: string[];
  sources: SiberDergiSource[];
  aiDisclosure: {
    generatedWithAi: true;
    humanReviewed: true;
    text: string;
  };
}

export interface SiberDergiManifestEntry {
  locale: SiberDergiLocale;
  path: string;
  route: string;
  canonical: string;
  schemaType: SiberDergiSchemaType;
  sha256: string;
}

export type NewsSitemapDecision =
  | {
      eligible: true;
      publicationDate: string;
      title: string;
      path: string;
    }
  | {
      eligible: false;
      reason: "NOT_NEWS" | "FUTURE_PUBLICATION" | "OLDER_THAN_48_HOURS";
    };

export interface SiberDergiPublicationManifest {
  contractVersion: 1;
  adapter: "siberdergi";
  revisionId: string;
  revisionHash: string;
  translationKey: string;
  generatedAt: string;
  entries: SiberDergiManifestEntry[];
  newsSitemap: NewsSitemapDecision;
}

export interface SiberDergiContentDiff {
  locale: SiberDergiLocale;
  path: string;
  action: "create" | "update" | "noop";
  beforeSha256: string | null;
  afterSha256: string;
  afterContent: string;
}

export interface SiberDergiPublicationPlan {
  manifest: SiberDergiPublicationManifest;
  diffs: SiberDergiContentDiff[];
  nextFixture: VirtualSiteFixture;
}

export type SiberDergiContractErrorCode =
  | "APPROVAL_HASH_MISMATCH"
  | "HIGH_RISK_APPROVAL_REQUIRED"
  | "REVISION_PACKAGE_INCOMPLETE"
  | "INVALID_DATES"
  | "INVALID_CLAIM_EVIDENCE"
  | "INVALID_DOCUMENT"
  | "INVALID_FIELD"
  | "INVALID_FIXTURE"
  | "INVALID_HASH"
  | "MEDIA_BUNDLE_MISMATCH"
  | "INVALID_PATH"
  | "INVALID_SOURCE"
  | "SECTION_TYPE_MISMATCH"
  | "TRANSLATION_KEY_CONFLICT"
  | "UNSAFE_MARKDOWN";

export class SiberDergiContractError extends Error {
  readonly code: SiberDergiContractErrorCode;

  constructor(code: SiberDergiContractErrorCode, message: string) {
    super(message);
    this.name = "SiberDergiContractError";
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasForbiddenControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    );
  });
}

function assertPlainText(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    hasForbiddenControlCharacter(value)
  ) {
    throw new SiberDergiContractError(
      "INVALID_FIELD",
      `${field} must be non-empty plain text`
    );
  }
  return value.trim();
}

function assertStrictIsoDate(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new SiberDergiContractError(
      "INVALID_DATES",
      `${field} must be an exact UTC ISO timestamp`
    );
  }
  return parsed;
}

function assertSlug(value: string, field: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new SiberDergiContractError(
      "INVALID_PATH",
      `${field} must be a lowercase ASCII slug`
    );
  }
  return value;
}

function normalizeMarkdown(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SiberDergiContractError(
      "UNSAFE_MARKDOWN",
      `${field} must contain Markdown`
    );
  }

  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  const hasNullByte = normalized.includes("\u0000");
  const policy = validatePublishableMarkdown(normalized);

  if (!policy.valid || hasNullByte) {
    throw new SiberDergiContractError(
      "UNSAFE_MARKDOWN",
      `${field} violates publishable Markdown policy: ${policy.blockers.join(",") || "NULL_BYTE"}`
    );
  }

  return `${normalized}\n`;
}

function normalizeSources(sources: readonly SiberDergiSource[]): SiberDergiSource[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new SiberDergiContractError(
      "INVALID_SOURCE",
      "at least one verified source is required"
    );
  }

  const normalized = sources.map((source, index) => {
    const title = assertPlainText(source.title, `sources[${index}].title`);
    assertStrictIsoDate(source.accessedAt, `sources[${index}].accessedAt`);

    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new SiberDergiContractError(
        "INVALID_SOURCE",
        `sources[${index}].url must be an absolute HTTPS URL`
      );
    }
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new SiberDergiContractError(
        "INVALID_SOURCE",
        `sources[${index}].url must be credential-free HTTPS`
      );
    }

    return {
      title,
      url: url.toString(),
      accessedAt: source.accessedAt
    };
  });

  const uniqueUrls = new Set(normalized.map((source) => source.url));
  if (uniqueUrls.size !== normalized.length) {
    throw new SiberDergiContractError(
      "INVALID_SOURCE",
      "source URLs must be unique"
    );
  }

  return normalized.sort(
    (left, right) =>
      left.url.localeCompare(right.url) || left.title.localeCompare(right.title)
  );
}

function validateInput(
  input: SiberDergiPublicationInput,
  now: string
): {
  publishedAtMs: number;
  nowMs: number;
  sources: SiberDergiSource[];
  tags: string[];
  trBody: string;
  enBody: string;
} {
  assertPlainText(input.revisionId, "revisionId");
  if (!/^[a-f0-9]{64}$/u.test(input.revisionHash)) {
    throw new SiberDergiContractError(
      "INVALID_HASH",
      "revisionHash must be a lowercase SHA-256 digest"
    );
  }
  if (input.approval.revisionHash !== input.revisionHash) {
    throw new SiberDergiContractError(
      "APPROVAL_HASH_MISMATCH",
      "approval must be bound to the exact revision hash"
    );
  }
  assertStrictIsoDate(input.approval.approvedAt, "approval.approvedAt");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.translationKey)) {
    throw new SiberDergiContractError(
      "INVALID_FIELD",
      "translationKey must be a stable lowercase key"
    );
  }

  const section = SECTION_CONTRACT[input.section];
  if (section === undefined || section.articleType !== input.articleType) {
    throw new SiberDergiContractError(
      "SECTION_TYPE_MISMATCH",
      "section and articleType do not match the V1 contract"
    );
  }

  assertPlainText(input.author, "author");
  assertPlainText(input.tr.title, "tr.title");
  assertPlainText(input.tr.description, "tr.description");
  assertPlainText(input.en.title, "en.title");
  assertPlainText(input.en.description, "en.description");
  assertSlug(input.tr.slug, "tr.slug");
  assertSlug(input.en.slug, "en.slug");

  const publishedAtMs = assertStrictIsoDate(input.publishedAt, "publishedAt");
  const modifiedAtMs = assertStrictIsoDate(input.modifiedAt, "modifiedAt");
  const nowMs = assertStrictIsoDate(now, "now");
  if (modifiedAtMs < publishedAtMs) {
    throw new SiberDergiContractError(
      "INVALID_DATES",
      "modifiedAt cannot be earlier than publishedAt"
    );
  }

  if (!Array.isArray(input.tags) || input.tags.length === 0) {
    throw new SiberDergiContractError(
      "INVALID_FIELD",
      "at least one tag is required"
    );
  }
  const tags = [...new Set(input.tags.map((tag, index) =>
    assertPlainText(tag, `tags[${index}]`)
  ))].sort();

  return {
    publishedAtMs,
    nowMs,
    sources: normalizeSources(input.sources),
    tags,
    trBody: normalizeMarkdown(input.tr.bodyMarkdown, "tr.bodyMarkdown"),
    enBody: normalizeMarkdown(input.en.bodyMarkdown, "en.bodyMarkdown")
  };
}

export function isAllowedSiberDergiContentPath(path: string): boolean {
  return /^src\/content\/articles\/(?:tr\/(?:haberler|analiz|dosyalar|rehberler)|en\/(?:news|analysis|deep-dives|guides))\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(
    path
  );
}

function assertFrontmatter(value: unknown): asserts value is SiberDergiFrontmatter {
  const invalid = (): never => {
    throw new SiberDergiContractError(
      "INVALID_DOCUMENT",
      "frontmatter does not match the SiberDergi V1 schema"
    );
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "aiDisclosure",
    "articleType",
    "author",
    "canonical",
    "dateModified",
    "datePublished",
    "description",
    "hreflang",
    "locale",
    "routeSection",
    "schemaType",
    "schemaVersion",
    "section",
    "slug",
    "sources",
    "tags",
    "title",
    "translationKey"
  ];
  const requiredStrings = [
    "locale",
    "title",
    "description",
    "slug",
    "translationKey",
    "section",
    "routeSection",
    "articleType",
    "schemaType",
    "canonical",
    "datePublished",
    "dateModified",
    "author"
  ];
  if (
    Object.keys(record).sort().join("\0") !== expectedKeys.join("\0") ||
    record.schemaVersion !== 1 ||
    requiredStrings.some((key) => typeof record[key] !== "string") ||
    !Array.isArray(record.tags) ||
    !Array.isArray(record.sources) ||
    typeof record.hreflang !== "object" ||
    record.hreflang === null ||
    typeof record.aiDisclosure !== "object" ||
    record.aiDisclosure === null
  ) {
    invalid();
  }

  const locale = record.locale;
  const sectionName = record.section;
  if (
    (locale !== "tr" && locale !== "en") ||
    typeof sectionName !== "string" ||
    !(sectionName in SECTION_CONTRACT) ||
    typeof record.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.slug) ||
    typeof record.translationKey !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.translationKey)
  ) {
    invalid();
  }

  const normalizedLocale = locale as SiberDergiLocale;
  const section = SECTION_CONTRACT[sectionName as SiberDergiSection];
  const expectedRouteSection =
    normalizedLocale === "tr" ? section.trRoute : section.enRoute;
  const expectedCanonical =
    normalizedLocale === "tr"
      ? `${SITE_ORIGIN}/${section.trRoute}/${record.slug}/`
      : `${SITE_ORIGIN}/en/${section.enRoute}/${record.slug}/`;
  if (
    record.articleType !== section.articleType ||
    record.schemaType !== section.schemaType ||
    record.routeSection !== expectedRouteSection ||
    record.canonical !== expectedCanonical
  ) {
    invalid();
  }

  const hreflang = record.hreflang as Record<string, unknown>;
  const expectedAlternatePrefixes = {
    tr: `${SITE_ORIGIN}/${section.trRoute}/`,
    en: `${SITE_ORIGIN}/en/${section.enRoute}/`
  };
  if (
    Object.keys(hreflang).sort().join("\0") !== "en\0tr" ||
    typeof hreflang.tr !== "string" ||
    typeof hreflang.en !== "string" ||
    !hreflang.tr.startsWith(expectedAlternatePrefixes.tr) ||
    !hreflang.en.startsWith(expectedAlternatePrefixes.en) ||
    hreflang[normalizedLocale] !== expectedCanonical
  ) {
    invalid();
  }

  const aiDisclosure = record.aiDisclosure as Record<string, unknown>;
  if (
    Object.keys(aiDisclosure).sort().join("\0") !==
      "generatedWithAi\0humanReviewed\0text" ||
    aiDisclosure.generatedWithAi !== true ||
    aiDisclosure.humanReviewed !== true ||
    aiDisclosure.text !== AI_DISCLOSURE
  ) {
    invalid();
  }

  if (
    !(record.tags as unknown[]).every(
      (tag) => typeof tag === "string" && tag.trim().length > 0
    ) ||
    !(record.sources as unknown[]).every((source) => {
      if (typeof source !== "object" || source === null || Array.isArray(source)) {
        return false;
      }
      const sourceRecord = source as Record<string, unknown>;
      if (
        Object.keys(sourceRecord).sort().join("\0") !==
          "accessedAt\0title\0url" ||
        typeof sourceRecord.title !== "string" ||
        sourceRecord.title.trim().length === 0 ||
        typeof sourceRecord.url !== "string" ||
        typeof sourceRecord.accessedAt !== "string"
      ) {
        return false;
      }
      const accessedAt = Date.parse(sourceRecord.accessedAt);
      try {
        const url = new URL(sourceRecord.url);
        return (
          url.protocol === "https:" &&
          url.username.length === 0 &&
          url.password.length === 0 &&
          Number.isFinite(accessedAt) &&
          new Date(accessedAt).toISOString() === sourceRecord.accessedAt
        );
      } catch {
        return false;
      }
    })
  ) {
    invalid();
  }

  const publishedAt = Date.parse(record.datePublished as string);
  const modifiedAt = Date.parse(record.dateModified as string);
  if (
    !Number.isFinite(publishedAt) ||
    !Number.isFinite(modifiedAt) ||
    new Date(publishedAt).toISOString() !== record.datePublished ||
    new Date(modifiedAt).toISOString() !== record.dateModified ||
    modifiedAt < publishedAt
  ) {
    invalid();
  }
}

export function parseSiberDergiDocument(content: string): {
  frontmatter: SiberDergiFrontmatter;
  bodyMarkdown: string;
} {
  if (!content.startsWith("---\n")) {
    throw new SiberDergiContractError(
      "INVALID_DOCUMENT",
      "document must start with frontmatter"
    );
  }
  const closeIndex = content.indexOf("\n---\n", 4);
  if (closeIndex === -1) {
    throw new SiberDergiContractError(
      "INVALID_DOCUMENT",
      "document frontmatter is not closed"
    );
  }

  let frontmatter: unknown;
  try {
    frontmatter = JSON.parse(content.slice(4, closeIndex));
  } catch {
    throw new SiberDergiContractError(
      "INVALID_DOCUMENT",
      "frontmatter must be strict JSON"
    );
  }
  assertFrontmatter(frontmatter);

  const bodyMarkdown = content.slice(closeIndex + 5);
  normalizeMarkdown(bodyMarkdown, "bodyMarkdown");
  return { frontmatter, bodyMarkdown };
}

function renderDocument(
  frontmatter: SiberDergiFrontmatter,
  bodyMarkdown: string
): string {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${bodyMarkdown}`;
}

function newsSitemapDecision(
  input: SiberDergiPublicationInput,
  publishedAtMs: number,
  nowMs: number
): NewsSitemapDecision {
  if (input.section !== "haberler") {
    return { eligible: false, reason: "NOT_NEWS" };
  }
  const age = nowMs - publishedAtMs;
  if (age < 0) {
    return { eligible: false, reason: "FUTURE_PUBLICATION" };
  }
  if (age > NEWS_WINDOW_MS) {
    return { eligible: false, reason: "OLDER_THAN_48_HOURS" };
  }
  return {
    eligible: true,
    publicationDate: input.publishedAt,
    title: input.tr.title.trim(),
    path: `/haberler/${input.tr.slug}/`
  };
}

function ensureTranslationKeyIsSafe(
  fixture: VirtualSiteFixture,
  input: SiberDergiPublicationInput,
  targetPaths: Readonly<Record<SiberDergiLocale, string>>
): void {
  if (
    typeof fixture !== "object" ||
    fixture === null ||
    typeof fixture.files !== "object" ||
    fixture.files === null
  ) {
    throw new SiberDergiContractError(
      "INVALID_FIXTURE",
      "fixture must contain an in-memory files record"
    );
  }

  for (const [path, content] of Object.entries(fixture.files)) {
    if (typeof content !== "string") {
      throw new SiberDergiContractError(
        "INVALID_FIXTURE",
        `fixture content at ${path} must be a string`
      );
    }
    if (!isAllowedSiberDergiContentPath(path)) {
      continue;
    }

    const { frontmatter } = parseSiberDergiDocument(content);
    const targetPath =
      frontmatter.locale === "tr"
        ? targetPaths.tr
        : frontmatter.locale === "en"
          ? targetPaths.en
          : null;
    const isTarget = targetPath === path;
    const ownsTranslationKey =
      frontmatter.translationKey === input.translationKey;

    if (
      (isTarget && !ownsTranslationKey) ||
      (ownsTranslationKey && !isTarget)
    ) {
      throw new SiberDergiContractError(
        "TRANSLATION_KEY_CONFLICT",
        `translationKey conflict at ${path}`
      );
    }
  }
}

export function planSiberDergiPublication(
  input: SiberDergiPublicationInput,
  fixture: VirtualSiteFixture,
  options: { now: string }
): SiberDergiPublicationPlan {
  const normalized = validateInput(input, options.now);
  const section = SECTION_CONTRACT[input.section];
  const trRoute = `/${section.trRoute}/${input.tr.slug}/`;
  const enRoute = `/en/${section.enRoute}/${input.en.slug}/`;
  const targetPaths: Record<SiberDergiLocale, string> = {
    tr: `src/content/articles/tr/${section.trRoute}/${input.tr.slug}.md`,
    en: `src/content/articles/en/${section.enRoute}/${input.en.slug}.md`
  };
  ensureTranslationKeyIsSafe(fixture, input, targetPaths);

  const hreflang = {
    tr: `${SITE_ORIGIN}${trRoute}`,
    en: `${SITE_ORIGIN}${enRoute}`
  };
  const shared = {
    schemaVersion: 1 as const,
    translationKey: input.translationKey,
    section: input.section,
    articleType: input.articleType,
    schemaType: section.schemaType,
    hreflang,
    datePublished: input.publishedAt,
    dateModified: input.modifiedAt,
    author: input.author.trim(),
    tags: normalized.tags,
    sources: normalized.sources,
    aiDisclosure: {
      generatedWithAi: true as const,
      humanReviewed: true as const,
      text: AI_DISCLOSURE
    }
  };
  const localized = [
    {
      locale: "en" as const,
      path: targetPaths.en,
      route: enRoute,
      value: input.en,
      body: normalized.enBody,
      routeSection: section.enRoute
    },
    {
      locale: "tr" as const,
      path: targetPaths.tr,
      route: trRoute,
      value: input.tr,
      body: normalized.trBody,
      routeSection: section.trRoute
    }
  ];

  const nextFiles: Record<string, string> = { ...fixture.files };
  const entries: SiberDergiManifestEntry[] = [];
  const diffs: SiberDergiContentDiff[] = [];

  for (const item of localized) {
    if (!isAllowedSiberDergiContentPath(item.path)) {
      throw new SiberDergiContractError(
        "INVALID_PATH",
        `adapter attempted to write outside content allowlist: ${item.path}`
      );
    }
    const frontmatter: SiberDergiFrontmatter = {
      ...shared,
      locale: item.locale,
      title: item.value.title.trim(),
      description: item.value.description.trim(),
      slug: item.value.slug,
      routeSection: item.routeSection,
      canonical: `${SITE_ORIGIN}${item.route}`
    };
    const afterContent = renderDocument(frontmatter, item.body);
    const beforeContent = fixture.files[item.path];
    const afterSha256 = sha256(afterContent);
    const beforeSha256 =
      beforeContent === undefined ? null : sha256(beforeContent);
    const action =
      beforeContent === undefined
        ? "create"
        : beforeContent === afterContent
          ? "noop"
          : "update";

    nextFiles[item.path] = afterContent;
    entries.push({
      locale: item.locale,
      path: item.path,
      route: item.route,
      canonical: frontmatter.canonical,
      schemaType: section.schemaType,
      sha256: afterSha256
    });
    diffs.push({
      locale: item.locale,
      path: item.path,
      action,
      beforeSha256,
      afterSha256,
      afterContent
    });
  }

  return {
    manifest: {
      contractVersion: 1,
      adapter: "siberdergi",
      revisionId: input.revisionId.trim(),
      revisionHash: input.revisionHash,
      translationKey: input.translationKey,
      generatedAt: options.now,
      entries,
      newsSitemap: newsSitemapDecision(
        input,
        normalized.publishedAtMs,
        normalized.nowMs
      )
    },
    diffs,
    nextFixture: { files: nextFiles }
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Builds deterministic crawl-discovery files from the same approved content
 * fixture used by the publisher. It performs no filesystem or network write;
 * the caller decides whether these files enter an approved artifact.
 */
export function buildSiberDergiIndexFiles(
  fixture: VirtualSiteFixture,
  now: string
): Record<string, string> {
  const nowMs = assertStrictIsoDate(now, "now");
  const entries: SiberDergiFrontmatter[] = [];
  for (const [path, content] of Object.entries(fixture.files)) {
    if (!isAllowedSiberDergiContentPath(path)) continue;
    const document = parseSiberDergiDocument(content);
    entries.push(document.frontmatter);
  }
  entries.sort((left, right) => left.canonical.localeCompare(right.canonical));
  // Do not advertise content that is scheduled for a future publication.
  // A sitemap is a crawl-discovery surface for publicly available URLs; a
  // future-dated document can remain in the local fixture without becoming
  // discoverable before its publication timestamp.
  const publishedEntries = entries.filter(
    (entry) => Date.parse(entry.datePublished) <= nowMs
  );
  const urlEntries = publishedEntries
    .map((entry) => `  <url><loc>${escapeXml(entry.canonical)}</loc><lastmod>${entry.dateModified}</lastmod></url>`)
    .join("\n");
  const newsEntries = publishedEntries
    .filter((entry) => entry.articleType === "news")
    .filter((entry) => {
      const age = nowMs - Date.parse(entry.datePublished);
      return age >= 0 && age <= NEWS_WINDOW_MS;
    })
    .map((entry) => [
      "  <url>",
      `    <loc>${escapeXml(entry.canonical)}</loc>`,
      "    <news:news>",
      `      <news:publication><news:name>SiberDergi</news:name><news:language>${entry.locale}</news:language></news:publication>`,
      `      <news:publication_date>${entry.datePublished}</news:publication_date>`,
      `      <news:title>${escapeXml(entry.title)}</news:title>`,
      "    </news:news>",
      "  </url>"
    ].join("\n"))
    .join("\n");
  const buildRss = (locale: SiberDergiLocale): string => {
    const localized = publishedEntries
      .filter((entry) => entry.locale === locale)
      .sort((left, right) => right.datePublished.localeCompare(left.datePublished))
      .map((entry) => [
        "    <item>",
        `      <title>${escapeXml(entry.title)}</title>`,
        `      <link>${escapeXml(entry.canonical)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(entry.canonical)}</guid>`,
        `      <description>${escapeXml(entry.description)}</description>`,
        `      <pubDate>${new Date(entry.datePublished).toUTCString()}</pubDate>`,
        `      <dc:creator>${escapeXml(entry.author)}</dc:creator>`,
        "    </item>"
      ].join("\n"))
      .join("\n");
    const language = locale === "tr" ? "tr-TR" : "en-US";
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      "  <channel>",
      "    <title>SiberDergi.net</title>",
      `    <link>${SITE_ORIGIN}/${locale === "tr" ? "" : "en/"}</link>`,
      `    <description>${escapeXml(locale === "tr" ? "Siber güvenlik haberleri ve analizleri." : "Cybersecurity news and analysis.")}</description>`,
      `    <language>${language}</language>`,
      localized,
      "  </channel>",
      "</rss>",
      ""
    ].join("\n");
  };
  return {
    "public/sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`,
    "public/news-sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${newsEntries}\n</urlset>\n`,
    "public/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://siberdergi.net/sitemap.xml\nSitemap: https://siberdergi.net/news-sitemap.xml\n",
    "public/rss.xml": buildRss("tr"),
    "public/en/rss.xml": buildRss("en")
  };
}
