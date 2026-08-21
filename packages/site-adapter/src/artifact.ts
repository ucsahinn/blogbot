export interface SiteArtifactManifest {
  version: 1;
  revisionId: string;
  revisionHash: string;
  translationKey?: string;
  adapterVersion: string;
  generatedAt: string;
  entries: Array<{ path: string; sha256: string; bytes: number }>;
}

const safeId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** Same character class and bound the revision contract uses for translation keys. */
const safeTranslationKey = /^[A-Za-z0-9._:-]{1,128}$/u;
const safePath = /^[a-zA-Z0-9._/-]+$/u;
const manifestKeys = new Set([
  "version",
  "revisionId",
  "revisionHash",
  "translationKey",
  "adapterVersion",
  "generatedAt",
  "entries"
]);
const entryKeys = new Set(["path", "sha256", "bytes"]);

/** Parse the adapter-neutral artifact contract used by the publisher. */
export function parseSiteArtifactManifest(content: string): SiteArtifactManifest {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("artifact manifest is invalid JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("artifact manifest must be an object");
  if (Object.keys(value).some((key) => !manifestKeys.has(key))) {
    throw new Error("artifact manifest does not match the adapter-neutral schema");
  }
  const manifest = value as Partial<SiteArtifactManifest>;
  if (
    manifest.version !== 1 ||
    typeof manifest.revisionId !== "string" || !safeId.test(manifest.revisionId) ||
    typeof manifest.revisionHash !== "string" || !/^[a-f0-9]{64}$/iu.test(manifest.revisionHash) ||
    (manifest.translationKey !== undefined &&
      (typeof manifest.translationKey !== "string" || !safeTranslationKey.test(manifest.translationKey))) ||
    typeof manifest.adapterVersion !== "string" || !manifest.adapterVersion.trim() ||
    typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    new Date(Date.parse(manifest.generatedAt)).toISOString() !== manifest.generatedAt ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      if (Object.keys(entry).some((key) => !entryKeys.has(key))) return false;
      const candidate = entry as { path?: unknown; sha256?: unknown; bytes?: unknown };
      return typeof candidate.path === "string" && safePath.test(candidate.path) &&
        !candidate.path.startsWith("/") && !candidate.path.split("/").some((part) => part === "." || part === ".." || part === "") &&
        typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(candidate.sha256) &&
        Number.isInteger(candidate.bytes) && Number(candidate.bytes) >= 0;
    })
  ) throw new Error("artifact manifest does not match the adapter-neutral schema");
  const entries = manifest.entries as Array<{ path: string; sha256: string; bytes: number }>;
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("artifact manifest contains duplicate paths");
  // Hex digests are accepted in either case but every value they are compared
  // against downstream is lowercase, so normalize here. Otherwise a manifest
  // that is byte-for-byte correct but written in uppercase is reported as a
  // tampered bundle.
  return {
    ...manifest,
    revisionHash: manifest.revisionHash.toLowerCase(),
    entries: entries.map((entry) => ({ ...entry, sha256: entry.sha256.toLowerCase() }))
  } as SiteArtifactManifest;
}
