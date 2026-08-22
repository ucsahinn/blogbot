import type {
  CodexLogicalRole,
  CodexRoleModels,
  CodexTaskKind
} from "./role-policy.ts";
import { resolveCodexRole } from "./role-policy.ts";

export const PAID_API_FALLBACK_ENABLED = false;

export type CodexRunnerErrorCode =
  | "DENIED_EVENT"
  | "INVALID_OUTPUT"
  | "MISSING_OUTPUT"
  | "PAID_FALLBACK_DISABLED"
  | "PROCESS_FAILED";

export class CodexRunnerError extends Error {
  constructor(
    readonly code: CodexRunnerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CodexRunnerError";
  }
}

export interface CodexEvent {
  type: string;
  thread_id?: string;
  threadId?: string;
  output?: unknown;
  message?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

export interface StructuredCodexPort {
  run(request: {
    model: string;
    input: unknown;
    outputSchema: Record<string, unknown>;
    conversationSessionId?: string;
    persistSession?: boolean;
  }): AsyncIterable<CodexEvent>;
}

export interface StructuredCodexTask<T> {
  taskKind: CodexTaskKind;
  input: unknown;
  outputSchema: Record<string, unknown>;
  validateOutput(value: unknown): value is T;
  /** Optional bounded repair for deterministic, derivable metadata only. */
  normalizeOutput?(value: unknown): unknown;
  paidFallbackRequested?: boolean;
  roleModels?: CodexRoleModels;
  /** A conversational task may persist and resume its own isolated Codex thread. */
  persistSession?: boolean;
  conversationSessionId?: string;
}

export type StructuredCodexResult<T> =
  | {
      status: "COMPLETED";
      role: CodexLogicalRole;
      model: string;
      output: T;
      conversationSessionId?: string;
    }
  | {
      status: "WAITING_CODEX";
      reason: "AUTH_REQUIRED" | "RATE_LIMIT" | "USAGE_LIMIT";
      role: CodexLogicalRole;
      model: string;
    };

export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "browser_use",
  "computer_use",
  "image_generation",
  "view_image",
  "apps",
  "plugins",
  "memories",
  "hooks",
  "standalone_web_search",
  "network_proxy"
] as const;

const safeConversationSessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function safeConversationSessionId(value: unknown): string | undefined {
  return typeof value === "string" && safeConversationSessionIdPattern.test(value)
    ? value
    : undefined;
}

export function buildCodexExecArgs(
  model: string,
  outputSchemaPath: string,
  options: { conversationSessionId?: string; persistSession?: boolean } = {}
): string[] {
  const conversationSessionId = options.persistSession === true
    ? safeConversationSessionId(options.conversationSessionId)
    : undefined;
  const args = [
    "exec",
    ...(!options.persistSession ? ["--ephemeral"] : []),
    "--sandbox",
    "read-only",
    ...(conversationSessionId ? ["resume", conversationSessionId] : []),
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-c",
    "mcp_servers={}",
    "-c",
    "tools.web_search=false",
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--json",
    "--output-schema",
    outputSchemaPath,
    "-"
  ];
  if (model !== "default") {
    args.splice(args.length - 1, 0, "--model", model);
  }
  return args;
}

const waitingReasons = {
  "auth.required": "AUTH_REQUIRED",
  "rate_limit.reached": "RATE_LIMIT",
  "usage_limit.reached": "USAGE_LIMIT"
} as const;

const deniedEventPattern =
  /(?:^|[._-])(command(?:_execution)?|tool|file(?:_change)?|mcp|web|browser|computer|shell|patch)(?:$|[._-])/i;

const allowedEventTypes = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.updated",
  "item.completed",
  "output.completed",
  ...Object.keys(waitingReasons)
]);

const allowedItemTypes = new Set(["agent_message", "reasoning"]);

function outputShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value !== "object") return `${typeof value}:${String(value).length}`;
  if (Array.isArray(value)) return `array:${value.length}`;
  const record = value as Record<string, unknown>;
  const allKeys = Object.keys(record).sort();
  const keys = allKeys.slice(0, 24);
  const nested = depth < 1
    ? ["tr", "en"].flatMap((key) => key in record ? `${key}={${outputShape(record[key], depth + 1)}}` : [])
    : [];
  const claims = Array.isArray(record.claims) ? ` claims=array:${record.claims.length}` : "";
  return `object keys=${keys.join(",")}${allKeys.length > keys.length ? ",…" : ""}${nested.length ? ` ${nested.join(" ")}` : ""}${claims}`;
}

export async function runStructuredCodexTask<T>(
  task: StructuredCodexTask<T>,
  port: StructuredCodexPort
): Promise<StructuredCodexResult<T>> {
  if (task.paidFallbackRequested === true) {
    throw new CodexRunnerError(
      "PAID_FALLBACK_DISABLED",
      "paid API fallback is disabled"
    );
  }

  const selection = resolveCodexRole(task.taskKind, task.roleModels);
  let output: unknown;
  let outputReceived = false;
  let malformedAgentMessageReceived = false;
  const requestedConversationSessionId = task.persistSession === true
    ? safeConversationSessionId(task.conversationSessionId)
    : undefined;
  let conversationSessionId: string | undefined;

  for await (const event of port.run({
    model: selection.model,
    input: task.input,
    outputSchema: task.outputSchema,
    ...(requestedConversationSessionId ? { conversationSessionId: requestedConversationSessionId } : {}),
    ...(task.persistSession !== undefined ? { persistSession: task.persistSession } : {})
  })) {
    if (event.type === "thread.started") {
      const threadId = safeConversationSessionId(event.thread_id ?? event.threadId);
      if (threadId) conversationSessionId = threadId;
    }
    if (event.type === "error") {
      const detail = typeof event.message === "string" && event.message.trim()
        ? event.message.trim().slice(0, 500)
        : "Codex çalıştırması tamamlanamadı";
      throw new CodexRunnerError("PROCESS_FAILED", detail);
    }
    const waitingReason =
      waitingReasons[event.type as keyof typeof waitingReasons];
    if (waitingReason) {
      return {
        status: "WAITING_CODEX",
        reason: waitingReason,
        ...selection
      };
    }
    const deniedType = [event.type, event.item?.type]
      .filter((value): value is string => typeof value === "string")
      .find((value) => deniedEventPattern.test(value));
    if (deniedType) {
      throw new CodexRunnerError(
        "DENIED_EVENT",
        `isolated Codex runner rejected event: ${deniedType}`
      );
    }
    if (
      !allowedEventTypes.has(event.type) ||
      (event.item?.type !== undefined && !allowedItemTypes.has(event.item.type))
    ) {
      throw new CodexRunnerError(
        "DENIED_EVENT",
        `isolated Codex runner rejected unknown event: ${
          event.item?.type ?? event.type
        }`
      );
    }
    if (event.type === "output.completed") {
      output = event.output;
      outputReceived = true;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      try {
        output = JSON.parse(event.item.text);
        outputReceived = true;
      } catch {
        // Streamed agent messages are not authoritative. Codex can emit a
        // human-readable progress item before the schema-bound final output.
        // Remember the malformed item so an agent-only run still fails with
        // INVALID_OUTPUT, but continue waiting for output.completed.
        malformedAgentMessageReceived = true;
      }
    }
  }

  if (!outputReceived) {
    throw new CodexRunnerError(
      malformedAgentMessageReceived ? "INVALID_OUTPUT" : "MISSING_OUTPUT",
      malformedAgentMessageReceived
        ? "Codex agent message was not valid structured JSON and no authoritative output arrived"
        : "Codex runner completed without structured output"
    );
  }
  const normalizedOutput = task.normalizeOutput ? task.normalizeOutput(output) : output;
  if (!task.validateOutput(normalizedOutput)) {
    throw new CodexRunnerError(
      "INVALID_OUTPUT",
      `Codex output did not match the required schema; shape=${outputShape(normalizedOutput)}`
    );
  }

  return {
    status: "COMPLETED",
    ...selection,
    output: normalizedOutput,
    ...(conversationSessionId ? { conversationSessionId } : {})
  };
}
