import { createHash } from "node:crypto";

import {
  computeRevisionHash,
  hasRevisionPackageV2Fields,
  validateClaimEvidence,
  validateRevisionPackageV2,
  type Approval,
  type ApprovalBundle,
  type ArticleRevision
} from "../../editorial/src/revision.ts";
import {
  buildSiberDergiIndexFiles,
  planSiberDergiPublication,
  SiberDergiContractError,
  type SiberDergiPublicationInput
} from "./adapter.ts";

export interface ApprovedMediaFile {
  path: string;
  content: Uint8Array;
}

export interface SiberDergiArtifactFile {
  path: string;
  content: string | Uint8Array;
}

export interface SiberDergiArtifactManifest {
  version: 1;
  revisionId: string;
  revisionHash: string;
  translationKey: string;
  adapterVersion: string;
  generatedAt: string;
  entries: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface ApprovedSiberDergiBundle {
  files: SiberDergiArtifactFile[];
  manifest: SiberDergiArtifactManifest;
}

// Artifact manifests are consumed by the publisher before any remote effect.
// Keep their path contract local to this package so a hand-crafted manifest
// cannot smuggle repository files through an otherwise valid bundle.
const artifactPath = /^(?:src\/content\/articles\/(?:tr\/(?:haberler|analiz|dosyalar|rehberler)|en\/(?:news|analysis|deep-dives|guides))\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|public\/images\/articles\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|webp|avif)|public\/(?:sitemap\.xml|news-sitemap\.xml|robots\.txt|rss\.xml)|public\/en\/rss\.xml)$/u;
const revisionId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const stableKey = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

function fail(message: string): never {
  throw new SiberDergiContractError("MEDIA_BUNDLE_MISMATCH", message);
}

function assertApproval(
  revision: ArticleRevision,
  approval: Approval | ApprovalBundle
): Approval {
  const editorial = "editorial" in approval ? approval.editorial : approval;
  if (
    editorial.revisionId !== revision.id ||
    editorial.revisionHash !== computeRevisionHash(revision)
  ) {
    throw new SiberDergiContractError(
      "APPROVAL_HASH_MISMATCH",
      "approval no longer matches this immutable revision"
    );
  }
  if (
    hasRevisionPackageV2Fields(revision) &&
    !validateRevisionPackageV2(revision)
  ) {
    throw new SiberDergiContractError(
      "REVISION_PACKAGE_INCOMPLETE",
      "the V2 immutable revision package is incomplete"
    );
  }
  if (revision.riskLevel === "HIGH") {
    const highRisk = "editorial" in approval ? approval.highRisk : null;
    if (
      highRisk === null ||
      highRisk.revisionId !== revision.id ||
      highRisk.revisionHash !== editorial.revisionHash ||
      highRisk.approvalType !== "HIGH_RISK" ||
      !/^[a-f0-9]{64}$/iu.test(highRisk.riskChecklistHash) ||
      !Number.isFinite(Date.parse(highRisk.windowsReauthenticatedAt))
    ) {
      throw new SiberDergiContractError(
        "HIGH_RISK_APPROVAL_REQUIRED",
        "high-risk publication requires a second exact-hash approval"
      );
    }
  }
  return editorial;
}

function materializeMedia(
  revision: ArticleRevision,
  supplied: readonly ApprovedMediaFile[]
): SiberDergiArtifactFile[] {
  const byPath = new Map<string, ApprovedMediaFile>();
  for (const file of supplied) {
    if (byPath.has(file.path)) fail(`duplicate approved media path: ${file.path}`);
    byPath.set(file.path, file);
  }
  if (byPath.size !== revision.media.length) {
    fail("approved media file set does not match the immutable revision");
  }
  return revision.media
    .map((artifact) => {
      const media = byPath.get(artifact.path);
      if (!media || digest(media.content) !== artifact.sha256) {
        fail(`media bytes do not match approved artifact: ${artifact.path}`);
      }
      const extension = artifact.path.split(".").at(-1)?.toLowerCase();
      if (!extension || !["png", "webp", "avif"].includes(extension)) {
        fail(`unsupported public media extension: ${artifact.path}`);
      }
      const basename = artifact.path.split(/[\\/]/u).at(-1);
      if (!basename || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|webp|avif)$/u.test(basename)) {
        fail(`unsafe approved media name: ${artifact.path}`);
      }
      return {
        path: `public/images/articles/${revision.id}/${basename}`,
        content: new Uint8Array(media.content)
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function parseSiberDergiArtifactManifest(content: string): SiberDergiArtifactManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new SiberDergiContractError("INVALID_DOCUMENT", "artifact manifest is invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SiberDergiContractError("INVALID_DOCUMENT", "artifact manifest must be an object");
  }
  const manifest = value as Partial<SiberDergiArtifactManifest>;
  if (
    manifest.version !== 1 ||
    typeof manifest.revisionId !== "string" ||
    !revisionId.test(manifest.revisionId) ||
    !/^[a-f0-9]{64}$/u.test(manifest.revisionHash ?? "") ||
    typeof manifest.translationKey !== "string" ||
    !stableKey.test(manifest.translationKey) ||
    typeof manifest.adapterVersion !== "string" ||
    typeof manifest.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    new Date(Date.parse(manifest.generatedAt)).toISOString() !== manifest.generatedAt ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.every((entry) =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as { path?: unknown }).path === "string" &&
      artifactPath.test((entry as { path: string }).path) &&
      /^[a-f0-9]{64}$/u.test(String((entry as { sha256?: unknown }).sha256)) &&
      Number.isInteger((entry as { bytes?: unknown }).bytes) &&
      Number((entry as { bytes: number }).bytes) >= 0
    )
  ) {
    throw new SiberDergiContractError("INVALID_DOCUMENT", "artifact manifest does not match the V1 schema");
  }
  const entryPaths = manifest.entries.map((entry) => (entry as { path: string }).path);
  if (new Set(entryPaths).size !== entryPaths.length) {
    throw new SiberDergiContractError("INVALID_DOCUMENT", "artifact manifest contains duplicate paths");
  }
  return manifest as SiberDergiArtifactManifest;
}

export function materializeApprovedSiberDergiBundle(
  revision: ArticleRevision,
  approval: Approval | ApprovalBundle,
  approvedMedia: readonly ApprovedMediaFile[],
  options: { now: string }
): ApprovedSiberDergiBundle {
  const editorialApproval = assertApproval(revision, approval);
  if (!validateClaimEvidence(revision)) {
    throw new SiberDergiContractError(
      "INVALID_CLAIM_EVIDENCE",
      "every claim must include bilingual text and anchored source evidence"
    );
  }
  if (
    revision.section !== "haberler" &&
    revision.section !== "analiz" &&
    revision.section !== "dosyalar" &&
    revision.section !== "rehberler"
  ) {
    throw new SiberDergiContractError(
      "SECTION_TYPE_MISMATCH",
      "the selected section is not supported by the SiberDergi adapter"
    );
  }
  const publication: SiberDergiPublicationInput = {
    revisionId: revision.id,
    revisionHash: editorialApproval.revisionHash,
    approval: {
      revisionHash: editorialApproval.revisionHash,
      approvedAt: editorialApproval.approvedAt
    },
    translationKey: revision.translationKey,
    section: revision.section,
    articleType: revision.articleType,
    author: revision.author,
    tags: [...revision.tags],
    publishedAt: revision.scheduledAt,
    modifiedAt: revision.scheduledAt,
    tr: revision.tr,
    en: revision.en,
    sources: revision.sources.map((source) => ({
      title: source.title,
      url: source.url,
      accessedAt: source.fetchedAt
    }))
  };
  const plan = planSiberDergiPublication(publication, { files: {} }, options);
  const contentFiles = plan.diffs.map((diff) => ({ path: diff.path, content: diff.afterContent }));
  const mediaFiles = materializeMedia(revision, approvedMedia);
  const indexFiles = Object.entries(buildSiberDergiIndexFiles(plan.nextFixture, options.now))
    .map(([path, content]) => ({ path, content }));
  const entries = [...contentFiles, ...indexFiles, ...mediaFiles]
    .map((file) => ({ path: file.path, sha256: digest(bytes(file.content)), bytes: bytes(file.content).byteLength }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: SiberDergiArtifactManifest = {
    version: 1,
    revisionId: revision.id,
    revisionHash: editorialApproval.revisionHash,
    translationKey: revision.translationKey,
    adapterVersion: revision.adapterVersion,
    generatedAt: options.now,
    entries
  };
  const manifestFile = {
    path: `.blogbot/manifests/${revision.id}.json`,
    content: `${JSON.stringify(manifest, null, 2)}\n`
  };
  return { files: [...contentFiles, ...indexFiles, ...mediaFiles, manifestFile], manifest };
}
