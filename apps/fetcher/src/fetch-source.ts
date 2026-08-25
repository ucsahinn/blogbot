import {
  assertSafeSourceUrl,
  validateResolvedAddresses
} from "../../../packages/security/src/url-policy.ts";

export type FetchBoundaryCode =
  | "TIMEOUT"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "TOO_MANY_REDIRECTS"
  | "INVALID_REDIRECT"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "HTTP_STATUS";

export class FetchBoundaryError extends Error {
  constructor(
    readonly code: FetchBoundaryCode,
    message: string
  ) {
    super(message);
    this.name = "FetchBoundaryError";
  }
}

export interface FetchRequestPlan {
  url: string;
  approvedAddresses: string[];
  redirect: "manual";
  timeoutMs: number;
  /** Wall-clock deadline for the whole hop, including slow-drip bodies. */
  deadlineAtMs?: number;
  maxResponseBytes: number;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

export interface FetchTransport {
  resolve(hostname: string): Promise<string[]>;
  request(plan: FetchRequestPlan): Promise<FetchResponse>;
  close?(): Promise<void>;
}

export interface FetchSourceOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: string[];
}

export interface FetchedSource {
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
}

export const MAX_FETCH_TIMEOUT_MS = 30_000;
export const MAX_FETCH_RESPONSE_BYTES = 2_000_000;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const defaultAllowedContentTypes = [
  "text/html",
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "application/json"
];

function headerValue(
  headers: Record<string, string | undefined>,
  name: string
): string | undefined {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return match?.[1];
}

function mediaType(contentType: string | undefined): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function withinDeadline<T>(work: Promise<T>, deadlineAtMs: number): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new FetchBoundaryError("TIMEOUT", "source wall-clock deadline exceeded"));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FetchBoundaryError("TIMEOUT", "source wall-clock deadline exceeded"));
    }, remainingMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function fetchSource(
  inputUrl: string,
  transport: FetchTransport,
  options: FetchSourceOptions = {}
): Promise<FetchedSource> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FETCH_TIMEOUT_MS) {
    throw new RangeError(`source timeout must be within 1..${MAX_FETCH_TIMEOUT_MS} ms`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FETCH_RESPONSE_BYTES) {
    throw new RangeError(`source max bytes must be within 1..${MAX_FETCH_RESPONSE_BYTES}`);
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new RangeError("source redirect bound must be within 0..10");
  }
  const allowedContentTypes = new Set(
    options.allowedContentTypes ?? defaultAllowedContentTypes
  );
  let currentUrl = assertSafeSourceUrl(inputUrl);
  // One source fetch has one budget. Redirects are additional trust-boundary
  // checks, not a reason to grant a fresh full timeout on every hop.
  const deadlineAtMs = Date.now() + timeoutMs;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const parsed = new URL(currentUrl);
    const approvedAddresses = validateResolvedAddresses(await withinDeadline(
      transport.resolve(parsed.hostname),
      deadlineAtMs
    ));
    const response = await withinDeadline(transport.request({
      url: currentUrl,
      approvedAddresses,
      redirect: "manual",
      timeoutMs,
      deadlineAtMs,
      maxResponseBytes: maxBytes
    }), deadlineAtMs);

    if (redirectStatuses.has(response.status)) {
      if (redirectCount >= maxRedirects) {
        throw new FetchBoundaryError(
          "TOO_MANY_REDIRECTS",
          `source exceeded ${maxRedirects} redirects`
        );
      }
      const location = headerValue(response.headers, "location");
      if (!location) {
        throw new FetchBoundaryError(
          "INVALID_REDIRECT",
          "redirect response did not include a location"
        );
      }
      currentUrl = assertSafeSourceUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new FetchBoundaryError(
        "HTTP_STATUS",
        `source returned HTTP ${response.status}`
      );
    }
    if (response.body.byteLength > maxBytes) {
      throw new FetchBoundaryError(
        "RESPONSE_TOO_LARGE",
        `source response exceeded ${maxBytes} bytes`
      );
    }

    const contentType = mediaType(headerValue(response.headers, "content-type"));
    if (!allowedContentTypes.has(contentType)) {
      throw new FetchBoundaryError(
        "UNSUPPORTED_CONTENT_TYPE",
        `source response type is not allowed: ${contentType || "missing"}`
      );
    }

    return { finalUrl: currentUrl, contentType, body: response.body };
  }
}
