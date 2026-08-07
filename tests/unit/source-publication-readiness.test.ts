import assert from "node:assert/strict";
import test from "node:test";

import { describeSourcePublicationReadiness } from "../../apps/desktop/src/source-publication-readiness.ts";

test("pending source reviews make the one required evidence decision clear without implying publication", () => {
  const result = describeSourcePublicationReadiness({
    canPublish: false,
    trustStatus: "PENDING",
    rightsStatus: "PENDING"
  });

  assert.equal(result.label, "Araştırma kullanımı için karar bekliyor");
  assert.match(result.detail, /Kaynak taranabilir/u);
  assert.match(result.detail, /Araştırmada kanıt olarak kullan/u);
  assert.match(result.detail, /tek insan kararı/u);
  assert.match(result.detail, /makale\/yayın onayı değildir/u);
  assert.match(result.detail, /kullanım hakkı/iu);
});

test("approved source reviews report evidence readiness without implying publication happened", () => {
  const result = describeSourcePublicationReadiness({
    canPublish: true,
    trustStatus: "APPROVED",
    rightsStatus: "APPROVED"
  });

  assert.equal(result.label, "Kanıt olarak kullanıma hazır");
  assert.match(result.detail, /Editoryal Masa > TR \/ EN inceleme/u);
});

test("rejected source reviews say the source cannot be used as publication evidence", () => {
  const result = describeSourcePublicationReadiness({
    canPublish: false,
    trustStatus: "REJECTED",
    rightsStatus: "APPROVED"
  });

  assert.equal(result.label, "Kanıt olarak kullanılamaz");
  assert.match(result.detail, /reddedildi/u);
});
