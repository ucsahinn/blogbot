import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { FetchBoundaryError, type FetchResponse, type FetchTransport } from "../../fetcher/src/fetch-source.ts";

const MAX_FETCHER_RESPONSE_BYTES = 3 * 1024 * 1024;
const FETCHER_GRACE_MS = 1_000;

function scrubbedFetcherEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"] as const) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

/**
 * Executes network parsing in a separate process with no engine data key,
 * PGlite location, Codex configuration, or inherited user environment.
 */
export function createFetcherSidecarTransport(executable: string): FetchTransport {
  return {
    async resolve(hostname) {
      const parsed = await invokeFetcher(executable, { kind: "resolve", hostname }, 8_000);
      if (!Array.isArray(parsed.addresses) || !parsed.addresses.every((value) => typeof value === "string")) {
        throw new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar returned invalid DNS data");
      }
      return parsed.addresses;
    },
    async request(plan) {
      const parsed = await invokeFetcher(executable, { kind: "request", plan }, Math.max(1, (plan.deadlineAtMs ?? Date.now() + plan.timeoutMs) - Date.now()));
      if (typeof parsed.status !== "number" || !parsed.headers || typeof parsed.headers !== "object" || typeof parsed.bodyBase64 !== "string") {
        throw new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar returned an invalid response");
      }
      const body = Buffer.from(parsed.bodyBase64, "base64");
      if (body.byteLength > plan.maxResponseBytes) throw new FetchBoundaryError("RESPONSE_TOO_LARGE", "fetcher sidecar exceeded the requested byte limit");
      return { status: parsed.status, headers: parsed.headers as FetchResponse["headers"], body };
    }
  };
}

async function invokeFetcher(executable: string, request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
      const id = randomUUID();
      const child = spawn(executable, [], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: scrubbedFetcherEnvironment()
      });
      const requestLine = JSON.stringify({ id, ...request });
      let response = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        response += chunk;
        if (Buffer.byteLength(response, "utf8") > MAX_FETCHER_RESPONSE_BYTES) child.kill();
      });
      child.stdin.end(`${requestLine}\n`);
      const timeout = setTimeout(() => child.kill(), timeoutMs + FETCHER_GRACE_MS);
      try {
        await once(child, "exit");
      } finally {
        clearTimeout(timeout);
      }
      if (Buffer.byteLength(response, "utf8") > MAX_FETCHER_RESPONSE_BYTES) {
        throw new FetchBoundaryError("RESPONSE_TOO_LARGE", "fetcher sidecar response exceeds the safe bound");
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(response.trim()) as Record<string, unknown>;
      } catch {
        throw new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar returned an invalid response");
      }
      if (parsed.id !== id || parsed.ok !== true) {
        const code = parsed.code === "TIMEOUT" ? "TIMEOUT" : "HTTP_STATUS";
        throw new FetchBoundaryError(code, typeof parsed.message === "string" ? parsed.message : "fetcher sidecar request failed");
      }
      return parsed;
}
