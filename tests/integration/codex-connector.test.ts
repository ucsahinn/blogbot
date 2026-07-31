import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexConnectorConfigError,
  createCodexConnectorPort,
  type CodexConnectorEvent
} from "../../apps/codex-runner/src/connector.ts";

test("dry-run connector reports ready without spawning or requiring credentials", async () => {
  let spawned = false;
  const connector = createCodexConnectorPort(
    {
      command: "codex",
      codexHome: "C:\\temp\\codex-home",
      timeoutMs: 10_000,
      dryRun: true
    },
    { onSpawn: () => { spawned = true; } }
  );

  assert.deepEqual(connector.status(), { state: "READY", mode: "DRY_RUN" });
  assert.deepEqual(connector.dryRun(), { ok: true, writes: false, network: false });
  const events = [] as unknown[];
  for await (const event of connector.run({ model: "gpt-5.6-terra", input: {}, outputSchema: {} })) {
    events.push(event);
  }
  assert.deepEqual(events, [{ type: "output.completed", output: { dryRun: true } }]);
  assert.equal(spawned, false);
});

test("connector transitions to typed login and limit states from runner events", () => {
  const connector = createCodexConnectorPort({ command: "codex", codexHome: "C:\\temp\\codex-home", timeoutMs: 1_000 });
  const cases: Array<[CodexConnectorEvent, unknown]> = [
    [{ type: "auth.required" }, { state: "LOGIN_REQUIRED", reason: "AUTH_REQUIRED" }],
    [{ type: "rate_limit.reached" }, { state: "RATE_LIMITED", reason: "RATE_LIMIT" }],
    [{ type: "usage_limit.reached" }, { state: "USAGE_LIMITED", reason: "USAGE_LIMIT" }]
  ];
  for (const [event, expected] of cases) assert.deepEqual(connector.observe(event), expected);
});

test("connector config rejects credential-shaped fields", () => {
  assert.throws(
    () => createCodexConnectorPort({ command: "codex", codexHome: "C:\\temp", timeoutMs: 1_000, token: "secret" } as never),
    (error: unknown) => error instanceof CodexConnectorConfigError && error.code === "CREDENTIALS_NOT_ALLOWED"
  );
});

test("connector config rejects credential-bearing CLI prefix arguments", () => {
  assert.throws(
    () => createCodexConnectorPort({
      command: "codex",
      codexHome: "C:\\temp",
      timeoutMs: 1_000,
      commandPrefixArgs: ["--api-key", "not-a-real-secret"]
    }),
    (error: unknown) => error instanceof CodexConnectorConfigError && error.code === "CREDENTIALS_NOT_ALLOWED"
  );
});
