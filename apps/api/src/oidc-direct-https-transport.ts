import { lookup as nodeLookup } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

import type { FetchImplementation } from "jose";

import type { OidcTokenEndpointTransport } from "./oidc-authorization-code-token-exchange.js";
import { parseExactOidcProviderUrl } from "./oidc-provider-url.js";

export const MAXIMUM_OIDC_RESPONSE_HEADER_BYTES = 16_384;
const MAXIMUM_DNS_ANSWERS = 32;
const SPECIAL_USE_DNS_SUFFIXES = [
  ".alt",
  ".example",
  ".home.arpa",
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
  ".onion",
  ".test",
] as const;
const GET_OPTION_KEYS = new Set(["headers", "method", "redirect", "signal"]);
const POST_OPTION_KEYS = new Set([
  "body",
  "credentials",
  "headers",
  "method",
  "redirect",
  "referrerPolicy",
  "signal",
]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export interface OidcResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

function unavailable(): Error {
  return new Error("OIDC egress unavailable.");
}

function isOrdinaryDnsName(value: string): boolean {
  const host = value.toLowerCase();
  if (
    host.length > 253 ||
    !host.includes(".") ||
    host === "localhost" ||
    SPECIAL_USE_DNS_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return false;
  }
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

/** Deny by default outside globally routable IPv4 and IPv6 unicast space. */
export function isPublicOidcAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, "ipv4");
  if (family !== 6 || blockedAddresses.check(address, "ipv6")) return false;
  const firstHextet = Number.parseInt(address.split(":", 1)[0] ?? "", 16);
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

/** Snapshot and reject the complete DNS set when any answer is unsafe. */
export function assertPublicOidcDnsAnswers(
  answers: readonly OidcResolvedAddress[],
): readonly OidcResolvedAddress[] {
  if (answers.length === 0 || answers.length > MAXIMUM_DNS_ANSWERS) throw unavailable();
  const snapshot = answers.map((answer) => {
    if (
      (answer.family !== 4 && answer.family !== 6) ||
      isIP(answer.address) !== answer.family ||
      !isPublicOidcAddress(answer.address)
    ) {
      throw unavailable();
    }
    return Object.freeze({ address: answer.address, family: answer.family });
  });
  return Object.freeze(snapshot);
}

function validatedUrl(resource: string): URL {
  const url = parseExactOidcProviderUrl(resource, true);
  if (url === null || isIP(url.hostname) !== 0 || !isOrdinaryDnsName(url.hostname)) {
    throw unavailable();
  }
  return url;
}

function validatedRequest(options: RequestInit): {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
} {
  const method = options.method;
  const allowedKeys =
    method === "GET" ? GET_OPTION_KEYS : method === "POST" ? POST_OPTION_KEYS : null;
  if (
    allowedKeys === null ||
    options.redirect !== "manual" ||
    !(options.signal instanceof AbortSignal) ||
    !(options.headers instanceof Headers) ||
    Object.keys(options).some((key) => !allowedKeys.has(key)) ||
    (method === "POST" &&
      (options.credentials !== "omit" ||
        options.referrerPolicy !== "no-referrer" ||
        typeof options.body !== "string"))
  ) {
    throw unavailable();
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of options.headers) {
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) throw unavailable();
    headers[name] = value;
  }
  const safeMethod = method as "GET" | "POST";
  return Object.freeze(
    safeMethod === "GET"
      ? { method: safeMethod, headers: Object.freeze(headers), signal: options.signal }
      : {
          method: safeMethod,
          headers: Object.freeze(headers),
          body: options.body as string,
          signal: options.signal,
        },
  );
}

function resolveWithAbort(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly OidcResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(unavailable()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void nodeLookup(hostname, { all: true, verbatim: true }).then(
      (answers) => {
        finish(() => {
          try {
            resolve(
              assertPublicOidcDnsAnswers(
                answers.map((answer) => ({
                  address: answer.address,
                  family: answer.family as 4 | 6,
                })),
              ),
            );
          } catch {
            reject(unavailable());
          }
        });
      },
      () => finish(() => reject(unavailable())),
    );
  });
}

function responseHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

class OidcHttpsResponse extends Response {
  constructor(url: string, response: IncomingMessage) {
    const status = response.statusCode;
    if (status === undefined || status < 200 || status > 599) throw unavailable();
    const hasBody = status !== 204 && status !== 205 && status !== 304;
    if (!hasBody) response.resume();
    super(hasBody ? (Readable.toWeb(response) as ReadableStream<Uint8Array>) : null, {
      status,
      headers: responseHeaders(response.headers),
    });
    Object.defineProperty(this, "url", { value: url, enumerable: true });
  }
}

function requestPinned(
  resource: string,
  url: URL,
  request: ReturnType<typeof validatedRequest>,
  address: OidcResolvedAddress,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let outgoing: ReturnType<typeof httpsRequest>;
    try {
      outgoing = httpsRequest({
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: request.headers,
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: MAXIMUM_OIDC_RESPONSE_HEADER_BYTES,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        signal: request.signal,
      });
    } catch {
      reject(unavailable());
      return;
    }
    outgoing.once("error", () => reject(unavailable()));
    outgoing.once("response", (response) => {
      try {
        resolve(new OidcHttpsResponse(resource, response));
      } catch {
        response.destroy();
        reject(unavailable());
      }
    });
    outgoing.once("upgrade", (_response, socket) => {
      socket.destroy();
      outgoing.destroy(unavailable());
    });
    outgoing.end(request.body);
  });
}

export function directOidcHttpsFetch(
  resource: string,
  options: Parameters<FetchImplementation>[1],
): Promise<Response>;
export function directOidcHttpsFetch(
  resource: string,
  options: Parameters<OidcTokenEndpointTransport>[1],
): Promise<Response>;
/** Direct, proxy-free, redirect-free OIDC HTTPS transport with DNS answer pinning. */
export async function directOidcHttpsFetch(
  resource: string,
  options: RequestInit,
): Promise<Response> {
  try {
    const url = validatedUrl(resource);
    const request = validatedRequest(options);
    const answers = await resolveWithAbort(url.hostname, request.signal);
    return await requestPinned(resource, url, request, answers[0]!);
  } catch {
    throw unavailable();
  }
}
