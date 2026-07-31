import {
  createCodexCliPort,
  type CodexCliPortOptions,
  type CodexCliSpawnObservation
} from "./cli-port.ts";
import type { CodexEvent, StructuredCodexPort } from "./structured-runner.ts";

/** Configuration accepted by the local Codex adapter. Credentials are never part of this type. */
export interface CodexConnectorConfig {
  command: string;
  codexHome: string;
  timeoutMs: number;
  dryRun?: boolean;
  commandPrefixArgs?: readonly string[];
}

export type CodexConnectorStatus =
  | { state: "READY"; mode: "DRY_RUN" | "LIVE" }
  | { state: "LOGIN_REQUIRED"; reason: "AUTH_REQUIRED" }
  | { state: "RATE_LIMITED"; reason: "RATE_LIMIT" }
  | { state: "USAGE_LIMITED"; reason: "USAGE_LIMIT" };

export type CodexConnectorEvent = Pick<CodexEvent, "type">;

export class CodexConnectorConfigError extends Error {
  constructor(
    readonly code: "INVALID_CONFIG" | "CREDENTIALS_NOT_ALLOWED",
    message: string
  ) {
    super(message);
    this.name = "CodexConnectorConfigError";
  }
}

export interface CodexConnectorPort extends StructuredCodexPort {
  status(): CodexConnectorStatus;
  observe(event: CodexConnectorEvent): CodexConnectorStatus;
  dryRun(): { ok: true; writes: false; network: false };
}

const credentialKey = /(?:token|secret|password|passphrase|api.?key|credential|private.?key)/iu;

function assertCredentialSafeConfig(config: CodexConnectorConfig): void {
  if (!config || typeof config !== "object") {
    throw new CodexConnectorConfigError("INVALID_CONFIG", "Codex connector config is required");
  }
  for (const key of Object.keys(config)) {
    if (credentialKey.test(key)) {
      throw new CodexConnectorConfigError(
        "CREDENTIALS_NOT_ALLOWED",
        `Codex connector does not accept credential field: ${key}`
      );
    }
  }
  for (const arg of config.commandPrefixArgs ?? []) {
    if (typeof arg !== "string" || credentialKey.test(arg) || /^(?:-|\/)(?:env|config(?:-dir)?|home)(?:=|$)/iu.test(arg)) {
      throw new CodexConnectorConfigError(
        "CREDENTIALS_NOT_ALLOWED",
        "Codex connector command arguments cannot contain credential or config override flags"
      );
    }
  }
  if (!config.command || !config.codexHome || !Number.isFinite(config.timeoutMs) || config.timeoutMs < 1_000) {
    throw new CodexConnectorConfigError(
      "INVALID_CONFIG",
      "Codex connector requires command, Codex home, and a timeout of at least 1000ms"
    );
  }
}

function statusFromEvent(event: CodexConnectorEvent, mode: "DRY_RUN" | "LIVE"): CodexConnectorStatus | null {
  switch (event.type) {
    case "auth.required":
      return { state: "LOGIN_REQUIRED", reason: "AUTH_REQUIRED" };
    case "rate_limit.reached":
      return { state: "RATE_LIMITED", reason: "RATE_LIMIT" };
    case "usage_limit.reached":
      return { state: "USAGE_LIMITED", reason: "USAGE_LIMIT" };
    case "output.completed":
      return { state: "READY", mode };
    default:
      return null;
  }
}

export function createCodexConnectorPort(
  config: CodexConnectorConfig,
  options: Pick<CodexCliPortOptions, "onSpawn"> = {}
): CodexConnectorPort {
  assertCredentialSafeConfig(config);
  const mode = config.dryRun === true ? "DRY_RUN" : "LIVE";
  let current: CodexConnectorStatus = { state: "READY", mode };
  const cliOptions: CodexCliPortOptions = {
    command: config.command,
    codexHome: config.codexHome,
    timeoutMs: config.timeoutMs,
    ...(config.commandPrefixArgs ? { commandPrefixArgs: config.commandPrefixArgs } : {}),
    ...(options.onSpawn ? { onSpawn: options.onSpawn } : {})
  };
  const delegate = config.dryRun
    ? null
    : createCodexCliPort(cliOptions);

  return {
    status: () => current,
    observe(event) {
      current = statusFromEvent(event, mode) ?? current;
      return current;
    },
    dryRun: () => ({ ok: true, writes: false, network: false }),
    async *run(request) {
      if (!delegate) {
        yield { type: "output.completed", output: { dryRun: true } };
        return;
      }
      for await (const event of delegate.run(request)) {
        const next = statusFromEvent(event, mode);
        if (next) current = next;
        yield event;
      }
    }
  };
}

export type { CodexCliSpawnObservation };
