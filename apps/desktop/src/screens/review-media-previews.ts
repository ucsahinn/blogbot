import type { ReviewRevision } from "../types.ts";

export const MAX_MEDIA_PREVIEW_LOADS = 4;
const MEDIA_PREVIEW_CONCURRENCY = 2;

export type MediaPreviewAsset = Pick<
  ReviewRevision["media"][number],
  "role" | "sha256" | "byteSize" | "contentBase64"
>;

export function selectMediaPreviewAssets(media: MediaPreviewAsset[]): MediaPreviewAsset[] {
  return [...media]
    .sort((left, right) => Number(right.role === "hero") - Number(left.role === "hero"))
    .filter(
      (asset, index, items) =>
        items.findIndex((candidate) => candidate.sha256 === asset.sha256) === index
    )
    .slice(0, MAX_MEDIA_PREVIEW_LOADS);
}

export async function loadRevisionMediaPreviews({
  revisionId,
  media,
  readMedia
}: {
  revisionId: string;
  media: MediaPreviewAsset[];
  readMedia: (input: {
    revisionId: string;
    sha256: string;
  }) => Promise<{ mimeType: string; contentBase64: string }>;
}): Promise<{
  urls: Record<string, string>;
  errors: Record<string, true>;
  selectedSha256: string[];
}> {
  const selected = selectMediaPreviewAssets(media);
  const urls: Record<string, string> = {};
  const errors: Record<string, true> = {};
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < selected.length) {
      const asset = selected[nextIndex++];
      if (!asset) continue;
      try {
        if (asset.contentBase64) {
          urls[asset.sha256] = `data:image/webp;base64,${asset.contentBase64}`;
          continue;
        }
        const byteSize = asset.byteSize;
        if (
          typeof byteSize !== "number" ||
          !Number.isSafeInteger(byteSize) ||
          byteSize < 1 ||
          !/^[a-f0-9]{64}$/iu.test(asset.sha256)
        ) {
          errors[asset.sha256] = true;
          continue;
        }
        const loaded = await readMedia({ revisionId, sha256: asset.sha256 });
        urls[asset.sha256] = `data:${loaded.mimeType};base64,${loaded.contentBase64}`;
      } catch {
        errors[asset.sha256] = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MEDIA_PREVIEW_CONCURRENCY, selected.length) }, worker)
  );
  return { urls, errors, selectedSha256: selected.map((asset) => asset.sha256) };
}
