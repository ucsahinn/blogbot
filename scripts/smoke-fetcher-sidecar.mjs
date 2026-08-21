import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const executable = join(
  resolve("."),
  "apps",
  "desktop",
  "src-tauri",
  "binaries",
  "blogbot-fetcher-x86_64-pc-windows-msvc.exe"
);
const workingDirectory = await mkdtemp(join(tmpdir(), "blogbot-fetcher-smoke-"));

try {
  const child = spawn(executable, [], {
    cwd: workingDirectory,
    windowsHide: true,
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
  child.stdin.end(`${JSON.stringify({ id: "fetcher-smoke", kind: "request", plan: null })}\n`);

  const exitCode = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Fetcher sidecar smoke timed out"));
    }, 10_000);
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
    throw new Error(`Fetcher sidecar exited with ${String(exitCode)}: ${stderr.trim().slice(0, 500)}`);
  }
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("Fetcher sidecar emitted an unexpected response count");
  }
  const response = JSON.parse(lines[0]);
  if (
    response.id !== "fetcher-smoke" ||
    response.ok !== false ||
    response.code !== "FETCHER_REQUEST_FAILED"
  ) {
    throw new Error(`Unexpected fetcher smoke response: ${lines[0]}`);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
} finally {
  await rm(workingDirectory, { recursive: true, force: true });
}
