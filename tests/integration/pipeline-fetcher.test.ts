import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  FetchBoundaryError,
  fetchSource,
  type FetchTransport
} from "../../apps/fetcher/src/fetch-source.ts";
import { createNodeFetchTransport } from "../../apps/fetcher/src/node-transport.ts";

const encoder = new TextEncoder();

test("pins each request to the public DNS answers validated for that redirect hop", async () => {
  const requests: Parameters<FetchTransport["request"]>[0][] = [];
  const result = await fetchSource(
    "https://feed.example/start",
    {
      resolve: async (hostname) => {
        if (hostname === "feed.example") return ["93.184.216.34"];
        if (hostname === "news.example") return ["151.101.1.69", "2a04:4e42::325"];
        throw new Error(`unexpected hostname: ${hostname}`);
      },
      request: async (plan) => {
        requests.push(plan);
        if (plan.url === "https://feed.example/start") {
          return {
            status: 302,
            headers: { location: "https://news.example/article" },
            body: new Uint8Array()
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: encoder.encode("<main>original reporting</main>")
        };
      }
    },
    { timeoutMs: 5_000, maxBytes: 64_000 }
  );

  assert.deepEqual(
    requests.map(({ url, approvedAddresses, redirect, timeoutMs, maxResponseBytes }) => ({
      url,
      approvedAddresses,
      redirect,
      timeoutMs,
      maxResponseBytes
    })),
    [
      {
        url: "https://feed.example/start",
        approvedAddresses: ["93.184.216.34"],
        redirect: "manual",
        timeoutMs: 5_000,
        maxResponseBytes: 64_000
      },
      {
        url: "https://news.example/article",
        approvedAddresses: ["151.101.1.69", "2a04:4e42::325"],
        redirect: "manual",
        timeoutMs: 5_000,
        maxResponseBytes: 64_000
      }
    ]
  );
  assert.equal(requests[0]?.deadlineAtMs, requests[1]?.deadlineAtMs, "redirects share one source-fetch deadline");
  assert.equal(result.finalUrl, "https://news.example/article");
  assert.equal(result.contentType, "text/html");
  assert.equal(new TextDecoder().decode(result.body), "<main>original reporting</main>");
});

test("rejects a redirect whose fresh DNS answer reaches a private address before transport", async () => {
  let requestCount = 0;

  await assert.rejects(
    fetchSource("https://feed.example/start", {
      resolve: async (hostname) =>
        hostname === "feed.example" ? ["93.184.216.34"] : ["10.77.0.1"],
      request: async () => {
        requestCount += 1;
        return {
          status: 302,
          headers: { location: "https://rebind.example/internal" },
          body: new Uint8Array()
        };
      }
    }),
    /DNS answer contains a forbidden address/
  );
  assert.equal(requestCount, 1);
});

test("rejects unsupported response media before accepting source bytes", async () => {
  await assert.rejects(
    fetchSource("https://feed.example/file", {
      resolve: async () => ["93.184.216.34"],
      request: async () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: encoder.encode("binary")
      })
    }),
    (error: unknown) =>
      error instanceof FetchBoundaryError && error.code === "UNSUPPORTED_CONTENT_TYPE"
  );
});

test("rejects a response even if a transport returns more than the byte boundary", async () => {
  await assert.rejects(
    fetchSource(
      "https://feed.example/large",
      {
        resolve: async () => ["93.184.216.34"],
        request: async () => ({
          status: 200,
          headers: { "content-type": "application/rss+xml" },
          body: encoder.encode("12345")
        })
      },
      { maxBytes: 4 }
    ),
    (error: unknown) =>
      error instanceof FetchBoundaryError && error.code === "RESPONSE_TOO_LARGE"
  );
});

test("surfaces a bounded transport timeout without retrying the same hop", async () => {
  let attempts = 0;
  await assert.rejects(
    fetchSource(
      "https://feed.example/slow",
      {
        resolve: async () => ["93.184.216.34"],
        request: async (plan) => {
          attempts += 1;
          assert.equal(plan.timeoutMs, 250);
          throw new FetchBoundaryError("TIMEOUT", "source request timed out");
        }
      },
      { timeoutMs: 250 }
    ),
    (error: unknown) =>
      error instanceof FetchBoundaryError && error.code === "TIMEOUT"
  );
  assert.equal(attempts, 1);
});

test("node transport connects only to an approved address while preserving the source host", async (t) => {
  let receivedHost = "";
  const server = createServer((request, response) => {
    receivedHost = request.headers.host ?? "";
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("bounded response");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const transport = createNodeFetchTransport();
  const response = await transport.request({
    url: `http://source.example:${address.port}/feed`,
    approvedAddresses: ["127.0.0.1"],
    redirect: "manual",
    timeoutMs: 1_000,
    maxResponseBytes: 1_024
  });

  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(response.body), "bounded response");
  assert.equal(receivedHost, `source.example:${address.port}`);
});

test("node transport aborts an oversized body before returning it", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("12345");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await assert.rejects(
    createNodeFetchTransport().request({
      url: `http://source.example:${address.port}/feed`,
      approvedAddresses: ["127.0.0.1"],
      redirect: "manual",
      timeoutMs: 1_000,
      maxResponseBytes: 4
    }),
    (error: unknown) =>
      error instanceof FetchBoundaryError &&
      error.code === "RESPONSE_TOO_LARGE"
  );
});

test("node transport rejects compressed responses to keep decompression outside the trust boundary", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-encoding": "gzip"
    });
    response.end("compressed bytes");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await assert.rejects(
    createNodeFetchTransport().request({
      url: `http://source.example:${address.port}/feed`,
      approvedAddresses: ["127.0.0.1"],
      redirect: "manual",
      timeoutMs: 1_000,
      maxResponseBytes: 1_024
    }),
    (error: unknown) =>
      error instanceof FetchBoundaryError &&
      error.code === "UNSUPPORTED_CONTENT_ENCODING"
  );
});

test("node transport enforces the request timeout against a connected slow server", async (t) => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late"), 250);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await assert.rejects(
    createNodeFetchTransport().request({
      url: `http://source.example:${address.port}/feed`,
      approvedAddresses: ["127.0.0.1"],
      redirect: "manual",
      timeoutMs: 50,
      maxResponseBytes: 1_024
    }),
    (error: unknown) =>
      error instanceof FetchBoundaryError && error.code === "TIMEOUT"
  );
});
