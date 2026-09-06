import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { windowsShellEnvironment, windowsShellExecutable } from "../helpers/windows-shell-environment.ts";

const execFile = promisify(execFileCallback);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const quotePs = (value: string) => `'${value.replaceAll("'", "''")}'`;
const safeEnvironment = windowsShellEnvironment();

async function runPowerShell(script: string, cwd: string, env: Record<string, string> = {}) {
  return await execFile(windowsShellExecutable(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64")
  ], { cwd, env: { ...safeEnvironment, ...env }, timeout: 15_000, windowsHide: true }).catch((error: { stderr?: string; code?: string | number }) => {
    const stderr = error.stderr?.replaceAll(/_x000[DA]_/gu, "\n") ?? "";
    const errorId = stderr.match(/FullyQualifiedErrorId\s*:\s*([A-Za-z0-9_.,-]+)/u)?.[1] ?? "UNKNOWN_ERROR_ID";
    const missingCommand = stderr.match(/ObjectNotFound:\s*\(([A-Za-z][A-Za-z0-9-]*):String\)/u)?.[1] ?? "UNKNOWN_COMMAND";
    throw new Error(stderr.match(/(?:RELEASE|STANDALONE|AUTHENTICODE)_[A-Z0-9_]+/u)?.[0]
      ?? `POWERSHELL_FIXTURE_FAILED: ${error.code}; ${errorId}; ${missingCommand}`);
  });
}

test("release signs the restored standalone executable after bundling and fails closed", {
  skip: process.platform !== "win32"
}, async () => {
  const workflowText = await readFile(join(root, ".github/workflows/release-desktop.yml"), "utf8");
  const lfText = workflowText.replaceAll("\r\n", "\n");
  const scripts = [lfText, lfText.replaceAll("\n", "\r\n")].map((input) => {
    const workflow = input.replaceAll("\r\n", "\n");
    const name = "Sign standalone application after bundling";
    const start = workflow.indexOf(`      - name: ${name}\n`);
    assert.ok(start > workflow.indexOf("Build signed desktop installers"), "Tauri restores the original main EXE after bundling; sign it afterwards");
    assert.ok(start < workflow.indexOf("Verify signed application and installers"));
    const step = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1));
    return step.slice(step.indexOf("        run: |\n") + "        run: |\n".length)
      .split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
  });
  assert.equal(scripts[0], scripts[1], "LF and CRLF checkouts must execute the same signing script");
  const run = scripts[0];
  const fixture = await mkdtemp(join(tmpdir(), "blogbot-release-signing-test-"));
  try {
    const app = "apps/desktop/src-tauri/target/release/blogbot.exe";
    await mkdir(dirname(join(fixture, app)), { recursive: true });
    await writeFile(join(fixture, app), "synthetic unsigned EXE");
    const fakeSigner = `
function Get-Command { param($Name, $ErrorAction) [pscustomobject]@{ Source = 'Invoke-FixtureSignTool' } }
function Invoke-FixtureSignTool {
  ConvertTo-Json -InputObject @($args) -Compress
  $global:LASTEXITCODE = [int]$env:FIXTURE_SIGN_EXIT
}
${run}`;
    const env = {
      OPE_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
      OPE_WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test",
      FIXTURE_SIGN_EXIT: "0"
    };
    const result = await runPowerShell(fakeSigner, fixture, env);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [
      "sign", "/sha1", env.OPE_WINDOWS_CERTIFICATE_THUMBPRINT, "/fd", "SHA256",
      "/tr", env.OPE_WINDOWS_TIMESTAMP_URL, "/td", "SHA256", app
    ]);
    await assert.rejects(runPowerShell(fakeSigner, fixture, { ...env, FIXTURE_SIGN_EXIT: "1" }),
      /STANDALONE_APPLICATION_SIGNING_FAILED/u);
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Model the documented Core date coercion at the JSON cmdlet boundary. This is
// not a substitute for executing the real CI pwsh runtime with signed artifacts.
const dateCoercingJsonCmdlet = `
function ConvertFrom-Json {
  param([Parameter(ValueFromPipeline = $true)][string]$InputObject, [string]$DateKind)
  process {
    $arguments = @{ InputObject = $InputObject }
    if ((Get-Command Microsoft.PowerShell.Utility\\ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
      $arguments.DateKind = 'String'
    }
    $parsed = Microsoft.PowerShell.Utility\\ConvertFrom-Json @arguments
    if ($DateKind -ne 'String') {
      foreach ($field in @('notes', 'pub_date')) {
        $property = $parsed.psobject.Properties[$field]
        if ($null -ne $property -and $property.Value -is [string] -and $property.Value -match '^\\d{4}-\\d{2}-\\d{2}T') {
          $property.Value = [DateTime]::Parse($property.Value)
        }
      }
    }
    $parsed
  }
}`;

test("explicit unsigned payload verification needs no certificate and still rejects tampering", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "blogbot-release-unsigned-test-"));
  const payload = join(fixture, "release-payload");
  const verifier = join(root, "scripts/verify-release-payload.ps1");
  const installer = "OPE_0.1.54_x64-setup.exe";
  const env = { RELEASE_VERSION: "0.1.54", RELEASE_NOTES: "Unsigned manual installation", REPOSITORY: "owner/site" };
  // Certificate access is forbidden in this lane, not faked as a valid signature.
  const run = (mode: string) => runPowerShell(`
function Get-AuthenticodeSignature { throw 'AUTHENTICODE_ACCESS_FORBIDDEN' }
& ${quotePs(verifier)} -SigningMode ${quotePs(mode)}`, fixture, env);
  try {
    await mkdir(payload);
    await writeFile(join(payload, "blogbot.exe"), "synthetic app");
    await writeFile(join(payload, installer), "synthetic installer");
    await writeFile(join(payload, "OPE_0.1.54_x64_en-US.msi"), "synthetic msi");
    await writeFile(join(payload, "ope-sbom.spdx.json"), JSON.stringify({
      spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", packages: [{ name: "synthetic" }]
    }));
    await writeFile(join(payload, "latest.json"), JSON.stringify({
      version: env.RELEASE_VERSION, notes: env.RELEASE_NOTES, pub_date: "2026-09-06T18:00:00Z",
      platforms: { "windows-x86_64": {
        sha256: sha256("synthetic installer"),
        url: `https://github.com/owner/site/releases/download/v0.1.54/${installer}`
      } }
    }));
    assert.match((await run("unsigned")).stdout, /RELEASE_PAYLOAD_VERIFIED/u);
    await assert.rejects(run("signed"), /RELEASE_PAYLOAD_ENVIRONMENT_MISSING/u);
    await assert.rejects(run("invalid"));
    await writeFile(join(payload, installer), "tampered installer");
    await assert.rejects(run("unsigned"), /RELEASE_MANIFEST_SHA256_INVALID/u);
    await writeFile(join(payload, installer), "synthetic installer");
    await writeFile(join(payload, "unexpected.txt"), "unexpected");
    await assert.rejects(run("unsigned"), /RELEASE_PAYLOAD_FILE_SET_INVALID/u);
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("release payload verification preserves exact JSON notes and UTC date strings", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "blogbot-release-payload-test-"));
  const payload = join(fixture, "release-payload");
  const version = "0.1.55";
  const installer = `OPE_${version}_x64-setup.exe`;
  const verifier = join(root, "scripts/verify-release-payload.ps1");
  const signatureFake = `
function Get-AuthenticodeSignature {
  param($LiteralPath, $ErrorAction)
  [pscustomobject]@{
    Status = [System.Management.Automation.SignatureStatus]::Valid
    SignerCertificate = [pscustomobject]@{ Thumbprint = ('A' * 40); RawData = [byte[]]@(1, 2, 3) }
    TimeStamperCertificate = [pscustomobject]@{}
  }
}`;
  const run = async (notes: string, pubDate: unknown, emulateCore: boolean, manifestNotes: unknown = notes) => {
    await writeFile(join(payload, "latest.json"), JSON.stringify({
      version, notes: manifestNotes, pub_date: pubDate,
      platforms: { "windows-x86_64": {
        sha256: sha256("synthetic installer"),
        url: `https://github.com/owner/site/releases/download/v${version}/${installer}`
      } }
    }));
    return await runPowerShell(`${signatureFake}\n${emulateCore ? dateCoercingJsonCmdlet : ""}\n& ${quotePs(verifier)}`, fixture, {
      RELEASE_VERSION: version, RELEASE_NOTES: notes, REPOSITORY: "owner/site",
      OPE_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
      OPE_UPDATE_SIGNER_SHA256: sha256(Buffer.from([1, 2, 3]))
    });
  };
  try {
    await mkdir(payload);
    await writeFile(join(payload, "blogbot.exe"), "synthetic app");
    await writeFile(join(payload, installer), "synthetic installer");
    await writeFile(join(payload, `OPE_${version}_x64_en-US.msi`), "synthetic msi");
    await writeFile(join(payload, "ope-sbom.spdx.json"), JSON.stringify({
      spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", packages: [{ name: "synthetic" }]
    }));
    for (const emulateCore of [true, false]) {
      for (const notes of ["Yerel deneme", "2026-09-05T10:00:00Z", "2026-09-05T13:00:00+03:00", 'Not: "deneme"\nİkinci satır']) {
        assert.match((await run(notes, "2026-09-05T10:00:00.000Z", emulateCore)).stdout, /RELEASE_PAYLOAD_VERIFIED/u);
      }
      await assert.rejects(run("fixture", "2026-09-05T13:00:00+03:00", emulateCore), /RELEASE_MANIFEST_DATE_INVALID/u);
      await assert.rejects(run("fixture", 0, emulateCore), /RELEASE_MANIFEST_DATE_INVALID/u);
      await assert.rejects(run("fixture", "2026-09-05T10:00:00Z", emulateCore, { notes: "fixture" }), /RELEASE_MANIFEST_METADATA_INVALID/u);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
