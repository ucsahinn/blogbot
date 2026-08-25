import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, addresses: ["203.0.113.8"] }) + "\\n");
      process.exit(0);
    }
  `, "utf8");
  let spawnCount = 0;
  const transport = createFetcherSidecarTransport(process.execPath, { args: [fixture], onSpawn: () => { spawnCount += 1; } });
  try {
    assert.deepEqual(await transport.resolve("one.example"), ["203.0.113.8"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await transport.resolve("two.example"), ["203.0.113.8"]);
    assert.equal(spawnCount, 2);
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});
