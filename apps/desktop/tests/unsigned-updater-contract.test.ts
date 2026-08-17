import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const source = (...parts: string[]) => join(desktopRoot, "src", ...parts);

test("unsigned updater uses the native HTTPS release bridge instead of Tauri signature verification", async () => {
  const shell = await readFile(source("components", "AppShell.tsx"), "utf8");
  const bridge = await readFile(source("bridge.ts"), "utf8");
  const native = await readFile(join(desktopRoot, "src-tauri", "src", "lib.rs"), "utf8");
  const workflow = await readFile(join(desktopRoot, "..", "..", ".github", "workflows", "release-desktop.yml"), "utf8");

  assert.match(shell, /checkUnsignedUpdate/u);
  assert.match(shell, /installUnsignedUpdate/u);
  assert.match(shell, /localBuildNewer/u);
  assert.match(shell, /yayınlanmış \$\{result\.latestVersion\} sürümünden daha yeni/u);
  assert.doesNotMatch(shell, /if \(!update\)/u);
  assert.doesNotMatch(shell, /@tauri-apps\/plugin-updater/u);
  assert.match(bridge, /checkUnsignedUpdate\(\)/u);
  assert.match(bridge, /installUnsignedUpdate\(/u);
  assert.match(native, /check_unsigned_update/u);
  assert.match(native, /install_unsigned_update/u);
  assert.match(workflow, /sha256/u);
  assert.match(workflow, /OPE_\$\(\$env:RELEASE_VERSION\)_x64-setup\.exe/u);
  assert.doesNotMatch(workflow, /Get-ChildItem .*\*-setup\.exe.*Select-Object -First 1/u);
  assert.match(workflow, /\^\\d\+\\\.\\d\+\\\.\\d\+\$/u);
  assert.equal(workflow.includes("(?:-[0-9A-Za-z.-]+)?"), false);
  assert.doesNotMatch(workflow, /TAURI_SIGNING_PRIVATE_KEY/u);
  assert.doesNotMatch(workflow, /UPDATER_SIGNATURE/u);
});
test("release notes never become PowerShell source in the release workflow", async () => {
  const workflow = await readFile(join(desktopRoot, "..", "..", ".github", "workflows", "release-desktop.yml"), "utf8");

  assert.match(workflow, /RELEASE_NOTES: \$\{\{ inputs\.notes \}\}/u);
  assert.match(workflow, /Set-Content -LiteralPath release-notes\.txt -Value \$env:RELEASE_NOTES/u);
  assert.match(workflow, /--notes-file release-notes\.txt/u);
  assert.doesNotMatch(workflow, /--notes\s+"\$\{\{\s*inputs\.notes/u);
});
