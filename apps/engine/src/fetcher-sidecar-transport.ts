import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  FetchBoundaryError,
  type FetchBoundaryCode,
  type FetchResponse,
  type FetchTransport
} from "../../fetcher/src/fetch-source.ts";

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

export interface FetcherSidecarTransportOptions {
  args?: string[];
  onSpawn?: () => void;
}

export type ManagedFetcherTransport = FetchTransport & {
  close(): Promise<void>;
};

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Executes network parsing in one reusable, isolated process with no engine
 * data key, PGlite location, Codex configuration, or inherited user
 * environment. The process is recycled after protocol failures or crashes.
 */
export function createFetcherSidecarTransport(
  executable: string,
  options: FetcherSidecarTransportOptions = {}
): ManagedFetcherTransport {
  let activeChild: ChildProcess | undefined;
  let closed = false;
  const pending = new Map<string, PendingRequest>();

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const retireChild = (child: ChildProcess, error: Error, kill: boolean): void => {
    if (activeChild !== child) return;
    activeChild = undefined;
    rejectPending(error);
    if (kill && child.exitCode === null && !child.killed) child.kill();
  };

  const acceptLine = (child: ChildProcess, line: string): void => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      retireChild(
        child,
        new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar returned an invalid response"),
        true
      );
      return;
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (parsed.ok === true) {
      request.resolve(parsed);
      return;
    }
    const code: FetchBoundaryCode = parsed.code === "TIMEOUT" ? "TIMEOUT" : "HTTP_STATUS";
    request.reject(new FetchBoundaryError(
      code,
      typeof parsed.message === "string" ? parsed.message : "fetcher sidecar request failed"
    ));
  };

  const startChild = (): ChildProcess => {
    if (closed) throw new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar transport is closed");
    if (activeChild && activeChild.exitCode === null && !activeChild.killed) return activeChild;

    const child = spawn(executable, options.args ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: scrubbedFetcherEnvironment()
    });
    activeChild = child;
    options.onSpawn?.();
    let responseBuffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (activeChild !== child) return;
      responseBuffer += chunk;
      if (Buffer.byteLength(responseBuffer, "utf8") > MAX_FETCHER_RESPONSE_BYTES) {
        retireChild(
          child,
          new FetchBoundaryError("RESPONSE_TOO_LARGE", "fetcher sidecar response exceeds the safe bound"),
          true
        );
        return;
      }
      for (;;) {
        const newline = responseBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = responseBuffer.slice(0, newline).trim();
        responseBuffer = responseBuffer.slice(newline + 1);
        if (line) acceptLine(child, line);
        if (activeChild !== child) break;
      }
    });
    child.once("error", () => {
      retireChild(
        child,
        new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar could not start"),
        false
      );
    });
    child.once("exit", () => {
      retireChild(
        child,
        new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar stopped before responding"),
        false
      );
    });
    child.stdin?.on("error", () => {
      retireChild(
        child,
        new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar input closed unexpectedly"),
        true
      );
    });
    return child;
  };

  const invokeFetcher = (
    request: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> => {
    const id = randomUUID();
    const child = startChild();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        retireChild(
          child,
          new FetchBoundaryError("TIMEOUT", "fetcher sidecar request timed out"),
          true
        );
      }, timeoutMs + FETCHER_GRACE_MS);
      pending.set(id, { resolve, reject, timer });
      const line = `${JSON.stringify({ id, ...request })}\n`;
      if (!child.stdin?.writable) {
        retireChild(
          child,
          new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar input is unavailable"),
          true
        );
        return;
      }
      child.stdin.write(line, (error) => {
        if (error) {
          retireChild(
            child,
            new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar request could not be sent"),
            true
          );
        }
      });
    });
  };

  return {
    async resolve(hostname) {
      const parsed = await invokeFetcher({ kind: "resolve", hostname }, 8_000);
      if (!Array.isArray(parsed.addresses) || !parsed.addresses.every((value) => typeof value === "string")) {
        throw new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar returned invalid DNS data");
      }
      return parsed.addresses;
    },
    async request(plan) {
      const parsed = await invokeFetcher(
        { kind: "request", plan },
        Math.max(1, (plan.deadlineAtMs ?? Date.now() + plan.timeoutMs) - Date.now())
      );
      if (typeof parsed.status !== "number" || !parsed.headers || typeof parsed.headers !== "object" || typeof parsed.bodyBase64 !== "string") {
        throw new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar returned an invalid response");
      }
      const body = Buffer.from(parsed.bodyBase64, "base64");
      if (body.byteLength > plan.maxResponseBytes) {
        throw new FetchBoundaryError("RESPONSE_TOO_LARGE", "fetcher sidecar exceeded the requested byte limit");
      }
      return { status: parsed.status, headers: parsed.headers as FetchResponse["headers"], body };
    },
    async close() {
      if (closed) return;
      closed = true;
      const child = activeChild;
      activeChild = undefined;
      rejectPending(new FetchBoundaryError("HTTP_STATUS", "fetcher sidecar transport closed"));
      if (!child || child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin?.end();
      let closeTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, FETCHER_GRACE_MS);
          closeTimer.unref?.();
        })
      ]);
      if (closeTimer) clearTimeout(closeTimer);
      if (child.exitCode === null && !child.killed) child.kill();
    }
  };
}
