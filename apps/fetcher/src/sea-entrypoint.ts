import { createInterface } from "node:readline";

import { createNodeFetchTransport } from "./node-transport.ts";
import type { FetchRequestPlan } from "./fetch-source.ts";

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

async function handle(line: string): Promise<Record<string, unknown>> {
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
    const transport = createNodeFetchTransport();
    if (input.kind === "resolve") {
      if (typeof input.hostname !== "string" || input.hostname.length === 0 || input.hostname.length > 253) throw new Error("invalid hostname");
      return { id: input.id, ok: true, addresses: await transport.resolve(input.hostname) };
    }
    if (!input.plan || typeof input.plan.url !== "string" || !Array.isArray(input.plan.approvedAddresses)) throw new Error("invalid request plan");
    const result = await transport.request(input.plan);
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
    process.stdout.write(`${JSON.stringify(await handle(line))}\n`);
  }
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "fetcher failure"}\n`);
  process.exitCode = 1;
});
