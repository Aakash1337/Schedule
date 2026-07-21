import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabaseConnection } from "@schedule/database";

import {
  collectOperationalDatabaseSnapshot,
  renderWorkerMetrics,
  runWorkerDeploymentHealthServer,
  runWorkerObservabilityServer,
  WorkerTelemetry,
  type OperationalDatabaseSnapshot,
} from "./observability.js";

const databaseSnapshot: OperationalDatabaseSnapshot = {
  outboxReady: 2,
  outboxProcessing: 1,
  outboxDeadLetter: 3,
  outboxOldestReadyAgeSeconds: 12.5,
  notificationIntentsReady: 4,
  notificationIntentsOldestReadyAgeSeconds: 20,
  notificationDeliveryReady: 5,
  notificationDeliveryProcessing: 1,
  notificationDeliveryDeadLetter: 2,
  notificationDeliveryOldestReadyAgeSeconds: 30,
  notificationDeliveryAttempts: 11,
  notificationDeliveryDelivered: 6,
  notificationDeliveryRetryableFailures: 2,
  notificationDeliveryPermanentFailures: 1,
  notificationDeliveryLeaseExpired: 1,
};

function databaseWithSql(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
): DatabaseConnection {
  return { sql, db: {}, close: vi.fn() } as unknown as DatabaseConnection;
}

async function startServer(
  database: DatabaseConnection,
  telemetry = new WorkerTelemetry(),
  deploymentHealth = false,
): Promise<{
  readonly baseUrl: string;
  readonly controller: AbortController;
  readonly server: Server;
  readonly stopped: Promise<void>;
}> {
  const controller = new AbortController();
  let resolveAddress: ((address: AddressInfo) => void) | undefined;
  let boundServer: Server | undefined;
  const address = new Promise<AddressInfo>((resolve) => {
    resolveAddress = resolve;
  });
  const onListening = (bound: AddressInfo, server: Server) => {
    boundServer = server;
    resolveAddress?.(bound);
  };
  const stopped = deploymentHealth
    ? runWorkerDeploymentHealthServer({ port: 0, database, onListening }, controller.signal)
    : runWorkerObservabilityServer(
        { port: 0, database, telemetry, onListening },
        controller.signal,
      );
  const bound = await address;
  expect(bound.address).toBe(deploymentHealth ? "0.0.0.0" : "127.0.0.1");
  if (boundServer === undefined) throw new Error("Test server did not expose its listener.");
  return {
    baseUrl: `http://127.0.0.1:${bound.port}`,
    controller,
    server: boundServer,
    stopped,
  };
}

describe("worker telemetry", () => {
  it("records fixed-cardinality counters and failure-free materialization timestamps", () => {
    let now = new Date("2026-07-14T20:00:00.000Z");
    const telemetry = new WorkerTelemetry(() => now);
    telemetry.recordOutboxClaimed();
    telemetry.recordOutboxCompleted();
    telemetry.recordOutboxRetried();
    telemetry.recordOutboxDeadLettered();
    telemetry.recordOutboxStaleClaim();
    telemetry.recordOutboxLeaseRenewalFailure();
    telemetry.recordOutboxShutdownDeadline();
    now = new Date("2026-07-14T20:00:05.000Z");
    telemetry.recordNotificationMaterializationCycle({
      selectedWorkspaces: 2,
      attemptedWorkspaces: 2,
      skippedWorkspaces: 1,
      failedWorkspaces: 0,
      createdIntents: 3,
      existingIntents: 4,
      suppressedCandidates: 5,
      workspaceListFailed: false,
      workspaceLimitExceeded: false,
      aborted: false,
    });
    telemetry.recordHostedSyncCleanupCycle({
      batches: 2,
      deletedChanges: 275,
      workspacesTouched: 2,
      failed: false,
      contended: false,
      limitReached: false,
      aborted: false,
    });
    telemetry.recordHostedLoginTransactionCleanupCycle({
      deletedTransactions: 42,
      failed: false,
      aborted: false,
    });

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({
      uptimeSeconds: 5,
      outboxClaimed: 1,
      outboxCompleted: 1,
      outboxRetried: 1,
      outboxDeadLettered: 1,
      outboxStaleClaims: 1,
      outboxLeaseRenewalFailures: 1,
      outboxShutdownDeadlines: 1,
      materializationCycles: 1,
      materializationWorkspaceSkips: 1,
      materializationCreatedIntents: 3,
      materializationExistingIntents: 4,
      materializationSuppressedCandidates: 5,
      materializationLastCompletedTimestampSeconds: 1_784_059_205,
      materializationLastSuccessfulTimestampSeconds: 1_784_059_205,
      hostedSyncCleanupCycles: 1,
      hostedSyncCleanupBatches: 2,
      hostedSyncCleanupDeletedChanges: 275,
      hostedSyncCleanupLastCompletedTimestampSeconds: 1_784_059_205,
      hostedSyncCleanupLastSuccessfulTimestampSeconds: 1_784_059_205,
      hostedLoginTransactionCleanupCycles: 1,
      hostedLoginTransactionCleanupDeletedTransactions: 42,
      hostedLoginTransactionCleanupLastCompletedTimestampSeconds: 1_784_059_205,
      hostedLoginTransactionCleanupLastSuccessfulTimestampSeconds: 1_784_059_205,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not mark failed, capped, or aborted materialization cycles successful", () => {
    const telemetry = new WorkerTelemetry(() => new Date("2026-07-14T20:00:00.000Z"));
    telemetry.recordNotificationMaterializationCycle({
      selectedWorkspaces: 0,
      attemptedWorkspaces: 0,
      skippedWorkspaces: 0,
      failedWorkspaces: 0,
      createdIntents: 0,
      existingIntents: 0,
      suppressedCandidates: 0,
      workspaceListFailed: true,
      workspaceLimitExceeded: true,
      aborted: true,
    });
    expect(telemetry.snapshot()).toMatchObject({
      materializationListFailures: 1,
      materializationLimitExceeded: 1,
      materializationAborted: 1,
      materializationLastSuccessfulTimestampSeconds: 0,
    });

    telemetry.recordHostedSyncCleanupCycle({
      batches: 0,
      deletedChanges: 0,
      workspacesTouched: 0,
      failed: false,
      contended: true,
      limitReached: false,
      aborted: false,
    });
    expect(telemetry.snapshot()).toMatchObject({
      hostedSyncCleanupContention: 1,
      hostedSyncCleanupLastSuccessfulTimestampSeconds: 0,
    });

    telemetry.recordHostedLoginTransactionCleanupCycle({
      deletedTransactions: 0,
      failed: true,
      aborted: true,
    });
    expect(telemetry.snapshot()).toMatchObject({
      hostedLoginTransactionCleanupCycles: 1,
      hostedLoginTransactionCleanupFailures: 1,
      hostedLoginTransactionCleanupAborted: 1,
      hostedLoginTransactionCleanupLastSuccessfulTimestampSeconds: 0,
    });

    telemetry.recordHostedSyncCleanupCycle({
      batches: 1,
      deletedChanges: 250,
      workspacesTouched: 1,
      failed: true,
      contended: false,
      limitReached: true,
      aborted: true,
    });
    expect(telemetry.snapshot()).toMatchObject({
      hostedSyncCleanupFailures: 1,
      hostedSyncCleanupContention: 1,
      hostedSyncCleanupLimitReached: 1,
      hostedSyncCleanupAborted: 1,
      hostedSyncCleanupLastSuccessfulTimestampSeconds: 0,
    });
  });

  it("rejects an invalid clock without leaking a supplied value", () => {
    expect(() => new WorkerTelemetry(() => new Date(Number.NaN))).toThrow(/invalid instant/);
  });
});

describe("operational database snapshot", () => {
  it("normalizes the single aggregate row without retaining source identifiers", async () => {
    const sql = vi.fn(async () => [{ ...databaseSnapshot }]);
    await expect(
      collectOperationalDatabaseSnapshot(databaseWithSql(sql), 5_000, ["webhook.delivery.v1"]),
    ).resolves.toEqual(databaseSnapshot);
    expect(sql).toHaveBeenCalledTimes(1);
    const query = sql.mock.calls[0]?.[0].join(" ") ?? "";
    expect(query).not.toContain("title_snapshot");
    expect(query).toContain("topic <> all(");
    expect(query.match(/command\.occurrence_key = intent\.occurrence_key/gu)).toHaveLength(2);
    expect(sql.mock.calls[0]?.slice(1)).toEqual([["webhook.delivery.v1"], ["webhook.delivery.v1"]]);
  });

  it("fails closed on missing or invalid aggregate values", async () => {
    await expect(
      collectOperationalDatabaseSnapshot(databaseWithSql(async () => [])),
    ).rejects.toThrow(/unexpected result/);
    await expect(
      collectOperationalDatabaseSnapshot(
        databaseWithSql(async () => [{ ...databaseSnapshot, outboxReady: -1 }]),
      ),
    ).rejects.toThrow(/outboxReady/);
  });

  it("bounds stalled aggregate queries with a fixed deadline", async () => {
    const sql = vi.fn(() => new Promise<never>(() => undefined));

    await expect(collectOperationalDatabaseSnapshot(databaseWithSql(sql), 10)).rejects.toThrow(
      "Database operation exceeded its deadline.",
    );
  });
});

describe("Prometheus rendering", () => {
  it("uses fixed metric names and no identifiers or labels", () => {
    const telemetry = new WorkerTelemetry(() => new Date("2026-07-14T20:00:00.000Z"));
    telemetry.recordOutboxClaimed();
    const output = renderWorkerMetrics(telemetry.snapshot(), databaseSnapshot);
    expect(output).toContain("# TYPE schedule_outbox_claimed_total counter");
    expect(output).toContain("schedule_outbox_claimed_total 1");
    expect(output).toContain("schedule_worker_database_up 1");
    expect(output).toContain("# TYPE schedule_notification_delivery_attempt_records gauge");
    expect(output).toContain("schedule_notification_delivery_attempt_records 11");
    expect(output).toContain("# TYPE schedule_hosted_sync_cleanup_cycles_total counter");
    expect(output).toContain(
      "# TYPE schedule_hosted_login_transaction_cleanup_cycles_total counter",
    );
    expect(output).not.toContain("{");
    expect(output).not.toContain("workspaceId");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("marks every database-backed value unavailable after collection failure", () => {
    const output = renderWorkerMetrics(new WorkerTelemetry().snapshot(), null);
    expect(output).toContain("schedule_worker_database_up 0");
    expect(output).toContain("schedule_outbox_ready NaN");
    expect(output).toContain("schedule_notification_delivery_attempt_records NaN");
  });
});

describe("worker observability HTTP server", () => {
  const controllers: AbortController[] = [];
  const servers: Promise<void>[] = [];

  afterEach(async () => {
    for (const controller of controllers) controller.abort("test cleanup");
    await Promise.allSettled(servers);
    controllers.length = 0;
    servers.length = 0;
  });

  it("binds to loopback and serves bounded health, metrics, and method responses", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) =>
      strings.join(" ").includes("observation_clock")
        ? [{ ...databaseSnapshot }]
        : [{ healthy: 1 }],
    );
    const running = await startServer(databaseWithSql(sql));
    controllers.push(running.controller);
    servers.push(running.stopped);

    const live = await fetch(`${running.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "alive" });
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(live.headers.has("access-control-allow-origin")).toBe(false);

    const ready = await fetch(`${running.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });

    const metrics = await fetch(`${running.baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await metrics.text()).toContain("schedule_worker_database_up 1");

    const method = await fetch(`${running.baseUrl}/metrics`, { method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    const missing = await fetch(`${running.baseUrl}/private-value`);
    expect(missing.status).toBe(404);

    running.controller.abort("test complete");
    await running.stopped;
  });

  it("binds deployment health on all interfaces without exposing metrics", async () => {
    const privateFailure = "postgres://private-user:private-password@db.internal";
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ healthy: 1 }])
      .mockRejectedValueOnce(new Error(privateFailure));
    const running = await startServer(databaseWithSql(sql), new WorkerTelemetry(), true);
    controllers.push(running.controller);
    servers.push(running.stopped);

    expect((await fetch(`${running.baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${running.baseUrl}/health/ready`)).status).toBe(200);
    const unavailable = await fetch(`${running.baseUrl}/health/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(privateFailure);
    expect((await fetch(`${running.baseUrl}/metrics`)).status).toBe(404);
    expect((await fetch(`${running.baseUrl}/health/live`, { method: "POST" })).status).toBe(405);

    running.controller.abort("test complete");
    await running.stopped;
  });

  it("shares deployment readiness and drains the in-flight probe before shutdown", async () => {
    let resolveProbe: ((rows: readonly { readonly healthy: number }[]) => void) | undefined;
    const sql = vi.fn(
      async () =>
        new Promise<readonly { readonly healthy: number }[]>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const running = await startServer(databaseWithSql(sql), new WorkerTelemetry(), true);
    controllers.push(running.controller);
    servers.push(running.stopped);

    const first = fetch(`${running.baseUrl}/health/ready`);
    await vi.waitFor(() => expect(sql).toHaveBeenCalledTimes(1));
    const second = fetch(`${running.baseUrl}/health/ready`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sql).toHaveBeenCalledTimes(1);

    let stopped = false;
    void running.stopped.then(() => {
      stopped = true;
    });
    running.controller.abort("test complete");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    resolveProbe?.([{ healthy: 1 }]);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    await running.stopped;
    expect(stopped).toBe(true);
  });

  it("keeps liveness up while readiness and database metrics fail safely", async () => {
    const privateFailure = "postgres://person:secret@private.example.invalid";
    const database = databaseWithSql(async () => {
      throw new Error(privateFailure);
    });
    const telemetry = new WorkerTelemetry();
    const running = await startServer(database, telemetry);
    controllers.push(running.controller);
    servers.push(running.stopped);

    expect((await fetch(`${running.baseUrl}/health/live`)).status).toBe(200);
    const ready = await fetch(`${running.baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.text()).not.toContain(privateFailure);
    const metrics = await (await fetch(`${running.baseUrl}/metrics`)).text();
    expect(metrics).toContain("schedule_worker_database_up 0");
    expect(metrics).toContain("schedule_worker_database_collection_failures_total 1");
    expect(metrics).not.toContain(privateFailure);
  });

  it("shares one database collection across concurrent metric scrapes", async () => {
    let resolveCollection: ((rows: readonly OperationalDatabaseSnapshot[]) => void) | undefined;
    const sql = vi.fn(
      async () =>
        new Promise<readonly OperationalDatabaseSnapshot[]>((resolve) => {
          resolveCollection = resolve;
        }),
    );
    const running = await startServer(databaseWithSql(sql));
    controllers.push(running.controller);
    servers.push(running.stopped);

    const first = fetch(`${running.baseUrl}/metrics`);
    await vi.waitFor(() => expect(sql).toHaveBeenCalledTimes(1));
    const second = fetch(`${running.baseUrl}/metrics`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sql).toHaveBeenCalledTimes(1);
    resolveCollection?.([databaseSnapshot]);

    const responses = await Promise.all([first, second]);
    expect(await responses[0]?.text()).toContain("schedule_worker_database_up 1");
    expect(await responses[1]?.text()).toContain("schedule_worker_database_up 1");
  });

  it("does not listen when shutdown already started and rejects invalid ports", async () => {
    const controller = new AbortController();
    controller.abort("already stopped");
    await expect(
      runWorkerObservabilityServer(
        { port: 0, database: databaseWithSql(async () => []), telemetry: new WorkerTelemetry() },
        controller.signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      runWorkerObservabilityServer(
        { port: -1, database: databaseWithSql(async () => []), telemetry: new WorkerTelemetry() },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/port/);
  });

  it("closes the bound socket before surfacing a post-listen server error", async () => {
    const failure = new Error("simulated listener failure");
    const running = await startServer(databaseWithSql(async () => [{ ...databaseSnapshot }]));
    controllers.push(running.controller);
    servers.push(running.stopped);

    running.server.emit("error", failure);
    running.controller.abort("concurrent shutdown");

    await expect(running.stopped).rejects.toBe(failure);
    expect(running.server.listening).toBe(false);
    expect(running.server.address()).toBeNull();
  });

  it("keeps error cleanup installed while exposing the newly bound listener", async () => {
    const controller = new AbortController();
    const failure = new Error("immediate listener failure");
    let boundServer: Server | undefined;
    const stopped = runWorkerObservabilityServer(
      {
        port: 0,
        database: databaseWithSql(async () => [{ ...databaseSnapshot }]),
        telemetry: new WorkerTelemetry(),
        onListening: (_address, server) => {
          boundServer = server;
          server.emit("error", failure);
        },
      },
      controller.signal,
    );

    await expect(stopped).rejects.toBe(failure);
    expect(boundServer?.listening).toBe(false);
    expect(boundServer?.address()).toBeNull();
  });

  it("closes the listener when the listening observer throws", async () => {
    const controller = new AbortController();
    const failure = new Error("listening observer failure");
    let boundServer: Server | undefined;
    const stopped = runWorkerObservabilityServer(
      {
        port: 0,
        database: databaseWithSql(async () => [{ ...databaseSnapshot }]),
        telemetry: new WorkerTelemetry(),
        onListening: (_address, server) => {
          boundServer = server;
          throw failure;
        },
      },
      controller.signal,
    );

    await expect(stopped).rejects.toBe(failure);
    expect(boundServer?.listening).toBe(false);
    expect(boundServer?.address()).toBeNull();
  });
});
