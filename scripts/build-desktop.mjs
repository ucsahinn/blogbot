import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dirname, "..");
const wixTemp = resolve(tmpdir(), "blogbot-wix-temp");
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("npm_execpath is required to run the repository package scripts safely.");
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

await run(process.execPath, [npmCli, "run", "build:engine"]);

const environment = process.platform === "win32"
  ? { ...process.env, WIX_TEMP: process.env.WIX_TEMP?.trim() || wixTemp }
  : process.env;
if (process.platform === "win32") {
  await mkdir(String(environment.WIX_TEMP), { recursive: true });
}
await run(
  process.execPath,
  [npmCli, "run", "tauri", "--workspace", "@blogbot/desktop", "--", "build", "--", "--bin", "blogbot"],
  environment
);
