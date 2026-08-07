import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const candidates = [
  "AGENTS.md", "PRODUCT.md", "DESIGN.md", "README.md",
  "package.json", "apps/desktop/package.json"
];
const rows = [];
for (const relativePath of candidates) {
  const absolutePath = resolve(relativePath);
  try {
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) continue;
    const content = await readFile(absolutePath, "utf8");
    rows.push({
      path: relativePath,
      bytes: metadata.size,
      characters: content.length,
      estimatedTokens: Math.ceil(content.length / 4)
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
}
rows.sort((left, right) => right.estimatedTokens - left.estimatedTokens);
const total = rows.reduce((sum, row) => sum + row.estimatedTokens, 0);
console.log(JSON.stringify({ version: 1, files: rows, estimatedTokensTotal: total }, null, 2));
if (rows.some((row) => row.characters > 120_000)) {
  console.error("Token audit failed: a primary context file exceeds 120,000 characters.");
  process.exitCode = 1;
}
