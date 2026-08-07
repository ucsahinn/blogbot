import assert from "node:assert/strict";
import test from "node:test";

import { userFacingBridgeError } from "../../apps/desktop/src/bridge.ts";

test("native engine module packaging failures name the repair action", () => {
  assert.equal(
    userFacingBridgeError(new Error("ENGINE_NATIVE_MODULES_MISSING")),
    "Blogbot'un paketlenmiş yerel engine bileşenleri eksik veya bozuk. Uygulamayı yeniden kurun; sorun sürerse Operasyonlar'dan sır içermeyen tanılama paketi oluşturun."
  );
});

test("unexpected bridge diagnostics never become end-user error text", () => {
  assert.equal(
    userFacingBridgeError(new Error("QA_SENTINEL: SCAN_STATUS_REFRESH_UNAVAILABLE"), "Tarama ayrıntısı alınamadı."),
    "Tarama ayrıntısı alınamadı."
  );
});
