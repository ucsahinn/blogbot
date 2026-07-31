import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { createInvokeBridge } from "../../apps/desktop/src/bridge.ts";
import { createDemoTransport } from "../../apps/desktop/src/demo-data.ts";
import { runDesktopPreflight } from "../../scripts/desktop-preflight.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("prerequisite wizard snapshot is unique, actionable, and scope-aware", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const snapshot = await bridge.getPrerequisiteStatus();
  const ids = snapshot.checks.map((check) => check.id);

  assert.ok(snapshot.checkedAtUnixMs > 0);
  assert.equal(new Set(ids).size, ids.length, "wizard rows must not duplicate checks");
  assert.ok(ids.includes("local-engine"));
  assert.ok(ids.includes("local-database"));
  assert.ok(ids.includes("local-queue"));

  for (const check of snapshot.checks) {
    assert.ok(["APP", "WRITE", "PUBLISH"].includes(check.scope));
    if (["MISSING", "BLOCKED", "ATTENTION"].includes(check.state)) {
      assert.ok(check.userAction, `${check.id} needs a user-facing recovery action`);
    }
  }
});

test("operation log entries retain correlation and human-readable diagnostics", async () => {
  const bridge = createInvokeBridge(createDemoTransport());
  const snapshot = await bridge.getOperations();
  const ids = snapshot.events.map((event) => event.id);
  const correlations = snapshot.events.map((event) => event.correlationId);

  assert.ok(snapshot.events.length > 0);
  assert.equal(new Set(ids).size, ids.length, "operation ids must be unique");
  assert.equal(new Set(correlations).size, correlations.length, "correlation ids must be unique");
  for (const event of snapshot.events) {
    assert.ok(event.at.trim());
    assert.ok(event.title.trim());
    assert.ok(event.detail.trim());
    assert.ok(event.correlationId.trim());
    assert.ok(["SUCCESS", "RUNNING", "WAITING", "BLOCKED"].includes(event.state));
  }
});

test("Windows bundle manifest includes the sidecar, local PGlite assets, and WebView2 bootstrapper", async () => {
  const config = JSON.parse(
    await readFile(
      join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"),
      "utf8"
    )
  ) as {
    bundle?: {
      active?: boolean;
      targets?: string[];
      externalBin?: string[];
      resources?: string[];
      windows?: { webviewInstallMode?: { type?: string } };
    };
  };
  const bundle = config.bundle;

  assert.equal(bundle?.active, true);
  assert.deepEqual(new Set(bundle?.targets), new Set(["msi", "nsis"]));
  assert.ok(bundle?.externalBin?.includes("binaries/blogbot-engine"));
  assert.ok(bundle?.resources?.includes("resources/pglite/*"));
  assert.equal(bundle?.windows?.webviewInstallMode?.type, "embedBootstrapper");
});

test("sidecar doctor smoke contract checks durable local readiness", async () => {
  const smokeScript = await readFile(
    join(repositoryRoot, "scripts", "smoke-engine-sidecar.mjs"),
    "utf8"
  );

  assert.match(smokeScript, /kind:\s*["']doctor["']/u);
  assert.match(smokeScript, /response\.status\s*!==\s*["']READY["']/u);
  assert.match(smokeScript, /response\.persistence\s*!==\s*["']pglite["']/u);
  assert.match(smokeScript, /response\.queue\s*!==\s*["']ready["']/u);
});

test("desktop preflight verifies clean-machine installer inputs without building an installer", async () => {
  const result = await runDesktopPreflight();
  assert.equal(result.ok, true, result.checks.filter((check) => check.status === "FAIL").map((check) => check.detail).join("; "));
  assert.ok(result.checks.some((check) => check.id === "webview2-bootstrapper"));
  assert.ok(result.checks.some((check) => check.id === "clean-machine-runtime"));
  assert.ok(result.checks.some((check) => check.id === "gui-smoke-contract"));
  assert.ok(result.checks.some((check) => check.id === "bundled-engine-sidecar"));
});
