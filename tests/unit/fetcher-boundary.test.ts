import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_FETCH_RESPONSE_BYTES,
  MAX_FETCH_TIMEOUT_MS,
  fetchSource,
  type FetchRequestPlan
} from "../../apps/fetcher/src/fetch-source.ts";
import * as fetcherSea from "../../apps/fetcher/src/sea-entrypoint.ts";
import { validateFetchRequestPlan } from "../../apps/fetcher/src/sea-entrypoint.ts";

const validPlan = {
  url: "https://example.com/feed.xml",
  approvedAddresses: ["93.184.216.34"],
  redirect: "manual" as const,
  timeoutMs: 8_000,
  deadlineAtMs: Date.now() + 8_000,
  maxResponseBytes: 2_000_000
};

test("fetcher SEA accepts only bounded complete request plans", () => {
  assert.equal(validateFetchRequestPlan(validPlan), true);
  for (const invalidShape of [null, [], "not-a-plan"]) {
    assert.equal(validateFetchRequestPlan(invalidShape), false);
  }
  for (const patch of [
    { timeoutMs: undefined },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { timeoutMs: MAX_FETCH_TIMEOUT_MS + 1 },
    { maxResponseBytes: undefined },
    { maxResponseBytes: 0 },
    { maxResponseBytes: -1 },
    { maxResponseBytes: Number.NaN },
    { maxResponseBytes: MAX_FETCH_RESPONSE_BYTES + 1 },
    { redirect: "follow" },
    { deadlineAtMs: Number.NaN },
    { deadlineAtMs: Date.now() + MAX_FETCH_TIMEOUT_MS + 5_000 }
  ]) {
    assert.equal(validateFetchRequestPlan({ ...validPlan, ...patch }), false, JSON.stringify(patch));
  }
});

test("fetcher SEA rejects unsafe URLs and resolved addresses before transport", () => {
  for (const plan of [
    { ...validPlan, url: "http://example.com/feed.xml" },
    { ...validPlan, url: "https://localhost/feed.xml" },
    { ...validPlan, url: "https://metadata.google.internal/latest" },
    { ...validPlan, approvedAddresses: ["127.0.0.1"] },
    { ...validPlan, approvedAddresses: ["10.0.0.1"] },
    { ...validPlan, approvedAddresses: ["169.254.169.254"] },
    { ...validPlan, approvedAddresses: ["192.168.1.1"] },
    { ...validPlan, approvedAddresses: ["240.0.0.1"] },
    { ...validPlan, approvedAddresses: ["::1"] },
    { ...validPlan, approvedAddresses: ["2002:a9fe:a9fe::"] }
  ]) {
    assert.equal(validateFetchRequestPlan(plan), false, JSON.stringify(plan));
  }
});

test("fetcher SEA passes only normalized URLs and deduplicated public addresses to transport", async () => {
  const handle = (fetcherSea as typeof fetcherSea & {
    handleFetcherRequestLine?: (
      line: string,
      transport: {
        resolve(hostname: string): Promise<string[]>;
        request(plan: FetchRequestPlan): Promise<{
          status: number;
          headers: Record<string, string | undefined>;
          body: Uint8Array;
        }>;
      }
    ) => Promise<Record<string, unknown>>;
  }).handleFetcherRequestLine;
  assert.equal(typeof handle, "function");

  let capturedPlan: FetchRequestPlan | undefined;
  const response = await handle!(JSON.stringify({
    id: "request-normalization",
    kind: "request",
    plan: {
      ...validPlan,
      url: "https://EXAMPLE.com./feed.xml#ignored",
      approvedAddresses: ["93.184.216.34", "93.184.216.34"]
    }
  }), {
    async resolve() {
      throw new Error("request path must not resolve again");
    },
    async request(plan) {
      capturedPlan = plan;
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
  });

  assert.equal(response.ok, true);
  assert.equal(capturedPlan?.url, "https://example.com/feed.xml");
  assert.deepEqual(capturedPlan?.approvedAddresses, ["93.184.216.34"]);
});

test("fetcher SEA resolve handler normalizes hostnames and rejects unsafe DNS results", async () => {
  const resolvedHostnames: string[] = [];
  const transport = {
    async resolve(hostname: string) {
      resolvedHostnames.push(hostname);
      return ["93.184.216.34", "93.184.216.34"];
    },
    async request() {
      throw new Error("resolve path must not request content");
    }
  };

  const safeResponse = await fetcherSea.handleFetcherRequestLine(JSON.stringify({
    id: "safe-resolve",
    kind: "resolve",
    hostname: "EXAMPLE.com."
  }), transport);
  assert.equal(safeResponse.ok, true);
  assert.deepEqual(safeResponse.addresses, ["93.184.216.34"]);
  assert.deepEqual(resolvedHostnames, ["example.com"]);

  const unsafeHostnameResponse = await fetcherSea.handleFetcherRequestLine(JSON.stringify({
    id: "unsafe-hostname",
    kind: "resolve",
    hostname: "metadata.google.internal"
  }), transport);
  assert.equal(unsafeHostnameResponse.ok, false);
  assert.deepEqual(resolvedHostnames, ["example.com"]);

  const unsafeAddressResponse = await fetcherSea.handleFetcherRequestLine(JSON.stringify({
    id: "unsafe-address",
    kind: "resolve",
    hostname: "example.com"
  }), {
    ...transport,
    async resolve() {
      return ["169.254.169.254"];
    }
  });
  assert.equal(unsafeAddressResponse.ok, false);
});

test("fetchSource rejects unsafe caller budgets before DNS or transport access", async () => {
  let calls = 0;
  const transport = {
    async resolve() { calls += 1; return ["93.184.216.34"]; },
    async request() { calls += 1; throw new Error("must not reach transport"); }
  };
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: MAX_FETCH_TIMEOUT_MS + 1 },
    { maxBytes: 0 },
    { maxBytes: MAX_FETCH_RESPONSE_BYTES + 1 }
  ]) {
    await assert.rejects(fetchSource("https://example.com/feed.xml", transport, options), /bound|timeout|max/i);
  }
  assert.equal(calls, 0);
});
