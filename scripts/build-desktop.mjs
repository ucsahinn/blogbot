import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dirname, "..");
const wixTemp = resolve(tmpdir(), "blogbot-wix-temp");
const npmCli = process.env.npm_execpath;
const preparedSidecars = process.argv.slice(2).includes("--prepared-sidecars");
const signingThumbprint = process.env.OPE_WINDOWS_CERTIFICATE_THUMBPRINT?.trim() || "";
const signingTimestampUrl = process.env.OPE_WINDOWS_TIMESTAMP_URL?.trim() || "";
const updateSignerSha256 = process.env.OPE_UPDATE_SIGNER_SHA256?.trim() || "";

if (!npmCli) {
  throw new Error("npm_execpath is required to run the repository package scripts safely.");
}

const signingValues = [signingThumbprint, signingTimestampUrl, updateSignerSha256];
const configuredSigningValues = signingValues.filter(Boolean).length;
if (configuredSigningValues !== 0 && configuredSigningValues !== signingValues.length) {
  throw new Error("WINDOWS_SIGNING_CONFIG_INCOMPLETE");
}
if (configuredSigningValues === signingValues.length) {
  if (!/^[a-f0-9]{40}$/iu.test(signingThumbprint)) {
    throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT_INVALID");
  }
  if (!/^[a-f0-9]{64}$/iu.test(updateSignerSha256)) {
    throw new Error("UPDATE_SIGNER_SHA256_INVALID");
  }
  const timestampUrl = new URL(signingTimestampUrl);
  if (!["http:", "https:"].includes(timestampUrl.protocol) || timestampUrl.username || timestampUrl.password || timestampUrl.search || timestampUrl.hash) {
    throw new Error("WINDOWS_TIMESTAMP_URL_INVALID");
  }
}

function run(command, args, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolveRun();
      rejectRun(new Error(`${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`));
    });
  });
}

await run(
  process.execPath,
  preparedSidecars
    ? [npmCli, "run", "desktop:preflight:json"]
    : [npmCli, "run", "build:engine"]
);

const environment = process.platform === "win32"
  ? { ...process.env, WIX_TEMP: process.env.WIX_TEMP?.trim() || wixTemp }
  : process.env;
if (process.platform === "win32") {
  await mkdir(String(environment.WIX_TEMP), { recursive: true });
}
const tauriBuildArgs = [npmCli, "run", "tauri", "--workspace", "@blogbot/desktop", "--", "build"];
if (configuredSigningValues === signingValues.length) {
  tauriBuildArgs.push(
    "--config",
    JSON.stringify({
      bundle: {
        windows: {
          certificateThumbprint: signingThumbprint,
          digestAlgorithm: "sha256",
          timestampUrl: signingTimestampUrl,
          tsp: true
        }
      }
    })
  );
}
tauriBuildArgs.push("--", "--bin", "blogbot");
await run(process.execPath, tauriBuildArgs, environment);
