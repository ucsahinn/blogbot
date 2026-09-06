import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = resolve(".");
const executable = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "binaries",
  "blogbot-engine-x86_64-pc-windows-msvc.exe"
);
const assets = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "pglite"
);
const engineModules = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "engine-node_modules",
  "node_modules"
);
const smokeTimeoutMs = Number.parseInt(
  process.env.BLOGBOT_ENGINE_SMOKE_TIMEOUT_MS ?? "30000",
  10
);
if (
  !Number.isSafeInteger(smokeTimeoutMs) ||
  smokeTimeoutMs < 1_000 ||
  smokeTimeoutMs > 120_000
) {
  throw new Error(
    "BLOGBOT_ENGINE_SMOKE_TIMEOUT_MS must be an integer from 1000 to 120000."
  );
}
const localAppData = await mkdtemp(join(tmpdir(), "blogbot-sea-smoke-"));

let child;
try {
  child = spawn(executable, [], {
    cwd: localAppData,
    windowsHide: true,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      BLOGBOT_PGLITE_ASSETS: assets,
      BLOGBOT_ENGINE_MODULES: engineModules,
      BLOGBOT_DATA_KEY_HEX:
        "8e51c4f05c864820531146e549d2c2e1f865d5e639ccf0cff8d496c214b2387c"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(
    `${JSON.stringify({ version: 1, id: "sea-doctor", kind: "doctor" })}\n`
  );

  const exitCode = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Engine sidecar smoke test timed out after ${smokeTimeoutMs}ms`));
    }, smokeTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(
      `Engine sidecar exited with ${String(exitCode)}: ${stderr.trim()}`
    );
  }

  const response = JSON.parse(stdout.trim());
  if (
    response.id !== "sea-doctor" ||
    response.status !== "READY" ||
    response.persistence !== "pglite" ||
    response.queue !== "ready"
  ) {
    throw new Error(`Unexpected engine doctor response: ${stdout.trim()}`);
  }

  process.stdout.write(`${JSON.stringify(response)}\n`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolveStop) => {
      const stopTimeout = setTimeout(resolveStop, 5_000);
      child.once("exit", () => {
        clearTimeout(stopTimeout);
        resolveStop();
      });
      if (!child.kill()) {
        clearTimeout(stopTimeout);
        resolveStop();
      }
    });
  }
  await rm(localAppData, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}
