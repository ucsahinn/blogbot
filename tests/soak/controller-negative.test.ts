import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const fault of ["prepare-network", "exit-before-close", "cleanup-failure", "spawn-error"]) {
  test(`soak controller rejects ${fault} without durable PASS`, { timeout: 100_000 }, async () => {
    const child = spawn(process.execPath,
      ["--experimental-transform-types", fileURLToPath(new URL("local-engine-24h.test.ts", import.meta.url))],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        // A fresh runner must not inherit NODE_TEST_CONTEXT or account state.
        env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: tmpdir(), TMP: tmpdir(),
          BLOGBOT_SOAK_MODE: "preflight", BLOGBOT_SOAK_FAULT: fault } });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, fault === "spawn-error" ? 8_000 : 90_000);
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("exit", accept);
      child.once("error", reject);
    }).finally(() => clearTimeout(timer));
    const announcement = output.split(/\r?\n/u).map((line) => {
      try { return JSON.parse(line.replace(/^# /u, "")) as { evidenceDirectory?: string }; } catch { return {}; }
    }).find((entry) => typeof entry.evidenceDirectory === "string");
    assert.ok(announcement?.evidenceDirectory, `missing evidence announcement: ${output.slice(-500)}`);
    const evidencePath = resolve(announcement.evidenceDirectory, "evidence.ndjson");
    assert.ok(evidencePath.startsWith(resolve(root, "build", "verification", "local-engine-soak") + "\\"));
    const entries = (await readFile(evidencePath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { status?: string; fixtureRootName?: string; code?: string });
    // Before the startup fix, spawn-error deadlocks without creating a child.
    // Clean only that exact fixture root after terminating our controller.
    if (timedOut && fault === "spawn-error") {
      const name = entries[0]?.fixtureRootName;
      assert.ok(name && /^blogbot-engine-soak-[A-Za-z0-9]+$/u.test(name));
      const fixture = resolve(tmpdir(), name);
      assert.equal(dirname(fixture), resolve(tmpdir()));
      assert.equal(basename(fixture), name);
      assert.equal((await lstat(fixture)).isSymbolicLink(), false);
      assert.deepEqual(await readdir(fixture), [], "failed spawn must leave an empty owned root");
      await rm(fixture, { recursive: true });
    }
    assert.equal(timedOut, false, "controller must terminate within its short failure budget");
    assert.notEqual(code, 0, "a failed controller must not report a successful test");
    assert.equal(entries.at(-1)?.status, "FAILED", "durable evidence must end in FAILED");
    const expected = { "prepare-network": "SOAK_NETWORK_ATTEMPT", "exit-before-close": "SOAK_CHILD_EXIT_BEFORE_CLOSE",
      "cleanup-failure": "SOAK_INJECTED_CLEANUP_FAILURE", "spawn-error": "ENOENT" }[fault];
    assert.ok(expected && entries.at(-1)?.code?.includes(expected), "an unrelated failure cannot satisfy this regression");
    assert.ok(!entries.some((entry) => entry.status?.startsWith("PASS")), "failed runs must not persist PASS");
  });
}
