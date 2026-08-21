/** Locale and article identifiers are adapter-defined, not site-specific. */
export type SiteLocale = string;
export type SiteArticleType = string;

export interface SiteSectionCapability {
  readonly id: string;
  readonly articleType: SiteArticleType;
  readonly schemaType: string;
  /** Route templates must contain a `{slug}` placeholder. */
  readonly routes: Readonly<Record<SiteLocale, string>>;
}

export interface SiteAdapterContext {
  siteOrigin: string;
  repositoryPath: string;
  adapterId: string;
}

export interface SiteAdapterDryRun {
  ok: boolean;
  adapterId: string;
  adapterVersion: string;
  files: string[];
  errors: string[];
  warnings: string[];
}

export interface SiteAdapterV2 {
  readonly id: string;
  readonly version: string;
  readonly supportedLocales: readonly SiteLocale[];
  readonly supportedArticleTypes: readonly SiteArticleType[];
  readonly sections: readonly SiteSectionCapability[];
  detect(context: SiteAdapterContext): Promise<boolean> | boolean;
  dryRun(context: SiteAdapterContext): Promise<SiteAdapterDryRun> | SiteAdapterDryRun;
  buildRevisionFiles(input: unknown, context: SiteAdapterContext): Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;
}

export class SiteAdapterResolutionError extends Error {
  readonly code = "SITE_ADAPTER_UNKNOWN" as const;

  constructor(adapterId: string) {
    super(`SITE_ADAPTER_UNKNOWN: ${adapterId}`);
    this.name = "SiteAdapterResolutionError";
  }
}

export type SiteAdapterIdentityErrorCode =
  | "SITE_ADAPTER_IDENTITY_MISMATCH"
  | "SITE_ADAPTER_VERSION_MISMATCH";

export class SiteAdapterIdentityError extends Error {
  constructor(readonly code: SiteAdapterIdentityErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SiteAdapterIdentityError";
  }
}

export class SiteAdapterRegistry {
  private readonly adapters = new Map<string, SiteAdapterV2>();

  register(adapter: SiteAdapterV2): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(adapter.id) || !adapter.version.trim()) {
      throw new Error("site adapter id and version must be safe non-empty values");
    }
    // A route template without `{slug}` cannot address a single article, so an
    // adapter that declares one would route every article of that section to
    // the same public URL.
    for (const section of adapter.sections) {
      for (const [locale, template] of Object.entries(section.routes)) {
        if (!template.includes("{slug}")) {
          throw new Error(`site adapter route template must contain {slug}: ${adapter.id}/${section.id}/${locale}`);
        }
      }
    }
    if (this.adapters.has(adapter.id)) throw new Error(`site adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): SiteAdapterV2 | undefined {
    return this.adapters.get(id);
  }

  list(): SiteAdapterV2[] {
    return [...this.adapters.values()];
  }

  async detect(context: SiteAdapterContext): Promise<SiteAdapterV2 | undefined> {
    for (const adapter of this.adapters.values()) {
      if (await adapter.detect(context)) return adapter;
    }
    return undefined;
  }
}

export { parseSiteArtifactManifest } from "./artifact.ts";
export type { SiteArtifactManifest } from "./artifact.ts";

export type PublicationTargetMode = "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH";

/**
 * Adapter identity recorded when Blogbot keeps generated files inside its own
 * `.blogbot/generated/` tree instead of the site's source tree.
 *
 * This is a path mode, not a second adapter implementation: articles are
 * formatted by the one adapter that exists (`astro-generic`), and only their
 * destination differs (see `writesSiteNativePaths`). Registering a separate
 * adapter under this id would create a second source of truth for the same
 * generated paths, so `resolveSiteAdapter` maps it onto `astro-generic`
 * instead. Every id that is neither of the two fails closed there.
 */
export const LOCAL_FOLDER_PATH_MODE_ID = "local-folder-v1";
export const DEFAULT_SITE_ADAPTER_ID = "astro-generic";

/**
 * Decides whether generated article files keep their site-native path
 * (`src/content/articles/...`) or are redirected into Blogbot's own
 * `.blogbot/generated/` tree.
 *
 * This must be one rule. The engine writes the decision into the
 * approval-bound `generatedFiles` manifest while the desktop writes the actual
 * preview bundle; they previously branched differently — the engine on target
 * mode alone, the renderer on mode plus adapter id — so a LOCAL_DEV workspace
 * whose adapter is not the generic Astro one produced a manifest that could
 * never match its own bundle, and publication preview failed permanently.
 *
 * Writing into a project's own `src/` tree is only safe when the adapter knows
 * that layout, hence the adapter check for LOCAL_DEV.
 */
export function writesSiteNativePaths(
  mode: PublicationTargetMode | undefined,
  adapterId: string | undefined
): boolean {
  if (mode === "PUBLISH") return true;
  return mode === "LOCAL_DEV" && adapterId === DEFAULT_SITE_ADAPTER_ID;
}
