import { astroGenericAdapter } from "../../../packages/site-adapter/src/astro-generic.ts";
import type { ConnectorStateSnapshot, ReviewRevision } from "./types.ts";

export interface EngineMediaReference {
  kind: "engine-media-ref";
  revisionId: string;
  sha256: string;
  byteSize: number;
}

export type PublicationFile = { path: string; content: string | Uint8Array | EngineMediaReference };

function publicationBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function isEngineMediaReference(content: PublicationFile["content"]): content is EngineMediaReference {
  return typeof content === "object" && content !== null && !(content instanceof Uint8Array) && content.kind === "engine-media-ref";
}

async function sha256(content: string | Uint8Array): Promise<string> {
  const bytes = publicationBytes(content);
  // The Web Crypto declaration is narrower than Uint8Array's generic buffer
  // type even though every value here is copied from application-owned bytes.
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes) as BufferSource);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function buildPublicationFiles(
  revision: ReviewRevision,
  mode: ConnectorStateSnapshot["mode"],
  adapterId: string
): Promise<PublicationFile[]> {
  const mediaPath = (filename: string) => mode === "LOCAL_ONLY" ? `.blogbot/generated/media/${filename}` : `public/images/${filename}`;
  const mediaFiles: PublicationFile[] = (revision.media ?? []).flatMap<PublicationFile>((media): PublicationFile[] => {
    if (Number.isSafeInteger(media.byteSize) && media.byteSize! > 0 && /^[a-f0-9]{64}$/iu.test(media.sha256)) {
      return [{ path: mediaPath(media.filename), content: { kind: "engine-media-ref", revisionId: revision.id, sha256: media.sha256, byteSize: media.byteSize! } }];
    }
    if (!media.contentBase64) return [];
    const binary = Uint8Array.from(atob(media.contentBase64), (character) => character.charCodeAt(0));
    return [{ path: mediaPath(media.filename), content: binary }];
  });
  const hero = revision.media?.find((media) => media.role === "hero");
  const generated = astroGenericAdapter.buildRevisionFiles({
    id: revision.id,
    // Generated article files use a fixed sentinel so their digests can be
    // included in the revision hash without creating a circular dependency.
    revisionHash: "0".repeat(64),
    translationKey: revision.articleId,
    tr: {
      ...revision.tr,
      section: revision.section,
      articleType: revision.articleType,
      authorId: revision.author,
      publishedAt: revision.scheduledAt,
      tags: revision.tags,
      sources: revision.sources,
      ...(hero ? { heroImage: mediaPath(hero.filename), heroImageAlt: hero.altTr } : {})
    },
    en: {
      ...revision.en,
      section: ({ haberler: "news", analiz: "analysis", dosyalar: "deep-dives", rehberler: "guides", teknoloji: "technology", ekonomi: "business", kultur: "culture", yasam: "life" } as Record<string, string>)[revision.section] ?? revision.section,
      articleType: revision.articleType,
      authorId: revision.author,
      publishedAt: revision.scheduledAt,
      tags: revision.tags,
      sources: revision.sources,
      ...(hero ? { heroImage: mediaPath(hero.filename), heroImageAlt: hero.altEn } : {})
    }
  }, { siteOrigin: "", repositoryPath: "", adapterId: astroGenericAdapter.id });
  const contentEntries = Object.entries(generated).map(([path, content]) => {
    if (mode === "PUBLISH" || (mode === "LOCAL_DEV" && adapterId === "astro-generic")) return [path, content] as const;
    const localPath = path.startsWith("src/content/articles/")
      ? path.replace(/^src\/content\/articles\//u, ".blogbot/generated/")
      : path;
    return [localPath, content] as const;
  });
  const packageFiles = [
    ...mediaFiles,
    ...contentEntries.map(([path, content]) => ({ path, content }))
  ];
  const entries = await Promise.all(packageFiles.map(async ({ path, content }) => isEngineMediaReference(content)
    ? { path, sha256: content.sha256, bytes: content.byteSize }
    : { path, sha256: await sha256(content), bytes: publicationBytes(content).byteLength }
  ));
  const manifestPath = `.blogbot/manifests/${revision.id}.json`;
  const manifest = JSON.stringify({
    version: 1,
    revisionId: revision.id,
    revisionHash: revision.revisionHash,
    translationKey: revision.articleId,
    adapterVersion: revision.adapterVersion,
    generatedAt: "1970-01-01T00:00:00.000Z",
    entries
  });
  return [
    ...packageFiles,
    { path: manifestPath, content: manifest }
  ];
}
