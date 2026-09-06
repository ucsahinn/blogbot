import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const source = (...parts: string[]) => join(desktopRoot, "src", ...parts);

test("native updater requires a pinned, timestamped Authenticode installer in addition to the release digest", async () => {
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
  assert.match(workflow, /OPE_UPDATE_SIGNER_SHA256/u);
  assert.match(workflow, /Get-AuthenticodeSignature/u);
  assert.match(workflow, /TimeStamperCertificate/u);
  assert.match(workflow, /OPE_WINDOWS_CERTIFICATE_PFX_BASE64/u);
  assert.match(workflow, /Import-PfxCertificate/u);
  assert.match(workflow, /if:\s*\$\{\{\s*always\(\) && inputs\.sign_windows\s*\}\}/u);
  assert.match(workflow, /Remove-Item[^\n]+Cert:/u);
  assert.doesNotMatch(workflow, /Publish unsigned release/u);
  assert.doesNotMatch(workflow, /UPDATER_SIGNATURE/u);
});
test("release notes never become PowerShell source in the release workflow", async () => {
  const workflow = await readFile(join(desktopRoot, "..", "..", ".github", "workflows", "release-desktop.yml"), "utf8");

  assert.match(workflow, /RELEASE_NOTES: \$\{\{ inputs\.notes \}\}/u);
  assert.match(workflow, /\$notes = \$env:RELEASE_NOTES/u);
  assert.match(workflow, /Set-Content -LiteralPath release-notes\.txt -Value \$notes/u);
  assert.match(workflow, /--notes-file release-notes\.txt/u);
  assert.doesNotMatch(workflow, /--notes\s+"\$\{\{\s*inputs\.notes/u);
});

test("a stalled installer body fails instead of leaving the desktop in a permanent downloading state", async () => {
  const updater = await readFile(join(desktopRoot, "src-tauri", "src", "unsigned_updater.rs"), "utf8");

  assert.match(updater, /const UPDATE_DOWNLOAD_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs\(30\);/u);
  assert.match(updater, /\.read_timeout\(UPDATE_DOWNLOAD_IDLE_TIMEOUT\)/u);
});
