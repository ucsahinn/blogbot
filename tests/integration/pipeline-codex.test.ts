import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  hasUnsafeCommandPrefixArgs,
  safeProcessDetail,
  type CodexCliSpawnObservation
} from "../../apps/codex-runner/src/cli-port.ts";
import { createMockStructuredCodexPort } from "../../apps/codex-runner/src/mock-port.ts";
import { createDraftCodexTaskResolver } from "../../apps/engine/src/codex-draft.ts";

const isolatedCodexHome = join(tmpdir(), "blogbot-isolated-codex-home");

const expectedRoles: ReadonlyArray<
  readonly [CodexTaskKind, "FAST" | "DEFAULT" | "DEEP_REVIEW", string]
> = [
  ["CLASSIFY", "FAST", "gpt-5.6-luna"],
  ["DEDUPE", "FAST", "gpt-5.6-luna"],
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
  const args = buildCodexExecArgs("gpt-5.6-terra", "C:\\job\\output.schema.json");
  assert.deepEqual(args.slice(0, 4), ["exec", "--ephemeral", "--sandbox", "read-only"]);
  for (const flag of ["--strict-config", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json"]) {
    assert.ok(args.includes(flag), `missing fail-closed CLI flag ${flag}`);
  }
  for (const feature of ["shell_tool", "browser_use", "computer_use", "image_generation", "view_image", "apps", "plugins", "memories", "hooks", "standalone_web_search", "network_proxy"]) {
    const index = args.findIndex((value, position) => value === "--disable" && args[position + 1] === feature);
    assert.notEqual(index, -1, `Codex feature must be explicitly disabled: ${feature}`);
  }
  assert.ok(args.some((value, index) => value === "-c" && args[index + 1] === "mcp_servers={}"));
  assert.ok(args.some((value, index) => value === "-c" && args[index + 1] === "tools.web_search=false"));
  assert.equal(args.at(-1), "-");
});

test("resume keeps the read-only sandbox on the exec parent before the subcommand", () => {
  const args = buildCodexExecArgs("default", "C:/safe/schema.json", {
    persistSession: true,
    conversationSessionId: "019fae00-0000-7000-8000-000000000001"
  });
  assert.deepEqual(args.slice(0, 5), [
    "exec", "--sandbox", "read-only", "resume", "019fae00-0000-7000-8000-000000000001"
  ]);
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
    model: "gpt-5.6-luna",
    output: { kind: "news" }
  });
});

test("uses authoritative output.completed after a malformed intermediate agent message", async () => {
  const result = await runStructuredCodexTask(
    {
      taskKind: "CLASSIFY",
      input: {},
      outputSchema: { type: "object" },
      validateOutput: (value): value is { kind: string } =>
        typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "news"
    },
    createMockStructuredCodexPort([
      { type: "item.completed", item: { type: "agent_message", text: "progress, not final JSON" } },
      { type: "output.completed", output: { kind: "news" } }
    ])
  );

  assert.equal(result.status, "COMPLETED");
  if (result.status === "COMPLETED") assert.deepEqual(result.output, { kind: "news" });
});

test("reports malformed agent-only output when no authoritative output arrives", async () => {
  await assert.rejects(
    runStructuredCodexTask(
      {
        taskKind: "CLASSIFY",
        input: {},
        outputSchema: { type: "object" },
        validateOutput: (_value): _value is { kind: string } => false
      },
      createMockStructuredCodexPort([
        { type: "item.completed", item: { type: "agent_message", text: "not JSON" } }
      ])
    ),
    (error: unknown) => error instanceof CodexRunnerError && error.code === "INVALID_OUTPUT"
  );
});

test("unsafe conversation ids never reach resume argv or the Codex port", async () => {
  for (const value of ["-override", "has space", "../thread", "x".repeat(129)]) {
    assert.equal(buildCodexExecArgs("default", "C:/safe/schema.json", {
      persistSession: true,
      conversationSessionId: value
    }).includes("resume"), false, value);
  }
  let forwarded: string | undefined;
  const result = await runStructuredCodexTask(
    {
      taskKind: "CLASSIFY",
      input: {},
      outputSchema: { type: "object" },
      persistSession: true,
      conversationSessionId: "-config",
      validateOutput: (value): value is { ok: true } =>
        typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true
    },
    {
      async *run(request) {
        forwarded = request.conversationSessionId;
        yield { type: "thread.started", thread_id: "../unsafe" };
        yield { type: "output.completed", output: { ok: true } };
      }
    }
  );
  assert.equal(forwarded, undefined);
  assert.equal(result.status, "COMPLETED");
  if (result.status === "COMPLETED") assert.equal(result.conversationSessionId, undefined);
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
  assert.deepEqual(
    seen[0]?.environmentKeys,
    ["CODEX_HOME", "PATH", "SystemRoot", "TEMP", "TMP"].filter(
      (key) => key === "CODEX_HOME" || Boolean(process.env[key])
    )
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "output.completed" &&
        (event.output as { kind?: unknown }).kind === "news"
    )
  );
});

test("Codex CLI 0.147 runs when all required capabilities are present", async () => {
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--unsupported-version"
    ],
    codexHome: await mkdtemp(join(tmpdir(), "blogbot-codex-legacy-compatible-version-")),
    timeoutMs: 5_000
  });
  const events = [];
  for await (const event of port.run({ model: "gpt-5.6-luna", input: {}, outputSchema: { type: "object" } })) {
    events.push(event);
  }
  assert.ok(events.some((event) => event.type === "output.completed"));
});

test("Codex CLI 0.146 remains rejected even when probe output looks otherwise compatible", async () => {
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--too-old-version"
    ],
    codexHome: await mkdtemp(join(tmpdir(), "blogbot-codex-too-old-version-")),
    timeoutMs: 5_000
  });
  await assert.rejects(async () => {
    for await (const _event of port.run({ model: "gpt-5.6-luna", input: {}, outputSchema: { type: "object" } })) {
      // This runtime must fail before task JSONL is consumed.
    }
  }, (error: unknown) => error instanceof CodexCliPortError && error.code === "UNSUPPORTED_CLI");
});

test("Codex CLI startup rejects a runtime missing a required disable capability", async () => {
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--missing-shell-feature"
    ],
    codexHome: await mkdtemp(join(tmpdir(), "blogbot-codex-missing-feature-")),
    timeoutMs: 5_000
  });
  await assert.rejects(async () => {
    for await (const _event of port.run({ model: "gpt-5.6-luna", input: {}, outputSchema: { type: "object" } })) {
      // Startup must fail before task JSONL is consumed.
    }
  }, (error: unknown) => error instanceof CodexCliPortError && error.code === "UNSUPPORTED_CLI");
});

test("session retention deletes only stale app-owned JSONL and resumes a recent UUID", async () => {
  const retentionRoot = await mkdtemp(join(tmpdir(), "blogbot-codex-session-retention-"));
  const codexHome = join(retentionRoot, "app-owned-codex-home");
  const sessionDirectory = join(codexHome, "sessions", "2026", "08", "20");
  await mkdir(sessionDirectory, { recursive: true });
  const currentId = "019fae00-0000-7000-8000-000000000002";
  const staleId = "019fae00-0000-7000-8000-000000000003";
  const currentPath = join(sessionDirectory, `rollout-current-${currentId}.jsonl`);
  const stalePath = join(sessionDirectory, `rollout-stale-${staleId}.jsonl`);
  await writeFile(currentPath, "{}\n", "utf8");
  await writeFile(stalePath, "{}\n", "utf8");
  const userHistoryPath = join(
    retentionRoot,
    "user-codex-home",
    "sessions",
    "2025",
    "01",
    "01",
    `rollout-user-${staleId}.jsonl`
  );
  await mkdir(join(userHistoryPath, ".."), { recursive: true });
  await writeFile(userHistoryPath, "user history\n", "utf8");
  await utimes(stalePath, new Date(0), new Date(0));
  await utimes(userHistoryPath, new Date(0), new Date(0));
  await utimes(currentPath, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));
  const capturePath = join(codexHome, "captured-argv.json");
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      `--capture-argv=${capturePath}`
    ],
    codexHome,
    timeoutMs: 5_000
  });
  for await (const _event of port.run({
    model: "gpt-5.6-luna",
    input: {},
    outputSchema: { type: "object" },
    persistSession: true,
    conversationSessionId: staleId
  })) {
    // Consume the fake task.
  }
  const staleArgs = JSON.parse(await readFile(capturePath, "utf8")) as string[];
  assert.equal(staleArgs.includes(staleId), false, "an expired record must not be resumed");
  await assert.rejects(stat(stalePath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
  assert.equal(
    (await stat(userHistoryPath)).isFile(),
    true,
    "retention must never reach outside the app-owned Codex home"
  );

  for await (const _event of port.run({
    model: "gpt-5.6-luna",
    input: {},
    outputSchema: { type: "object" },
    persistSession: true,
    conversationSessionId: currentId
  })) {
    // Consume the fake task.
  }
  const currentArgs = JSON.parse(await readFile(capturePath, "utf8")) as string[];
  assert.ok(currentArgs.includes("resume"));
  assert.ok(currentArgs.includes(currentId));
});

test("a new persistent session evicts the oldest app-owned record before reaching the count bound", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "blogbot-codex-session-count-"));
  const sessionDirectory = join(codexHome, "sessions", "2026", "08", "20");
  await mkdir(sessionDirectory, { recursive: true });
  let oldestPath = "";
  let newestPath = "";
  const recentBase = Date.now();
  for (let index = 0; index < 32; index += 1) {
    const id = `019fae00-0000-7000-8000-${String(index).padStart(12, "0")}`;
    const recordPath = join(sessionDirectory, `rollout-extra-${id}.jsonl`);
    await writeFile(recordPath, "{}\n", "utf8");
    await utimes(recordPath, new Date(recentBase + index), new Date(recentBase + index));
    if (index === 0) oldestPath = recordPath;
    if (index === 31) newestPath = recordPath;
  }
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url))],
    codexHome,
    timeoutMs: 5_000
  });
  for await (const _event of port.run({
    model: "gpt-5.6-luna",
    input: {},
    outputSchema: { type: "object" },
    persistSession: true
  })) {
    // The fake runtime completes the new persistent task.
  }
  await assert.rejects(stat(oldestPath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
  assert.equal((await stat(newestPath)).isFile(), true);
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
    "claimKey", "trText", "enText", "sourceIds", "status", "evidenceQuotes"
  ]);
});

test("Windows command wrappers cannot keep a timed-out Codex task running", { skip: process.platform !== "win32" }, async () => {
  const timeoutCodexHome = await mkdtemp(join(tmpdir(), "blogbot-isolated-codex-home-timeout-"));
  const port = createCodexCliPort({
    command: fileURLToPath(new URL("../fixtures/fake-codex-wrapper.cmd", import.meta.url)),
    commandPrefixArgs: ["--hang"],
    codexHome: timeoutCodexHome,
    // Node's test runner executes the integration files concurrently on
    // Windows. Give the fixture enough cold-start time to publish its exact
    // PID before the intentionally bounded timeout fires; the assertion still
    // proves that a timed-out child tree cannot survive the runner.
    timeoutMs: 5_000
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
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout did not release the Codex caller")), 7_000))
    ]),
    (error: unknown) =>
      error instanceof CodexCliPortError && error.code === "PROCESS_TIMEOUT"
  );

  const childPid = Number(
    (await readFile(join(timeoutCodexHome, "fake-codex-child.pid"), "utf8")).trim()
  );
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0, "fixture must report its exact child PID");
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(childPid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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

test("the bounded capability probe budget is independent from the task execution deadline", async () => {
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--slow-capability-probe",
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
        // The startup probe may take longer than this task's execution budget,
        // but the heartbeat task itself must still time out after one second.
      }
    },
    (error: unknown) =>
      error instanceof CodexCliPortError && error.code === "PROCESS_TIMEOUT"
  );
});

test("a transient capability probe failure is not cached across a later user retry", async () => {
  const marker = join(isolatedCodexHome, `probe-failure-${Date.now()}.marker`);
  const commandPrefixArgs = [
    fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
    `--capability-failure-marker=${marker}`
  ];
  await writeFile(marker, "fail once\n", "utf8");
  try {
    const failedPort = createCodexCliPort({
      command: process.execPath,
      commandPrefixArgs,
      codexHome: isolatedCodexHome,
      timeoutMs: 5_000
    });
    await assert.rejects(
      async () => {
        for await (const _event of failedPort.run({ model: "gpt-5.6-luna", input: {}, outputSchema: { type: "object" } })) {
          // The marker makes this first capability probe fail transiently.
        }
      },
      (error: unknown) => error instanceof CodexCliPortError && error.code === "UNSUPPORTED_CLI"
    );

    await rm(marker, { force: true });
    const recoveredPort = createCodexCliPort({
      command: process.execPath,
      commandPrefixArgs,
      codexHome: isolatedCodexHome,
      timeoutMs: 5_000
    });
    const events = [];
    for await (const event of recoveredPort.run({ model: "gpt-5.6-luna", input: {}, outputSchema: { type: "object" } })) {
      events.push(event);
    }
    assert.ok(events.some((event) => event.type === "output.completed"));
  } finally {
    await rm(marker, { force: true });
  }
});

test("concurrent capability probes with different bounded budgets do not share a timeout", async () => {
  const commandPrefixArgs = [
    fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
    "--capability-probe-delay-ms=5500"
  ];
  const shortPort = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs,
    codexHome: isolatedCodexHome,
    timeoutMs: 1_000
  });
  const longPort = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs,
    codexHome: isolatedCodexHome,
    timeoutMs: 10_000
  });

  const shortRun = assert.rejects(
    async () => {
      for await (const _event of shortPort.run({ model: "gpt-5.6-luna", input: {}, outputSchema: { type: "object" } })) {
        // The normalized five-second startup budget is intentionally too short.
      }
    },
    (error: unknown) => error instanceof CodexCliPortError && error.code === "UNSUPPORTED_CLI"
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const longRun = (async () => {
    const events = [];
    for await (const event of longPort.run({ model: "gpt-5.6-luna", input: {}, outputSchema: { type: "object" } })) {
      events.push(event);
    }
    assert.ok(events.some((event) => event.type === "output.completed"));
  })();
  await Promise.all([shortRun, longRun]);
});

test("a deadline that fires after the JSONL stream closes is still reported as a timeout", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "blogbot-isolated-codex-home-linger-"));
  // This is the Windows wrapper shape: the reported child closes stdout at once
  // while the process it launched lingers, so the deadline fires while the exit
  // status is still awaited rather than during iteration.
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--close-stdout-linger"
    ],
    codexHome,
    timeoutMs: 1_000
  });

  await assert.rejects(
    async () => {
      for await (const _event of port.run({
        model: "gpt-5.6-luna",
        input: {},
        outputSchema: { type: "object" }
      })) {
        // The stream ends immediately and never carries a final answer.
      }
    },
    // Before the fix the kill's own exit code was read as PROCESS_FAILED, which
    // the worker treats as a real failure instead of a retryable timeout.
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

test("turns a nested Codex error item into a terminal runner failure instead of protocol drift", async () => {
  await assert.rejects(
    runStructuredCodexTask(
      {
        taskKind: "RESEARCH",
        input: {},
        outputSchema: { type: "object" },
        validateOutput: (_value): _value is Record<string, never> => true
      },
      createMockStructuredCodexPort([{ type: "item.completed", item: { type: "error", text: "runner failed" } }])
    ),
    (error: unknown) =>
      error instanceof CodexRunnerError &&
      error.code === "PROCESS_FAILED"
  );
});
test("turns a Codex error event into a terminal runner failure instead of treating it as protocol drift", async () => {
  await assert.rejects(
    runStructuredCodexTask(
      {
        taskKind: "RESEARCH",
        input: {},
        outputSchema: { type: "object" },
        validateOutput: (_value): _value is Record<string, never> => true
      },
      createMockStructuredCodexPort([{ type: "error", message: "invalid output schema" }])
    ),
    (error: unknown) =>
      error instanceof CodexRunnerError &&
      error.code === "PROCESS_FAILED" &&
      error.message.includes("invalid output schema")
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

test("a Codex runtime that dies before draining the prompt cannot crash the engine sidecar", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "blogbot-isolated-codex-home-epipe-"));
  const port = createCodexCliPort({
    command: process.execPath,
    commandPrefixArgs: [
      fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)),
      "--exit-before-reading-stdin"
    ],
    codexHome,
    timeoutMs: 10_000
  });

  // The prompt must be larger than the OS pipe buffer, otherwise the write is
  // absorbed by the kernel and the broken pipe is never observed.
  const oversizedEvidence = "x".repeat(2 * 1024 * 1024);

  // Before the fix this rejected with an *unhandled* EPIPE on the child's stdin,
  // which has no listener and therefore terminates the whole engine process.
  await assert.rejects(
    async () => {
      for await (const event of port.run({
        model: "gpt-5.6-luna",
        input: { evidence: oversizedEvidence },
        outputSchema: {
          type: "object",
          required: ["kind"],
          properties: { kind: { type: "string" } },
          additionalProperties: false
        }
      })) {
        void event;
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof CodexCliPortError, `expected a typed port error, got ${String(error)}`);
      // Whatever the exact failure, it must be reported as a bounded runner
      // failure the worker can classify, never an unhandled stream error.
      assert.ok(
        ["PROCESS_FAILED", "INVALID_EVENT", "MISSING_FINAL_OUTPUT"].includes(error.code),
        `unexpected failure code ${error.code}`
      );
      return true;
    }
  );
});

test("Codex failure detail drops any line that could carry a credential", () => {
  // This detail is persisted into local job metadata, where the Rust layer's log
  // redaction never reaches it. The previous expression emitted a literal "$1"
  // and matched only marker-prefixed values, so an opaque key, a JWT or a bare
  // bearer blob survived into the database.
  const dropped = [
    "token=gh" + "p_0123456789abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "OPENAI_API_KEY s" + "k-abcdefghijklmnopqrstuvwxyz012345",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
      ".abcdefghij",
    "-----BEGIN " + "PRIVATE KEY-----",
    "signed in as editor@example.com",
    "see https://example.com/session/abc",
    "opaque 0123456789012345678901234567890123456789012"
  ];
  for (const line of dropped) {
    const detail = safeProcessDetail(line);
    assert.equal(detail, "[redacted]", `must drop: ${line}`);
    assert.doesNotMatch(detail, /\$1/u, "redaction must never emit a literal $1");
  }

  // Ordinary diagnostic signal has to survive, or the desk learns nothing.
  const kept = safeProcessDetail("codex exited with status 3");
  assert.equal(kept, "codex exited with status 3");
  // A scoped npm path is not user identity.
  assert.match(safeProcessDetail("cannot find module @openai/codex"), /@openai\/codex/u);
});

test("Codex failure detail keeps useful lines while dropping a credential beside them", () => {
  const detail = safeProcessDetail([
    "codex exited with status 1",
    "token=gh" + "p_0123456789abcdefghijklmnopqrstuvwxyz",
    "retry after 30 seconds"
  ].join("\n"));

  assert.match(detail, /codex exited with status 1/u);
  assert.match(detail, /retry after 30 seconds/u);
  assert.doesNotMatch(detail, /ghp_/u);
  assert.match(detail, /\[redacted\]/u);
});

test("an unsafe command prefix cannot re-attach the user Codex configuration", () => {
  for (const unsafe of ["--config-dir=C:/Users/me/.codex", "--home", "-env", "--api-key=secret"]) {
    assert.equal(hasUnsafeCommandPrefixArgs([unsafe]), true, `must reject: ${unsafe}`);
  }
  assert.equal(hasUnsafeCommandPrefixArgs(["exec", "--json"]), false);
  assert.equal(hasUnsafeCommandPrefixArgs(undefined), false);
});
