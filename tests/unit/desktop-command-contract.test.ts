import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

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
  const registered = new Set<string>();
  for (const match of nativeSource.matchAll(/commands::([a-z0-9_]+)\b/gu)) {
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
});
