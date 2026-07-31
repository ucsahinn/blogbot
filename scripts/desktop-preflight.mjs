import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function nonEmptyFile(path) {
  try {
    return (await stat(path)).isFile() && (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function hasArtifact(root, extension) {
  if (!(await exists(root))) return false;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && await hasArtifact(path, extension)) return true;
    if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) return true;
  }
  return false;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runDesktopPreflight({ artifactsDir } = {}) {
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, status: ok ? "PASS" : "FAIL", detail });
  const tauriPath = join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const verifyPath = join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.verify.conf.json");
  const docsPath = join(repositoryRoot, "docs", "operations", "windows-client-prerequisites.md");
  const guiSmokePath = join(repositoryRoot, "apps", "desktop", "tests", "e2e-smoke.py");

  let config;
  let verifyConfig;
  try {
    config = await readJson(tauriPath);
    verifyConfig = await readJson(verifyPath);
    check("tauri-config-json", true, "Tauri manifests parse as JSON");
  } catch (error) {
    check("tauri-config-json", false, error instanceof Error ? error.message : String(error));
    return { ok: false, checks };
  }

  const bundle = config.bundle ?? {};
  check("windows-bundle-targets", bundle.active === true &&
    ["msi", "nsis"].every((target) => bundle.targets?.includes(target)), "MSI and NSIS targets enabled");
  check("webview2-bootstrapper", bundle.windows?.webviewInstallMode?.type === "embedBootstrapper", "WebView2 is embedded for clean machines");
  check("local-only-dev-url", config.build?.devUrl === "http://127.0.0.1:1420", "Development URL is loopback-only");
  check("verify-config-no-bundle", verifyConfig.bundle?.active === false, "Verification config cannot emit installers");

  const tauriRoot = join(repositoryRoot, "apps", "desktop", "src-tauri");
  const sidecar = join(tauriRoot, "binaries", "blogbot-engine-x86_64-pc-windows-msvc.exe");
  check("bundled-engine-sidecar", await nonEmptyFile(sidecar), "Windows engine sidecar exists and is non-empty");
  for (const resource of ["pglite.wasm", "pglite.data", "initdb.wasm"]) {
    check(`pglite-${resource}`, await nonEmptyFile(join(tauriRoot, "resources", "pglite", resource)), "Bundled local PGlite asset exists");
  }
  for (const icon of bundle.icon ?? []) {
    check(`icon-${icon}`, await nonEmptyFile(join(tauriRoot, icon)), "Bundled installer icon exists");
  }

  const docs = await readFile(docsPath, "utf8");
  check("clean-machine-runtime", /Node\.js.*kurmaz/us.test(docs) && /WebView2/u.test(docs), "Clean machine does not require Node.js and documents WebView2");
  const guiSmoke = await readFile(guiSmokePath, "utf8");
  check("gui-smoke-contract", /playwright/u.test(guiSmoke) && /127\.0\.0\.1:1420/u.test(guiSmoke) && /screenshot/u.test(guiSmoke), "GUI smoke covers the local app URL and captures evidence");

  if (artifactsDir) {
    const base = isAbsolute(artifactsDir) ? artifactsDir : resolve(repositoryRoot, artifactsDir);
    check("msi-artifact", await hasArtifact(base, ".msi"), `MSI artifact exists under: ${base}`);
    check("nsis-artifact", await hasArtifact(base, ".exe"), `NSIS executable artifact exists under: ${base}`);
  }
  return { ok: checks.every((entry) => entry.status === "PASS"), checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifactIndex = process.argv.indexOf("--artifacts-dir");
  const artifactsDir = artifactIndex >= 0 ? process.argv[artifactIndex + 1] : undefined;
  const result = await runDesktopPreflight({ artifactsDir });
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else for (const item of result.checks) console.log(`${item.status} ${item.id}: ${item.detail}`);
  process.exitCode = result.ok ? 0 : 1;
}
