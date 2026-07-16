import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

import {
  assertPublicOidcDnsAnswers,
  directOidcHttpsFetch,
  isPublicOidcAddress,
  MAXIMUM_OIDC_RESPONSE_HEADER_BYTES,
} from "./oidc-direct-https-transport.js";

class FakeRequest extends EventEmitter {
  body: string | undefined;
  destroyedWith: Error | undefined;

  destroy(error: Error): this {
    this.destroyedWith = error;
    this.emit("error", error);
    return this;
  }

  end(body?: string): this {
    this.body = body;
    return this;
  }
}

function response(
  statusCode = 200,
  headers: Record<string, string | string[]> = { "content-type": "application/json" },
  body = '{"ok":true}',
) {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
}

function getOptions(signal = new AbortController().signal) {
  return {
    method: "GET" as const,
    redirect: "manual" as const,
    headers: new Headers({ accept: "application/json", "accept-encoding": "identity" }),
    signal,
  };
}

function postOptions(signal = new AbortController().signal) {
  return {
    method: "POST" as const,
    redirect: "manual" as const,
    credentials: "omit" as const,
    referrerPolicy: "no-referrer" as const,
    headers: new Headers({
      authorization: "Basic opaque",
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: "grant_type=authorization_code&code=opaque",
    signal,
  };
}

async function waitForRequest(): Promise<void> {
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
}

describe("direct OIDC HTTPS transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  });

  it.each([
    ["8.8.8.8", true],
    ["198.17.255.255", true],
    ["198.18.0.0", false],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["10.0.0.1", false],
    ["2606:4700:4700::1111", true],
    ["2001:db8::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["4000::1", false],
  ])("classifies %s as public=%s", (address, expected) => {
    expect(isPublicOidcAddress(address)).toBe(expected);
  });

  it("snapshots only a bounded all-public DNS answer set", () => {
    const source = [
      { address: "8.8.8.8", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ];
    const result = assertPublicOidcDnsAnswers(source);
    source[0] = { address: "127.0.0.1", family: 4 };

    expect(result).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() =>
      assertPublicOidcDnsAnswers([
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).toThrow("OIDC egress unavailable");
  });

  it("makes one direct GET through a pinned public address while preserving TLS hostname checks", async () => {
    const outgoing = new FakeRequest();
    mocks.request.mockReturnValueOnce(outgoing);
    const pending = directOidcHttpsFetch(
      "https://login.example.net/.well-known/openid-configuration",
      getOptions(),
    );
    await waitForRequest();

    expect(mocks.lookup).toHaveBeenCalledWith("login.example.net", {
      all: true,
      verbatim: true,
    });
    const requestOptions = mocks.request.mock.calls[0]![0];
    expect(requestOptions).toMatchObject({
      protocol: "https:",
      hostname: "login.example.net",
      servername: "login.example.net",
      port: 443,
      path: "/.well-known/openid-configuration",
      method: "GET",
      agent: false,
      rejectUnauthorized: true,
      maxHeaderSize: MAXIMUM_OIDC_RESPONSE_HEADER_BYTES,
    });
    const pinnedLookup = vi.fn();
    requestOptions.lookup("login.example.net", {}, pinnedLookup);
    expect(pinnedLookup).toHaveBeenCalledWith(null, "8.8.8.8", 4);

    outgoing.emit("response", response());
    const result = await pending;
    expect(result).toBeInstanceOf(Response);
    expect(result.url).toBe("https://login.example.net/.well-known/openid-configuration");
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true });
    expect(outgoing.body).toBeUndefined();
  });

  it("preserves the strict token POST shape without synthesizing proxy headers", async () => {
    const outgoing = new FakeRequest();
    mocks.request.mockReturnValueOnce(outgoing);
    const options = postOptions();
    const pending = directOidcHttpsFetch(
      "https://login.example.net/oauth/token?tenant=one",
      options,
    );
    await waitForRequest();

    const requestOptions = mocks.request.mock.calls[0]![0];
    expect(requestOptions).toMatchObject({
      hostname: "login.example.net",
      path: "/oauth/token?tenant=one",
      method: "POST",
      headers: {
        authorization: "Basic opaque",
        "content-type": "application/x-www-form-urlencoded",
      },
      agent: false,
    });
    expect(requestOptions.headers).not.toHaveProperty("proxy-authorization");
    expect(requestOptions.headers).not.toHaveProperty("x-forwarded-for");
    outgoing.emit("response", response(400));

    const result = await pending;
    expect(result.status).toBe(400);
    expect(outgoing.body).toBe(options.body);
  });

  it.each([
    "http://login.example.net/oidc",
    "https://127.0.0.1/oidc",
    "https://localhost/oidc",
    "https://login.test/oidc",
    "https://user:pass@login.example.net/oidc",
    "https://login.example.net:8443/oidc",
    "https://login.example.net/oidc#fragment",
  ])("rejects unsafe target %s before DNS", async (url) => {
    await expect(directOidcHttpsFetch(url, getOptions())).rejects.toThrow(
      "OIDC egress unavailable",
    );
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    ["automatic redirect", { ...getOptions(), redirect: "follow" as const }],
    ["ambient credentials", { ...postOptions(), credentials: "include" as const }],
    ["forbidden host header", { ...getOptions(), headers: new Headers({ host: "evil.test" }) }],
    [
      "caller-controlled content length",
      { ...postOptions(), headers: new Headers({ "content-length": "1" }) },
    ],
    ["unsupported method", { ...getOptions(), method: "PUT" as const }],
  ])("rejects %s before DNS", async (_label, options) => {
    await expect(
      directOidcHttpsFetch(
        "https://login.example.net/oidc",
        // This table intentionally exercises hostile RequestInit shapes.
        options as Parameters<typeof directOidcHttpsFetch>[1],
      ),
    ).rejects.toThrow("OIDC egress unavailable");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects a mixed DNS set before opening a request", async () => {
    mocks.lookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    await expect(
      directOidcHttpsFetch("https://login.example.net/oidc", getOptions()),
    ).rejects.toThrow("OIDC egress unavailable");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("detaches an unresolved DNS lookup when the caller aborts", async () => {
    mocks.lookup.mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = directOidcHttpsFetch(
      "https://login.example.net/oidc",
      getOptions(controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow("OIDC egress unavailable");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("redacts DNS and HTTPS failures", async () => {
    mocks.lookup.mockRejectedValueOnce(new Error("private resolver detail"));
    await expect(
      directOidcHttpsFetch("https://login.example.net/oidc", getOptions()),
    ).rejects.toEqual(new Error("OIDC egress unavailable."));

    const outgoing = new FakeRequest();
    mocks.request.mockReturnValueOnce(outgoing);
    const pending = directOidcHttpsFetch("https://login.example.net/oidc", getOptions());
    await waitForRequest();
    outgoing.emit("error", new Error("private TLS detail"));
    await expect(pending).rejects.toEqual(new Error("OIDC egress unavailable."));
  });
});
