import { browserSessionId, userId } from "@schedule/domain";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  clearHostedCsrfCookie,
  clearHostedLoginBindingCookie,
  clearHostedSessionCookie,
  hostedLoginBindingFromRequest,
  HostedBrowserCsrfGuard,
  HostedBrowserSessionAuthenticator,
  HOSTED_CSRF_COOKIE_NAME,
  HOSTED_CSRF_HEADER_NAME,
  HOSTED_LOGIN_BINDING_COOKIE_NAME,
  HOSTED_SESSION_COOKIE_NAME,
  issueHostedCsrfProtection,
  serializeHostedLoginBindingCookie,
  serializeHostedSessionCookie,
} from "./hosted-browser-session.js";

const SELECTOR = "a0000000-0000-4000-8000-000000000201";
const SECRET = "A".repeat(43);
const CSRF_TOKEN = "B".repeat(43);
const LOGIN_BINDING = "C".repeat(43);
const ORIGIN = "https://hosted.schedule.test";
const SESSION_COOKIE = `${HOSTED_SESSION_COOKIE_NAME}=${SELECTOR}.${SECRET}`;
const CSRF_COOKIE = `${HOSTED_CSRF_COOKIE_NAME}=${CSRF_TOKEN}`;
const principal = {
  userId: userId("00000000-0000-4000-8000-000000000101"),
  sessionId: browserSessionId(SELECTOR),
  idleExpiresAt: new Date("2026-07-15T01:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-07-16T00:00:00.000Z"),
};

function requestFor(
  rawHeaders: ReadonlyArray<readonly [string, string]>,
  method = "GET",
): FastifyRequest {
  const normalized: Record<string, string | string[]> = {};
  for (const [name, value] of rawHeaders) {
    const key = name.toLowerCase();
    const existing = normalized[key];
    normalized[key] =
      existing === undefined
        ? value
        : Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
  }
  return {
    method,
    headers: normalized,
    raw: { rawHeaders: rawHeaders.flatMap(([name, value]) => [name, value]) },
  } as unknown as FastifyRequest;
}

describe("dormant hosted browser-session transport", () => {
  it("round-trips one hardened OIDC login-binding cookie", () => {
    expect(
      hostedLoginBindingFromRequest(
        requestFor([
          ["Cookie", `theme=dark; ${HOSTED_LOGIN_BINDING_COOKIE_NAME}=${LOGIN_BINDING}`],
        ]),
      ),
    ).toBe(LOGIN_BINDING);
    expect(
      hostedLoginBindingFromRequest(
        requestFor([
          [
            "Cookie",
            `${HOSTED_LOGIN_BINDING_COOKIE_NAME}=${LOGIN_BINDING}; ${HOSTED_LOGIN_BINDING_COOKIE_NAME}=${LOGIN_BINDING}`,
          ],
        ]),
      ),
    ).toBeNull();
    expect(serializeHostedLoginBindingCookie(LOGIN_BINDING, 300)).toBe(
      `${HOSTED_LOGIN_BINDING_COOKIE_NAME}=${LOGIN_BINDING}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`,
    );
    expect(() => serializeHostedLoginBindingCookie("malformed", 300)).toThrow(
      "hosted login binding is malformed",
    );
    expect(() => serializeHostedLoginBindingCookie(LOGIN_BINDING, 59)).toThrow(
      "hosted login binding is malformed",
    );
    expect(clearHostedLoginBindingCookie()).toBe(
      `${HOSTED_LOGIN_BINDING_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  });

  it("resolves exactly one bounded canonical session cookie without trusting spoofed headers", async () => {
    const execute = vi.fn(async () => principal);
    const authenticator = new HostedBrowserSessionAuthenticator({ execute });

    await expect(
      authenticator.authenticate(
        requestFor([
          ["Cookie", `theme=dark; ${SESSION_COOKIE}; locale=en`],
          ["X-User-Id", "attacker-controlled"],
        ]),
      ),
    ).resolves.toBe(principal);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ selector: SELECTOR, secret: SECRET });
  });

  it.each([
    [
      "64 cookie pairs",
      `${Array.from({ length: 63 }, (_, index) => `c${index}=x`).join("; ")}; ${SESSION_COOKIE}`,
      64,
      null,
    ],
    [
      "4096 header bytes",
      (() => {
        const framing = `padding=; ${SESSION_COOKIE}`;
        return `padding=${"A".repeat(4_096 - Buffer.byteLength(framing, "utf8"))}; ${SESSION_COOKIE}`;
      })(),
      2,
      4_096,
    ],
  ])("accepts the exact %s transport boundary", async (_label, cookie, pairs, bytes) => {
    expect(cookie.split(";")).toHaveLength(pairs);
    if (bytes !== null) expect(Buffer.byteLength(cookie, "utf8")).toBe(bytes);
    const execute = vi.fn(async () => principal);
    const authenticator = new HostedBrowserSessionAuthenticator({ execute });

    await expect(authenticator.authenticate(requestFor([["Cookie", cookie]]))).resolves.toBe(
      principal,
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", []],
    ["unrelated", [["Cookie", "theme=dark"]]],
    ["empty", [["Cookie", `${HOSTED_SESSION_COOKIE_NAME}=`]]],
    ["missing separator", [["Cookie", `${HOSTED_SESSION_COOKIE_NAME}=${SELECTOR}${SECRET}`]]],
    ["multiple separators", [["Cookie", `${SESSION_COOKIE}.extra`]]],
    [
      "uppercase selector",
      [["Cookie", `${HOSTED_SESSION_COOKIE_NAME}=${SELECTOR.toUpperCase()}.${SECRET}`]],
    ],
    ["short secret", [["Cookie", `${HOSTED_SESSION_COOKIE_NAME}=${SELECTOR}.${SECRET.slice(1)}`]]],
    [
      "encoded secret",
      [["Cookie", `${HOSTED_SESSION_COOKIE_NAME}=${SELECTOR}.%${SECRET.slice(1)}`]],
    ],
    ["name whitespace", [["Cookie", `${HOSTED_SESSION_COOKIE_NAME} =${SELECTOR}.${SECRET}`]]],
    ["value whitespace", [["Cookie", `${HOSTED_SESSION_COOKIE_NAME}= ${SELECTOR}.${SECRET}`]]],
    ["duplicate cookie", [["Cookie", `${SESSION_COOKIE}; ${SESSION_COOKIE}`]]],
    ["comma ambiguity", [["Cookie", `${SESSION_COOKIE}, ${SESSION_COOKIE}`]]],
    ["lookalike name", [["Cookie", `${HOSTED_SESSION_COOKIE_NAME}Suffix=${SELECTOR}.${SECRET}`]]],
    ["empty pair", [["Cookie", `theme=dark;; ${SESSION_COOKIE}`]]],
    ["oversized header", [["Cookie", `padding=${"A".repeat(4_096)}; ${SESSION_COOKIE}`]]],
    [
      "too many pairs",
      [
        [
          "Cookie",
          `${Array.from({ length: 64 }, (_, index) => `c${index}=x`).join(";")};${SESSION_COOKIE}`,
        ],
      ],
    ],
    [
      "duplicate raw header",
      [
        ["Cookie", SESSION_COOKIE],
        ["Cookie", "theme=dark"],
      ],
    ],
  ] as const)("rejects %s transport input before session resolution", async (_label, headers) => {
    const execute = vi.fn(async () => principal);
    const authenticator = new HostedBrowserSessionAuthenticator({ execute });

    await expect(authenticator.authenticate(requestFor(headers))).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves null and internal resolver outcomes for the central boundary", async () => {
    const unavailable = new Error("private resolver diagnostic");
    const returnsNull = new HostedBrowserSessionAuthenticator({
      execute: vi.fn(async () => null),
    });
    const rejects = new HostedBrowserSessionAuthenticator({
      execute: vi.fn(async () => {
        throw unavailable;
      }),
    });
    const request = requestFor([["Cookie", SESSION_COOKIE]]);

    await expect(returnsNull.authenticate(request)).resolves.toBeNull();
    await expect(rejects.authenticate(request)).rejects.toBe(unavailable);
  });

  it("serializes and clears a host-only server-expiring browser session", () => {
    const issued = serializeHostedSessionCookie({ selector: SELECTOR, secret: SECRET });
    expect(issued).toBe(`${SESSION_COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect(issued).not.toContain("Domain=");
    expect(issued).not.toContain("Expires=");
    expect(issued).not.toContain("Max-Age=");
    expect(() => serializeHostedSessionCookie({ selector: SELECTOR, secret: "bad;value" })).toThrow(
      "browser session token is malformed",
    );

    const cleared = clearHostedSessionCookie();
    expect(cleared).toContain(`${HOSTED_SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly`);
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cleared).not.toContain("Domain=");
  });
});

describe("dormant hosted browser CSRF transport", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "allows the safe %s method without browser proof",
    (method) => {
      expect(new HostedBrowserCsrfGuard(ORIGIN).verify(requestFor([], method))).toBe(true);
    },
  );

  it("accepts only the exact configured origin and matching double-submit proof", () => {
    const guard = new HostedBrowserCsrfGuard(ORIGIN);
    const request = requestFor(
      [
        ["Origin", ORIGIN],
        ["Cookie", `theme=dark; ${CSRF_COOKIE}`],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
      "POST",
    );
    expect(guard.verify(request)).toBe(true);
  });

  it.each([
    [
      "missing origin",
      [
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
    [
      "null origin",
      [
        ["Origin", "null"],
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
    [
      "trailing slash",
      [
        ["Origin", `${ORIGIN}/`],
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
    [
      "attacker origin",
      [
        ["Origin", "https://attacker.test"],
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
    [
      "missing cookie",
      [
        ["Origin", ORIGIN],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
    [
      "duplicate cookie",
      [
        ["Origin", ORIGIN],
        ["Cookie", `${CSRF_COOKIE}; ${CSRF_COOKIE}`],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
    [
      "missing header token",
      [
        ["Origin", ORIGIN],
        ["Cookie", CSRF_COOKIE],
      ],
    ],
    [
      "mismatched token",
      [
        ["Origin", ORIGIN],
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, "C".repeat(43)],
      ],
    ],
    [
      "malformed token",
      [
        ["Origin", ORIGIN],
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, "short"],
      ],
    ],
    [
      "duplicate origin header",
      [
        ["Origin", ORIGIN],
        ["Origin", ORIGIN],
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
    [
      "duplicate proof header",
      [
        ["Origin", ORIGIN],
        ["Cookie", CSRF_COOKIE],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
        [HOSTED_CSRF_HEADER_NAME, CSRF_TOKEN],
      ],
    ],
  ] as const)("rejects unsafe requests with %s", (_label, headers) => {
    expect(new HostedBrowserCsrfGuard(ORIGIN).verify(requestFor(headers, "PATCH"))).toBe(false);
  });

  it.each([
    "http://hosted.schedule.test",
    `${ORIGIN}/`,
    `${ORIGIN}/path`,
    "HTTPS://hosted.schedule.test",
    "not-an-origin",
  ])("rejects the noncanonical configured origin %s", (origin) => {
    expect(() => new HostedBrowserCsrfGuard(origin)).toThrow("canonical HTTPS origin");
  });

  it("issues independent script-readable host-only CSRF cookies and clears them exactly", () => {
    const first = issueHostedCsrfProtection();
    const second = issueHostedCsrfProtection();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second.token).not.toBe(first.token);
    expect(first.setCookie).toBe(
      `${HOSTED_CSRF_COOKIE_NAME}=${first.token}; Path=/; Secure; SameSite=Lax`,
    );
    expect(first.setCookie).not.toContain("HttpOnly");
    expect(first.setCookie).not.toContain("Domain=");

    const cleared = clearHostedCsrfCookie();
    expect(cleared).toContain(`${HOSTED_CSRF_COOKIE_NAME}=; Path=/; Secure; SameSite=Lax`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cleared).not.toContain("HttpOnly");
    expect(cleared).not.toContain("Domain=");
  });
});
