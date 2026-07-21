import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  BrowserSessionPrincipal,
  BrowserSessionToken,
  ResolveBrowserSession,
} from "@schedule/application";
import type { FastifyRequest } from "fastify";

export const HOSTED_SESSION_COOKIE_NAME = "__Host-schedule_session";
export const HOSTED_CSRF_COOKIE_NAME = "__Host-schedule_csrf";
export const HOSTED_LOGIN_BINDING_COOKIE_NAME = "__Host-schedule_login";
export const HOSTED_CSRF_HEADER_NAME = "x-schedule-csrf";

const MAX_COOKIE_HEADER_BYTES = 4_096;
const MAX_COOKIE_PAIRS = 64;
const MAX_ORIGIN_HEADER_BYTES = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const COOKIE_VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u;
const EXPIRED_COOKIE_DATE = "Thu, 01 Jan 1970 00:00:00 GMT";
const DUMMY_CSRF_TOKEN = "A".repeat(43);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface BrowserSessionResolver {
  execute(token: BrowserSessionToken): ReturnType<ResolveBrowserSession["execute"]>;
}

function requestHeaderValues(request: FastifyRequest, name: string): readonly string[] {
  const values: string[] = [];
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const candidateName = rawHeaders[index];
    const candidateValue = rawHeaders[index + 1];
    if (
      typeof candidateName === "string" &&
      candidateName.toLowerCase() === name &&
      typeof candidateValue === "string"
    ) {
      values.push(candidateValue);
    }
  }
  if (values.length > 0) return values;

  // The fallback keeps the adapter usable with conforming Fastify request doubles. Real requests
  // retain rawHeaders above, which is necessary to reject duplicate fields before Node coalesces.
  const normalized = request.headers[name];
  if (typeof normalized === "string") return [normalized];
  return Array.isArray(normalized) ? normalized : [];
}

function singleBoundedHeader(
  request: FastifyRequest,
  name: string,
  maximumBytes: number,
): string | null {
  const values = requestHeaderValues(request, name);
  if (values.length !== 1) return null;
  const value = values[0];
  return value !== undefined && Buffer.byteLength(value, "utf8") <= maximumBytes ? value : null;
}

function trimOptionalWhitespace(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, "");
}

function namedCookieValue(header: string, expectedName: string): string | null {
  if (Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES) return null;
  const pairs = header.split(";");
  if (pairs.length > MAX_COOKIE_PAIRS) return null;

  let selected: string | null = null;
  for (const rawPair of pairs) {
    const pair = trimOptionalWhitespace(rawPair);
    const equals = pair.indexOf("=");
    if (equals <= 0) return null;
    const name = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (!COOKIE_NAME_PATTERN.test(name) || !COOKIE_VALUE_PATTERN.test(value)) return null;
    if (name !== expectedName) continue;
    if (selected !== null) return null;
    selected = value;
  }
  return selected;
}

function cookieHeader(request: FastifyRequest): string | null {
  return singleBoundedHeader(request, "cookie", MAX_COOKIE_HEADER_BYTES);
}

function parseSessionCookieValue(value: string): BrowserSessionToken | null {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator !== value.lastIndexOf(".")) return null;
  const selector = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  return UUID_PATTERN.test(selector) && TOKEN_PATTERN.test(secret) ? { selector, secret } : null;
}

function requireSessionToken(token: BrowserSessionToken): string {
  if (!UUID_PATTERN.test(token.selector) || !TOKEN_PATTERN.test(token.secret)) {
    throw new TypeError("The browser session token is malformed.");
  }
  return `${token.selector}.${token.secret}`;
}

function constantTimeCsrfMatch(left: string, right: string): boolean {
  const leftIsWellFormed = TOKEN_PATTERN.test(left);
  const rightIsWellFormed = TOKEN_PATTERN.test(right);
  const normalizedLeft = leftIsWellFormed ? left : DUMMY_CSRF_TOKEN;
  const normalizedRight = rightIsWellFormed ? right : DUMMY_CSRF_TOKEN;
  return (
    timingSafeEqual(Buffer.from(normalizedLeft, "ascii"), Buffer.from(normalizedRight, "ascii")) &&
    leftIsWellFormed &&
    rightIsWellFormed
  );
}

function requireCanonicalHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("The hosted browser origin must be a canonical HTTPS origin.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("The hosted browser origin must be a canonical HTTPS origin.");
  }
  return value;
}

export class HostedBrowserSessionAuthenticator {
  constructor(private readonly resolver: BrowserSessionResolver) {}

  authenticate(request: FastifyRequest): Promise<BrowserSessionPrincipal | null> {
    const token = hostedSessionTokenFromRequest(request);
    return token === null ? Promise.resolve(null) : this.resolver.execute(token);
  }
}

/** Parse the one canonical browser-session cookie without resolving or trusting its identity. */
export function hostedSessionTokenFromRequest(request: FastifyRequest): BrowserSessionToken | null {
  const header = cookieHeader(request);
  if (header === null) return null;
  const value = namedCookieValue(header, HOSTED_SESSION_COOKIE_NAME);
  return value === null ? null : parseSessionCookieValue(value);
}

/** Parse the single opaque browser binding used only by the OIDC login transaction. */
export function hostedLoginBindingFromRequest(request: FastifyRequest): string | null {
  const header = cookieHeader(request);
  if (header === null) return null;
  const value = namedCookieValue(header, HOSTED_LOGIN_BINDING_COOKIE_NAME);
  return value !== null && TOKEN_PATTERN.test(value) ? value : null;
}

export class HostedBrowserCsrfGuard {
  private readonly allowedOrigin: string;

  constructor(allowedOrigin: string) {
    this.allowedOrigin = requireCanonicalHttpsOrigin(allowedOrigin);
  }

  verify(request: FastifyRequest): boolean {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    const origin = singleBoundedHeader(request, "origin", MAX_ORIGIN_HEADER_BYTES);
    const submittedToken = singleBoundedHeader(request, HOSTED_CSRF_HEADER_NAME, 64);
    const header = cookieHeader(request);
    const cookieToken = header === null ? null : namedCookieValue(header, HOSTED_CSRF_COOKIE_NAME);
    return (
      origin === this.allowedOrigin &&
      submittedToken !== null &&
      cookieToken !== null &&
      constantTimeCsrfMatch(cookieToken, submittedToken)
    );
  }
}

export function serializeHostedSessionCookie(token: BrowserSessionToken): string {
  return `${HOSTED_SESSION_COOKIE_NAME}=${requireSessionToken(token)}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearHostedSessionCookie(): string {
  return `${HOSTED_SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=${EXPIRED_COOKIE_DATE}`;
}

export function serializeHostedLoginBindingCookie(binding: string, maxAgeSeconds: number): string {
  if (
    !TOKEN_PATTERN.test(binding) ||
    !Number.isInteger(maxAgeSeconds) ||
    maxAgeSeconds < 60 ||
    maxAgeSeconds > 900
  ) {
    throw new TypeError("The hosted login binding is malformed.");
  }
  return `${HOSTED_LOGIN_BINDING_COOKIE_NAME}=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(maxAgeSeconds)}`;
}

export function clearHostedLoginBindingCookie(): string {
  return `${HOSTED_LOGIN_BINDING_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=${EXPIRED_COOKIE_DATE}`;
}

export interface IssuedHostedCsrfProtection {
  readonly token: string;
  readonly setCookie: string;
}

export function issueHostedCsrfProtection(): IssuedHostedCsrfProtection {
  const token = randomBytes(32).toString("base64url");
  return Object.freeze({
    token,
    setCookie: `${HOSTED_CSRF_COOKIE_NAME}=${token}; Path=/; Secure; SameSite=Lax`,
  });
}

export function clearHostedCsrfCookie(): string {
  return `${HOSTED_CSRF_COOKIE_NAME}=; Path=/; Secure; SameSite=Lax; Max-Age=0; Expires=${EXPIRED_COOKIE_DATE}`;
}
