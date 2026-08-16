import assert from "node:assert/strict";
import test from "node:test";

import { createInvokeBridge, userFacingBridgeError } from "../../apps/desktop/src/bridge.ts";

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

test("project page uses the native external-browser command", async () => {
  const calls: string[] = [];
  const bridge = createInvokeBridge(async (command) => {
    calls.push(command);
    return { opened: true };
  });

  await bridge.openProjectPage();

  assert.deepEqual(calls, ["open_project_page"]);
});
