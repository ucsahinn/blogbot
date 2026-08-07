import assert from "node:assert/strict";
import test from "node:test";

import { userFacingPublicationQueueError } from "../../apps/desktop/src/bridge.ts";

test("publication queue hides unexpected native diagnostics from end users", () => {
  assert.equal(
    userFacingPublicationQueueError(new Error("QA_SENTINEL: PREVIEW_IO_FAILED")),
    "Yayın kuyruğuna alım tamamlanamadı. Yayın önizlemesini yeniden hazırlayın; sorun sürerse Operasyonlar’dan tanılama paketi oluşturun."
  );
});

test("publication queue keeps the explicit safe GitHub broker explanation", () => {
  assert.equal(
    userFacingPublicationQueueError(new Error("GITHUB_CREDENTIAL_BROKER_UNAVAILABLE")),
    "GitHub yayını güvenli depo yetkilendirmesi hazır olmadığı için kapalı. Yerel çıktı kullanın veya güvenli yayın aracısının bulunduğu sürümü bekleyin."
  );
});
