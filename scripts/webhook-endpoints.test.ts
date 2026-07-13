import { describe, expect, it, vi } from "vitest";

import {
  createWebhookTestBody,
  parseWebhookEndpointArguments,
  runWebhookEndpointCommand,
  type WebhookEndpointCliDependencies,
} from "./webhook-endpoints.js";

const workspaceId = "0191c54f-f691-7b8b-9d87-16f1c99128f9";
const endpointId = "0191c54f-f691-7f98-8ab4-bbc507f1abe5";
const secretId = "0191c54f-f691-7e23-8b19-d4e903ca5ac2";
const deliveryId = "0191c54f-f691-7e33-9a73-d4e903ca5ac3";
const key = Buffer.alloc(32, 7).toString("base64url");

function dependencies(
  overrides: Partial<WebhookEndpointCliDependencies> = {},
): WebhookEndpointCliDependencies {
  const close = vi.fn(async () => undefined);
  return {
    loadConfig: vi.fn(() => ({
      DATABASE_URL: "postgres://test",
      WEBHOOK_ACTIVE_MASTER_KEY_ID: "primary",
      WEBHOOK_MASTER_KEYS_BY_ID: new Map([["primary", { id: "primary", material: key }]]),
    })) as never,
    createConnection: vi.fn(() => ({ close })) as never,
    createEndpoint: vi.fn(async (_connection, input) => ({
      id: input.endpointId,
      workspaceId: input.workspaceId,
      name: input.name,
      url: input.url,
      status: "active",
    })) as never,
    listEndpoints: vi.fn(async () => []) as never,
    prepareRotation: vi.fn(async (_connection, input) => ({
      id: input.secretId,
      endpointId: input.endpointId,
      version: 2,
    })) as never,
    activateRotation: vi.fn(async () => ({
      id: secretId,
      endpointId,
      version: 2,
      status: "active",
    })) as never,
    revokeEndpoint: vi.fn(async () => true) as never,
    enqueueTestDelivery: vi.fn(async (_connection, input) => ({
      id: deliveryId,
      outboxEventId: secretId,
      eventId: input.eventId,
    })) as never,
    getEventSubscriptions: vi.fn(async () => []) as never,
    replaceEventSubscriptions: vi.fn(async (_connection, input) => ({
      previousEventTypes: [],
      eventTypes: input.eventTypes,
      changed: input.eventTypes.length > 0,
    })) as never,
    listDeadLetters: vi.fn(async () => []) as never,
    redriveDelivery: vi.fn(async () => true) as never,
    validateUrl: vi.fn((url) => new URL(url)) as never,
    resolveDns: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
    assertPublicDns: vi.fn((answers) => answers) as never,
    randomUuid: vi.fn(() => endpointId),
    random: vi.fn((size) => Buffer.alloc(size, 7)),
    now: () => new Date("2026-07-13T00:00:00.000Z"),
    write: vi.fn(),
    ...overrides,
  };
}

describe("webhook endpoint CLI parsing", () => {
  it("canonicalizes UUIDs and accepts every command", () => {
    expect(
      parseWebhookEndpointArguments([
        "create",
        "--workspace",
        workspaceId.toUpperCase(),
        "--name",
        " Hermes ",
        "--url",
        "https://receiver.example/hook",
      ]),
    ).toEqual({
      kind: "create",
      workspaceId,
      name: "Hermes",
      url: "https://receiver.example/hook",
    });
    expect(
      parseWebhookEndpointArguments(["dead-letters", "--workspace", workspaceId, "--limit=9"]),
    ).toEqual({ kind: "dead-letters", workspaceId, limit: 9 });
    expect(
      parseWebhookEndpointArguments([
        "activate-rotation",
        "--workspace",
        workspaceId,
        "--endpoint",
        endpointId,
        "--secret",
        secretId,
      ]),
    ).toMatchObject({ kind: "activate-rotation" });
  });

  it("rejects unsafe, duplicate, empty, and unknown options", () => {
    for (const args of [
      [
        "create",
        "--workspace",
        workspaceId,
        "--name",
        "bad\nname",
        "--url",
        "https://receiver.example",
      ],
      ["create", "--workspace", workspaceId, "--name", "x", "--url", "http://receiver.example"],
      ["list", "--workspace", workspaceId, "--workspace", workspaceId],
      ["dead-letters", "--workspace", workspaceId, "--limit", "0"],
      ["list", "--workspace="],
      ["list", "--workspace", workspaceId, "--unknown", "x"],
      [
        "replace-subscriptions",
        "--workspace",
        workspaceId,
        "--endpoint",
        endpointId,
        "--events",
        "schedule.changed.v1",
      ],
      [
        "replace-subscriptions",
        "--workspace",
        workspaceId,
        "--endpoint",
        endpointId,
        "--events",
        "none",
      ],
      [
        "replace-subscriptions",
        "--workspace",
        workspaceId,
        "--endpoint",
        endpointId,
        "--events",
        "none",
        "--confirm",
        "yes",
      ],
    ])
      expect(() => parseWebhookEndpointArguments(args)).toThrow(/Usage:/);
  });

  it("strictly parses automatic subscription reads, enables, and disables", () => {
    expect(
      parseWebhookEndpointArguments([
        "list-subscriptions",
        "--workspace",
        workspaceId.toUpperCase(),
        "--endpoint",
        endpointId.toUpperCase(),
      ]),
    ).toEqual({ kind: "list-subscriptions", workspaceId, endpointId });

    const base = ["replace-subscriptions", "--workspace", workspaceId, "--endpoint", endpointId];
    expect(
      parseWebhookEndpointArguments([
        ...base,
        "--events",
        "schedule.changed.v1",
        "--confirm",
        "replace-automatic-subscriptions",
      ]),
    ).toEqual({
      kind: "replace-subscriptions",
      workspaceId,
      endpointId,
      eventTypes: ["schedule.changed.v1"],
      confirmation: "replace-automatic-subscriptions",
    });
    expect(
      parseWebhookEndpointArguments([
        ...base,
        "--events=none",
        "--confirm=replace-automatic-subscriptions",
      ]),
    ).toEqual({
      kind: "replace-subscriptions",
      workspaceId,
      endpointId,
      eventTypes: [],
      confirmation: "replace-automatic-subscriptions",
    });
  });

  it("rejects ambiguous, duplicated, malformed, and control-tainted subscription arguments", () => {
    const prefix = ["replace-subscriptions", "--workspace", workspaceId, "--endpoint", endpointId];
    for (const tail of [
      ["--events", ""],
      ["--events", "schedule.changed.v1,none", "--confirm", "replace-automatic-subscriptions"],
      ["--events", "schedule.changed.v1 ", "--confirm", "replace-automatic-subscriptions"],
      ["--events", "SCHEDULE.CHANGED.V1", "--confirm", "replace-automatic-subscriptions"],
      ["--events", "schedule.changed.v1\n", "--confirm", "replace-automatic-subscriptions"],
      ["--events", "none", "--confirm", "replace-automatic-subscriptions\u202e"],
      ["--events", "none", "--events", "none", "--confirm", "replace-automatic-subscriptions"],
      ["--events", "other.event.v1", "--confirm", "replace-automatic-subscriptions"],
    ]) {
      expect(() => parseWebhookEndpointArguments([...prefix, ...tail])).toThrow(/Usage:/);
    }
    expect(() =>
      parseWebhookEndpointArguments([
        "list-subscriptions",
        "--workspace",
        workspaceId,
        "--endpoint",
        `${endpointId} `,
      ]),
    ).toThrow(/--endpoint must be a valid UUID/);
  });
});

describe("webhook endpoint CLI execution", () => {
  it("generates master key environment lines without loading configuration or connecting", async () => {
    const deps = dependencies();
    await runWebhookEndpointCommand({ kind: "generate-master-key", keyId: "primary" }, {}, deps);
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.createConnection).not.toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledTimes(2);
    expect(deps.write).toHaveBeenNthCalledWith(1, `WEBHOOK_MASTER_KEYS=primary:${key}`);
  });

  it("requires the exact replacement confirmation even for direct runner calls", async () => {
    const deps = dependencies();
    await expect(
      runWebhookEndpointCommand(
        {
          kind: "replace-subscriptions",
          workspaceId,
          endpointId,
          eventTypes: [],
          confirmation: "yes",
        } as never,
        {},
        deps,
      ),
    ).rejects.toThrow("Exact webhook subscription replacement confirmation is required.");
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.createConnection).not.toHaveBeenCalled();
    expect(deps.replaceEventSubscriptions).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("prints a signing secret only after endpoint creation succeeds and closes the connection", async () => {
    const deps = dependencies();
    await runWebhookEndpointCommand(
      { kind: "create", workspaceId, name: "Hermes", url: "https://receiver.example/hook" },
      {},
      deps,
    );
    expect(deps.createEndpoint).toHaveBeenCalledOnce();
    expect(deps.validateUrl).toHaveBeenCalledWith("https://receiver.example/hook");
    expect(deps.resolveDns).toHaveBeenCalledWith("receiver.example");
    expect(deps.assertPublicDns).toHaveBeenCalledOnce();
    expect(deps.write).toHaveBeenCalledOnce();
    expect(String((deps.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "signingSecret",
    );
    expect(deps.createConnection).toHaveBeenCalledOnce();
  });

  it("does not mutate or output a secret when no active master key is available", async () => {
    const deps = dependencies({
      loadConfig: vi.fn(() => ({
        DATABASE_URL: "postgres://test",
        WEBHOOK_ACTIVE_MASTER_KEY_ID: "",
        WEBHOOK_MASTER_KEYS_BY_ID: new Map(),
      })) as never,
    });
    await expect(
      runWebhookEndpointCommand({ kind: "prepare-rotation", workspaceId, endpointId }, {}, deps),
    ).rejects.toThrow(/active webhook master key/);
    expect(deps.prepareRotation).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("does not connect or mutate when URL preflight fails, and redacts the resolver detail", async () => {
    const deps = dependencies({
      resolveDns: vi.fn(async () => {
        throw new Error("internal.receiver.example 10.0.0.1");
      }),
    });
    await expect(
      runWebhookEndpointCommand(
        { kind: "create", workspaceId, name: "Hermes", url: "https://receiver.example/hook" },
        {},
        deps,
      ),
    ).rejects.toThrow("Webhook endpoint URL did not pass network preflight.");
    expect(deps.createConnection).not.toHaveBeenCalled();
    expect(deps.createEndpoint).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("uses a canonical thin test body and reports only opaque identifiers", async () => {
    const deps = dependencies({ randomUuid: vi.fn(() => endpointId) });
    await runWebhookEndpointCommand({ kind: "send-test", workspaceId, endpointId }, {}, deps);
    expect(deps.enqueueTestDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "schedule.webhook.test.v1",
        rawBody: createWebhookTestBody(endpointId, new Date("2026-07-13T00:00:00.000Z")),
      }),
    );
    expect(String((deps.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).not.toContain(
      "rawBody",
    );
  });

  it("lists subscriptions with only the endpoint identifier and event types", async () => {
    const close = vi.fn(async () => undefined);
    const deps = dependencies({
      loadConfig: vi.fn(() => ({
        DATABASE_URL: "postgres://test",
        WEBHOOK_DELIVERY_MODE: "disabled",
        WEBHOOK_ACTIVE_MASTER_KEY_ID: "",
        WEBHOOK_MASTER_KEYS_BY_ID: new Map(),
      })) as never,
      createConnection: vi.fn(() => ({ close })) as never,
      getEventSubscriptions: vi.fn(async () => ["schedule.changed.v1"]) as never,
    });
    await runWebhookEndpointCommand(
      { kind: "list-subscriptions", workspaceId, endpointId },
      {},
      deps,
    );
    expect(deps.getEventSubscriptions).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      endpointId,
    });
    expect(deps.write).toHaveBeenCalledWith(
      JSON.stringify({ endpointId, eventTypes: ["schedule.changed.v1"] }),
    );
    const output = String((deps.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(output).not.toMatch(/url|secret|body|credential|workspace/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "enables",
      eventTypes: ["schedule.changed.v1"] as const,
      previousEventTypes: [] as readonly string[],
      changed: true,
      status: "replaced",
    },
    {
      label: "disables",
      eventTypes: [] as const,
      previousEventTypes: ["schedule.changed.v1"] as const,
      changed: true,
      status: "replaced",
    },
    {
      label: "leaves an idempotent replacement unchanged",
      eventTypes: ["schedule.changed.v1"] as const,
      previousEventTypes: ["schedule.changed.v1"] as const,
      changed: false,
      status: "unchanged",
    },
  ])("$label automatic subscriptions with an exact minimal result", async (scenario) => {
    const close = vi.fn(async () => undefined);
    const deps = dependencies({
      loadConfig: vi.fn(() => ({
        DATABASE_URL: "postgres://test",
        WEBHOOK_DELIVERY_MODE: "disabled",
        WEBHOOK_ACTIVE_MASTER_KEY_ID: "",
        WEBHOOK_MASTER_KEYS_BY_ID: new Map(),
      })) as never,
      createConnection: vi.fn(() => ({ close })) as never,
      replaceEventSubscriptions: vi.fn(async () => ({
        previousEventTypes: scenario.previousEventTypes,
        eventTypes: scenario.eventTypes,
        changed: scenario.changed,
      })) as never,
    });
    await runWebhookEndpointCommand(
      {
        kind: "replace-subscriptions",
        workspaceId,
        endpointId,
        eventTypes: scenario.eventTypes,
        confirmation: "replace-automatic-subscriptions",
      },
      {},
      deps,
    );
    expect(deps.replaceEventSubscriptions).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      endpointId,
      eventTypes: scenario.eventTypes,
    });
    expect(deps.write).toHaveBeenCalledWith(
      JSON.stringify({
        endpointId,
        previousEventTypes: scenario.previousEventTypes,
        eventTypes: scenario.eventTypes,
        status: scenario.status,
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "missing subscription endpoint",
      overrides: { getEventSubscriptions: vi.fn(async () => null) as never },
      command: { kind: "list-subscriptions", workspaceId, endpointId } as const,
      message: "Webhook endpoint subscriptions could not be read.",
    },
    {
      label: "missing replacement endpoint",
      overrides: { replaceEventSubscriptions: vi.fn(async () => null) as never },
      command: {
        kind: "replace-subscriptions",
        workspaceId,
        endpointId,
        eventTypes: [] as const,
        confirmation: "replace-automatic-subscriptions",
      } as const,
      message: "Webhook endpoint subscriptions could not be replaced.",
    },
    {
      label: "subscription read database failure",
      overrides: {
        getEventSubscriptions: vi.fn(async () => {
          throw new Error("postgres://admin:password@private-host/internal-url-and-secret");
        }) as never,
      },
      command: { kind: "list-subscriptions", workspaceId, endpointId } as const,
      message: "Webhook endpoint subscriptions could not be read.",
    },
    {
      label: "subscription replacement database failure",
      overrides: {
        replaceEventSubscriptions: vi.fn(async () => {
          throw new Error("postgres://admin:password@private-host/internal-url-and-secret");
        }) as never,
      },
      command: {
        kind: "replace-subscriptions",
        workspaceId,
        endpointId,
        eventTypes: ["schedule.changed.v1"] as const,
        confirmation: "replace-automatic-subscriptions",
      } as const,
      message: "Webhook endpoint subscriptions could not be replaced.",
    },
  ])("closes and emits nothing for $label", async ({ overrides, command, message }) => {
    const close = vi.fn(async () => undefined);
    const deps = dependencies({
      createConnection: vi.fn(() => ({ close })) as never,
      ...overrides,
    });
    await expect(runWebhookEndpointCommand(command, {}, deps)).rejects.toThrowError(
      new Error(message),
    );
    expect(deps.write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed for null/conflict/revoked outcomes and still closes", async () => {
    const close = vi.fn(async () => undefined);
    const deps = dependencies({
      createConnection: vi.fn(() => ({ close })) as never,
      revokeEndpoint: vi.fn(async () => false) as never,
    });
    await expect(
      runWebhookEndpointCommand({ kind: "revoke", workspaceId, endpointId }, {}, deps),
    ).rejects.toThrow(/could not be revoked/);
    expect(deps.write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("redacts database errors at the executable boundary", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./webhook-endpoints.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("Webhook endpoint command failed.");
    expect(source).not.toContain("console.error(`Webhook endpoint command failed: ${");
  });
});
