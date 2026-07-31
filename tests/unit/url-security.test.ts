import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeSourceUrl,
  validateResolvedAddresses
} from "../../packages/security/src/url-policy.ts";

test("accepts public HTTPS source URLs", () => {
  assert.equal(assertSafeSourceUrl("https://www.cisa.gov/news-events"), "https://www.cisa.gov/news-events");
});

test("rejects public HTTP source URLs", () => {
  assert.throws(() => assertSafeSourceUrl("http://example.com/feed"), /HTTPS/);
});

for (const unsafeUrl of [
  "http://localhost/admin",
  "http://127.0.0.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://169.254.169.254/latest/meta-data/",
  "ftp://example.com/file",
  "https://user:pass@example.com/"
]) {
  test(`rejects unsafe source URL ${unsafeUrl}`, () => {
    assert.throws(() => assertSafeSourceUrl(unsafeUrl));
  });
}

test("rejects a DNS answer set if any address reaches a private network", () => {
  assert.throws(() => validateResolvedAddresses(["93.184.216.34", "10.0.0.4"]));
  assert.deepEqual(validateResolvedAddresses(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]), [
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946"
  ]);
});
