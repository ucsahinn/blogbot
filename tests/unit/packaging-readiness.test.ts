import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createInvokeBridge } from "../../apps/desktop/src/bridge.ts";
import { createDemoTransport } from "../../apps/desktop/src/demo-data.ts";
import { runDesktopPreflight } from "../../scripts/desktop-preflight.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const execFile = promisify(execFileCallback);

test("prerequisite wizard snapshot is unique, actionable, and scope-aware", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const snapshot = await bridge.getPrerequisiteStatus();
  const ids = snapshot.checks.map((check) => check.id);

  assert.ok(snapshot.checkedAtUnixMs > 0);
  assert.equal(new Set(ids).size, ids.length, "wizard rows must not duplicate checks");
  assert.ok(ids.includes("local-engine"));
  assert.ok(ids.includes("local-database"));
  assert.ok(ids.includes("local-queue"));

  for (const check of snapshot.checks) {
    assert.ok(["APP", "WRITE", "PUBLISH"].includes(check.scope));
    if (["MISSING", "BLOCKED", "ATTENTION"].includes(check.state)) {
      assert.ok(check.userAction, `${check.id} needs a user-facing recovery action`);
    }
  }
});

test("operation log entries retain correlation and human-readable diagnostics", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const snapshot = await bridge.getOperations();
  const ids = snapshot.events.map((event) => event.id);
  const correlations = snapshot.events.map((event) => event.correlationId);

  assert.ok(snapshot.events.length > 0);
  assert.equal(new Set(ids).size, ids.length, "operation ids must be unique");
  assert.equal(new Set(correlations).size, correlations.length, "correlation ids must be unique");
  for (const event of snapshot.events) {
    assert.ok(event.at.trim());
    assert.ok(event.title.trim());
    assert.ok(event.detail.trim());
    assert.ok(event.correlationId.trim());
    assert.ok(["SUCCESS", "RUNNING", "WAITING", "BLOCKED"].includes(event.state));
  }
});

test("Windows bundle manifest includes the sidecar, local PGlite assets, and WebView2 bootstrapper", async () => {
  const config = JSON.parse(
    await readFile(
      join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"),
      "utf8"
    )
  ) as {
    bundle?: {
      active?: boolean;
      targets?: string[];
      externalBin?: string[];
      resources?: string[];
      windows?: { webviewInstallMode?: { type?: string } };
    };
  };
  const bundle = config.bundle;

  assert.equal(bundle?.active, true);
  assert.deepEqual(new Set(bundle?.targets), new Set(["msi", "nsis"]));
  assert.ok(bundle?.externalBin?.includes("binaries/blogbot-engine"));
  assert.ok(bundle?.resources?.includes("resources/pglite/*"));
  assert.ok(
    bundle?.resources?.includes("resources/engine-node_modules/**/*"),
    "the packaged engine must receive Sharp's Windows native runtime outside the SEA blob"
  );
  assert.equal(bundle?.windows?.webviewInstallMode?.type, "embedBootstrapper");
});

test("engine sidecar packaging externalizes Sharp and gives only the bundled runtime module path to the sidecar", async () => {
  const [buildScript, smokeScript, visualSource] = await Promise.all([
    readFile(join(repositoryRoot, "scripts", "build-engine-sidecar.mjs"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "smoke-engine-sidecar.mjs"), "utf8"),
    readFile(join(repositoryRoot, "packages", "visuals", "src", "index.ts"), "utf8")
  ]);

  assert.match(buildScript, /external:\s*\[\s*["']sharp["']\s*\]/u);
  assert.match(buildScript, /engine-node_modules/u);
  assert.match(buildScript, /sharp-win32-x64/u);
  assert.match(smokeScript, /BLOGBOT_ENGINE_MODULES/u);
  assert.match(visualSource, /createRequire/u);
  assert.match(visualSource, /BLOGBOT_ENGINE_MODULES/u);
});

test("Windows bundle metadata is valid Turkish UTF-8 rather than mojibake", async () => {
  const config = JSON.parse(
    await readFile(
      join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"),
      "utf8"
    )
  ) as {
    app?: { windows?: Array<{ title?: string }> };
    bundle?: { shortDescription?: string; longDescription?: string };
  };
  const metadata = [
    config.app?.windows?.[0]?.title,
    config.bundle?.shortDescription,
    config.bundle?.longDescription
  ].join(" ");

  assert.match(metadata, /OpenPostEdit\u00f6r/u);
  assert.match(metadata, /Se\u00e7ti\u011finiz site/u);
  assert.doesNotMatch(metadata, /(?:Â|Ä|Ã|Å)/u, "installer metadata must not contain mojibake");
});

test("Windows auto-update requires HTTPS, SHA-256, and a pinned timestamped Authenticode signer", async () => {
  const [configText, cargoText, desktopSource, releaseWorkflow] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "release-desktop.yml"), "utf8")
  ]);
  const config = JSON.parse(configText) as {
    bundle?: { createUpdaterArtifacts?: boolean };
    plugins?: { updater?: unknown };
  };

  assert.equal(config.bundle?.createUpdaterArtifacts, false);
  assert.doesNotMatch(cargoText, /tauri-plugin-updater/u);
  assert.match(desktopSource, /check_unsigned_update/u);
  assert.match(desktopSource, /install_unsigned_update/u);
  assert.doesNotMatch(configText, /"pubkey"/u);
  assert.match(releaseWorkflow, /sha256/u);
  assert.match(releaseWorkflow, /OPE_UPDATE_SIGNER_SHA256/u);
  assert.match(releaseWorkflow, /Get-AuthenticodeSignature/u);
  assert.match(releaseWorkflow, /TimeStamperCertificate/u);
  assert.match(releaseWorkflow, /OPE_WINDOWS_CERTIFICATE_PFX_BASE64/u);
  assert.match(releaseWorkflow, /OPE_WINDOWS_CERTIFICATE_PASSWORD/u);
  assert.match(releaseWorkflow, /Import-PfxCertificate/u);
  assert.match(releaseWorkflow, /if:\s*\$\{\{\s*always\(\) && inputs\.sign_windows\s*\}\}/u);
  assert.match(releaseWorkflow, /Remove-Item[^\n]+Cert:/u);
  const topLevelPermissions = releaseWorkflow.slice(
    releaseWorkflow.indexOf("permissions:"),
    releaseWorkflow.indexOf("concurrency:")
  );
  assert.match(topLevelPermissions, /contents:\s*read/u);
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  publish:"));
  assert.match(publishJob, /permissions:\s*\r?\n\s+contents:\s*write/u);
  assert.match(publishJob, /gh release create/u);
  assert.doesNotMatch(
    publishJob,
    /OPE_WINDOWS_CERTIFICATE_PFX_BASE64|OPE_WINDOWS_CERTIFICATE_PASSWORD|Import-PfxCertificate/u
  );
  assert.match(releaseWorkflow, /environment:\s*\$\{\{ inputs\.sign_windows && 'windows-signing' \|\| 'windows-unsigned' \}\}/u);
  assert.match(releaseWorkflow, /actions\/upload-artifact@[a-f0-9]{40}/u);
  assert.match(publishJob, /actions\/download-artifact@[a-f0-9]{40}/u);

  const importIndex = releaseWorkflow.indexOf("Import Windows signing certificate");
  const buildIndex = releaseWorkflow.indexOf("Build signed desktop installers");
  const verifyIndex = releaseWorkflow.indexOf("Verify signed application and installers");
  const cleanupIndex = releaseWorkflow.indexOf("Remove signing credentials");
  const uploadIndex = releaseWorkflow.indexOf("actions/upload-artifact@");
  assert.ok(
    importIndex < buildIndex &&
      buildIndex < verifyIndex &&
      verifyIndex < cleanupIndex &&
      cleanupIndex < uploadIndex
  );
  const importStep = releaseWorkflow.slice(importIndex, buildIndex);
  const cleanupStep = releaseWorkflow.slice(cleanupIndex, uploadIndex);
  const baselineWriteIndex = importStep.indexOf("[IO.File]::WriteAllLines($certificateBaselinePath");
  const certificateImportIndex = importStep.indexOf("Import-PfxCertificate");
  assert.ok(
    baselineWriteIndex >= 0 && baselineWriteIndex < certificateImportIndex,
    "the certificate-store baseline must be durable before PFX import starts"
  );
  assert.match(importStep, /baseline_sha256=/u);
  assert.match(importStep, /tracking_started=true/u);
  assert.match(cleanupStep, /SIGNING_TRACKING_STARTED/u);
  assert.match(cleanupStep, /SIGNING_BASELINE_SHA256/u);
  assert.match(cleanupStep, /Get-FileHash -LiteralPath \$certificateBaselinePath -Algorithm SHA256/u);
  assert.match(
    cleanupStep,
    /Where-Object \{ -not \$baseline\.ContainsKey\(\$_\.Thumbprint\.ToUpperInvariant\(\)\) \}/u,
    "always cleanup must rediscover every certificate added after the durable baseline"
  );
  assert.match(
    importStep,
    /Remove-Item -LiteralPath \$pfxPath -Force -ErrorAction Stop/u
  );
  assert.match(importStep, /WINDOWS_SIGNING_CERTIFICATE_NOT_TRACKED/u);
  assert.match(
    importStep,
    /Remove-Item -LiteralPath \("Cert:\\CurrentUser\\My\\" \+ \$_\.Thumbprint\) -DeleteKey -Force/u,
    "failed imports must delete each imported certificate together with its private key"
  );
  assert.match(cleanupStep, /@\(\$certificateBaselinePath, \$pfxPath\)/u);
  assert.match(
    cleanupStep,
    /Remove-Item -LiteralPath \$certificatePath -DeleteKey -Force -ErrorAction Stop/u,
    "the always cleanup must delete the private-key container, not only the certificate record"
  );
  assert.match(cleanupStep, /Test-Path -LiteralPath \$temporaryPath/u);
  assert.match(cleanupStep, /WINDOWS_SIGNING_CREDENTIAL_CLEANUP_FAILED/u);
  assert.match(releaseWorkflow, /latest\.json/u);
  assert.match(releaseWorkflow, /-setup\.exe/u);
  assert.doesNotMatch(releaseWorkflow, /UPDATER_SIGNATURE/u);
  assert.match(releaseWorkflow, /Build unsigned desktop installers \(manual installation only\)\r?\n\s+if: \$\{\{ !inputs\.sign_windows \}\}/u);
});

test("Windows installer exposes OPE as the product name while preserving the stable local data identifier", async () => {
  const [configText, releaseWorkflow] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "release-desktop.yml"), "utf8")
  ]);
  const config = JSON.parse(configText) as { productName?: string; identifier?: string };

  assert.equal(config.productName, "OPE");
  assert.equal(config.identifier, "app.blogbot.desktop");
  assert.match(releaseWorkflow, /OPE_\$\(\$env:RELEASE_VERSION\)_x64-setup\.exe/u);
});

test("Windows installer declares one stable per-user upgrade identity for in-place updates", async () => {
  const config = JSON.parse(
    await readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8")
  ) as {
    bundle?: { windows?: { nsis?: { installMode?: string }; wix?: { upgradeCode?: string } } };
  };

  assert.equal(config.bundle?.windows?.nsis?.installMode, "currentUser");
  assert.match(config.bundle?.windows?.wix?.upgradeCode ?? "", /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu);
});

test("NSIS installer automatically treats an older OPE install as a passive in-place update", async () => {
  const config = JSON.parse(
    await readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8")
  ) as {
    bundle?: { windows?: { nsis?: { template?: string } } };
  };
  const templatePath = config.bundle?.windows?.nsis?.template;

  assert.equal(templatePath, "windows/installer.nsi");
  const installer = await readFile(
    join(repositoryRoot, "apps", "desktop", "src-tauri", templatePath),
    "utf8"
  );
  assert.match(
    installer,
    /ReadRegStr \$R0 SHCTX "\$\{UNINSTKEY\}" "DisplayVersion"[\s\S]*nsis_tauri_utils::SemverCompare "\$\{VERSION\}" \$R0[\s\S]*StrCpy \$UpdateMode 1[\s\S]*StrCpy \$PassiveMode 1/u,
    "an installer launched by an older updater must detect and enter upgrade mode itself"
  );
  assert.match(
    installer,
    /\$UpdateMode <> 1[\s\S]*ReadRegStr \$R0 SHCTX/u,
    "explicit command-line update mode must remain authoritative"
  );
  assert.match(installer, /\{\{version\}\}/u, "the vendored template must retain Tauri placeholders");
});

test("desktop package icons are generated from the OPE logo rather than a letter mark", async () => {
  const iconScript = await readFile(join(repositoryRoot, "scripts", "generate-desktop-icons.ts"), "utf8");

  assert.match(iconScript, /ope-logo-v2\.png/u);
  assert.doesNotMatch(iconScript, /readFile\(join\(iconDirectory, "icon\.svg"\)\)/u);
});

test("secure restore helper is built as a Cargo example so Tauri sees only the GUI binary", async () => {
  const buildScript = await readFile(join(repositoryRoot, "scripts", "build-engine-sidecar.mjs"), "utf8");

  await access(
    join(repositoryRoot, "apps", "desktop", "src-tauri", "examples", "blogbot-secure-restore.rs")
  );
  assert.match(buildScript, /"--example",\s*"blogbot-secure-restore"/u);
  assert.match(buildScript, /target",\s*"release",\s*"examples",\s*"blogbot-secure-restore\.exe"/u);
});

test("secret scan excludes generated build artifacts but keeps source files in scope", async () => {
  const config = await readFile(join(repositoryRoot, ".gitleaks.toml"), "utf8");

  assert.match(config, /\(\^\|\/\)build\//u);
  assert.doesNotMatch(config, /paths\s*=\s*\[\s*'''\.\*'''/u);
});

test("source trust and rights review is explicitly granted to the trusted desktop window", async () => {
  const [buildManifest, defaultPermission] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "build.rs"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "permissions", "default.toml"), "utf8")
  ]);

  assert.match(buildManifest, /"review_source"/u);
  assert.match(defaultPermission, /"allow-review-source"/u);
  assert.match(buildManifest, /"github_device_flow_status"/u);
  assert.match(defaultPermission, /"allow-github-device-flow-status"/u);
});

test("desktop production build invokes Tauri after preparing the local engine", async () => {
  const [manifestText, desktopBuildScript] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "build-desktop.mjs"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText) as { scripts?: Record<string, string> };
  const command = manifest.scripts?.["build:desktop"];

  assert.ok(command, "build:desktop script must exist");
  assert.equal(command, "node scripts/build-desktop.mjs");
  assert.match(desktopBuildScript, /build:engine/u, "desktop build must prepare the bundled engine first");
  assert.match(desktopBuildScript, /tauri/u, "desktop build must produce a Tauri executable, not only Vite assets");
  assert.match(desktopBuildScript, /\bbuild\b/u, "desktop build must invoke the Tauri production build command");
  assert.match(
    desktopBuildScript,
    /"--bin",\s*"blogbot"/u,
    "Tauri packaging must explicitly build the GUI binary"
  );
  assert.doesNotMatch(desktopBuildScript, /--no-bundle/u, "release packaging must generate the configured MSI and NSIS installers");
  assert.match(desktopBuildScript, /WIX_TEMP/u, "Windows MSI packaging must use an app-owned writable WiX temporary directory");
});

test("desktop build validates prepared sidecars without rebuilding them", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "blogbot-desktop-build-plan-"));
  const fakeNpmCli = join(temporaryRoot, "fake-npm.mjs");
  const commandLog = join(temporaryRoot, "commands.jsonl");
  await writeFile(
    fakeNpmCli,
    [
      'import { appendFile } from "node:fs/promises";',
      'await appendFile(process.env.BLOGBOT_DESKTOP_BUILD_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");'
    ].join("\n"),
    "utf8"
  );

  try {
    await execFile(
      process.execPath,
      [join(repositoryRoot, "scripts", "build-desktop.mjs"), "--prepared-sidecars"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          npm_execpath: fakeNpmCli,
          BLOGBOT_DESKTOP_BUILD_COMMAND_LOG: commandLog
        },
        windowsHide: true
      }
    );
    const commands = (await readFile(commandLog, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);

    assert.deepEqual(commands, [
      ["run", "desktop:preflight:json"],
      ["run", "tauri", "--workspace", "@blogbot/desktop", "--", "build", "--", "--bin", "blogbot"]
    ]);

    await writeFile(commandLog, "", "utf8");
    const signingEnvironment = {
      ...process.env,
      npm_execpath: fakeNpmCli,
      BLOGBOT_DESKTOP_BUILD_COMMAND_LOG: commandLog,
      OPE_WINDOWS_CERTIFICATE_THUMBPRINT: "a".repeat(40),
      OPE_UPDATE_SIGNER_SHA256: "b".repeat(64),
      OPE_WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test/rfc3161"
    };
    await execFile(
      process.execPath,
      [join(repositoryRoot, "scripts", "build-desktop.mjs"), "--prepared-sidecars"],
      { cwd: repositoryRoot, env: signingEnvironment, windowsHide: true }
    );
    const signedCommands = (await readFile(commandLog, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    const tauriCommand = signedCommands[1] ?? [];
    const configIndex = tauriCommand.indexOf("--config");
    assert.ok(configIndex > -1, "a complete signing contract must reach Tauri as a config overlay");
    assert.deepEqual(JSON.parse(tauriCommand[configIndex + 1] ?? "{}"), {
      bundle: {
        windows: {
          certificateThumbprint: "a".repeat(40),
          digestAlgorithm: "sha256",
          timestampUrl: "https://timestamp.example.test/rfc3161",
          tsp: true
        }
      }
    });

    await assert.rejects(
      execFile(
        process.execPath,
        [join(repositoryRoot, "scripts", "build-desktop.mjs"), "--prepared-sidecars"],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            npm_execpath: fakeNpmCli,
            BLOGBOT_DESKTOP_BUILD_COMMAND_LOG: commandLog,
            OPE_UPDATE_SIGNER_SHA256: "b".repeat(64)
          },
          windowsHide: true
        }
      ),
      /WINDOWS_SIGNING_CONFIG_INCOMPLETE/u
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("root Tauri development command delegates to the desktop workspace", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };

  assert.equal(
    manifest.scripts?.tauri,
    "npm run tauri --workspace @blogbot/desktop --",
    "the documented root development command must reach the desktop Tauri workspace"
  );
});

test("native WebView smoke is an explicit, environment-gated evidence command", async () => {
  const [manifestText, smokeScript] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText) as { scripts?: Record<string, string> };

  assert.equal(manifest.scripts?.["smoke:native-webview"], "node scripts/native-webview-smoke.mjs");
  assert.match(smokeScript, /BLOGBOT_TAURI_DRIVER/u);
  assert.match(smokeScript, /BLOGBOT_EDGE_DRIVER/u);
  assert.match(
    smokeScript,
    /AbortSignal\.timeout\(/u,
    "native WebView driver requests must have a bounded timeout instead of hanging the release check"
  );
  assert.match(
    smokeScript,
    /NATIVE_SMOKE_REQUEST_TIMEOUT/u,
    "native WebView timeout failures must identify the bounded request stage"
  );
  assert.match(
    smokeScript,
    /additionalBrowserArguments[\s\S]*--disable-gpu/u,
    "native WebView smoke must isolate the known Windows GPU crash path"
  );
  assert.match(
    smokeScript,
    /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS[\s\S]*--disable-gpu/u,
    "the GPU mitigation must reach WebView2 through its process environment"
  );
  assert.match(
    smokeScript,
    /cleanupSmokeDataRoot/u,
    "native smoke must retry disposable-profile cleanup and report retained artifacts"
  );
  assert.match(
    smokeScript,
    /attempt < 60/u,
    "WebView2 shutdown can outlive the driver process and needs a bounded fifteen-second cleanup window"
  );
  assert.match(smokeScript, /BLOGBOT_NATIVE_PROFILE === "actual"/u);
  assert.match(
    smokeScript,
    /BLOGBOT_PROFILE_OBSERVE_MS/u,
    "an explicitly requested existing-profile observation must be able to report progress over time without changing the default isolated smoke"
  );
  assert.match(
    smokeScript,
    /16 \* 60 \* 1_000/u,
    "the existing-profile observation needs a margin beyond the 15-minute Codex deadline so it cannot sample exactly before timeout state is persisted"
  );
  assert.match(
    smokeScript,
    /initialProfile/u,
    "existing-profile observation must preserve a redacted initial state for comparison"
  );
  assert.match(
    smokeScript,
    /finalProfile/u,
    "existing-profile observation must preserve a redacted final state for comparison"
  );
  assert.match(
    smokeScript,
    /LOCALAPPDATA:\s*smokeDataRoot,\s*APPDATA:\s*smokeDataRoot/u,
    "native smoke must isolate both the engine data root and Tauri application-data root from the user's profile by default"
  );
  assert.match(smokeScript, /editorial-review/u);
  assert.match(smokeScript, /expectedHeadings/u);
  assert.match(
    smokeScript,
    /Boby · Yerel yayın merkezi/u,
    "native smoke must wait for the current visible Boby window title"
  );
  assert.match(
    smokeScript,
    /WEBDRIVER_TITLE_UNAVAILABLE/u,
    "native smoke must use a visible DOM readiness fallback when the Windows driver does not expose a window title"
  );
  assert.match(
    smokeScript,
    /waitForTauriBridge/u,
    "native smoke must wait for the Tauri invoke bridge after a visible DOM appears"
  );
  assert.match(
    smokeScript,
    /Pazar · 1\. slot: Takvimde bu slotu düzenle/u,
    "native smoke must select the compact Sunday slot before editing it"
  );
  assert.match(
    smokeScript,
    /catalogReadLatencyMs/u,
    "native smoke must report catalog-read latency so navigation stalls cannot hide behind a green smoke result"
  );
  assert.match(
    smokeScript,
    /NATIVE_SMOKE_SINGLE_INSTANCE_CONFLICT/u,
    "native smoke must explain the Boby single-instance collision instead of surfacing a misleading WebDriver crash"
  );
  assert.match(
    smokeScript,
    /NATIVE_SMOKE_EXISTING_PROFILE_ATTACH_UNSUPPORTED/u,
    "native smoke must explain that WebDriver cannot attach to an editor-owned Tauri window"
  );
  assert.match(smokeScript, /waitForVisibleHeading/u);
  assert.match(
    smokeScript,
    /requiredNativeReadContracts/u,
    "native smoke must bind each real IPC read to an explicit response key contract"
  );
  assert.match(smokeScript, /missingKeys/u);
  assert.match(
    smokeScript,
    /candidateRankingSummary/u,
    "actual-profile native smoke must report only aggregate candidate-score diversity"
  );
  assert.match(smokeScript, /unexpectedKeys/u);
  assert.match(
    smokeScript,
    /verifyCandidateJourney/u,
    "native smoke must exercise a real candidate-to-editorial state transition, not only read commands"
  );
  assert.match(
    smokeScript,
    /get_editorial_workspace", \{ includeCandidates: true \}/u,
    "native smoke must explicitly request the opt-in candidate projection before asserting candidate results"
  );  assert.match(
    smokeScript,
    /clickCandidateResearchAction/u,
    "native smoke must click the visible candidate research action instead of promoting a candidate through the bridge alone"
  );
  assert.match(
    smokeScript,
    /verifySingleSourceAddressCheckJourney/u,
    "native smoke must start its candidate journey from the visible source-address flow"
  );
  assert.match(
    smokeScript,
    /Tümünü izlemeye al/u,
    "native smoke must save a technically checked source through the visible action"
  );
  assert.match(
    smokeScript,
    /Araştırmaya al/u,
    "native smoke must locate the candidate research action by its user-visible Turkish label"
  );
  assert.match(
    smokeScript,
    /verifyInitialEngineSurface/u,
    "native smoke must verify that the first rendered system state is not falsely offline"
  );
  assert.match(
    smokeScript,
    /verifyVisibleInstantCreateJourney/u,
    "native smoke must prove that the visible Instant Create form persists a pending editorial draft"
  );
  assert.match(smokeScript, /Araştırmayı başlat/u);
  assert.match(smokeScript, /Editoryal Masada gör/u);
  assert.match(
    smokeScript,
    /verifyPreferencesAndScheduleJourney/u,
    "native smoke must prove that settings and weekly schedule changes persist in the local workspace"
  );
  assert.match(smokeScript, /update_schedule_slot/u);
  assert.match(smokeScript, /save_desktop_preferences/u);
  assert.match(
    smokeScript,
    /async function refreshEditorialInventory/u,
    "native smoke must trigger Editorial Desk refresh through its user-visible action"
  );
  assert.match(
    smokeScript,
    /Taslak envanterini yenile/u,
    "native smoke must locate the named Editorial Desk refresh action instead of a generic CSS button"
  );
  assert.match(
    smokeScript,
    /async function refreshEditorialInventory\(sessionId, expectedDraftTitle\)/u,
    "native smoke refresh must wait for the expected rendered draft, not a stale success notice"
  );
  assert.match(
    smokeScript,
    /verifyOperationsJourney/u,
    "native smoke must prove that Operations pause state persists and diagnostics remain redacted"
  );
  const visiblePauseJourney = smokeScript.slice(
    smokeScript.indexOf("async function verifyVisibleOperationsPauseJourney"),
    smokeScript.indexOf("async function verifyVisibleDiagnosticsExportJourney")
  );
  assert.match(
    visiblePauseJourney,
    /await synchronizeVisibleOperationsState\(sessionId\);/u,
    "direct IPC checks must reconcile the visible Operations snapshot before exercising its controls"
  );
  assert.match(
    smokeScript,
    /verifyVisibleCandidateJournalJourney/u,
    "native smoke must prove that the visible Operations journal explains where a promoted candidate can be followed"
  );
  assert.match(smokeScript, /Araştırma işi kuyruğa alındı/u);
  assert.match(smokeScript, /Taslağı Editoryal Masa’da takip edebilirsiniz\./u);
  assert.match(smokeScript, /set_runtime_pause/u);
  assert.match(smokeScript, /export_diagnostics/u);
  assert.match(
    smokeScript,
    /verifyVisibleInstantCreateJourney/u,
    "native smoke must prove that the visible Instant Create workflow uses the persisted weekly schedule"
  );
  assert.match(
    smokeScript,
    /verifyVisibleReviewEmptyJourney/u,
    "native smoke must prove that an empty Review Workspace gives a truthful next action instead of a synthetic approval state"
  );
  assert.match(smokeScript, /İncelenecek revizyon yok\./u);
  assert.match(smokeScript, /İçerik Akışı'ndan bir işi araştırmaya alın\./u);
  assert.match(smokeScript, /scheduledAt/u);
  assert.match(
    smokeScript,
    /await clickCandidateResearchAction\(sessionId, candidate\.title\)/u,
    "candidate promotion evidence must flow through the rendered UI action"
  );
  assert.match(smokeScript, /get_editorial_workspace/u);
  for (const command of [
    "get_bootstrap_snapshot",
    "get_prerequisite_status",
    "get_connector_state",
    "get_editorial_workspace",
    "get_operations",
    "get_engine_diagnostics",
    "list_sources",
    "local_dev_status",
    "github_device_flow_status",
    "autostart_status"
  ]) {
    assert.match(smokeScript, new RegExp(command, "u"));
  }
  assert.match(
    smokeScript,
    /async function waitForVisibleHeading[\s\S]*?attempt < 100/u,
    "the visible-page wait must match the 15-second failure message"
  );
  assert.match(
    smokeScript,
    /fatal-state[\s\S]*?Safe error codes/u,
    "fatal native startup states must expose only redacted diagnostic codes"
  );
  assert.match(
    smokeScript,
    /querySelector\('\.fatal-state h1 \+ p'\)/u,
    "fatal startup diagnostics must inspect the user-facing error detail instead of the section kicker"
  );
  assert.match(
    smokeScript,
    /çalışma alanı hazırlanırken zaman aşımına uğradı[\s\S]*?BOOTSTRAP_TIMEOUT/u,
    "fatal startup diagnostics must preserve the application's bounded bootstrap timeout code"
  );
  assert.match(smokeScript, /Haftalık ritim, hazır (?:yayınlar|çıktılar) ve geçmiş\./u);
});

test("sidecar doctor smoke contract checks durable local readiness", async () => {
  const smokeScript = await readFile(
    join(repositoryRoot, "scripts", "smoke-engine-sidecar.mjs"),
    "utf8"
  );

  assert.match(smokeScript, /kind:\s*["']doctor["']/u);
  assert.match(smokeScript, /response\.status\s*!==\s*["']READY["']/u);
  assert.match(smokeScript, /response\.persistence\s*!==\s*["']pglite["']/u);
  assert.match(smokeScript, /response\.queue\s*!==\s*["']ready["']/u);
  assert.match(smokeScript, /BLOGBOT_ENGINE_SMOKE_TIMEOUT_MS/u);
  assert.match(smokeScript, /smokeTimeoutMs < 1_000[\s\S]*smokeTimeoutMs > 120_000/u);
  assert.match(
    smokeScript,
    /cwd:\s*localAppData/u,
    "sidecar smoke must not resolve native modules from the development repository"
  );
  assert.match(
    smokeScript,
    /maxRetries:\s*[1-9]\d*/u,
    "Windows sidecar cleanup must retry bounded transient file-handle contention"
  );
  assert.match(smokeScript, /retryDelay:\s*[1-9]\d*/u);
});

test("engine sidecar smoke removes its app-owned temporary directory", {
  skip: process.platform !== "win32"
}, async (context) => {
  const executable = join(
    repositoryRoot,
    "apps",
    "desktop",
    "src-tauri",
    "binaries",
    "blogbot-engine-x86_64-pc-windows-msvc.exe"
  );
  try {
    await access(executable);
  } catch {
    context.skip("the built engine sidecar is not available");
    return;
  }
  const appOwnedSmokeDirectories = async () =>
    (await readdir(tmpdir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("blogbot-sea-smoke-"))
      .map((entry) => entry.name)
      .sort();
  const before = await appOwnedSmokeDirectories();

  await execFile(process.execPath, [join(repositoryRoot, "scripts", "smoke-engine-sidecar.mjs")], {
    cwd: repositoryRoot,
    timeout: 75_000,
    env: {
      ...process.env,
      BLOGBOT_ENGINE_SMOKE_TIMEOUT_MS: "60000"
    },
    windowsHide: true
  });

  assert.deepEqual(await appOwnedSmokeDirectories(), before);
});

test("fetcher SEA bundle starts its stdin protocol and has a packaged smoke gate", async () => {
  const [buildScript, entrypoint, smokeScript, packageJson, verifyWorkflow, releaseWorkflow] = await Promise.all([
    readFile(join(repositoryRoot, "scripts", "build-engine-sidecar.mjs"), "utf8"),
    readFile(join(repositoryRoot, "apps", "fetcher", "src", "sea-entrypoint.ts"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "smoke-fetcher-sidecar.mjs"), "utf8"),
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "verify.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "release-desktop.yml"), "utf8")
  ]);

  assert.match(buildScript, /__BLOGBOT_FETCHER_SEA__.*true/u);
  assert.match(entrypoint, /typeof __BLOGBOT_FETCHER_SEA__/u);
  assert.match(smokeScript, /blogbot-fetcher-x86_64-pc-windows-msvc\.exe/u);
  assert.match(smokeScript, /FETCHER_REQUEST_FAILED/u);
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["smoke:fetcher"], "node scripts/smoke-fetcher-sidecar.mjs");
  const checkAll = scripts["check:all"];
  assert.ok(checkAll);
  assert.match(checkAll, /smoke:fetcher/u);
  assert.match(verifyWorkflow, /npm\.cmd run smoke:engine[\s\S]*npm\.cmd run smoke:fetcher/u);
  assert.match(releaseWorkflow, /npm\.cmd run smoke:engine[\s\S]*npm\.cmd run smoke:fetcher/u);
  assert.match(releaseWorkflow, /npm\.cmd run test:browser/u);
});

test("desktop release gates publication on a same-run commit-pinned Gitleaks scan", async () => {
  const releaseWorkflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );

  assert.match(
    releaseWorkflow,
    /secret-scan:[\s\S]*?permissions:\r?\n\s+contents:\s*read[\s\S]*?actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683[\s\S]*?fetch-depth:\s*0[\s\S]*?gitleaks\/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7/u
  );
  assert.match(releaseWorkflow, /build-signed:\s*\r?\n\s+needs:\s*secret-scan/u);
  assert.match(releaseWorkflow, /attest:\s*\r?\n\s+needs:\s*build-signed/u);
});

test("desktop release prepares Windows sidecars before tests assert clean-machine inputs", async () => {
  const releaseWorkflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );
  const buildEngineIndex = releaseWorkflow.indexOf("npm.cmd run build:engine");
  const testAllIndex = releaseWorkflow.indexOf("npm.cmd run test:all");

  assert.notEqual(buildEngineIndex, -1, "release workflow must build the Windows sidecars");
  assert.notEqual(testAllIndex, -1, "release workflow must run the complete Node test suite");
  assert.ok(
    buildEngineIndex < testAllIndex,
    "release workflow must prepare sidecars before Windows packaging-readiness tests"
  );
});

test("desktop build injects Windows signing configuration only from a complete public contract", async () => {
  const buildScript = await readFile(
    join(repositoryRoot, "scripts", "build-desktop.mjs"),
    "utf8"
  );

  assert.match(buildScript, /OPE_WINDOWS_CERTIFICATE_THUMBPRINT/u);
  assert.match(buildScript, /OPE_WINDOWS_TIMESTAMP_URL/u);
  assert.match(buildScript, /OPE_UPDATE_SIGNER_SHA256/u);
  assert.match(buildScript, /digestAlgorithm:\s*"sha256"/u);
  assert.match(buildScript, /tsp:\s*true/u);
  assert.match(buildScript, /"--config"/u);
});

test("desktop release packages prepared sidecars without rebuilding them", async () => {
  const releaseWorkflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );

  assert.match(
    releaseWorkflow,
    /run: npm\.cmd run build:desktop -- --prepared-sidecars/u
  );
});

test("desktop release rejects an existing version tag before tool setup or build", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );
  const buildJob = workflow.slice(
    workflow.indexOf("\n  build-signed:"),
    workflow.indexOf("\n  attest:")
  );
  const versionGateIndex = buildJob.indexOf("Verify release version");
  const setupNodeIndex = buildJob.indexOf("actions/setup-node@");
  const buildEngineIndex = buildJob.indexOf("npm.cmd run build:engine");

  assert.match(
    buildJob,
    /actions\/checkout@[a-f0-9]{40}[\s\S]*?persist-credentials:\s*false[\s\S]*?fetch-depth:\s*0/u,
    "the release checkout must include tags so the duplicate-version gate is authoritative"
  );
  assert.ok(
    versionGateIndex > -1 && versionGateIndex < setupNodeIndex && setupNodeIndex < buildEngineIndex,
    "version and duplicate-tag validation must finish before tool setup or repository build code"
  );
  const versionGate = buildJob.slice(versionGateIndex, setupNodeIndex);
  assert.match(versionGate, /\$existingTagRefs = @\(& git for-each-ref --format='%\(refname\)' \$tagRef\)/u);
  assert.match(
    versionGate,
    /\$LASTEXITCODE -ne 0[\s\S]*RELEASE_TAG_LOOKUP_FAILED[\s\S]*\$existingTagRefs\.Count -ne 0[\s\S]*RELEASE_TAG_ALREADY_EXISTS/u,
    "an empty tag query must succeed while lookup failures and existing tags fail closed"
  );
});

test("desktop release pins the generated tag to the dispatched commit", async () => {
  const releaseWorkflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );

  assert.match(
    releaseWorkflow,
    /gh release create "v\$env:RELEASE_VERSION"[\s\S]*?--target "\$\{\{ github\.sha \}\}"/u
  );
});

test("verify and release reject RustSec vulnerabilities in the Windows desktop lock", async () => {
  const [packageJsonRaw, verifyWorkflow, releaseWorkflow] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "verify.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "release-desktop.yml"), "utf8")
  ]);

  const scripts = (JSON.parse(packageJsonRaw) as { scripts: Record<string, string> }).scripts;
  assert.equal(
    scripts["security:rust"],
    "cargo audit --file apps/desktop/src-tauri/Cargo.lock --target-os windows --target-arch x86_64"
  );
  const securityVerify = scripts["security:verify"];
  assert.ok(securityVerify);
  assert.match(securityVerify, /npm run security:rust/u);
  for (const workflow of [verifyWorkflow, releaseWorkflow]) {
    assert.match(
      workflow,
      /cargo install cargo-audit --version 0\.22\.2 --locked[\s\S]*npm\.cmd run security:rust/u
    );
  }
});

test("native diagnostics smoke accepts the redacted handoff without requiring a local path", async () => {
  const smokeScript = await readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8");

  assert.match(smokeScript, /result\?\.status\.includes\('Tanılama paketi hazırlandı'\) && result\.summary/u);
  assert.doesNotMatch(smokeScript, /result\.path &&/u);
  assert.doesNotMatch(smokeScript, /diagnostic-export-path/u);
});
test("native smoke fails a slow route instead of tolerating a minute-long frozen menu", async () => {
  const smoke = await readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8");

  assert.match(smoke, /const MAX_ROUTE_RENDER_MS = 3_000;/u);
  assert.match(smoke, /route #\$\{route\} did not render a visible page heading within \$\{timeoutMs\} ms/u);
  assert.match(smoke, /routeRenderMs/u);
  assert.match(smoke, /profileRoutePerformance/u);
  assert.match(smoke, /BLOGBOT_PROFILE_TEST_SOURCES/u);
  assert.match(smoke, /profileSourceChecks/u);
  assert.match(smoke, /degraded: unreachableIndexes\.length > 0/u);
  assert.match(smoke, /unreachableSources/u);
  assert.doesNotMatch(smoke, /actual profile source checks failed/u);
  assert.match(smoke, /verifyCodexRuntime/u);
  assert.match(smoke, /test_codex_runtime/u);
});

test("native smoke bounds its final WebDriver session cleanup", async () => {
  const smoke = await readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8");

  assert.match(
    smoke,
    /fetch\(`\$\{webdriverBaseUrl\}\/session\/\$\{sessionId\}`, \{\s*method: "DELETE",\s*signal: AbortSignal\.timeout\(nativeSmokeRequestTimeoutMs\)\s*\}\)/u,
    "a wedged local driver must not hold the smoke harness open forever during finally cleanup"
  );
});

test("live Boby smoke reports a safe terminal status when the reply deadline expires", async () => {
  const smoke = await readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8");

  assert.match(smoke, /const liveBobyReplyTimeoutMs = Number\.parseInt\(\s*process\.env\.BLOGBOT_LIVE_BOBY_TIMEOUT_MS \?\? "120000"/u);
  assert.match(smoke, /BLOGBOT_LIVE_BOBY_TIMEOUT_MS must be an integer from 10000 to 120000\./u);
  assert.match(smoke, /performance\.now\(\) - startedAt < liveBobyReplyTimeoutMs/u);
  assert.match(smoke, /live Boby did not finish within \$\{liveBobyReplyTimeoutMs\}ms; safe state=/u);
  assert.match(smoke, /const safeLiveBobyState = \{/u);
  assert.match(smoke, /state: typeof finalGuidance\.result\?\.state === "string"/u);
  assert.match(smoke, /waitReason: typeof finalGuidance\.result\?\.waitReason === "string"/u);
  assert.match(smoke, /const safeLiveBobyState = \{[^}]*diagnosticCode: typeof finalGuidance\.result\?\.diagnosticCode === "string"/u);
  assert.doesNotMatch(smoke, /const safeLiveBobyState = \{[^}]*diagnosticDetail/u);
  assert.match(smoke, /suggestedActionCount: Array\.isArray\(finalGuidance\.result\?\.suggestedActions\)/u);
  assert.doesNotMatch(smoke, /safeLiveBobyState[^\n]*reply/u);
  assert.doesNotMatch(smoke, /safeLiveBobyState[^\n]*guidanceId/u);
  assert.doesNotMatch(smoke, /live Boby request was not accepted: \$\{JSON\.stringify\(submitted\)\}/u);
  assert.doesNotMatch(smoke, /live Boby status read failed: \$\{JSON\.stringify\(guidance\)\}/u);
  assert.doesNotMatch(smoke, /live Boby job failed: \$\{JSON\.stringify\(result\)\}/u);
  assert.doesNotMatch(smoke, /return \{ guidanceId,/u);

});

test("optional live updater smoke exposes only a safe read-only check summary", async () => {
  const smoke = await readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8");

  assert.match(smoke, /const verifyUpdaterLiveCheck = process\.env\.BLOGBOT_VERIFY_UPDATER_LIVE_CHECK === "1";/u);
  assert.match(smoke, /async function verifyLiveUpdaterCheck\(sessionId\)/u);
  assert.match(smoke, /"check_unsigned_update"/u);
  assert.match(smoke, /live updater check failed: ok=\$\{response\?\.ok === true\}\./u);
  assert.match(smoke, /latestVersion/u);
  assert.doesNotMatch(smoke, /liveUpdaterCheck[^\n]*\.url/u);
  assert.doesNotMatch(smoke, /liveUpdaterCheck[^\n]*\.sha256/u);
  assert.doesNotMatch(smoke, /liveUpdaterCheck[^\n]*\.notes/u);
});
test("native restart smoke waits for a non-blocking engine to recover its durable draft", async () => {
  const smoke = await readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8");

  assert.match(smoke, /const MAX_ENGINE_RECOVERY_RENDER_MS = 15_000;/u);
  assert.match(smoke, /async function waitForRecoveredDraft\(sessionId, draftId\)/u);
  assert.match(smoke, /performance\.now\(\) - startedAt < MAX_ENGINE_RECOVERY_RENDER_MS/u);
  assert.match(smoke, /await waitForRecoveredDraft\(sessionId, candidateJourney\.draftId\)/u);
});

test("native candidate action smoke waits for the prior mutation to settle before selecting again", async () => {
  const matrix = await readFile(join(repositoryRoot, "scripts", "native-visible-action-matrix.mjs"), "utf8");
  const settleCheck = matrix.indexOf(
    'await waitUntil("return !document.querySelectorAll(\'.candidate-bulk-actions button\')[0].disabled;", "candidate single close did not settle");'
  );
  const nextSelection = matrix.indexOf(
    'document.querySelector(\'.candidate-card input[type=checkbox]\').click()'
  );

  assert.notEqual(settleCheck, -1, "single-close mutation must expose an explicit settlement gate");
  assert.ok(settleCheck < nextSelection, "the settlement gate must run before the next checkbox click");
});

test("live Boby smoke runs for both actual and fresh temporary profiles", async () => {
  const smoke = await readFile(join(repositoryRoot, "scripts", "native-webview-smoke.mjs"), "utf8");

  assert.match(smoke, /const liveBobyReply = verifyBobyLiveReply \? await verifyLiveBobyReply\(sessionId\) : undefined;/u);
  assert.match(smoke, /singleSourceAddressCheckJourney = await verifySingleSourceAddressCheckJourney\(sessionId\);\s+const liveBobyReply = verifyBobyLiveReply \? await verifyLiveBobyReply\(sessionId\) : undefined;/u);
  assert.match(smoke, /localEngine: localEngine\.result,[\s\S]*liveBobyReply,[\s\S]*singleSourceAddressCheckJourney/u);
});
test("desktop preflight verifies clean-machine installer inputs without building an installer", { skip: process.platform !== "win32" }, async () => {
  const result = await runDesktopPreflight();
  assert.equal(result.ok, true, result.checks.filter((check) => check.status === "FAIL").map((check) => check.detail).join("; "));
  assert.ok(result.checks.some((check) => check.id === "webview2-bootstrapper"));
  assert.ok(result.checks.some((check) => check.id === "clean-machine-runtime"));
  assert.ok(result.checks.some((check) => check.id === "gui-smoke-contract"));
  assert.ok(result.checks.some((check) => check.id === "bundled-engine-sidecar"));
});

test("desktop release package is pinned to the planned 0.1.55 version", async () => {
  const manifests = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "package.json"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8")
  ]);
  const versions = [
    JSON.parse(manifests[0]).version,
    /^\s*\[package\][\s\S]*?^\s*version\s*=\s*"([^"]+)"/mu.exec(manifests[1])?.[1],
    JSON.parse(manifests[2]).version
  ].map(String);

  assert.deepEqual(versions, ["0.1.55", "0.1.55", "0.1.55"]);
});
test("release version stays identical across every packaged desktop manifest", async () => {
  const [desktopManifestRaw, cargoManifestRaw, tauriConfigRaw] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "package.json"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8")
  ]);

  const desktopVersion = (JSON.parse(desktopManifestRaw) as { version?: unknown }).version;
  const tauriVersion = (JSON.parse(tauriConfigRaw) as { version?: unknown }).version;
  const cargoVersion = /^\s*\[package\][\s\S]*?^\s*version\s*=\s*"([^"]+)"/mu.exec(cargoManifestRaw)?.[1];

  // A vacuous pass would hide a real drift, so prove each manifest was parsed.
  assert.match(String(desktopVersion), /^\d+\.\d+\.\d+$/u, "apps/desktop/package.json needs a SemVer version");
  assert.match(String(tauriVersion), /^\d+\.\d+\.\d+$/u, "tauri.conf.json needs a SemVer version");
  assert.match(String(cargoVersion), /^\d+\.\d+\.\d+$/u, "src-tauri/Cargo.toml [package] needs a SemVer version");

  assert.equal(
    tauriVersion,
    desktopVersion,
    "tauri.conf.json version must match apps/desktop/package.json or the NSIS bundle name drifts from the release tag"
  );
  assert.equal(
    cargoVersion,
    desktopVersion,
    "src-tauri/Cargo.toml version must match apps/desktop/package.json or the installed app reports the wrong version"
  );
});

test("signed release blocks publication until a pinned SBOM and both attestations succeed", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );
  const cleanupIndex = workflow.indexOf("Remove signing credentials");
  const sbomIndex = workflow.indexOf("Generate SPDX SBOM");
  const uploadIndex = workflow.indexOf("actions/upload-artifact@");
  const attestIndex = workflow.indexOf("\n  attest:");
  const publishIndex = workflow.indexOf("\n  publish:");

  assert.notEqual(attestIndex, -1, "release workflow needs a separate attestation job");
  assert.ok(
    cleanupIndex < sbomIndex && sbomIndex < uploadIndex && uploadIndex < attestIndex &&
      attestIndex < publishIndex,
    "credentials must be removed before SBOM generation, attestation, and publication"
  );

  const buildJob = workflow.slice(workflow.indexOf("\n  build-signed:"), attestIndex);
  assert.match(
    buildJob,
    /anchore\/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26/u
  );
  assert.match(buildJob, /format:\s*spdx-json/u);
  assert.match(buildJob, /output-file:\s*release-payload\/ope-sbom\.spdx\.json/u);
  assert.match(buildJob, /upload-artifact:\s*false/u);
  assert.match(buildJob, /upload-release-assets:\s*false/u);
  assert.match(buildJob, /dependency-snapshot:\s*false/u);

  const attestJob = workflow.slice(attestIndex, publishIndex);
  assert.match(attestJob, /needs:\s*build-signed/u);
  assert.match(
    attestJob,
    /actions\/checkout@[a-f0-9]{40}[\s\S]*?persist-credentials:\s*false[\s\S]*?actions\/download-artifact@/u
  );
  assert.match(
    attestJob,
    /permissions:\s*\r?\n\s+contents:\s*read\s*\r?\n\s+id-token:\s*write\s*\r?\n\s+attestations:\s*write/u
  );
  assert.doesNotMatch(
    attestJob,
    /contents:\s*write|OPE_WINDOWS_CERTIFICATE_PFX_BASE64|OPE_WINDOWS_CERTIFICATE_PASSWORD/u
  );
  assert.match(
    attestJob,
    /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u
  );
  assert.equal(
    (attestJob.match(/actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d/gu) ?? []).length,
    2
  );
  assert.match(attestJob, /sbom-path:\s*release-payload\/ope-sbom\.spdx\.json/u);
  assert.match(attestJob, /release-payload\/blogbot\.exe[\s\S]*?-setup\.exe[\s\S]*?_en-US\.msi/u);
  assert.match(attestJob, /scripts\/verify-release-payload\.ps1/u);

  const publishJob = workflow.slice(publishIndex);
  assert.match(
    workflow,
    /publish_release:\s*\r?\n\s+description:[^\r\n]+\r?\n\s+required:\s*true\r?\n\s+type:\s*boolean\r?\n\s+default:\s*false/u,
    "publication must require an explicit dispatch decision and default to verification-only"
  );
  assert.match(publishJob, /needs:\s*attest/u);
  assert.match(
    publishJob,
    /if:\s*\$\{\{\s*inputs\.publish_release\s*\}\}/u,
    "the only contents-write job must stay skipped unless publication is explicitly selected"
  );
  assert.match(publishJob, /scripts\/verify-release-payload\.ps1/u);
  assert.match(
    publishJob,
    /actions\/checkout@[a-f0-9]{40}[\s\S]*?persist-credentials:\s*false[\s\S]*?actions\/download-artifact@/u
  );
  assert.match(publishJob, /ope-sbom\.spdx\.json[\s\S]*?gh release create/u);

  const verifierPath = join(repositoryRoot, "scripts", "verify-release-payload.ps1");
  await access(verifierPath);
  const verifier = await readFile(verifierPath, "utf8");
  assert.match(verifier, /ope-sbom\.spdx\.json/u);
  assert.match(verifier, /SPDX-2\.3/u);
  assert.match(verifier, /ConvertFrom-Json/u);
  assert.match(verifier, /Get-AuthenticodeSignature/u);
  assert.match(verifier, /AUTHENTICODE_SIGNER_SHA256_MISMATCH/u);
  assert.match(verifier, /RELEASE_PAYLOAD_FILE_SET_INVALID/u);
});

test("desktop release fails closed unless dispatch targets the checked-out main commit", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );
  const buildJob = workflow.slice(
    workflow.indexOf("\n  build-signed:"),
    workflow.indexOf("\n  attest:")
  );
  const sourceGateIndex = buildJob.indexOf("Verify release source ref");
  const installIndex = buildJob.indexOf("npm ci");

  assert.notEqual(sourceGateIndex, -1, "release source ref needs an explicit fail-closed gate");
  assert.ok(sourceGateIndex < installIndex, "source identity must be checked before repository code runs");
  assert.match(buildJob, /RELEASE_REF:\s*\$\{\{ github\.ref \}\}/u);
  assert.match(buildJob, /RELEASE_SHA:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(buildJob, /refs\/heads\/main/u);
  assert.match(buildJob, /git rev-parse HEAD/u);
  assert.match(buildJob, /RELEASE_REF_NOT_ALLOWED/u);
  assert.match(buildJob, /RELEASE_CHECKOUT_SHA_MISMATCH/u);
});

test("release payload verifier remains compatible with Windows PowerShell 5.1", async () => {
  const verifier = await readFile(join(repositoryRoot, "scripts", "verify-release-payload.ps1"), "utf8");
  assert.doesNotMatch(
    verifier,
    /\[IO\.Path\]::GetRelativePath/u,
    "the local Windows PowerShell 5.1 runtime does not provide Path.GetRelativePath"
  );
  assert.match(verifier, /\$_\.Name/u);
});

test("release payload verifier accepts legal dot-prefixed repositories but rejects dot segments", {
  skip: process.platform !== "win32"
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "blogbot-release-verifier-"));
  const verifier = join(repositoryRoot, "scripts", "verify-release-payload.ps1");
  const safeEnvironment = (repository: string) => ({
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? "C:\\Windows",
    PATH: process.env.PATH ?? "",
    TEMP: tmpdir(),
    TMP: tmpdir(),
    RELEASE_VERSION: "0.1.55",
    RELEASE_NOTES: "Synthetic local verifier fixture",
    REPOSITORY: repository,
    OPE_WINDOWS_CERTIFICATE_THUMBPRINT: "0".repeat(40),
    OPE_UPDATE_SIGNER_SHA256: "0".repeat(64)
  });
  const runVerifier = async (repository: string) => {
    try {
      await execFile("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        verifier
      ], {
        cwd: fixtureRoot,
        env: safeEnvironment(repository),
        timeout: 10_000,
        windowsHide: true
      });
      return "UNEXPECTED_SUCCESS";
    } catch (reason) {
      const failure = reason as { stdout?: string; stderr?: string };
      return `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    }
  };

  try {
    await mkdir(join(fixtureRoot, "release-payload"));
    assert.match(await runVerifier("owner/.github"), /RELEASE_PAYLOAD_FILE_SET_INVALID/u);
    assert.match(await runVerifier("owner/.github-private"), /RELEASE_PAYLOAD_FILE_SET_INVALID/u);
    assert.match(await runVerifier("owner/."), /RELEASE_REPOSITORY_INVALID/u);
    assert.match(await runVerifier("owner/.."), /RELEASE_REPOSITORY_INVALID/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("signed release verifies every Tauri external sidecar with the pinned publisher", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );
  const verification = workflow.slice(
    workflow.indexOf("Verify signed application and installers"),
    workflow.indexOf("Remove signing credentials")
  );

  assert.match(verification, /blogbot-engine-x86_64-pc-windows-msvc\.exe/u);
  assert.match(verification, /blogbot-fetcher-x86_64-pc-windows-msvc\.exe/u);
  assert.match(
    verification,
    /\$signatureTargets = @\(\$app, \$engine, \$fetcher, \$secureRestore, \$nsis, \$msi\) \+ \$nativeRuntimeFiles/u,
    "the same Authenticode, timestamp, thumbprint, and SHA-256 pin gates must cover sidecars"
  );
  assert.match(verification, /TimeStamperCertificate/u);
});

test("secure restore helper is a Tauri-signed external binary rather than an opaque resource", async () => {
  const [configText, buildScript, preflight, workflow] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "build-engine-sidecar.mjs"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "desktop-preflight.mjs"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "release-desktop.yml"), "utf8")
  ]);
  const config = JSON.parse(configText) as {
    bundle?: { externalBin?: string[]; resources?: string[] };
  };
  const verification = workflow.slice(
    workflow.indexOf("Verify signed application and installers"),
    workflow.indexOf("Remove signing credentials")
  );

  assert.ok(config.bundle?.externalBin?.includes("binaries/blogbot-secure-restore"));
  assert.ok(!config.bundle?.resources?.includes("resources/secure-restore/*"));
  assert.match(
    buildScript,
    /binaryDirectory,[\s\S]*?"blogbot-secure-restore-x86_64-pc-windows-msvc\.exe"/u
  );
  assert.match(
    buildScript,
    /TAURI_CONFIG:\s*JSON\.stringify\(\{\s*bundle:\s*\{\s*externalBin:\s*\[\]\s*\}\s*\}\)/u,
    "building the helper must temporarily disable sidecar copying to avoid a clean-build cycle"
  );
  assert.match(preflight, /blogbot-secure-restore-x86_64-pc-windows-msvc\.exe/u);
  assert.match(verification, /blogbot-secure-restore-x86_64-pc-windows-msvc\.exe/u);
  assert.match(
    verification,
    /\$signatureTargets = @\(\$app, \$engine, \$fetcher, \$secureRestore, \$nsis, \$msi\) \+ \$nativeRuntimeFiles/u
  );
});

test("release signs packaged native runtime modules with SHA-256 and RFC 3161 before bundling", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-desktop.yml"),
    "utf8"
  );
  const signIndex = workflow.indexOf("Sign packaged native runtime modules");
  const buildIndex = workflow.indexOf("Build signed desktop installers");
  assert.notEqual(signIndex, -1, "native runtime modules need an explicit signing step");
  assert.ok(signIndex < buildIndex, "native modules must be signed before Tauri copies them into installers");

  const signing = workflow.slice(signIndex, buildIndex);
  assert.match(signing, /signtool\.exe/u);
  assert.match(signing, /resources\/engine-node_modules/u);
  assert.match(signing, /\.Extension -in @\('\.dll', '\.node'\)/u);
  assert.match(signing, /\/sha1/u);
  assert.match(signing, /\/fd SHA256/u);
  assert.match(signing, /\/tr/u);
  assert.match(signing, /\/td SHA256/u);

  const verification = workflow.slice(
    workflow.indexOf("Verify signed application and installers"),
    workflow.indexOf("Remove signing credentials")
  );
  assert.match(verification, /\$nativeRuntimeFiles/u);
  assert.match(
    verification,
    /\$signatureTargets = @\(\$app, \$engine, \$fetcher, \$secureRestore, \$nsis, \$msi\) \+ \$nativeRuntimeFiles/u
  );
  assert.match(verification, /foreach \(\$candidate in \$signatureTargets\)/u);
});
