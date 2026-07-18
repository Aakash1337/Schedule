import type { ApiConfig } from "@schedule/config";
import type { DatabaseConnection } from "@schedule/database";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  constructDormantHostedOidcPreflight,
  prepareAppAfterDormantHostedOidcPreflight,
} from "./dormant-hosted-oidc-runtime.js";
import { prepareHostedApiApp } from "./hosted-api-runtime.js";
import type { HostedAuthLifecycleDependencies } from "./hosted-auth-lifecycle.js";
import type { HostedWebShell } from "./hosted-web-shell.js";

const database = {} as DatabaseConnection;
const secret = "provider-client-secret";
const preflight = Object.freeze({
  registration: Object.freeze({
    publicOrigin: "https://schedule.example.com",
    issuer: "https://login.example.com/tenant",
    clientId: "schedule-browser",
    redirectUri: "https://schedule.example.com/v1/auth/callback",
  }),
  loginTransactionPepper: "login-transaction-pepper-with-32-bytes",
  browserSessionPepper: "browser-session-pepper-with-32-bytes",
  pkceKeyRing: Object.freeze({
    primaryKeyId: "primary",
    keys: Object.freeze({ primary: Buffer.alloc(32, 4).toString("base64url") }),
  }),
  tokenEndpointAuthentication: Object.freeze({
    method: "client_secret_basic" as const,
    clientSecret: secret,
  }),
});
const hostedShell = Object.freeze({
  html: '<div id="root"></div>',
  icon: Buffer.from("<svg/>", "utf8"),
  assets: new Map(),
}) satisfies HostedWebShell;

function hostedComposition(): HostedAuthLifecycleDependencies {
  return Object.freeze({
    authenticator: { authenticate: async () => null },
    csrfGuard: { verify: () => true },
    loginTransactionStarter: { execute: vi.fn() },
    loginTransactionConsumer: { execute: vi.fn() },
    authorizationRequestBuilder: { build: vi.fn() },
    tokenExchanger: { exchange: vi.fn() },
    identityVerifier: { verify: vi.fn() },
    identityProvisioner: { execute: vi.fn() },
    sessionIssuer: { execute: vi.fn() },
    sessionRevoker: { execute: vi.fn() },
    sessionPolicy: { idleTimeoutSeconds: 900, absoluteTtlSeconds: 86_400 },
    loginPolicy: {
      hostedOrigin: preflight.registration.publicOrigin,
      issuer: preflight.registration.issuer,
      clientId: preflight.registration.clientId,
      redirectUri: preflight.registration.redirectUri,
      returnToPath: "/",
      ttlSeconds: 300,
    },
  }) as unknown as HostedAuthLifecycleDependencies;
}

describe("dormant hosted OIDC runtime preflight", () => {
  it("does nothing when preflight is disabled", async () => {
    const factory = vi.fn();

    await expect(
      constructDormantHostedOidcPreflight({ HOSTED_OIDC_PREFLIGHT: undefined }, database, factory),
    ).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("constructs one frozen graph from the validated config and shared database", async () => {
    const composition = Object.freeze({ marker: true });
    const factory = vi.fn(async () => composition as never);

    await expect(
      constructDormantHostedOidcPreflight(
        { HOSTED_OIDC_PREFLIGHT: preflight } as Pick<ApiConfig, "HOSTED_OIDC_PREFLIGHT">,
        database,
        factory,
      ),
    ).resolves.toBe(composition);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({ database, ...preflight });
  });

  it("maps construction failures to one stable error without secret disclosure", async () => {
    const factory = vi.fn(async () => {
      throw new Error(`provider rejected ${secret}`);
    });
    const promise = constructDormantHostedOidcPreflight(
      { HOSTED_OIDC_PREFLIGHT: preflight } as Pick<ApiConfig, "HOSTED_OIDC_PREFLIGHT">,
      database,
      factory,
    );

    await expect(promise).rejects.toThrow("Hosted OIDC preflight failed.");
    await expect(promise).rejects.not.toThrow(secret);
  });

  it("closes the shared database when activated preflight fails", async () => {
    const close = vi.fn(async () => undefined);
    const failingDatabase = { close } as unknown as DatabaseConnection;
    const factory = vi.fn(async () => {
      throw new Error(`provider rejected ${secret}`);
    });

    await expect(
      prepareHostedApiApp(
        {
          HOSTED_API_MODE: "oidc",
          HOSTED_OIDC_PREFLIGHT: preflight,
          HOSTED_RATE_LIMIT_PER_MINUTE: 120,
        },
        failingDatabase,
        {},
        factory,
      ),
    ).rejects.toThrow("Hosted OIDC preflight failed.");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the shared database when the hosted shell cannot load", async () => {
    const close = vi.fn(async () => undefined);
    const failingDatabase = { close } as unknown as DatabaseConnection;
    const factory = vi.fn(async () => Object.freeze({ marker: true }) as never);
    const shellLoader = vi.fn(async () => {
      throw new Error("C:/secret/build/path");
    });
    const enableSyncCapture = vi.fn(async () => undefined);

    const promise = prepareHostedApiApp(
      {
        HOSTED_API_MODE: "oidc",
        HOSTED_OIDC_PREFLIGHT: preflight,
        HOSTED_RATE_LIMIT_PER_MINUTE: 120,
      },
      failingDatabase,
      {},
      factory,
      shellLoader,
      enableSyncCapture,
    );

    await expect(promise).rejects.toThrow("Hosted web shell could not be loaded.");
    await expect(promise).rejects.not.toThrow("secret");
    expect(enableSyncCapture).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("enables hosted work-item capture exactly once after app assembly", async () => {
    const enableSyncCapture = vi.fn(async () => undefined);
    const shellLoader = vi.fn(async () => hostedShell);
    const prepared = await prepareHostedApiApp(
      {
        HOSTED_API_MODE: "oidc",
        HOSTED_OIDC_PREFLIGHT: preflight,
        HOSTED_RATE_LIMIT_PER_MINUTE: 120,
      },
      database,
      {},
      vi.fn(async () => hostedComposition()),
      shellLoader,
      enableSyncCapture,
    );
    try {
      expect(shellLoader).toHaveBeenCalledOnce();
      expect(enableSyncCapture).toHaveBeenCalledOnce();
      expect(enableSyncCapture).toHaveBeenCalledWith(database);
    } finally {
      await prepared.app.close();
    }
  });

  it("fails closed and releases the database when capture activation fails", async () => {
    const close = vi.fn(async () => undefined);
    const failingDatabase = { close } as unknown as DatabaseConnection;
    const enableSyncCapture = vi.fn(async () => {
      throw new Error(`capture rejected ${secret}`);
    });
    const promise = prepareHostedApiApp(
      {
        HOSTED_API_MODE: "oidc",
        HOSTED_OIDC_PREFLIGHT: preflight,
        HOSTED_RATE_LIMIT_PER_MINUTE: 120,
      },
      failingDatabase,
      {},
      vi.fn(async () => hostedComposition()),
      vi.fn(async () => hostedShell),
      enableSyncCapture,
    );

    await expect(promise).rejects.toThrow("Hosted work-item sync capture activation failed.");
    await expect(promise).rejects.not.toThrow(secret);
    expect(enableSyncCapture).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not load the hosted shell while explicit mode is disabled", async () => {
    const shellLoader = vi.fn();
    const enableSyncCapture = vi.fn(async () => undefined);
    const prepared = await prepareHostedApiApp(
      {
        HOSTED_API_MODE: "disabled",
        HOSTED_OIDC_PREFLIGHT: preflight,
        HOSTED_RATE_LIMIT_PER_MINUTE: 120,
      },
      database,
      {},
      vi.fn(async () => Object.freeze({ marker: true }) as never),
      shellLoader,
      enableSyncCapture,
    );
    try {
      expect(shellLoader).not.toHaveBeenCalled();
      expect(enableSyncCapture).not.toHaveBeenCalled();
      expect((await prepared.app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    } finally {
      await prepared.app.close();
    }
  });

  it("preflights before building the normal route-closed app", async () => {
    const order: string[] = [];
    const factory = vi.fn(async () => {
      order.push("preflight");
      return Object.freeze({ marker: true }) as never;
    });
    const prepared = await prepareAppAfterDormantHostedOidcPreflight(
      { HOSTED_OIDC_PREFLIGHT: preflight } as Pick<ApiConfig, "HOSTED_OIDC_PREFLIGHT">,
      database,
      async (composition) => {
        order.push("app");
        expect(composition).toEqual({ marker: true });
        return buildApp({ logger: false });
      },
      factory,
    );
    try {
      expect(order).toEqual(["preflight", "app"]);
      expect(Object.isFrozen(prepared)).toBe(true);
      expect(prepared.composition).toEqual({ marker: true });
      const systemInfo = await prepared.app.inject({ method: "GET", url: "/v1/system/info" });
      expect(systemInfo.json()).toEqual({
        service: "schedule-api",
        version: "0.1.0",
        architecture: "modular-monolith",
        productEndpointsEnabled: false,
        integrationEndpointsEnabled: false,
        hostedEndpointsEnabled: false,
      });
      expect((await prepared.app.inject({ method: "GET", url: "/v1/auth/login" })).statusCode).toBe(
        404,
      );
    } finally {
      await prepared.app.close();
    }
  });
});
