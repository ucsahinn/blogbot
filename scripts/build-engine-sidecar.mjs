import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, "build", "engine-sidecar");
const binaryDirectory = join(root, "apps", "desktop", "src-tauri", "binaries");
const resourceDirectory = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "pglite"
);
const engineModulesDirectory = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "engine-node_modules",
  "node_modules"
);
const executable = join(
  binaryDirectory,
  "blogbot-engine-x86_64-pc-windows-msvc.exe"
);
const bundle = join(work, "sea-entry.cjs");
const blob = join(work, "sea-prep.blob");
const config = join(work, "sea-config.json");

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(binaryDirectory, { recursive: true });
await mkdir(resourceDirectory, { recursive: true });
await rm(join(resourceDirectory, "..", "engine-node_modules"), { recursive: true, force: true });
await mkdir(engineModulesDirectory, { recursive: true });

await build({
  entryPoints: [join(root, "apps", "engine", "src", "sea-entrypoint.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  external: ["sharp"],
  banner: {
    js: `globalThis.__BLOGBOT_IMPORT_META_URL__ = require("node:url").pathToFileURL(require("node:path").join(process.env.BLOGBOT_PGLITE_ASSETS || require("node:path").dirname(process.execPath), "index.js")).href;`
  },
  define: {
    "import.meta.url": "globalThis.__BLOGBOT_IMPORT_META_URL__"
  }
});

await writeFile(
  config,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  )
);

await run(process.execPath, ["--experimental-sea-config", config]);
await copyFile(process.execPath, executable);
await run(process.execPath, [
  join(root, "node_modules", "postject", "dist", "cli.js"),
  executable,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
]);

for (const asset of ["pglite.wasm", "initdb.wasm", "pglite.data"]) {
  await copyFile(
    join(root, "node_modules", "@electric-sql", "pglite", "dist", asset),
    join(resourceDirectory, asset)
  );
}

for (const modulePath of [
  ["sharp"],
  ["detect-libc"],
  ["@img", "colour"],
  ["@img", "sharp-win32-x64"]
]) {
  await cp(
    join(root, "node_modules", ...modulePath),
    join(engineModulesDirectory, ...modulePath),
    { recursive: true, force: true }
  );
}

process.stdout.write(`${executable}\n`);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(`${command} exited with code ${String(code)}`)
        );
      }
    });
  });
}
