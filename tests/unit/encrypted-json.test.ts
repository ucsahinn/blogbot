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

test("legacy plaintext is only accepted when it matches the expected record", () => {
  const protector = new JsonProtector(key);

  assert.deepEqual(
    protector.openLegacy<{ id: string }>({ id: "record-a" }, (candidate) =>
      typeof candidate === "object" && candidate !== null && (candidate as { id?: unknown }).id === "record-a"),
    { id: "record-a" }
  );
  assert.throws(
    () => protector.openLegacy({ id: "injected" }, (candidate) =>
      typeof candidate === "object" && candidate !== null && (candidate as { id?: unknown }).id === "record-a"),
    /LOCAL_DATA_LEGACY_UNVERIFIABLE/
  );
});

test("a v2 envelope is never resealed through the legacy path", () => {
  const protector = new JsonProtector(key);
  const envelope = protector.seal({ id: "record-a" }, context);

  assert.throws(
    () => protector.openLegacy(envelope, () => true),
    /LOCAL_DATA_LEGACY_UNVERIFIABLE/
  );
});

test("a row sealed under another data key reports a key mismatch, not tampering", () => {
  const envelope = new JsonProtector(key).seal({ id: "record-a" }, context);
  const otherKey = Buffer.from(
    "1f2e3d4c5b6a798807162534435261708f9eadbccbdae9f80f1e2d3c4b5a6978",
    "hex"
  );

  assert.throws(
    () => new JsonProtector(otherKey).open(envelope, context),
    /LOCAL_DATA_KEY_MISMATCH/
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
