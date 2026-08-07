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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeDisplayText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[link removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
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
  const title = escapeXml(safeDisplayText(direction.title));
  const motifLabel = escapeXml(direction.motifs.join(" · ").toUpperCase());
  const titleY = Math.round(size.height * 0.58);

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
    `<text x="${Math.round(size.width * 0.08)}" y="${Math.round(size.height * 0.25)}" fill="${accent}" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.max(18, Math.round(size.height * 0.035))}" letter-spacing="4">${motifLabel}</text>`,
    `<text x="${Math.round(size.width * 0.08)}" y="${titleY}" fill="#f4f8fb" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.max(34, Math.round(size.height * 0.075))}" font-weight="700">${title}</text>`,
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
  const artifacts: RenderedCoverArtifact[] = [];
  const sharp = loadSharp();

  for (const variant of planRasterVariants(baseName)) {
    const target = resolve(join(root, variant.path));
    if (!target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
      throw new Error("Visual output escaped its target directory");
    }
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
      .toFile(target);
    const bytes = await readFile(target);
    artifacts.push({
      ...variant,
      absolutePath: target,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }

  return artifacts;
}
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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
