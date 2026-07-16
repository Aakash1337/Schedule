import type { ApiConfig } from "@schedule/config";
import type { DatabaseConnection } from "@schedule/database";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  constructDormantHostedOidcPreflight,
  prepareAppAfterDormantHostedOidcPreflight,
} from "./dormant-hosted-oidc-runtime.js";

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

  it("preflights before building the normal route-closed app", async () => {
    const order: string[] = [];
    const factory = vi.fn(async () => {
      order.push("preflight");
      return Object.freeze({ marker: true }) as never;
    });
    const prepared = await prepareAppAfterDormantHostedOidcPreflight(
      { HOSTED_OIDC_PREFLIGHT: preflight } as Pick<ApiConfig, "HOSTED_OIDC_PREFLIGHT">,
      database,
      async () => {
        order.push("app");
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
