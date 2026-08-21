import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { SITE_SECTIONS } from "../../packages/contracts/src/index.ts";

const repositoryRoot = join(import.meta.dirname, "..", "..");

test("every WebView bridge command is registered by the Tauri desktop handler", async () => {
  const [bridgeSource, nativeSource, defaultCapability] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "src", "bridge.ts"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "permissions", "default.toml"), "utf8")
  ]);
  const invoked = new Set<string>();
  for (const match of bridgeSource.matchAll(/\b(?:read|mutate)\("([a-z0-9_]+)"/gu)) {
    invoked.add(match[1]!);
  }
  // Only the `generate_handler!` list is reachable from the WebView. `lib.rs`
  // also calls internal `commands::` helpers during setup, and counting those
  // as exposed commands would make the reverse check below report phantoms.
  const handler = /tauri::generate_handler!\[([\s\S]*?)\]/u.exec(nativeSource);
  assert.ok(handler, "lib.rs must declare a tauri::generate_handler! list");
  const registered = new Set<string>();
  for (const match of handler[1]!.matchAll(/commands::([a-z0-9_]+)\b/gu)) {
    registered.add(match[1]!);
  }

  assert.ok(invoked.size > 0, "bridge command scan must find command names");
  assert.deepEqual(
    [...invoked].filter((command) => !registered.has(command)),
    [],
    "every command exposed to the WebView must be registered by Tauri"
  );
  const permitted = new Set(
    [...defaultCapability.matchAll(/"allow-([a-z0-9-]+)"/gu)].map((match) => match[1]!)
  );
  assert.deepEqual(
    [...invoked]
      .map((command) => command.replaceAll("_", "-"))
      .filter((command) => !permitted.has(command)),
    [],
    "every WebView bridge command must have an explicit default capability permission"
  );
  // The reverse direction matters just as much: a command that is registered and
  // permitted but never invoked is reachable from the WebView while nobody
  // reviews it as part of a user path. `engine_doctor` and `secure_store_status`
  // sat here for exactly that reason -- both duplicated data
  // `get_prerequisite_status` already returns.
  assert.deepEqual(
    [...registered].filter((command) => !invoked.has(command)),
    [],
    "a registered Tauri command with no WebView caller is unreviewed attack surface"
  );
});

test("the native section allowlist covers every site section the contract declares", async () => {
  const nativeSource = await readFile(
    join(repositoryRoot, "apps", "desktop", "src-tauri", "src", "commands.rs"),
    "utf8"
  );
  const declared = /pub\(crate\) const SITE_SECTION_IDS: \[&str; (\d+)\] = \[([\s\S]*?)\];/u.exec(nativeSource);
  assert.ok(declared, "commands.rs must declare SITE_SECTION_IDS");
  const nativeSections = [...declared[2]!.matchAll(/"([a-z]+)"/gu)].map((match) => match[1]);

  // The renderer offers every contract section, so the native command must
  // accept every one of them; it previously accepted only four of eight and
  // rejected the rest as an invalid section.
  assert.deepEqual(
    [...nativeSections].sort(),
    Object.keys(SITE_SECTIONS).sort(),
    "SITE_SECTION_IDS must match SITE_SECTIONS in packages/contracts"
  );
  assert.equal(Number(declared[1]), nativeSections.length, "the declared array length must match");
});

test("stopping the local dev server never depends on a healthy engine runtime", async () => {
  const nativeSource = await readFile(
    join(repositoryRoot, "apps", "desktop", "src-tauri", "src", "commands.rs"),
    "utf8"
  );
  const command = /pub fn stop_local_dev\(([\s\S]*?)\r?\n\}/u.exec(nativeSource);
  assert.ok(command, "commands.rs must declare stop_local_dev");

  // Terminating a child this process owns needs no engine at all, and a degraded
  // runtime is exactly when the user needs the dev server stopped. The guard used
  // to leave the npm tree running with no way to stop it.
  assert.ok(
    !command[1]!.includes("ensure_mutation_allowed"),
    "stop_local_dev must not require mutation-allowed runtime"
  );
});
