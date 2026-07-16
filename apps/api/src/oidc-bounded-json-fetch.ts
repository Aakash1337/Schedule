import type { FetchImplementation } from "jose";

const MAXIMUM_REQUEST_HEADERS = 8;
const MAXIMUM_HEADER_NAME_BYTES = 128;
const MAXIMUM_HEADER_VALUE_BYTES = 1_024;
const MAXIMUM_CONFIGURED_BODY_BYTES = 1024 * 1_024;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "forwarded",
  "proxy-authorization",
  "proxy-connection",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export interface BoundedOidcJsonFetchOptions {
  readonly url: string;
  readonly transport: FetchImplementation;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
  readonly requestHeaders: Headers;
  readonly maximumBodyBytes: number;
  readonly acceptedContentTypes: readonly string[];
}

/** Stable internal failure; callers map it to their own public redacted error contract. */
export class OidcBoundedJsonFetchError extends Error {
  constructor() {
    super("The trusted OIDC JSON document is unavailable.");
    this.name = "OidcBoundedJsonFetchError";
  }
}

function unavailable(): OidcBoundedJsonFetchError {
  return new OidcBoundedJsonFetchError();
}

function trustedRequestHeaders(headers: Headers): Headers {
  const snapshot = new Headers(headers);
  let headerCount = 0;
  for (const [name, value] of snapshot) {
    headerCount += 1;
    const normalizedName = name.toLowerCase();
    if (
      headerCount > MAXIMUM_REQUEST_HEADERS ||
      FORBIDDEN_REQUEST_HEADERS.has(normalizedName) ||
      normalizedName.startsWith("x-forwarded-") ||
      Buffer.byteLength(name, "utf8") > MAXIMUM_HEADER_NAME_BYTES ||
      Buffer.byteLength(value, "utf8") > MAXIMUM_HEADER_VALUE_BYTES
    ) {
      throw unavailable();
    }
  }
  snapshot.set("accept-encoding", "identity");
  return snapshot;
}

function safeContentLength(headers: Headers, maximumBodyBytes: number): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw unavailable();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximumBodyBytes) throw unavailable();
  return value;
}

async function readBoundedBody(response: Response, maximumBodyBytes: number): Promise<Uint8Array> {
  const declaredLength = safeContentLength(response.headers, maximumBodyBytes);
  if (response.body === null) throw unavailable();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maximumBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw unavailable();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && declaredLength !== total) throw unavailable();
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function trustedContentTypes(values: readonly string[]): ReadonlySet<string> {
  if (values.length === 0 || values.length > 4) throw unavailable();
  const normalized = values.map((value) => value.toLowerCase());
  if (
    normalized.some((value) => !/^application\/[a-z0-9!#$&^_.+-]+$/u.test(value)) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw unavailable();
  }
  return new Set(normalized);
}

function parseJson(body: Uint8Array): unknown {
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(json) as unknown;
  } catch {
    throw unavailable();
  }
}

async function withAbortingDeadline<T>(
  upstreamSignal: AbortSignal,
  timeoutMilliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (upstreamSignal.aborted) throw unavailable();
  const controller = new AbortController();
  const signal = AbortSignal.any([upstreamSignal, controller.signal]);
  let timeout: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(unavailable());
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(unavailable());
      }, timeoutMilliseconds);
      timeout.unref();
    });
    return await Promise.race([operation(signal), cancellation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }
}

/**
 * Retrieves one exact trusted OIDC JSON document without following redirects or buffering an
 * unbounded body. The injected transport remains responsible for DNS, IP, proxy, and TLS policy.
 */
export async function fetchBoundedOidcJson(options: BoundedOidcJsonFetchOptions): Promise<unknown> {
  try {
    if (
      typeof options.url !== "string" ||
      options.url.length === 0 ||
      typeof options.transport !== "function" ||
      !(options.signal instanceof AbortSignal) ||
      !Number.isSafeInteger(options.timeoutMilliseconds) ||
      options.timeoutMilliseconds < 100 ||
      options.timeoutMilliseconds > 10_000 ||
      !(options.requestHeaders instanceof Headers) ||
      !Number.isSafeInteger(options.maximumBodyBytes) ||
      options.maximumBodyBytes < 1 ||
      options.maximumBodyBytes > MAXIMUM_CONFIGURED_BODY_BYTES
    ) {
      throw unavailable();
    }
    const acceptedContentTypes = trustedContentTypes(options.acceptedContentTypes);
    const requestHeaders = trustedRequestHeaders(options.requestHeaders);
    return await withAbortingDeadline(
      options.signal,
      options.timeoutMilliseconds,
      async (signal) => {
        const response = await options.transport(options.url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: requestHeaders,
        });
        if (
          !(response instanceof Response) ||
          response.status !== 200 ||
          response.redirected ||
          (response.url.length > 0 && response.url !== options.url)
        ) {
          throw unavailable();
        }

        const rawContentType = response.headers.get("content-type");
        const contentType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType === undefined || !acceptedContentTypes.has(contentType))
          throw unavailable();
        return parseJson(await readBoundedBody(response, options.maximumBodyBytes));
      },
    );
  } catch {
    throw unavailable();
  }
}
