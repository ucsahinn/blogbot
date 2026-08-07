import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const usesGitBash = existsSync(gitBash);
const bashExecutable = usesGitBash ? gitBash : "bash";

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function toBashPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.replace(
    /^([A-Za-z]):/,
    (_, drive: string) =>
      usesGitBash ? `/${drive.toLowerCase()}` : `/mnt/${drive.toLowerCase()}`
  );
}

function runBash(relativeScript: string, args: string[]) {
  return spawnSync(
    bashExecutable,
    [toBashPath(join(repoRoot, relativeScript)), ...args.map(toBashPath)],
    { encoding: "utf8", env: process.env }
  );
}

test("public hosting stack contains only the static SiberDergi edge", () => {
  const compose = readRepoFile("infra/compose/public.compose.yml");
  const caddy = readRepoFile("infra/caddy/public.Caddyfile");

  assert.match(compose, /^\s{2}public-caddy:/m);
  assert.doesNotMatch(
    compose,
    /^\s{2}(?:api|worker|postgres|private-caddy|codex-runner|fetcher|publisher):/m
  );
  assert.match(compose, /\/srv\/siberdergi\/current:\/srv:ro/);
  assert.match(caddy, /root \* \/srv/);
  assert.doesNotMatch(caddy, /reverse_proxy|client_auth|10\.77\.0\./);
});

test("release deployer dry-run is path-safe and does not create a release", () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-release-dry-run-"));
  const artifact = join(root, "site.tar.gz");
  const releaseRoot = join(root, "releases-root");
  writeFileSync(artifact, "fixture artifact", "utf8");
  const sha256 = createHash("sha256")
    .update("fixture artifact")
    .digest("hex");

  try {
    const preview = runBash("infra/scripts/deploy-release.sh", [
      "--artifact",
      artifact,
      "--sha256",
      sha256,
      "--release-id",
      "0123456789abcdef",
      "--root",
      releaseRoot
    ]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(existsSync(releaseRoot), false, "dry-run must not write");
    assert.deepEqual(JSON.parse(preview.stdout.trim()), {
      mode: "preview",
      releaseId: "0123456789abcdef",
      releaseDirectory: join(releaseRoot, "releases", "0123456789abcdef"),
      currentLink: join(releaseRoot, "current"),
      previousLink: join(releaseRoot, "previous"),
      sha256
    });

    const unsafe = runBash("infra/scripts/deploy-release.sh", [
      "--artifact",
      artifact,
      "--sha256",
      sha256,
      "--release-id",
      "../escape",
      "--root",
      releaseRoot
    ]);
    assert.notEqual(unsafe.status, 0);
    assert.equal(existsSync(releaseRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup creates a hashed archive while restore is preview-first", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "blogbot-local-backup-"));
  const source = join(root, "staged-backup");
  const destination = join(root, "archives");
  const restoreTarget = join(root, "restored");
  mkdirSync(source);
  writeFileSync(join(source, "local-engine.snapshot"), "fixture encrypted snapshot", "utf8");
  writeFileSync(join(source, "manifest.json"), '{"version":1}', "utf8");

  try {
    const backup = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repoRoot, "infra/scripts/backup.ps1"),
        "-SourceDirectory",
        source,
        "-DestinationDirectory",
        destination,
        "-BackupName",
        "blogbot-local-test"
      ],
      { encoding: "utf8" }
    );
    assert.equal(backup.status, 0, backup.stderr);
    const backupResult = JSON.parse(backup.stdout.trim()) as {
      archivePath: string;
      hashPath: string;
      sha256: string;
    };
    assert.equal(existsSync(backupResult.archivePath), true);
    assert.equal(existsSync(backupResult.hashPath), true);
    assert.match(backupResult.sha256, /^[A-F0-9]{64}$/);

    const preview = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repoRoot, "infra/scripts/restore.ps1"),
        "-ArchivePath",
        backupResult.archivePath,
        "-TargetDirectory",
        restoreTarget,
        "-ExpectedSha256",
        backupResult.sha256
      ],
      { encoding: "utf8" }
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(existsSync(restoreTarget), false, "preview must not write");

    const applied = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repoRoot, "infra/scripts/restore.ps1"),
        "-ArchivePath",
        backupResult.archivePath,
        "-TargetDirectory",
        restoreTarget,
        "-ExpectedSha256",
        backupResult.sha256,
        "-Apply"
      ],
      { encoding: "utf8" }
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(readdirSync(restoreTarget).sort(), [
      "local-engine.snapshot",
      "manifest.json"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
