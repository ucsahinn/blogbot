import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconDirectory = join(
  repositoryRoot,
  "apps",
  "desktop",
  "src-tauri",
  "icons"
);
const desktopPublicDirectory = join(
  repositoryRoot,
  "apps",
  "desktop",
  "public"
);
await mkdir(desktopPublicDirectory, { recursive: true });
const avatarSource = join(repositoryRoot, "apps", "desktop", "src", "assets", "ope-logo-v2.png");
const sizes = [32, 48, 64, 128, 256] as const;

function createBitmapInfo(
  width: number,
  height: number,
  rgba: Buffer
): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * width * 4;
    const targetRow = (height - y - 1) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 4;
      const target = targetRow + x * 4;
      pixels[target] = rgba[source + 2] ?? 0;
      pixels[target + 1] = rgba[source + 1] ?? 0;
      pixels[target + 2] = rgba[source] ?? 0;
      pixels[target + 3] = rgba[source + 3] ?? 0;
    }
  }
  const maskStride = Math.ceil(width / 32) * 4;
  const mask = Buffer.alloc(maskStride * height);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(pixels.length, 20);
  return Buffer.concat([header, pixels, mask]);
}

const bitmaps: Array<{ size: number; bytes: Buffer }> = [];
for (const size of sizes) {
  const png = await sharp(avatarSource)
    .resize(size, size, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  await writeFile(join(iconDirectory, `${size}x${size}.png`), png);
  if (size === 32) {
    await writeFile(join(desktopPublicDirectory, "favicon.png"), png);
  }

  const { data, info } = await sharp(avatarSource)
    .resize(size, size, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  bitmaps.push({
    size,
    bytes: createBitmapInfo(info.width, info.height, data)
  });
}

const directory = Buffer.alloc(6 + bitmaps.length * 16);
directory.writeUInt16LE(0, 0);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(bitmaps.length, 4);
let offset = directory.length;
for (const [index, bitmap] of bitmaps.entries()) {
  const entry = 6 + index * 16;
  directory.writeUInt8(bitmap.size === 256 ? 0 : bitmap.size, entry);
  directory.writeUInt8(bitmap.size === 256 ? 0 : bitmap.size, entry + 1);
  directory.writeUInt8(0, entry + 2);
  directory.writeUInt8(0, entry + 3);
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(bitmap.bytes.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += bitmap.bytes.length;
}
await writeFile(
  join(iconDirectory, "icon.ico"),
  Buffer.concat([directory, ...bitmaps.map(({ bytes }) => bytes)])
);

console.log(
  JSON.stringify({
    ok: true,
    source: "apps/desktop/src/assets/ope-logo-v2.png",
    generated: [
      ...sizes.map((size) => `icons/${size}x${size}.png`),
      "icons/icon.ico",
      "apps/desktop/public/favicon.png"
    ]
  })
);
