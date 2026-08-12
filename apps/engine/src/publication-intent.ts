import type { PublicationIntentBinding } from "../../../packages/database/src/backend-repository.ts";
import type { ArticleRevision } from "../../../packages/editorial/src/revision.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reconstruct the publication tuple only from an immutable revision and the
 * exact persisted preview. Both manual enqueue and scheduling use this single
 * policy so neither path can manufacture a destination after approval.
 */
export function publicationIntentBinding(
  revision: Pick<ArticleRevision, "targetRepository" | "targetBaseBranch" | "targetBaseSha" | "adapterVersion">,
  preview: unknown
): PublicationIntentBinding {
  if (!isRecord(preview) || typeof preview.previewHash !== "string" || !/^[a-f0-9]{64}$/iu.test(preview.previewHash)) {
    throw new Error("NO_VALID_PUBLICATION_PREVIEW");
  }
  const targetRepository = String(revision.targetRepository ?? "").trim();
  const baseBranch = String(revision.targetBaseBranch ?? "").trim();
  const targetBaseSha = String(revision.targetBaseSha ?? "").trim();
  const adapterVersion = String(revision.adapterVersion ?? "").trim();
  if (!targetRepository || !baseBranch || !targetBaseSha || !adapterVersion) {
    throw new Error("APPROVAL_TARGET_MISMATCH");
  }
  return { previewHash: preview.previewHash.toLowerCase(), targetRepository, baseBranch, targetBaseSha, adapterVersion };
}
