import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  resolveCodexRole,
  type CodexTaskKind
} from "../../apps/codex-runner/src/role-policy.ts";
import {
  buildCodexExecArgs,
  CodexRunnerError,
  PAID_API_FALLBACK_ENABLED,
  runStructuredCodexTask
} from "../../apps/codex-runner/src/structured-runner.ts";
import {
  createCodexCliPort,
  type CodexCliSpawnObservation
} from "../../apps/codex-runner/src/cli-port.ts";
import { createMockStructuredCodexPort } from "../../apps/codex-runner/src/mock-port.ts";

const expectedRoles: ReadonlyArray<
  readonly [CodexTaskKind, "FAST" | "DEFAULT" | "DEEP_REVIEW", string]
> = [
  ["CLASSIFY", "FAST", "gpt-5.6-luna"],
  ["DEDUPE", "FAST", "gpt-5.6-luna"],
  ["RESEARCH", "DEFAULT", "gpt-5.6-terra"],
  ["WRITE_TR", "DEFAULT", "gpt-5.6-terra"],
  ["LOCALIZE_EN", "DEFAULT", "gpt-5.6-terra"],
  ["CHECK_CONTRADICTIONS", "DEEP_REVIEW", "gpt-5.6-sol"],
  ["FINAL_QUALITY", "DEEP_REVIEW", "gpt-5.6-sol"]
];

for (const [taskKind, expectedRole, expectedModel] of expectedRoles) {
  test(`routes ${taskKind} through the ${expectedRole} logical role`, () => {
    assert.deepEqual(resolveCodexRole(taskKind), {
      role: expectedRole,
      model: expectedModel
    });
  });
}

test("builds a private-runner command that ignores personal config and allows no writes", () => {
  assert.deepEqual(
    buildCodexExecArgs("gpt-5.6-terra", "C:\\job\\output.schema.json"),
    [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      "C:\\job\\output.schema.json",
      "--model",
      "gpt-5.6-terra",
      "-"
    ]
  );
});

test("returns only validator-approved structured output from the selected role", async () => {
  const result = await runStructuredCodexTask(
    {
      taskKind: "WRITE_TR",
      input: { evidence: ["source-1"] },
      outputSchema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
        additionalProperties: false
      },
      validateOutput: (value): value is { title: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { title?: unknown }).title === "string"
    },
    createMockStructuredCodexPort([
      { type: "turn.started" },
      { type: "output.completed", output: { title: "Özgün güvenlik analizi" } },
      { type: "turn.completed" }
    ])
  );

  assert.deepEqual(result, {
    status: "COMPLETED",
    role: "DEFAULT",
    model: "gpt-5.6-terra",
    output: { title: "Özgün güvenlik analizi" }
  });
});

test("accepts schema-bound JSON from the real Codex agent_message event shape", async () => {
  const result = await runStructuredCodexTask(
    {
      taskKind: "CLASSIFY",
      input: { title: "Güvenlik duyurusu" },
      outputSchema: {
        type: "object",
        required: ["kind"],
        properties: { kind: { type: "string" } },
        additionalProperties: false
      },
      validateOutput: (value): value is { kind: string } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { kind?: unknown }).kind === "string"
    },
    createMockStructuredCodexPort([
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "{\"kind\":\"news\"}"
        }
      },
      { type: "turn.completed" }
    ])
  );

  assert.deepEqual(result, {
    status: "COMPLETED",
    role: "FAST",
    model: "gpt-5.6-luna",
    output: { kind: "news" }
  });
});

test("Codex CLI port uses an isolated cwd, allowlisted environment, and final output file", async () => {
  const seen: CodexCliSpawnObservation[] = [];
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url))
    ],
    codexHome: "C:\\isolated-codex-home",
    timeoutMs: 5_000,
    onSpawn: (observation) => seen.push(observation)
  });

  const events = [];
  for await (const event of port.run({
    model: "gpt-5.6-luna",
    input: { title: "Duyuru" },
    outputSchema: {
      type: "object",
      required: ["kind"],
      properties: { kind: { type: "string" } },
      additionalProperties: false
    }
  })) {
    events.push(event);
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.shell, false);
  assert.equal(seen[0]?.cwdIsIsolated, true);
  assert.deepEqual(seen[0]?.environmentKeys, [
    "CODEX_HOME",
    "PATH",
    "SystemRoot"
  ]);
  assert.ok(
    events.some(
      (event) =>
        event.type === "output.completed" &&
        (event.output as { kind?: unknown }).kind === "news"
    )
  );
});

test("deploy-time model policy can change a logical role without changing task routing", () => {
  assert.deepEqual(
    resolveCodexRole("WRITE_TR", {
      FAST: "fast-model",
      DEFAULT: "editorial-model",
      DEEP_REVIEW: "review-model"
    }),
    { role: "DEFAULT", model: "editorial-model" }
  );
});

test("rejects command, tool, file, MCP, web, and browser events from the isolated runner", async () => {
  for (const eventType of [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "command.started",
    "tool.call",
    "file.write",
    "mcp.call",
    "web.search",
    "browser.open"
  ]) {
    await assert.rejects(
      runStructuredCodexTask(
        {
          taskKind: "RESEARCH",
          input: { evidence: [] },
          outputSchema: { type: "object" },
          validateOutput: (_value): _value is Record<string, never> => true
        },
        createMockStructuredCodexPort([{ type: eventType }])
      ),
      (error: unknown) =>
        error instanceof CodexRunnerError &&
        error.code === "DENIED_EVENT" &&
        error.message.includes(eventType)
    );
  }
});

test("rejects forbidden nested item events from real JSONL-shaped streams", async () => {
  await assert.rejects(
    runStructuredCodexTask(
      {
        taskKind: "RESEARCH",
        input: {},
        outputSchema: { type: "object" },
        validateOutput: (_value): _value is Record<string, never> => true
      },
      createMockStructuredCodexPort([
        {
          type: "item.started",
          item: { type: "command_execution" }
        }
      ])
    ),
    (error: unknown) =>
      error instanceof CodexRunnerError && error.code === "DENIED_EVENT"
  );
});

test("rejects unknown lifecycle events instead of silently accepting protocol drift", async () => {
  await assert.rejects(
    runStructuredCodexTask(
      {
        taskKind: "RESEARCH",
        input: {},
        outputSchema: { type: "object" },
        validateOutput: (_value): _value is Record<string, never> => true
      },
      createMockStructuredCodexPort([{ type: "future.protocol.event" }])
    ),
    (error: unknown) =>
      error instanceof CodexRunnerError && error.code === "DENIED_EVENT"
  );
});

test("rejects oversized final output files before parsing them", async () => {
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--oversized-output"
    ],
    codexHome: "C:\\isolated-codex-home",
    timeoutMs: 5_000
  });

  await assert.rejects(
    async () => {
      for await (const _event of port.run({
        model: "gpt-5.6-luna",
        input: {},
        outputSchema: { type: "object" }
      })) {
        // Consume the stream so the final-output validation executes.
      }
    },
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("exceeded the bounded size")
  );
});

test("moves authentication and usage limits to WAITING_CODEX without a fallback call", async () => {
  for (const [eventType, expectedReason] of [
    ["auth.required", "AUTH_REQUIRED"],
    ["rate_limit.reached", "RATE_LIMIT"],
    ["usage_limit.reached", "USAGE_LIMIT"]
  ] as const) {
    const result = await runStructuredCodexTask(
      {
        taskKind: "CLASSIFY",
        input: {},
        outputSchema: { type: "object" },
        validateOutput: (_value): _value is Record<string, never> => true
      },
      createMockStructuredCodexPort([{ type: eventType }])
    );

    assert.deepEqual(result, {
      status: "WAITING_CODEX",
      reason: expectedReason,
      role: "FAST",
      model: "gpt-5.6-luna"
    });
  }
});

test("keeps paid API fallback hard-off even when a caller requests it", async () => {
  assert.equal(PAID_API_FALLBACK_ENABLED, false);
  await assert.rejects(
    runStructuredCodexTask(
      {
        taskKind: "FINAL_QUALITY",
        input: {},
        outputSchema: { type: "object" },
        validateOutput: (_value): _value is Record<string, never> => true,
        paidFallbackRequested: true
      },
      createMockStructuredCodexPort([])
    ),
    (error: unknown) =>
      error instanceof CodexRunnerError &&
      error.code === "PAID_FALLBACK_DISABLED"
  );
});
