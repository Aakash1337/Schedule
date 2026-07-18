import { createHash } from "node:crypto";

import { DomainError, workspaceId } from "@schedule/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  INTEGRATION_API_VERSION,
  parseIntegrationAuthorization,
  type IntegrationServices,
} from "./integration-routes.js";

const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "00000000-0000-4000-8000-000000000003";
const CONFIRMATION_ID = "00000000-0000-4000-8000-000000000004";
const RESOURCE_ID = "00000000-0000-4000-8000-000000000005";
const PLAN_ID = "00000000-0000-4000-8000-000000000006";
const ITEM_ID = "00000000-0000-4000-8000-000000000007";
const CLAIM_TOKEN = "00000000-0000-4000-8000-000000000008";
const CASE_CREDENTIAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const AUTHORIZATION = `Bearer ${CREDENTIAL_ID}.${SECRET}`;

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Test commands must be JSON-serializable.");
  return encoded;
}

function commandDisplay(command: unknown): string {
  return canonicalJson(command).replace(
    /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

function integrationServices(): IntegrationServices {
  return {
    authenticateCredential: vi.fn(async () => ({
      credentialId: CREDENTIAL_ID,
      workspaceId: workspaceId(WORKSPACE_ID),
      scopes: ["schedule:read", "schedule:write", "schedule:delivery"],
    })),
    getToday: vi.fn(async () => ({ date: "2026-07-13", plan: null }) as never),
    getDailyPlanFitInsight: vi.fn(
      async () =>
        ({
          forDate: "2026-07-13",
          status: "suggested",
          disposition: "available",
          sampleCount: 4,
          minimumSamples: 3,
          suggestedTargetMinutes: 90,
          suggestedTargetTaskCount: 3,
        }) as never,
    ),
    listWorkItems: vi.fn(
      async () =>
        ({
          items: [
            {
              id: RESOURCE_ID,
              workspaceId: WORKSPACE_ID,
              title: "Call the dentist",
              description: null,
              status: "planned",
              priority: "high",
              planningDurationMinutes: 45,
              dueOn: "2026-07-15",
              version: 3,
              createdAt: "2026-07-13T12:00:00.000Z",
              updatedAt: "2026-07-13T13:00:00.000Z",
            },
          ],
          page: { limit: 100, offset: 0 },
        }) as never,
    ),
    listScheduleBlocks: vi.fn(
      async () =>
        ({
          items: [
            {
              id: RESOURCE_ID,
              workspaceId: WORKSPACE_ID,
              workItemId: null,
              title: "Deep work",
              startsAt: "2026-07-13T13:00:00.000Z",
              endsAt: "2026-07-13T14:30:00.000Z",
              timeZone: "America/La_Paz",
              version: 2,
              createdAt: "2026-07-13T12:00:00.000Z",
              updatedAt: "2026-07-13T12:30:00.000Z",
            },
          ],
          page: { limit: 100, offset: 0 },
        }) as never,
    ),
    listOneOffReminders: vi.fn(
      async () =>
        ({
          items: [
            {
              id: RESOURCE_ID,
              workspaceId: WORKSPACE_ID,
              title: "Call the clinic",
              scheduledFor: "2026-07-13T13:30:00.000Z",
              cancelledAt: null,
              version: 2,
              createdAt: "2026-07-13T12:00:00.000Z",
              updatedAt: "2026-07-13T12:30:00.000Z",
            },
          ],
        }) as never,
    ),
    prepareCommand: vi.fn(async (input) => {
      const display = commandDisplay(input.command);
      return {
        confirmationId: CONFIRMATION_ID,
        requestId: REQUEST_ID,
        commandHash: createHash("sha256").update(display).digest("hex"),
        command: input.command,
        commandDisplay: display,
        summary: "Create work item “Call the dentist”",
        expiresAt: "2026-07-13T12:10:00.000Z",
      };
    }),
    confirmCommand: vi.fn(
      async () =>
        ({
          receiptVersion: 2,
          confirmationId: CONFIRMATION_ID,
          operation: "work_item.create",
          commandHash: "a".repeat(64),
          outcome: {
            type: "work_item.created",
            workItem: { id: RESOURCE_ID, title: "Call the dentist", dueOn: null },
          },
        }) as never,
    ),
    claimNotificationDelivery: vi.fn(async () => ({
      command: {
        deliveryId: RESOURCE_ID,
        intentId: RESOURCE_ID,
        dedupeKey: RESOURCE_ID,
        kind: "one_off",
        targetType: "one_off",
        title: "Call the dentist",
        scheduledFor: "2026-07-13T12:00:00.000Z",
        localDate: "2026-07-13",
        priority: 80,
        attempt: 1,
        claimToken: CLAIM_TOKEN,
        leaseExpiresAt: "2026-07-13T12:05:00.000Z",
      },
    })),
    recordNotificationDeliveryReceipt: vi.fn(async () => ({
      deliveryId: RESOURCE_ID,
      status: "delivered" as const,
    })),
  };
}

async function integrationApp(
  services: IntegrationServices = integrationServices(),
  requestsPerMinute = 120,
) {
  const app = await buildApp({
    integrationServices: services,
    integrationApiLimits: { requestsPerMinute },
  });
  apps.push(app);
  return app;
}

function preparePayload(command: Readonly<Record<string, unknown>>) {
  return { version: INTEGRATION_API_VERSION, requestId: REQUEST_ID, command };
}

describe("integration gateway authentication", () => {
  it("accepts only canonical, sufficiently strong bearer credentials", () => {
    expect(parseIntegrationAuthorization(AUTHORIZATION)).toEqual({
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
    });
    expect(parseIntegrationAuthorization(`bearer ${CREDENTIAL_ID}.${SECRET}`)).toEqual({
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
    });
    expect(
      parseIntegrationAuthorization(`Bearer ${CASE_CREDENTIAL_ID.toUpperCase()}.${SECRET}`),
    ).toEqual({ credentialId: CASE_CREDENTIAL_ID, secret: SECRET });

    for (const value of [
      undefined,
      "",
      `Basic ${CREDENTIAL_ID}.${SECRET}`,
      `Bearer not-a-uuid.${SECRET}`,
      `Bearer ${CREDENTIAL_ID}.${Buffer.alloc(31).toString("base64url")}`,
      `Bearer ${CREDENTIAL_ID}.${SECRET}=`,
      `Bearer ${CREDENTIAL_ID}.${"a".repeat(513)}`,
    ]) {
      expect(() => parseIntegrationAuthorization(value)).toThrow("Authentication failed.");
    }
  });

  it("returns the same generic challenge for malformed and unknown credentials", async () => {
    const services = integrationServices();
    vi.mocked(services.authenticateCredential).mockRejectedValueOnce(
      new DomainError("integration.authentication_failed", "credential secret mismatch"),
    );
    const app = await integrationApp(services);

    const malformed = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: "Bearer private-token" },
    });
    const unknown = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
    });

    for (const response of [malformed, unknown]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json().error).toEqual({
        code: "integration.authentication_failed",
        message: "Authentication failed.",
      });
      expect(response.body).not.toContain(SECRET);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("authenticates read and write routes with their least required scope", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);

    await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
    });
    await app.inject({
      method: "POST",
      url: "/v1/integrations/commands/prepare",
      headers: { authorization: AUTHORIZATION },
      payload: preparePayload({ type: "work_item.create", title: "Call the dentist" }),
    });

    expect(services.authenticateCredential).toHaveBeenNthCalledWith(1, {
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
      requiredScope: "schedule:read",
    });
    expect(services.authenticateCredential).toHaveBeenNthCalledWith(2, {
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
      requiredScope: "schedule:write",
    });
  });

  it("rate limits both a remote address and a credential", async () => {
    const services = integrationServices();
    const app = await integrationApp(services, 1);

    const first = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
      remoteAddress: "192.0.2.1",
    });
    const credentialLimited = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
      remoteAddress: "192.0.2.2",
    });
    const ipLimited = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
      remoteAddress: "192.0.2.1",
    });

    expect(first.statusCode).toBe(200);
    expect(credentialLimited.statusCode).toBe(429);
    expect(credentialLimited.json().error.code).toBe("integration.rate_limit_exceeded");
    expect(ipLimited.statusCode).toBe(429);
    expect(ipLimited.headers["retry-after"]).toBeDefined();
  });

  it("rate limits failed guesses by presented credential ID across remote addresses", async () => {
    const services = integrationServices();
    vi.mocked(services.authenticateCredential).mockRejectedValue(
      new DomainError("integration.authentication_failed", "credential secret mismatch"),
    );
    const app = await integrationApp(services, 1);

    const first = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: {
        authorization: `Bearer ${CASE_CREDENTIAL_ID.toUpperCase()}.${SECRET}`,
      },
      remoteAddress: "192.0.2.10",
    });
    const distributedRetry = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: `Bearer ${CASE_CREDENTIAL_ID}.${SECRET}` },
      remoteAddress: "192.0.2.11",
    });

    expect(first.statusCode).toBe(401);
    expect(distributedRetry.statusCode).toBe(429);
    expect(services.authenticateCredential).toHaveBeenCalledTimes(1);
    expect(services.authenticateCredential).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: CASE_CREDENTIAL_ID }),
    );
  });

  it("bounds limiter state without denying new clients or evicting a hot credential", async () => {
    const services = integrationServices();
    vi.mocked(services.authenticateCredential).mockImplementation(async (input) => ({
      credentialId: input.credentialId,
      workspaceId: workspaceId(WORKSPACE_ID),
      scopes: ["schedule:read", "schedule:write"],
    }));
    const app = await buildApp({
      integrationServices: services,
      integrationApiLimits: { requestsPerMinute: 1, maxTrackedClients: 32 },
    });
    apps.push(app);

    const first = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
      remoteAddress: "192.0.2.1",
    });
    expect(first.statusCode).toBe(200);

    for (let index = 10; index < 41; index += 1) {
      const credentialId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const response = await app.inject({
        method: "GET",
        url: "/v1/integrations/today?date=2026-07-13",
        headers: { authorization: `Bearer ${credentialId}.${SECRET}` },
        remoteAddress: `192.0.2.${index - 8}`,
      });
      expect(response.statusCode).toBe(200);
    }

    const hotRetry = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
      remoteAddress: "192.0.2.40",
    });
    expect(hotRetry.statusCode).toBe(429);

    const newCredentialId = "00000000-0000-4000-8000-000000000042";
    const newClient = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: `Bearer ${newCredentialId}.${SECRET}` },
      remoteAddress: "192.0.2.41",
    });
    expect(newClient.statusCode).toBe(200);

    const stillProtected = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION },
      remoteAddress: "192.0.2.42",
    });
    expect(stillProtected.statusCode).toBe(429);
  });

  it("uses forwarded client addresses only from an explicitly trusted proxy", async () => {
    const services = integrationServices();
    vi.mocked(services.authenticateCredential).mockImplementation(async (input) => ({
      credentialId: input.credentialId,
      workspaceId: workspaceId(WORKSPACE_ID),
      scopes: ["schedule:read", "schedule:write"],
    }));
    const app = await buildApp({
      trustProxy: ["127.0.0.1"],
      integrationServices: services,
      integrationApiLimits: { requestsPerMinute: 1 },
    });
    apps.push(app);
    const anotherCredentialId = "00000000-0000-4000-8000-000000000010";
    const thirdCredentialId = "00000000-0000-4000-8000-000000000011";
    const fourthCredentialId = "00000000-0000-4000-8000-000000000012";

    const trustedClientOne = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: {
        authorization: AUTHORIZATION,
        "x-forwarded-for": "203.0.113.10",
      },
      remoteAddress: "127.0.0.1",
    });
    const trustedClientTwo = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: {
        authorization: `Bearer ${anotherCredentialId}.${SECRET}`,
        "x-forwarded-for": "203.0.113.11",
      },
      remoteAddress: "127.0.0.1",
    });
    expect(trustedClientOne.statusCode).toBe(200);
    expect(trustedClientTwo.statusCode).toBe(200);

    const untrustedDirectOne = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: {
        authorization: `Bearer ${thirdCredentialId}.${SECRET}`,
        "x-forwarded-for": "203.0.113.12",
      },
      remoteAddress: "198.51.100.20",
    });
    const untrustedDirectSpoof = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: {
        authorization: `Bearer ${fourthCredentialId}.${SECRET}`,
        "x-forwarded-for": "203.0.113.13",
      },
      remoteAddress: "198.51.100.20",
    });
    expect(untrustedDirectOne.statusCode).toBe(200);
    expect(untrustedDirectSpoof.statusCode).toBe(429);
  });
});

describe("integration gateway routes", () => {
  it("claims one provider-neutral reminder with the delivery-only scope", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/reminder-deliveries/claim",
      headers: {
        authorization: AUTHORIZATION,
        "content-type": "application/json",
        "idempotency-key": "claim-2026-07-13-1",
      },
      payload: { version: INTEGRATION_API_VERSION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: INTEGRATION_API_VERSION,
      data: {
        command: {
          deliveryId: RESOURCE_ID,
          dedupeKey: RESOURCE_ID,
          claimToken: CLAIM_TOKEN,
        },
      },
    });
    expect(services.authenticateCredential).toHaveBeenCalledWith(
      expect.objectContaining({ requiredScope: "schedule:delivery" }),
    );
    expect(services.claimNotificationDelivery).toHaveBeenCalledWith({
      principal: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
      idempotencyKey: "claim-2026-07-13-1",
    });
  });

  it("records bounded delivery receipts and rejects provider payloads", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const delivered = await app.inject({
      method: "POST",
      url: "/v1/integrations/reminder-deliveries/receipt",
      headers: {
        authorization: AUTHORIZATION,
        "content-type": "application/json",
        "idempotency-key": "receipt-1",
      },
      payload: {
        version: INTEGRATION_API_VERSION,
        deliveryId: RESOURCE_ID,
        claimToken: CLAIM_TOKEN,
        outcome: "delivered",
      },
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().data).toEqual({ deliveryId: RESOURCE_ID, status: "delivered" });

    const unbounded = await app.inject({
      method: "POST",
      url: "/v1/integrations/reminder-deliveries/receipt",
      headers: {
        authorization: AUTHORIZATION,
        "content-type": "application/json",
        "idempotency-key": "receipt-2",
      },
      payload: {
        version: INTEGRATION_API_VERSION,
        deliveryId: RESOURCE_ID,
        claimToken: CLAIM_TOKEN,
        outcome: "permanent_failure",
        failureCode: "transport.rejected",
        providerResponse: "raw provider content",
      },
    });
    expect(unbounded.statusCode).toBe(400);
    expect(unbounded.json().error.code).toBe("request.validation_failed");
    expect(services.recordNotificationDeliveryReceipt).toHaveBeenCalledTimes(1);
  });

  it("requires JSON and an idempotency key for delivery mutations", async () => {
    const app = await integrationApp();
    const missingJson = await app.inject({
      method: "POST",
      url: "/v1/integrations/reminder-deliveries/claim",
      headers: { authorization: AUTHORIZATION },
      payload: "{}",
    });
    expect(missingJson.statusCode).toBe(415);

    const missingKey = await app.inject({
      method: "POST",
      url: "/v1/integrations/reminder-deliveries/claim",
      headers: { authorization: AUTHORIZATION, "content-type": "application/json" },
      payload: { version: INTEGRATION_API_VERSION },
    });
    expect(missingKey.statusCode).toBe(400);
  });

  it("returns the authenticated workspace Today view in a no-store envelope", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
      headers: { authorization: AUTHORIZATION, host: "gateway.example" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      version: INTEGRATION_API_VERSION,
      data: { date: "2026-07-13", plan: null },
    });
    expect(services.getToday).toHaveBeenCalledWith({
      principal: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
      date: "2026-07-13",
    });
  });

  it("returns only bounded Plan Fit guidance and rejects strict query drift after authentication", async () => {
    const services = integrationServices();
    vi.mocked(services.getDailyPlanFitInsight).mockResolvedValueOnce({
      forDate: "2026-07-13",
      status: "suggested",
      disposition: "available",
      sampleCount: 4,
      minimumSamples: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 3,
      insightKey: "must-not-escape",
    } as never);
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/daily-plan-fit-insight?forDate=2026-07-13",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().data).toEqual({
      forDate: "2026-07-13",
      status: "suggested",
      disposition: "available",
      sampleCount: 4,
      minimumSamples: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 3,
    });
    expect(response.body).not.toContain("must-not-escape");
    expect(services.getDailyPlanFitInsight).toHaveBeenCalledWith({
      principal: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
      forDate: "2026-07-13",
    });
    expect(services.authenticateCredential).toHaveBeenCalledWith({
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
      requiredScope: "schedule:read",
    });

    for (const query of ["", "forDate=2026-02-30", "forDate=2026-07-13&workspaceId=x"]) {
      const invalid = await app.inject({
        method: "GET",
        url: `/v1/integrations/daily-plan-fit-insight?${query}`,
        headers: { authorization: AUTHORIZATION },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("request.validation_failed");
    }
    expect(services.getDailyPlanFitInsight).toHaveBeenCalledTimes(1);
  });

  it("lists credential-scoped work items with stable versions and serialized dates", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/work-items",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toMatchObject({
      version: INTEGRATION_API_VERSION,
      requestId: expect.any(String),
    });
    expect(body.data).toEqual({
      items: [
        {
          id: RESOURCE_ID,
          workspaceId: WORKSPACE_ID,
          title: "Call the dentist",
          description: null,
          status: "planned",
          priority: "high",
          planningDurationMinutes: 45,
          dueOn: "2026-07-15",
          version: 3,
          createdAt: "2026-07-13T12:00:00.000Z",
          updatedAt: "2026-07-13T13:00:00.000Z",
        },
      ],
      page: { limit: 100, offset: 0 },
    });
    expect(services.listWorkItems).toHaveBeenCalledWith({
      principal: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
      limit: 100,
      offset: 0,
    });
  });

  it("passes only validated optional work-item filters and numeric paging", async () => {
    const services = integrationServices();
    vi.mocked(services.listWorkItems).mockResolvedValueOnce({
      items: [],
      page: { limit: 25, offset: 50 },
    } as never);
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/work-items?status=in_progress&priority=urgent&limit=25&offset=50",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ items: [], page: { limit: 25, offset: 50 } });
    expect(services.listWorkItems).toHaveBeenCalledWith({
      principal: expect.objectContaining({ credentialId: CREDENTIAL_ID }),
      status: "in_progress",
      priority: "urgent",
      limit: 25,
      offset: 50,
    });
  });

  it("lists an exact credential-scoped schedule-block page with omitted paging defaults", async () => {
    const services = integrationServices();
    vi.mocked(services.listScheduleBlocks).mockResolvedValueOnce({
      items: [
        {
          id: RESOURCE_ID,
          workspaceId: WORKSPACE_ID,
          workItemId: null,
          title: "Deep work",
          startsAt: "2026-07-13T13:00:00.000Z",
          endsAt: "2026-07-13T14:30:00.000Z",
          timeZone: "America/La_Paz",
          version: 2,
          createdAt: "2026-07-13T12:00:00.000Z",
          updatedAt: "2026-07-13T12:30:00.000Z",
          adapterSecret: "must-not-escape",
        },
      ],
      page: { limit: 100, offset: 0, adapterSecret: "must-not-escape" },
      adapterSecret: "must-not-escape",
    } as never);
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/schedule-blocks?from=2026-07-13T00%3A00%3A00-04%3A00&to=2026-07-20T00%3A00%3A00-04%3A00",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      version: INTEGRATION_API_VERSION,
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      data: {
        items: [
          {
            id: RESOURCE_ID,
            workspaceId: WORKSPACE_ID,
            workItemId: null,
            title: "Deep work",
            startsAt: "2026-07-13T13:00:00.000Z",
            endsAt: "2026-07-13T14:30:00.000Z",
            timeZone: "America/La_Paz",
            version: 2,
            createdAt: "2026-07-13T12:00:00.000Z",
            updatedAt: "2026-07-13T12:30:00.000Z",
          },
        ],
        page: { limit: 100, offset: 0 },
      },
    });
    expect(response.body).not.toContain("must-not-escape");
    expect(services.listScheduleBlocks).toHaveBeenCalledWith({
      principal: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
      fromInclusive: "2026-07-13T00:00:00-04:00",
      throughExclusive: "2026-07-20T00:00:00-04:00",
      limit: 100,
      offset: 0,
    });
    expect(services.authenticateCredential).toHaveBeenCalledWith({
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
      requiredScope: "schedule:read",
    });
  });

  it("passes explicit canonical schedule-block paging", async () => {
    const services = integrationServices();
    vi.mocked(services.listScheduleBlocks).mockResolvedValueOnce({
      items: [],
      page: { limit: 25, offset: 50 },
    } as never);
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/schedule-blocks?from=2026-07-13T00%3A00%3A00Z&to=2026-10-14T00%3A00%3A00Z&limit=25&offset=50",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ items: [], page: { limit: 25, offset: 50 } });
    expect(services.listScheduleBlocks).toHaveBeenCalledWith({
      principal: expect.objectContaining({ credentialId: CREDENTIAL_ID }),
      fromInclusive: "2026-07-13T00:00:00Z",
      throughExclusive: "2026-10-14T00:00:00Z",
      limit: 25,
      offset: 50,
    });
  });

  it("rejects strict schedule-block query drift before reading", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const validRange = "from=2026-07-13T00%3A00%3A00.000Z&to=2026-07-14T00%3A00%3A00.000Z";

    for (const query of [
      "",
      "to=2026-07-14T00%3A00%3A00.000Z",
      "from=2026-07-13T00%3A00%3A00.000Z",
      "from=2026-02-30T00%3A00%3A00.000Z&to=2026-03-01T00%3A00%3A00.000Z",
      "from=2026-07-13T00%3A00%3A00&to=2026-07-14T00%3A00%3A00.000Z",
      "from=2026-07-14T00%3A00%3A00.000Z&to=2026-07-13T00%3A00%3A00.000Z",
      "from=2026-07-13T00%3A00%3A00.000Z&to=2026-10-15T00%3A00%3A00.000Z",
      `${validRange}&workspaceId=${WORKSPACE_ID}`,
      `${validRange}&limit=0`,
      `${validRange}&limit=201`,
      `${validRange}&limit=01`,
      `${validRange}&limit=1e2`,
      `${validRange}&limit=%2B1`,
      `${validRange}&offset=-1`,
      `${validRange}&offset=1000001`,
      `${validRange}&offset=`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/schedule-blocks?${query}`,
        headers: { authorization: AUTHORIZATION },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("request.validation_failed");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(services.listScheduleBlocks).not.toHaveBeenCalled();
  });

  it("requires schedule:read credentials before validating schedule-block queries", async () => {
    const services = integrationServices();
    vi.mocked(services.authenticateCredential).mockRejectedValueOnce(
      new DomainError("integration.scope_denied", "credential lacks schedule:read"),
    );
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/schedule-blocks?unknown=value",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("integration.scope_denied");
    expect(services.authenticateCredential).toHaveBeenCalledWith({
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
      requiredScope: "schedule:read",
    });
    expect(services.listScheduleBlocks).not.toHaveBeenCalled();
  });

  it("lists one strict reminder range and rejects query drift before reading", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/one-off-reminders?from=2026-07-13T00%3A00%3A00.000Z&to=2026-07-14T00%3A00%3A00.000Z",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const responseBody = response.json();
    expect(responseBody.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(responseBody.data).toEqual({
      items: [
        {
          id: RESOURCE_ID,
          workspaceId: WORKSPACE_ID,
          title: "Call the clinic",
          scheduledFor: "2026-07-13T13:30:00.000Z",
          cancelledAt: null,
          version: 2,
          createdAt: "2026-07-13T12:00:00.000Z",
          updatedAt: "2026-07-13T12:30:00.000Z",
        },
      ],
    });
    expect(services.listOneOffReminders).toHaveBeenCalledWith({
      principal: expect.objectContaining({ workspaceId: WORKSPACE_ID }),
      fromInclusive: "2026-07-13T00:00:00.000Z",
      throughExclusive: "2026-07-14T00:00:00.000Z",
    });

    for (const query of [
      "to=2026-07-14T00%3A00%3A00.000Z",
      "from=2026-02-30T00%3A00%3A00.000Z&to=2026-03-01T00%3A00%3A00.000Z",
      "from=2026-07-13T00%3A00%3A00&to=2026-07-14T00%3A00%3A00.000Z",
      "from=2026-07-14T00%3A00%3A00.000Z&to=2026-07-13T00%3A00%3A00.000Z",
      "from=2026-07-13T00%3A00%3A00.000Z&to=2026-08-14T00%3A00%3A00.000Z",
      "from=2026-07-13T00%3A00%3A00.000Z&to=2026-07-14T00%3A00%3A00.000Z&workspaceId=00000000-0000-4000-8000-000000000002",
    ]) {
      const invalid = await app.inject({
        method: "GET",
        url: `/v1/integrations/one-off-reminders?${query}`,
        headers: { authorization: AUTHORIZATION },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("request.validation_failed");
    }
    expect(services.listOneOffReminders).toHaveBeenCalledTimes(1);
  });

  it("authenticates work-item reads before rejecting strict query drift", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);

    for (const query of [
      "workspaceId=00000000-0000-4000-8000-000000000002",
      "status=not-a-status",
      "priority=not-a-priority",
      "limit=0",
      "limit=201",
      "limit=not-a-number",
      "limit=0x1",
      "limit=1e2",
      "limit=01",
      "limit=%2B1",
      "limit=-1",
      "offset=-1",
      "offset=1000001",
      "offset=not-a-number",
      "offset=",
      "offset=%20",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/work-items?${query}`,
        headers: { authorization: AUTHORIZATION },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("request.validation_failed");
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(services.authenticateCredential).toHaveBeenCalledTimes(16);
    expect(services.authenticateCredential).toHaveBeenCalledWith({
      credentialId: CREDENTIAL_ID,
      secret: SECRET,
      requiredScope: "schedule:read",
    });
    expect(services.listWorkItems).not.toHaveBeenCalled();
  });

  it("requires schedule:read credentials before work-item reads", async () => {
    const services = integrationServices();
    vi.mocked(services.authenticateCredential).mockRejectedValueOnce(
      new DomainError("integration.scope_denied", "credential lacks schedule:read"),
    );
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "GET",
      url: "/v1/integrations/work-items?unknown=value",
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("integration.scope_denied");
    expect(services.listWorkItems).not.toHaveBeenCalled();
  });

  it("rejects malformed or missing credentials before validating work-item queries", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);

    for (const authorization of [undefined, "Bearer private-token"]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/integrations/work-items?limit=1e2",
        headers: authorization === undefined ? {} : { authorization },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toEqual({
        code: "integration.authentication_failed",
        message: "Authentication failed.",
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(services.authenticateCredential).not.toHaveBeenCalled();
    expect(services.listWorkItems).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: "work_item.create",
      title: "Call the dentist",
      parentWorkItemId: RESOURCE_ID,
      dueOn: "2028-02-29",
    },
    {
      type: "work_item.update",
      workItemId: RESOURCE_ID,
      expectedVersion: 2,
      parentWorkItemId: null,
      priority: "high",
      dueOn: null,
    },
    {
      type: "schedule_block.create",
      title: "Dentist",
      startsAt: "2026-07-13T14:00:00-04:00",
      endsAt: "2026-07-13T15:00:00-04:00",
      timeZone: "America/La_Paz",
    },
    {
      type: "schedule_block.update",
      scheduleBlockId: RESOURCE_ID,
      expectedVersion: 3,
      endsAt: "2026-07-13T15:30:00-04:00",
    },
    {
      type: "schedule_block.cancel",
      scheduleBlockId: RESOURCE_ID,
      expectedVersion: 3,
    },
    {
      type: "one_off_reminder.create",
      title: "Call the clinic",
      scheduledFor: "2026-07-13T09:30:00-04:00",
    },
    {
      type: "one_off_reminder.update",
      oneOffReminderId: RESOURCE_ID,
      expectedVersion: 2,
      title: "Call the new clinic",
      scheduledFor: "2026-07-13T10:30:00-04:00",
    },
    {
      type: "one_off_reminder.cancel",
      oneOffReminderId: RESOURCE_ID,
      expectedVersion: 3,
    },
    {
      type: "plan_item.activity",
      date: "2026-07-13",
      expectedPlanId: PLAN_ID,
      itemId: ITEM_ID,
      expectedHeadVersion: 4,
      activityType: "completed",
      occurredAt: "2026-07-13T15:00:00-04:00",
      timeZone: "America/La_Paz",
      durationMinutes: 30,
    },
  ])("prepares the strict $type command for explicit confirmation", async (command) => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/commands/prepare",
      headers: { authorization: AUTHORIZATION },
      payload: preparePayload(command),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      version: INTEGRATION_API_VERSION,
      requestId: REQUEST_ID,
      data: { confirmationId: CONFIRMATION_ID, requestId: REQUEST_ID, command },
    });
    expect(services.prepareCommand).toHaveBeenCalledWith({
      principal: expect.objectContaining({ credentialId: CREDENTIAL_ID }),
      requestId: REQUEST_ID,
      command,
    });
  });

  it("returns the exact validated command so truncated or bidi text cannot hide approval data", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const deceptiveTitle = `Review \u202ecod.exe ${"x".repeat(160)}`;
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/commands/prepare",
      headers: { authorization: AUTHORIZATION },
      payload: preparePayload({
        type: "work_item.create",
        title: `  ${deceptiveTitle}  `,
        description: "The summary is convenience text, not the approval authority.",
      }),
    });

    expect(response.statusCode).toBe(201);
    const prepared = response.json().data;
    expect(prepared.command).toEqual({
      type: "work_item.create",
      title: deceptiveTitle,
      description: "The summary is convenience text, not the approval authority.",
    });
    expect(prepared.summary).not.toContain(deceptiveTitle);
    expect(prepared.commandDisplay).toContain("\\u202E");
    expect(prepared.commandDisplay).not.toContain("\u202e");
    expect(prepared.commandDisplay).toContain("x".repeat(160));
    expect(prepared.commandHash).toBe(
      createHash("sha256").update(prepared.commandDisplay).digest("hex"),
    );
  });

  it("rejects schema drift, no-op updates, and non-completion durations before preparing", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const payloads = [
      { ...preparePayload({ type: "work_item.create", title: "Task" }), unexpected: true },
      {
        version: "schedule.integration/v2",
        requestId: REQUEST_ID,
        command: { type: "work_item.create", title: "Task" },
      },
      preparePayload({ type: "work_item.update", workItemId: RESOURCE_ID, expectedVersion: 1 }),
      preparePayload({
        type: "work_item.create",
        title: "Task",
        parentWorkItemId: "not-a-uuid",
      }),
      preparePayload({ type: "work_item.create", title: "Task", dueOn: "2027-02-29" }),
      preparePayload({
        type: "one_off_reminder.create",
        title: "Reminder",
        scheduledFor: "2026-07-13 09:30",
      }),
      preparePayload({
        type: "one_off_reminder.create",
        title: " Reminder ",
        scheduledFor: "2026-07-13T09:30:00-04:00",
      }),
      preparePayload({
        type: "one_off_reminder.create",
        title: "Reminder",
        scheduledFor: "2026-02-30T09:30:00-04:00",
      }),
      preparePayload({
        type: "one_off_reminder.create",
        title: "Reminder",
        scheduledFor: "2026-07-13T09:30:00-04:00",
        recipient: "someone-else",
      }),
      preparePayload({
        type: "one_off_reminder.update",
        oneOffReminderId: RESOURCE_ID,
        expectedVersion: 1,
      }),
      preparePayload({
        type: "one_off_reminder.update",
        oneOffReminderId: RESOURCE_ID,
        expectedVersion: 1,
        title: " Reminder ",
      }),
      preparePayload({
        type: "one_off_reminder.cancel",
        oneOffReminderId: RESOURCE_ID,
        expectedVersion: 0,
      }),
      preparePayload({
        type: "one_off_reminder.cancel",
        oneOffReminderId: "00000000-0000-4000-8000-AAAAAAAAAAAA",
        expectedVersion: 1,
      }),
      preparePayload({
        type: "one_off_reminder.cancel",
        oneOffReminderId: RESOURCE_ID,
        expectedVersion: 1,
        reason: "unsupported",
      }),
      preparePayload({
        type: "work_item.update",
        workItemId: RESOURCE_ID,
        expectedVersion: 1,
        dueOn: "2028-2-29",
      }),
      preparePayload({
        type: "schedule_block.update",
        scheduleBlockId: RESOURCE_ID,
        expectedVersion: 1,
      }),
      preparePayload({
        type: "schedule_block.cancel",
        scheduleBlockId: RESOURCE_ID,
        expectedVersion: 0,
      }),
      preparePayload({
        type: "schedule_block.cancel",
        scheduleBlockId: "00000000-0000-4000-8000-AAAAAAAAAAAA",
        expectedVersion: 1,
      }),
      preparePayload({
        type: "schedule_block.cancel",
        scheduleBlockId: RESOURCE_ID,
        expectedVersion: 1,
        reason: "unsupported",
      }),
      preparePayload({
        type: "plan_item.activity",
        date: "2026-07-13",
        expectedPlanId: PLAN_ID,
        itemId: ITEM_ID,
        expectedHeadVersion: 1,
        activityType: "started",
        occurredAt: "2026-07-13T15:00:00-04:00",
        timeZone: "America/La_Paz",
        durationMinutes: 10,
      }),
    ];

    for (const payload of payloads) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/integrations/commands/prepare",
        headers: { authorization: AUTHORIZATION },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("request.validation_failed");
    }
    expect(services.prepareCommand).not.toHaveBeenCalled();
  });

  it("requires JSON for mutation routes", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/commands/prepare",
      headers: { authorization: AUTHORIZATION, "content-type": "text/plain" },
      payload: JSON.stringify(
        preparePayload({ type: "work_item.create", title: "Call the dentist" }),
      ),
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("request.media_type_unsupported");
    expect(services.prepareCommand).not.toHaveBeenCalled();
  });

  it("confirms idempotently and correlates responses with the stable confirmation id", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const request = {
      method: "POST" as const,
      url: "/v1/integrations/commands/confirm",
      headers: { authorization: AUTHORIZATION, "idempotency-key": "whatsapp-message-42" },
      payload: { version: INTEGRATION_API_VERSION, confirmationId: CONFIRMATION_ID },
    };

    const first = await app.inject(request);
    const replay = await app.inject({ ...request, remoteAddress: "192.0.2.2" });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({
      version: INTEGRATION_API_VERSION,
      requestId: CONFIRMATION_ID,
      data: {
        receiptVersion: 2,
        confirmationId: CONFIRMATION_ID,
        operation: "work_item.create",
      },
    });
    expect(services.confirmCommand).toHaveBeenCalledWith({
      principal: expect.objectContaining({ credentialId: CREDENTIAL_ID }),
      confirmationId: CONFIRMATION_ID,
      idempotencyKey: "whatsapp-message-42",
    });
  });

  it("requires an idempotency key before confirmation reaches the application", async () => {
    const services = integrationServices();
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/commands/confirm",
      headers: { authorization: AUTHORIZATION },
      payload: { version: INTEGRATION_API_VERSION, confirmationId: CONFIRMATION_ID },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.validation_failed");
    expect(services.confirmCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["integration.scope_denied", 403],
    ["integration.request_conflict", 409],
    ["integration.receipt_conflict", 409],
    ["integration.receipt_in_progress", 409],
    ["integration.confirmation_expired", 410],
    ["integration.confirmation_consumed", 410],
  ] as const)("maps %s to a stable HTTP status", async (code, status) => {
    const services = integrationServices();
    vi.mocked(services.prepareCommand).mockRejectedValueOnce(
      new DomainError(code, "sensitive repository detail"),
    );
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/commands/prepare",
      headers: { authorization: AUTHORIZATION },
      payload: preparePayload({ type: "work_item.create", title: "Task" }),
    });

    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.body).not.toContain("sensitive repository detail");
  });

  it("redacts integration persistence corruption as an internal failure", async () => {
    const services = integrationServices();
    vi.mocked(services.prepareCommand).mockRejectedValueOnce(
      new DomainError("integration.confirmation_corrupt", "raw corrupt row contents"),
    );
    const app = await integrationApp(services);
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/commands/prepare",
      headers: { authorization: AUTHORIZATION },
      payload: preparePayload({ type: "work_item.create", title: "Task" }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      code: "internal.unexpected_error",
      message: "An unexpected error occurred.",
    });
    expect(response.body).not.toContain("raw corrupt row contents");
  });
});
