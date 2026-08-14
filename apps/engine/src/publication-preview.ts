import { createHash } from "node:crypto";

import { canonicalJson } from "../../../packages/editorial/src/revision.ts";
import {
  buildPublisherDryRunPlan,
  publicationFileDigest,
  type ApprovedPublicationCommand,
  type PublicationBundlePolicy,
  type PublicationFile,
  type PublisherDryRunPlan
} from "../../publisher/src/publication.ts";

const SHA256 = /^[a-f0-9]{64}$/iu;

export interface PublicationPreviewInput {
  revisionId: string;
  approvedRevisionHash: string;
  currentRevisionHash: string;
  targetRepository: string;
  baseBranch: string;
  /** Read-only repository snapshot captured before the approval is queued. */
  approvedBaseSha?: string;
  currentBaseSha?: string;
  files: readonly PublicationFile[];
  bundlePolicy: PublicationBundlePolicy;
  siteOrigin: string;
  contentRoot: string;
  adapterId?: string;
  requiredChecks: readonly string[];
  deployWorkflow: string;
  now: string;
}

export interface PublicationPreview {
  adapterId: string;
  previewHash: string;
  plan: PublisherDryRunPlan;
}

function fileDigest(file: PublicationFile): { path: string; sha256: string; bytes: number } {
  return { path: file.path, ...publicationFileDigest(file) };
}

/**
 * Perform the no-write publication preflight used by the local engine.
 *
 * The publisher remains the authority for path, manifest, revision and
 * connector validation. This helper adds a stable preview hash over the
 * selected adapter contract and exact file digests so enqueue can require
 * that the reviewed bundle is the one being published.
 */
export function buildPublicationPreview(input: PublicationPreviewInput): PublicationPreview {
  if (!input.revisionId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/iu.test(input.revisionId)) {
    throw new Error("revisionId must be a safe identifier");
  }
  if (!SHA256.test(input.approvedRevisionHash) || !SHA256.test(input.currentRevisionHash)) {
    throw new Error("publication preview requires SHA-256 revision hashes");
  }
  if (input.approvedRevisionHash.toLowerCase() !== input.currentRevisionHash.toLowerCase()) {
    throw new Error("current revision no longer matches the approved hash");
  }
  if (!input.bundlePolicy || input.bundlePolicy.adapterId.trim().length === 0) {
    throw new Error("publication preview requires a selected adapter bundle policy");
  }
  if (input.adapterId && input.adapterId !== input.bundlePolicy.adapterId) {
    throw new Error("selected adapter does not match the bundle policy");
  }

  const command: ApprovedPublicationCommand = {
    articleId: input.revisionId,
    revisionId: input.revisionId,
    approvedRevisionHash: input.approvedRevisionHash,
    currentRevisionHash: input.currentRevisionHash,
    targetRepository: input.targetRepository,
    baseBranch: input.baseBranch,
    approvedBaseSha: input.approvedBaseSha ?? "",
    currentBaseSha: input.currentBaseSha ?? input.approvedBaseSha ?? "",
    approvedHeadSha: "",
    currentHeadSha: "",
    files: input.files,
    bundlePolicy: input.bundlePolicy
  };

  const plan = buildPublisherDryRunPlan({
    command,
    connectors: {
      github: { repository: input.targetRepository, baseBranch: input.baseBranch },
      site: {
        siteOrigin: input.siteOrigin,
        contentRoot: input.contentRoot,
        adapterId: input.bundlePolicy.adapterId
      }
    },
    now: input.now
  });

  const previewHash = createHash("sha256")
    .update(canonicalJson({
      revisionId: input.revisionId,
      approvedRevisionHash: input.approvedRevisionHash,
      targetRepository: input.targetRepository,
      baseBranch: input.baseBranch,
      approvedBaseSha: input.approvedBaseSha ?? "",
      adapterId: input.bundlePolicy.adapterId,
      bundlePolicy: input.bundlePolicy,
      requiredChecks: input.requiredChecks,
      deployWorkflow: input.deployWorkflow,
      files: input.files.map(fileDigest).sort((a, b) => a.path.localeCompare(b.path)),
      plan
    }), "utf8")
    .digest("hex");

  return { adapterId: input.bundlePolicy.adapterId, previewHash, plan };
}
