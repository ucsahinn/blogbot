export type CoverMotif =
  | "network"
  | "shield"
  | "terminal"
  | "key"
  | "signal"
  | "grid"
  | "abstract";

export interface ArtDirection {
  title: string;
  palette: string[];
  motifs: string[];
  externalAssets: string[];
  depictsRealPerson: boolean;
  depictsBrandLogo: boolean;
}

export interface VisualPolicyResult {
  valid: boolean;
  blockers: string[];
  warnings: string[];
}

export interface RasterVariant {
  ratio: "16:9" | "4:3" | "1:1";
  width: number;
  height: number;
  path: string;
}

export interface RenderedCoverArtifact extends RasterVariant {
  absolutePath: string;
  sha256: string;
  /**
   * Size of the exact bytes that produced `sha256`. Callers used to read this
   * back from disk separately, so the digest and the size of one hash-bound
   * media record came from two different reads of the same file.
   */
  byteSize: number;
  /**
   * Which renderer produced the file. A provider-generated bitmap cannot be
   * checked against the art-direction policy, so the caller has to be able to
   * tell the two apart when it records the media entry.
   */
  source: "IMAGEGEN" | "LOCAL_RENDERER";
}

const allowedMotifs = new Set<CoverMotif>([
  "network",
  "shield",
  "terminal",
  "key",
  "signal",
  "grid",
  "abstract"
]);

export function validateArtDirection(direction: ArtDirection): VisualPolicyResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (direction.externalAssets.length > 0) {
    blockers.push("EXTERNAL_ASSET_FORBIDDEN");
  }
  if (direction.depictsBrandLogo) {
    blockers.push("BRAND_LOGO_REQUIRES_HUMAN_REVIEW");
  }
  if (direction.depictsRealPerson) {
    blockers.push("REAL_PERSON_REPRESENTATION_REQUIRES_HUMAN_REVIEW");
  }
  if (
    direction.palette.length < 2 ||
    direction.palette.some((color) => !/^#[a-f0-9]{6}$/i.test(color))
  ) {
    blockers.push("INVALID_COLOR_PALETTE");
  }
  if (direction.motifs.some((motif) => !allowedMotifs.has(motif as CoverMotif))) {
    blockers.push("UNSUPPORTED_MOTIF");
  }
  if (direction.title.trim().length === 0) {
    blockers.push("VISUAL_TITLE_REQUIRED");
  }

  return { valid: blockers.length === 0, blockers, warnings };
}

export function planRasterVariants(baseName: string): RasterVariant[] {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(baseName)) {
    throw new Error("Visual baseName must be a safe lowercase slug");
  }
  return [
    {
      ratio: "16:9",
      width: 1600,
      height: 900,
      path: `${baseName}-16x9.webp`
    },
    {
      ratio: "4:3",
      width: 1200,
      height: 900,
      path: `${baseName}-4x3.webp`
    },
    {
      ratio: "1:1",
      width: 1200,
      height: 1200,
      path: `${baseName}-1x1.webp`
    }
  ];
}

export function buildSafeCoverSvg(
  direction: ArtDirection,
  size: { width: number; height: number }
): string {
  const validation = validateArtDirection(direction);
  if (!validation.valid) {
    throw new Error(`Unsafe art direction: ${validation.blockers.join(",")}`);
  }
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 320 ||
    size.height < 320
  ) {
    throw new Error("Raster target must use integer dimensions of at least 320px");
  }

  const [background = "#08131f", accent = "#32d3a6"] = direction.palette;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">`,
    "<defs>",
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="#02070d"/></linearGradient>`,
    `<pattern id="grid" width="56" height="56" patternUnits="userSpaceOnUse"><path d="M 56 0 L 0 0 0 56" fill="none" stroke="${accent}" stroke-opacity=".12"/></pattern>`,
    "</defs>",
    '<rect width="100%" height="100%" fill="url(#bg)"/>',
    '<rect width="100%" height="100%" fill="url(#grid)"/>',
    `<circle cx="${Math.round(size.width * 0.79)}" cy="${Math.round(size.height * 0.28)}" r="${Math.round(size.height * 0.18)}" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity=".85"/>`,
    `<path d="M ${Math.round(size.width * 0.08)} ${Math.round(size.height * 0.33)} H ${Math.round(size.width * 0.62)}" stroke="${accent}" stroke-width="6"/>`,
    `<path d="M ${Math.round(size.width * 0.08)} ${Math.round(size.height * 0.67)} C ${Math.round(size.width * 0.28)} ${Math.round(size.height * 0.49)}, ${Math.round(size.width * 0.49)} ${Math.round(size.height * 0.84)}, ${Math.round(size.width * 0.72)} ${Math.round(size.height * 0.58)}" fill="none" stroke="${accent}" stroke-width="10" stroke-linecap="round" stroke-opacity=".78"/>`,
    `<circle cx="${Math.round(size.width * 0.26)}" cy="${Math.round(size.height * 0.67)}" r="${Math.max(9, Math.round(size.height * 0.018))}" fill="${accent}"/>`,
    `<circle cx="${Math.round(size.width * 0.51)}" cy="${Math.round(size.height * 0.76)}" r="${Math.max(9, Math.round(size.height * 0.018))}" fill="${accent}"/>`,
    `<circle cx="${Math.round(size.width * 0.72)}" cy="${Math.round(size.height * 0.58)}" r="${Math.max(9, Math.round(size.height * 0.018))}" fill="${accent}"/>`,
    "</svg>"
  ].join("");
}

export async function renderCoverVariants(
  direction: ArtDirection,
  outputDirectory: string,
  baseName: string
): Promise<RenderedCoverArtifact[]> {
  if (!isAbsolute(outputDirectory)) {
    throw new Error("Visual output directory must be absolute");
  }
  const root = resolve(outputDirectory);
  await mkdir(root, { recursive: true });
  const sharp = loadSharp();

  return renderVariantBatch(
    root,
    baseName,
    "LOCAL_RENDERER",
    async (variant, temporaryPath) => {
      const svg = buildSafeCoverSvg(direction, {
        width: variant.width,
        height: variant.height
      });
      await sharp(Buffer.from(svg, "utf8"), {
        density: 72,
        limitInputPixels: variant.width * variant.height
      })
        .resize(variant.width, variant.height, { fit: "fill" })
        .webp({ quality: 88, effort: 5, smartSubsample: true })
        .toFile(temporaryPath);
    }
  );
}

/** Stages all ratios before committing any no-replace publication target. */
interface PendingVariant {
  artifact: RenderedCoverArtifact;
  targetPath: string;
  temporaryPath: string;
}

async function renderVariantBatch(
  root: string,
  baseName: string,
  source: RenderedCoverArtifact["source"],
  render: (variant: RasterVariant, temporaryPath: string) => Promise<void>
): Promise<RenderedCoverArtifact[]> {
  const pending: PendingVariant[] = [];
  const temporaryPaths: string[] = [];
  const committedTargets: string[] = [];

  try {
    for (const variant of planRasterVariants(baseName)) {
      const targetPath = resolve(join(root, variant.path));
      if (!targetPath.startsWith(`${root}\\`) && !targetPath.startsWith(`${root}/`)) {
        throw new Error("Visual output escaped its target directory");
      }
      const temporaryPath = resolve(
        join(root, `.${variant.path}.${randomUUID()}.tmp.webp`)
      );
      temporaryPaths.push(temporaryPath);
      await render(variant, temporaryPath);
      const bytes = await readFile(temporaryPath);
      pending.push({
        artifact: {
          ...variant,
          absolutePath: targetPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteSize: bytes.byteLength,
          source
        },
        targetPath,
        temporaryPath
      });
    }

    for (const variant of pending) {
      // A hard link is an atomic, same-volume, no-replace commit. Existing
      // valid variants therefore make the batch fail without being touched.
      await link(variant.temporaryPath, variant.targetPath);
      committedTargets.push(variant.targetPath);
    }
    await Promise.all(temporaryPaths.map((path) => rm(path)));
    return pending.map(({ artifact }) => artifact);
  } catch (error) {
    await discardAttemptFiles([...temporaryPaths, ...committedTargets]);
    throw error;
  }
}

/** Removes only temporary files and targets created by the aborted attempt. */
async function discardAttemptFiles(paths: readonly string[]): Promise<void> {
  await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
}

/** Converts one generated raster image into the three locally published ratios. */
export async function renderGeneratedImageVariants(
  source: Uint8Array,
  outputDirectory: string,
  baseName: string
): Promise<RenderedCoverArtifact[]> {
  if (!isAbsolute(outputDirectory)) {
    throw new Error("Visual output directory must be absolute");
  }
  if (source.byteLength === 0 || source.byteLength > 20_000_000) {
    throw new Error("Generated visual bytes are outside the allowed bounds");
  }
  const root = resolve(outputDirectory);
  await mkdir(root, { recursive: true });
  const sharp = loadSharp();

  return renderVariantBatch(
    root,
    baseName,
    "IMAGEGEN",
    async (variant, temporaryPath) => {
      await sharp(source, { limitInputPixels: 40_000_000, failOn: "error" })
        .rotate()
        .resize(variant.width, variant.height, { fit: "cover", position: "attention" })
        .webp({ quality: 88, effort: 5, smartSubsample: true })
        .toFile(temporaryPath);
    }
  );
}
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import type sharp from "sharp";

type Sharp = typeof sharp;

function loadSharp(): Sharp {
  const bundledModules = process.env.BLOGBOT_ENGINE_MODULES;
  const requireFromBundledModules = createRequire(
    bundledModules
      ? join(bundledModules, "package.json")
      : import.meta.url
  );
  return requireFromBundledModules("sharp") as Sharp;
}
