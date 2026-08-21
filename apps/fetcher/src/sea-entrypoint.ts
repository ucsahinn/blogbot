import { createInterface } from "node:readline";

import { createNodeFetchTransport } from "./node-transport.ts";
import {
  assertSafeSourceUrl,
  validateResolvedAddresses
} from "../../../packages/security/src/url-policy.ts";
import {
  MAX_FETCH_RESPONSE_BYTES,
  MAX_FETCH_TIMEOUT_MS,
  type FetchRequestPlan,
  type FetchTransport
} from "./fetch-source.ts";

declare const __BLOGBOT_FETCHER_SEA__: boolean | undefined;

const MAX_REQUEST_BYTES = 64 * 1024;

type FetchRequest = {
  id: string;
  kind: "resolve" | "request";
  hostname?: string;
  plan?: FetchRequestPlan;
};

function isRequest(value: unknown): value is FetchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id.length > 0 && record.id.length <= 200 &&
    (record.kind === "resolve" || record.kind === "request");
}

export function normalizeFetchRequestPlan(value: unknown): FetchRequestPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as Record<string, unknown>;
  if (
    typeof plan.url !== "string" || plan.url.length === 0 || plan.url.length > 4_096 ||
    !Array.isArray(plan.approvedAddresses) || plan.approvedAddresses.length === 0 || plan.approvedAddresses.length > 16 ||
    plan.approvedAddresses.some((address) => typeof address !== "string" || address.length === 0 || address.length > 64) ||
    plan.redirect !== "manual" ||
    !Number.isSafeInteger(plan.timeoutMs) || Number(plan.timeoutMs) < 1 || Number(plan.timeoutMs) > MAX_FETCH_TIMEOUT_MS ||
    !Number.isSafeInteger(plan.maxResponseBytes) || Number(plan.maxResponseBytes) < 1 || Number(plan.maxResponseBytes) > MAX_FETCH_RESPONSE_BYTES
  ) {
    return null;
  }
  if (plan.deadlineAtMs !== undefined) {
    if (!Number.isSafeInteger(plan.deadlineAtMs) || Number(plan.deadlineAtMs) < 1) return null;
    if (Number(plan.deadlineAtMs) > Date.now() + Number(plan.timeoutMs) + 1_000) return null;
  }
  try {
    const url = assertSafeSourceUrl(plan.url);
    const approvedAddresses = validateResolvedAddresses(plan.approvedAddresses as string[]);
    return {
      url,
      approvedAddresses,
      redirect: "manual",
      timeoutMs: Number(plan.timeoutMs),
      ...(plan.deadlineAtMs === undefined ? {} : { deadlineAtMs: Number(plan.deadlineAtMs) }),
      maxResponseBytes: Number(plan.maxResponseBytes)
    };
  } catch {
    return null;
  }
}

export function validateFetchRequestPlan(value: unknown): value is FetchRequestPlan {
  return normalizeFetchRequestPlan(value) !== null;
}

function normalizeResolveHostname(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253 || value !== value.trim()) {
    throw new Error("invalid hostname");
  }
  const normalizedUrl = assertSafeSourceUrl(`https://${value}/`);
  const hostname = new URL(normalizedUrl).hostname;
  const comparableInput = value.toLowerCase().endsWith(".")
    ? value.toLowerCase().slice(0, -1)
    : value.toLowerCase();
  if (hostname.toLowerCase() !== comparableInput) {
    throw new Error("invalid hostname");
  }
  return hostname;
}

export async function handleFetcherRequestLine(
  line: string,
  transport: FetchTransport = createNodeFetchTransport()
): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    return { ok: false, code: "FETCHER_REQUEST_TOO_LARGE", message: "Fetcher request exceeds the safe bound" };
  }
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    return { ok: false, code: "FETCHER_REQUEST_INVALID", message: "Fetcher request is not valid JSON" };
  }
  if (!isRequest(input)) {
    return { ok: false, code: "FETCHER_REQUEST_INVALID", message: "Fetcher request shape is invalid" };
  }
  try {
    if (input.kind === "resolve") {
      const hostname = normalizeResolveHostname(input.hostname);
      const addresses = validateResolvedAddresses(await transport.resolve(hostname));
      return { id: input.id, ok: true, addresses };
    }
    const plan = normalizeFetchRequestPlan(input.plan);
    if (!plan) throw new Error("invalid request plan");
    const result = await transport.request(plan);
    return {
      id: input.id,
      ok: true,
      status: result.status,
      headers: result.headers,
      bodyBase64: Buffer.from(result.body).toString("base64")
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "FETCHER_REQUEST_FAILED";
    return { id: input.id, ok: false, code, message: error instanceof Error ? error.message.slice(0, 500) : "Fetcher request failed" };
  }
}

async function run(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    process.stdout.write(`${JSON.stringify(await handleFetcherRequestLine(line))}\n`);
  }
}

if (typeof __BLOGBOT_FETCHER_SEA__ !== "undefined" && __BLOGBOT_FETCHER_SEA__) {
  void run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "fetcher failure"}\n`);
    process.exitCode = 1;
  });
}
