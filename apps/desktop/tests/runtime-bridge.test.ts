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
  assert.match(appSource, /getConnectorState\(\)\.catch\(\(reason\)[\s\S]*?fallbackConnectorState/u);
});

test("application bootstrap loads the editorial workspace only after Doctor can set the runtime mode", async () => {
  const appSource = await readFile(join(desktopRoot, "src", "App.tsx"), "utf8");

  assert.match(appSource, /const coalescingBridge = createCoalescingBridge\(runtimeBridge\);/u);
  assert.match(appSource, /const initialSnapshot = await coalescingBridge\.getBootstrapSnapshot\(\);/u);
  assert.match(
    appSource,
    /const \[initialWorkspace, initialConnectorState\] = await Promise\.all\(\[[\s\S]*?coalescingBridge\.getEditorialWorkspace\(\),[\s\S]*?coalescingBridge\.getConnectorState\(\)/u
  );
  assert.match(
    appSource,
    /setTimeout\(\(\) => \{[\s\S]*?\}, 750\)/u,
    "a bounded post-Doctor refresh prevents the first visible workspace from retaining a pre-recovery projection"
  );
  assert.match(appSource, /coalescingBridge\.getEditorialWorkspace\(\)/u);
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
