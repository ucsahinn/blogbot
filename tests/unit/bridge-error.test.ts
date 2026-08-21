import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createInvokeBridge, userFacingBridgeError } from "../../apps/desktop/src/bridge.ts";

const repositoryRoot = join(import.meta.dirname, "..", "..");

function decimalConstant(source: string, pattern: RegExp): number {
  const match = source.match(pattern);
  assert.ok(match, `constant not found for ${pattern}`);
  return Number.parseInt(match[1]!.replaceAll("_", ""), 10);
}

test("native engine module packaging failures name the repair action", () => {
  assert.equal(
    userFacingBridgeError(new Error("ENGINE_NATIVE_MODULES_MISSING")),
    "OPE'nin paketlenmiş yerel engine bileşenleri eksik veya bozuk. Uygulamayı yeniden kurun; sorun sürerse Operasyonlar'dan sır içermeyen tanılama paketi oluşturun."
  );
});

test("unexpected bridge diagnostics never become end-user error text", () => {
  assert.equal(
    userFacingBridgeError(new Error("QA_SENTINEL: SCAN_STATUS_REFRESH_UNAVAILABLE"), "Tarama ayrıntısı alınamadı."),
    "Tarama ayrıntısı alınamadı."
  );
});

test("the bridge request cap never exceeds the engine's NDJSON line cap", async () => {
  const [bridgeSource, engineSource] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "src", "engine_bridge.rs"), "utf8"),
    readFile(join(repositoryRoot, "apps", "engine", "src", "stdio-entrypoint.ts"), "utf8")
  ]);

  const requestCap = decimalConstant(bridgeSource, /const MAX_REQUEST_BYTES: usize = ([0-9_]+);/u);
  const lineCap = decimalConstant(engineSource, /const MAX_LINE_BYTES = ([0-9_]+);/u);

  assert.equal(
    requestCap,
    lineCap,
    "a request the bridge accepts but the engine drops would be answered against an unreadable id"
  );
});

test("quitting the desktop stops the processes it owns instead of orphaning them", async () => {
  const [nativeSource, traySource] = await Promise.all([
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(join(repositoryRoot, "apps", "desktop", "src-tauri", "src", "tray.rs"), "utf8")
  ]);

  // app.exit ends the event loop without unwinding, so the teardown has to be
  // explicit on the run-event path and on the tray's own quit item.
  assert.match(nativeSource, /RunEvent::Exit[\s\S]{0,120}shutdown_owned_processes\(app\)/u);
  assert.match(nativeSource, /fn shutdown_owned_processes[\s\S]{0,600}stop_local_dev/u);
  assert.match(nativeSource, /fn shutdown_owned_processes[\s\S]{0,600}bridge\.stop\(\)/u);
  assert.match(traySource, /"quit" =>[\s\S]{0,400}shutdown_owned_processes\(app\)[\s\S]{0,120}app\.exit\(0\)/u);
});

test("project page uses the native external-browser command", async () => {
  const calls: string[] = [];
  const bridge = createInvokeBridge(async (command) => {
    calls.push(command);
    return { opened: true };
  });

  await bridge.openProjectPage();

  assert.deepEqual(calls, ["open_project_page"]);
});
