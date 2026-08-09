import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopSource = fileURLToPath(new URL("../src", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".tsx")) output.push(path);
  }
  return output;
}

test("desktop user interface stays site and hosting neutral", async () => {
  const files = await sourceFiles(desktopSource);
  const forbiddenUserCopy = /(?:LegacyPublisherName|LegacyHostingName|WireGuard|\bSD\b)/u;
  const matches: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (forbiddenUserCopy.test(content)) matches.push(file);
  }
  assert.deepEqual(matches, [], "brand/hosting-specific copy must remain in adapter/docs layers, not the desktop UI");
});

test("setup exposes the three generic project targets", async () => {
  const setup = await readFile(join(desktopSource, "screens", "SetupCenter.tsx"), "utf8");
  assert.match(setup, /Klasöre yaz/u);
  assert.match(setup, /Yerel projeye gönder/u);
  assert.match(setup, /Yayındaki siteye gönder/u);
  assert.match(setup, /selectedTask === "publishing"/u);
  assert.match(setup, /\["site", "github", "deploy"\]\.includes\(connector\.id\)/u);
});

test("review actions do not enqueue remote publication for local targets", async () => {
  const review = await readFile(join(desktopSource, "screens", "ReviewWorkspace.tsx"), "utf8");
  assert.match(review, /siteMode === "PUBLISH"/u);
  assert.match(review, /Onaylı paketi yerel projeye yaz/u);
});
