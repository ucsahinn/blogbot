import assert from "node:assert/strict";
import test from "node:test";

import { JsonProtector } from "../../packages/database/src/encrypted-json.ts";

const key = Buffer.from(
  "8e51c4f05c864820531146e549d2c2e1f865d5e639ccf0cff8d496c214b2387c",
  "hex"
);
const context = {
  table: "unit_records",
  key: "record-a",
  field: "value"
};

test("AES-256-GCM JSON envelopes hide plaintext and round-trip", () => {
  const protector = new JsonProtector(key);
  const value = {
    title: "BLOGBOT-SENSITIVE-CANARY",
    claims: [{ text: "private evidence" }]
  };
  const envelope = protector.seal(value, context);

  assert.equal(envelope.alg, "A256GCM");
  assert.doesNotMatch(JSON.stringify(envelope), /BLOGBOT-SENSITIVE-CANARY/);
  assert.deepEqual(protector.open(envelope, context), value);
});

test("AES-256-GCM envelope tampering fails closed", () => {
  const protector = new JsonProtector(key);
  const envelope = protector.seal({ value: "protected" }, context);
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;

  assert.throws(
    () => protector.open(envelope, context),
    /LOCAL_DATA_DECRYPT_FAILED/
  );
});

test("AES-256-GCM envelope is bound to its record identity", () => {
  const protector = new JsonProtector(key);
  const envelope = protector.seal({ id: "record-a" }, context);

  assert.throws(
    () => protector.open(envelope, { ...context, key: "record-b" }),
    /LOCAL_DATA_DECRYPT_FAILED/
  );
});
