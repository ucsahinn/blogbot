import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFetcherSidecarTransport } from "../../apps/engine/src/fetcher-sidecar-transport.ts";

test("fetcher transport reuses one isolated sidecar across requests", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-fetcher-persistent-"));
  const fixture = join(root, "fixture.mjs");
  await writeFile(fixture, `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, addresses: ["203.0.113.7"] }) + "\\n");
    }
  `, "utf8");

  let spawnCount = 0;
  const transport = createFetcherSidecarTransport(process.execPath, {
    args: [fixture],
    onSpawn: () => { spawnCount += 1; }
  });
  try {
    const [first, second] = await Promise.all([
      transport.resolve("one.example"),
      transport.resolve("two.example")
    ]);
    assert.deepEqual(first, ["203.0.113.7"]);
    assert.deepEqual(second, ["203.0.113.7"]);
    assert.equal(spawnCount, 1);
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fetcher transport respawns only after an unexpected sidecar exit", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-fetcher-respawn-"));
  const fixture = join(root, "fixture.mjs");
  await writeFile(fixture, `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      process.stdout.write(
        JSON.stringify({ id: request.id, ok: true, addresses: ["203.0.113.8"] }) + "\\n",
        () => process.exit(0)
      );
    }
  `, "utf8");
  let spawnCount = 0;
  const transport = createFetcherSidecarTransport(process.execPath, { args: [fixture], onSpawn: () => { spawnCount += 1; } });
  try {
    assert.deepEqual(await transport.resolve("one.example"), ["203.0.113.8"]);
    assert.deepEqual(await transport.resolve("two.example"), ["203.0.113.8"]);
    assert.equal(spawnCount, 2);
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fetcher transport never replays an ambiguously dispatched HTTP request", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "blogbot-fetcher-no-replay-"));
  const fixture = join(root, "fixture.mjs");
  const counter = join(root, "requests.txt");
  await writeFile(fixture, `
    import { appendFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const counter = process.argv[2];
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      JSON.parse(line);
      appendFileSync(counter, "request\\n", "utf8");
      process.exit(0);
    }
  `, "utf8");

  let spawnCount = 0;
  const transport = createFetcherSidecarTransport(process.execPath, {
    args: [fixture, counter],
    onSpawn: () => { spawnCount += 1; }
  });
  const plan = () => ({
    url: "https://example.com/feed.xml",
    approvedAddresses: ["93.184.216.34"],
    redirect: "manual" as const,
    timeoutMs: 5_000,
    deadlineAtMs: Date.now() + 5_000,
    maxResponseBytes: 1_024
  });

  try {
    await assert.rejects(transport.request(plan()), { name: "FetchBoundaryError" });
    assert.equal(await readFile(counter, "utf8"), "request\n");
    assert.equal(spawnCount, 1);

    await assert.rejects(transport.request(plan()), { name: "FetchBoundaryError" });
    assert.equal(await readFile(counter, "utf8"), "request\nrequest\n");
    assert.equal(spawnCount, 2);
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});
