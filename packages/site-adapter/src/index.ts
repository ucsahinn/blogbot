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

export class SiteAdapterRegistry {
  private readonly adapters = new Map<string, SiteAdapterV2>();

  register(adapter: SiteAdapterV2): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(adapter.id) || !adapter.version.trim()) {
      throw new Error("site adapter id and version must be safe non-empty values");
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
