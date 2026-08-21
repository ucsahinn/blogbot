import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { BridgeError } from "../src/bridge.ts";
import { createRuntimeBridge } from "../src/runtime-bridge.ts";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime bridge fails closed outside Tauri instead of opening demo data", async () => {
  await assert.rejects(
    createRuntimeBridge(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "BRIDGE_UNAVAILABLE"
  );
});

test("application startup keeps the setup path available when connector state cannot load", async () => {
  const appSource = await readFile(join(desktopRoot, "src", "App.tsx"), "utf8");

  assert.match(appSource, /fallbackConnectorState/u);
  assert.match(appSource, /setConnectorState\(fallbackConnectorState\);/u);
  assert.match(appSource, /getConnectorState\(\)\.then\([\s\S]*?\)\.catch\(\(reason\)/u);
});

test("application bootstrap renders the local workspace before a slow connector read completes", async () => {
  const appSource = await readFile(join(desktopRoot, "src", "App.tsx"), "utf8");

  assert.match(appSource, /const coalescingBridge = createCoalescingBridge\(runtimeBridge\);/u);
  assert.match(appSource, /const initialSnapshot = await withBootstrapTimeout\(coalescingBridge\.getBootstrapSnapshot\(\)\);[\s\S]*?const initialWorkspace = await withBootstrapTimeout\(coalescingBridge\.getEditorialWorkspace\(\)\);/u);
  assert.match(appSource, /setConnectorState\(fallbackConnectorState\);/u);
  assert.match(
    appSource,
    /void coalescingBridge\.getConnectorState\(\)\.then\(\(initialConnectorState\) => \{/u,
    "connector state must reconcile in the background instead of blocking the first workspace render"
  );
  assert.match(
    appSource,
    /setTimeout\(\(\) => \{[\s\S]*?\}, 750\)/u,
    "a bounded post-Doctor refresh prevents the first visible workspace from retaining a pre-recovery projection"
  );
  assert.match(appSource, /coalescingBridge\.getEditorialWorkspace\(\)/u);
  assert.match(
    appSource,
    /\[settledSnapshot, settledWorkspace\][\s\S]*?\.catch\(\(reason\) => \{/u,
    "post-Doctor reconciliation failures must remain visible instead of silently leaving stale workspace data"
  );
  assert.match(appSource, /Çalışma alanı arka planda yenilenemedi/u);
  assert.match(
    appSource,
    /\.then\(\(\[settledSnapshot, settledWorkspace\][\s\S]*?setSyncError\(""\)/u,
    "a successful post-Doctor reconciliation must clear an earlier transient sync error"
  );
  assert.match(
    appSource,
    /reconciliationTimer = window\.setTimeout\([\s\S]*?window\.clearTimeout\(reconciliationTimer\)/u,
    "post-Doctor reconciliation must cancel its timer when the app unmounts"
  );
  assert.match(
    appSource,
    /setConnectorState\(fallbackConnectorState\);[\s\S]*?if \(!alive\) return;[\s\S]*?if \(initialSnapshot\.runtime === "ONLINE"\)/u,
    "an async bootstrap completion must not schedule new work after the app has unmounted"
  );
});

test("application reads the Doctor snapshot before the first editorial workspace projection", async () => {
  const appSource = await readFile(join(desktopRoot, "src", "App.tsx"), "utf8");

  assert.match(
    appSource,
    /const initialSnapshot = await withBootstrapTimeout\(coalescingBridge\.getBootstrapSnapshot\(\)\);[\s\S]*?const initialWorkspace = await withBootstrapTimeout\(coalescingBridge\.getEditorialWorkspace\(\)\);/u,
    "the workspace must not read the initial offline runtime before Doctor reports the actual engine state"
  );
});

test("native startup projections are asynchronous commands so sidecar I/O cannot hold the WebView thread", async () => {
  const commands = await readFile(join(desktopRoot, "src-tauri", "src", "commands.rs"), "utf8");

  assert.match(commands, /#\[tauri::command\]\s*pub async fn get_bootstrap_snapshot/u);
  assert.match(commands, /#\[tauri::command\]\s*pub async fn get_editorial_workspace/u);
  assert.match(commands, /#\[tauri::command\]\s*pub async fn get_connector_state/u);
});

test("Tauri sync listener is disposed even when dynamic import resolves after unmount", async () => {
  const appSource = await readFile(join(desktopRoot, "src", "App.tsx"), "utf8");

  assert.match(
    appSource,
    /let disposed = false;[\s\S]*?const registerSyncListener = async \(\) => \{[\s\S]*?if \(disposed\) return;[\s\S]*?const cleanup = await listen\([\s\S]*?if \(disposed\) \{[\s\S]*?cleanup\(\);[\s\S]*?return;[\s\S]*?unlisten = cleanup;/u,
    "late listener registration must be cleaned up when the App has already unmounted"
  );
  assert.match(
    appSource,
    /return \(\) => \{\s*disposed = true;\s*unlisten\?\.\(\);\s*\};/u,
    "listener cleanup must mark the effect disposed before invoking the current cleanup"
  );
});

test("operations refresh also waits for Doctor before reading runtime-dependent workspaces", async () => {
  const operationsSource = await readFile(join(desktopRoot, "src", "screens", "OperationsHub.tsx"), "utf8");

  assert.doesNotMatch(
    operationsSource,
    /Promise\.all\(\[\s*props\.bridge\.getBootstrapSnapshot\(\),\s*props\.bridge\.getEditorialWorkspace\(\)/u
  );
  assert.match(
    operationsSource,
    /const snapshot = await props\.bridge\.getBootstrapSnapshot\(\);\s*const \[workspace, connectorState\] = await Promise\.all/u
  );
});
