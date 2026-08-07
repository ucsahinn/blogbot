import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  CodexCliPortError,
  createCodexCliPort,
  type CodexCliSpawnObservation
} from "../../apps/codex-runner/src/cli-port.ts";
import { createMockStructuredCodexPort } from "../../apps/codex-runner/src/mock-port.ts";
import { createDraftCodexTaskResolver } from "../../apps/engine/src/codex-draft.ts";

const isolatedCodexHome = join(tmpdir(), "blogbot-isolated-codex-home");

const expectedRoles: ReadonlyArray<
  readonly [CodexTaskKind, "FAST" | "DEFAULT" | "DEEP_REVIEW", string]
> = [
  ["CLASSIFY", "FAST", "default"],
  ["DEDUPE", "FAST", "default"],
  ["RESEARCH", "DEFAULT", "default"],
  ["WRITE_TR", "DEFAULT", "default"],
  ["LOCALIZE_EN", "DEFAULT", "default"],
  ["CHECK_CONTRADICTIONS", "DEEP_REVIEW", "default"],
  ["FINAL_QUALITY", "DEEP_REVIEW", "default"]
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
    model: "default",
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
    model: "default",
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
    codexHome: isolatedCodexHome,
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
    "SystemRoot",
    "TEMP",
    "TMP"
  ]);
  assert.ok(
    events.some(
      (event) =>
        event.type === "output.completed" &&
        (event.output as { kind?: unknown }).kind === "news"
    )
  );
});

test("optional live Codex probe completes the production draft contract with synthetic evidence", {
  skip: process.env.BLOGBOT_LIVE_CODEX_PROBE !== "1"
}, async () => {
  const appData = process.env.APPDATA;
  assert.ok(appData, "APPDATA is required for the application-owned Codex home");
  const task = await createDraftCodexTaskResolver().resolve({
    jobId: "synthetic-contract-probe",
    idempotencyKey: "synthetic-contract-probe",
    definitionId: "DRAFT.CREATE",
    state: "RUNNING",
    version: 1,
    payload: {
      instruction: "Write a short original report about a synthetic local event.",
      candidateTitle: "Synthetic contract probe",
      section: "haberler",
      articleType: "news",
      sources: [{
        id: "synthetic-source-1",
        title: "Synthetic evidence",
        url: "https://example.invalid/synthetic",
        excerpt: "This is deliberately synthetic evidence used only to validate the local output contract.",
        quoteHash: "0".repeat(64)
      }]
    }
  });
  const port = createCodexCliPort({
    command: process.env.BLOGBOT_LIVE_CODEX_COMMAND ?? "codex.cmd",
    codexHome: join(appData, "app.blogbot.desktop", "codex-home"),
    timeoutMs: 120_000
  });
  const result = await runStructuredCodexTask(task, port);
  // Do not log generated article content. The result proves only that the
  // production schema, isolated runner and parser interoperate.
  assert.equal(result.status, "COMPLETED");
});

test("production draft schema keeps every closed claim property required", async () => {
  const task = await createDraftCodexTaskResolver().resolve({
    jobId: "schema-contract",
    idempotencyKey: "schema-contract",
    definitionId: "DRAFT.CREATE",
    state: "RUNNING",
    version: 1,
    payload: {}
  });
  const schema = task.outputSchema as { properties?: { claims?: { items?: { required?: unknown } } } };
  assert.deepEqual(schema.properties?.claims?.items?.required, [
    "claimKey", "trText", "enText", "sourceIds", "status", "quoteHash"
  ]);
});

test("Windows command wrappers cannot keep a timed-out Codex task running", { skip: process.platform !== "win32" }, async () => {
  const port = createCodexCliPort({
    command: fileURLToPath(new URL("../fixtures/fake-codex-wrapper.cmd", import.meta.url)),
    commandPrefixArgs: ["--hang"],
    codexHome: isolatedCodexHome,
    timeoutMs: 1_000
  });
  const consume = async () => {
    for await (const _event of port.run({
      model: "gpt-5.6-luna",
      input: {},
      outputSchema: { type: "object" }
    })) {
      // The timeout must interrupt iteration before a final event exists.
    }
  };

  await assert.rejects(
    Promise.race([
      consume(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout did not terminate the wrapped process tree")), 4_000))
    ]),
    (error: unknown) =>
      error instanceof CodexCliPortError && error.code === "PROCESS_TIMEOUT"
  );

  const childPid = Number(
    (await readFile(join(isolatedCodexHome, "fake-codex-child.pid"), "utf8")).trim()
  );
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0, "fixture must report its exact child PID");
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    process.kill(childPid, 0);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
    return;
  }
  try {
    process.kill(childPid, "SIGKILL");
  } finally {
    assert.fail("the timed-out Windows wrapper left its fixture child running");
  }
});

test("a chatty Codex stream cannot postpone the execution deadline", async () => {
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--heartbeat"
    ],
    codexHome: isolatedCodexHome,
    timeoutMs: 1_000
  });

  await assert.rejects(
    async () => {
      for await (const _event of port.run({
        model: "gpt-5.6-luna",
        input: {},
        outputSchema: { type: "object" }
      })) {
        // The stream is intentionally alive but never produces final output.
      }
    },
    (error: unknown) =>
      error instanceof CodexCliPortError && error.code === "PROCESS_TIMEOUT"
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
    codexHome: isolatedCodexHome,
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

test("uses a valid streamed agent message when the optional final output file is not JSON", async () => {
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)), "--invalid-final-output"],
    codexHome: isolatedCodexHome,
    timeoutMs: 5_000
  });
  const result = await runStructuredCodexTask({
    taskKind: "CLASSIFY",
    input: {},
    outputSchema: { type: "object" },
    validateOutput: (value): value is { kind: string } => typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "news"
  }, port);
  assert.equal(result.status, "COMPLETED");
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
      model: "default"
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
