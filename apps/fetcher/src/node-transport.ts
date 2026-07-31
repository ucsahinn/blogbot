import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";

import {
  FetchBoundaryError,
  type FetchRequestPlan,
  type FetchResponse,
  type FetchTransport
} from "./fetch-source.ts";

function responseHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : value
    ])
  );
}

async function requestPinned(plan: FetchRequestPlan): Promise<FetchResponse> {
  const parsed = new URL(plan.url);
  const approvedAddress = plan.approvedAddresses[0];
  const family = approvedAddress ? isIP(approvedAddress) : 0;
  if (!approvedAddress || family === 0) {
    throw new Error("fetch transport requires a validated IP address");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported source protocol: ${parsed.protocol}`);
  }

  return new Promise<FetchResponse>((resolve, reject) => {
    let settled = false;
    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new FetchBoundaryError("TIMEOUT", "source wall-clock deadline exceeded"));
    }, Math.max(1, (plan.deadlineAtMs ?? Date.now() + plan.timeoutMs) - Date.now()));
    const cleanup = () => clearTimeout(deadlineTimer);
    const request = (parsed.protocol === "https:" ? requestHttps : requestHttp)(
      parsed,
      {
        method: "GET",
        headers: {
          accept:
            "text/html, application/rss+xml, application/atom+xml, application/xml, text/xml, application/json",
          "accept-encoding": "identity",
          "user-agent": "BlogbotFetcher/0.1"
        },
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all === true) {
            callback(null, [{ address: approvedAddress, family }]);
            return;
          }
          callback(null, approvedAddress, family);
        }
      },
      (response) => {
        const contentEncoding = response.headers["content-encoding"]
          ?.trim()
          .toLowerCase();
        if (contentEncoding && contentEncoding !== "identity") {
          settled = true;
          cleanup();
          response.destroy();
          request.destroy();
          reject(
            new FetchBoundaryError(
              "UNSUPPORTED_CONTENT_ENCODING",
              `source response encoding is not allowed: ${contentEncoding}`
            )
          );
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > plan.maxResponseBytes
        ) {
          settled = true;
          cleanup();
          response.destroy();
          request.destroy();
          reject(
            new FetchBoundaryError(
              "RESPONSE_TOO_LARGE",
              `source response exceeded ${plan.maxResponseBytes} bytes`
            )
          );
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > plan.maxResponseBytes) {
            settled = true;
            cleanup();
            response.destroy();
            request.destroy();
            reject(
              new FetchBoundaryError(
                "RESPONSE_TOO_LARGE",
                `source response exceeded ${plan.maxResponseBytes} bytes`
              )
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders(response.headers),
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    request.setTimeout(plan.timeoutMs, () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      request.destroy();
      reject(
        new FetchBoundaryError("TIMEOUT", "source request timed out")
      );
    });
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    request.end();
  });
}

export function createNodeFetchTransport(): FetchTransport {
  return {
    async resolve(hostname) {
      return (await lookup(hostname, { all: true, verbatim: true })).map(
        ({ address }) => address
      );
    },
    request: requestPinned
  };
}
