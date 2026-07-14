import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MaterializeNotificationIntentsCommand,
  MaterializeNotificationIntentsResult,
  UnitOfWork,
} from "@schedule/application";
import { DomainError, type WorkspaceId } from "@schedule/domain";

import {
  createNotificationMaterializationDependencies,
  MAXIMUM_AUTOMATIC_MATERIALIZATION_WORKSPACES,
  runNotificationMaterializationCycle,
  runNotificationMaterializationWorker,
  type NotificationMaterializationDependencies,
  type NotificationMaterializationLogger,
} from "./notification-materializer.js";

const now = new Date("2026-07-14T12:00:00.000Z");
const enabledConfig = {
  NOTIFICATION_MATERIALIZATION_MODE: "enabled" as const,
  NOTIFICATION_MATERIALIZATION_INTERVAL_MS: 10_000,
  NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: 300_000,
};
const emptyResult: MaterializeNotificationIntentsResult = {
  created: [],
  existing: [],
  suppressed: [],
};

const workspaceId = (index: number): WorkspaceId =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as WorkspaceId;

function loggerHarness(): {
  readonly logger: NotificationMaterializationLogger;
  readonly info: Record<string, string | number | boolean>[];
  readonly error: Record<string, string | number | boolean>[];
} {
  const info: Record<string, string | number | boolean>[] = [];
  const error: Record<string, string | number | boolean>[] = [];
  return {
    info,
    error,
    logger: {
      info: (entry) => info.push({ ...entry }),
      error: (entry) => error.push({ ...entry }),
    },
  };
}

function dependencies(
  overrides: Partial<NotificationMaterializationDependencies> = {},
): NotificationMaterializationDependencies {
  return {
    clock: { now: () => new Date(now) },
    listWorkspaces: async () => [{ id: workspaceId(1) }],
    materialize: async () => emptyResult,
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("automatic notification materialization", () => {
  it("does no work while disabled", async () => {
    const listWorkspaces = vi.fn(async () => [{ id: workspaceId(1) }]);
    const materialize = vi.fn(async () => emptyResult);
    const controller = new AbortController();

    const disabledConfig = {
      ...enabledConfig,
      NOTIFICATION_MATERIALIZATION_MODE: "disabled" as const,
    };
    const summary = await runNotificationMaterializationCycle(
      disabledConfig,
      dependencies({ listWorkspaces, materialize }),
      controller.signal,
    );
    await runNotificationMaterializationWorker(
      disabledConfig,
      dependencies({ listWorkspaces, materialize }),
      controller.signal,
    );

    expect(summary.selectedWorkspaces).toBe(0);
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("binds production workspace discovery and materialization to the supplied unit of work", async () => {
    const list = vi.fn(async () => [{ id: workspaceId(1) }]);
    const discoveryUnitOfWork: UnitOfWork = {
      run: async (operation) => await operation({ workspaces: { list } } as never),
    };
    const discovery = createNotificationMaterializationDependencies(discoveryUnitOfWork, {
      now: () => new Date(now),
    });

    await expect(discovery.listWorkspaces(1)).resolves.toEqual([{ id: workspaceId(1) }]);
    expect(list).toHaveBeenCalledWith(2, 0);
    expect(discovery.clock.now()).toEqual(now);

    const lockWorkspace = vi.fn(async () => undefined);
    const materializationUnitOfWork: UnitOfWork = {
      run: async (operation) =>
        await operation({
          notifications: { lockWorkspace },
          workspaces: { findById: async () => null },
        } as never),
    };
    const materialization =
      createNotificationMaterializationDependencies(materializationUnitOfWork);
    await expect(
      materialization.materialize(
        {
          workspaceId: workspaceId(1),
          fromInclusive: new Date(now),
          throughExclusive: new Date(now.getTime() + 60_000),
        },
        new Date(now),
      ),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
    expect(lockWorkspace).toHaveBeenCalledWith(workspaceId(1));
  });

  it("emits only structured entries through the default logger", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runNotificationMaterializationCycle(
      enabledConfig,
      dependencies({ listWorkspaces: async () => [] }),
      new AbortController().signal,
    );
    await runNotificationMaterializationCycle(
      enabledConfig,
      dependencies({
        listWorkspaces: async () => {
          throw new Error("private connection detail");
        },
      }),
      new AbortController().signal,
    );

    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining('"event":"notification_materialization_tick_completed"'),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('"failureClass":"workspace_list_error"'),
    );
    expect([...consoleInfo.mock.calls, ...consoleError.mock.calls].flat().join(" ")).not.toContain(
      "private connection detail",
    );
  });

  it("uses one bounded look-ahead window and processes at most 20 workspaces sequentially", async () => {
    const commands: MaterializeNotificationIntentsCommand[] = [];
    const evaluatedAt: Date[] = [];
    let active = 0;
    let maximumActive = 0;
    const listWorkspaces = vi.fn(async (limit: number) => {
      expect(limit).toBe(MAXIMUM_AUTOMATIC_MATERIALIZATION_WORKSPACES);
      return Array.from({ length: 20 }, (_, index) => ({ id: workspaceId(index + 1) }));
    });
    const materialize = vi.fn(async (command: MaterializeNotificationIntentsCommand, at: Date) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      commands.push(command);
      evaluatedAt.push(at);
      await Promise.resolve();
      active -= 1;
      return emptyResult;
    });
    const logs = loggerHarness();

    const summary = await runNotificationMaterializationCycle(
      enabledConfig,
      dependencies({ listWorkspaces, materialize }),
      new AbortController().signal,
      logs.logger,
    );

    expect(materialize).toHaveBeenCalledTimes(20);
    expect(maximumActive).toBe(1);
    expect(summary).toMatchObject({
      selectedWorkspaces: 20,
      attemptedWorkspaces: 20,
      failedWorkspaces: 0,
      aborted: false,
    });
    expect(
      commands.every(
        (command) =>
          command.fromInclusive.toISOString() === "2026-07-14T12:00:00.000Z" &&
          command.throughExclusive.toISOString() === "2026-07-14T12:05:00.000Z",
      ),
    ).toBe(true);
    expect(evaluatedAt.every((instant) => instant.toISOString() === now.toISOString())).toBe(true);
    expect(logs.error).toEqual([]);
    expect(logs.info).toEqual([
      expect.objectContaining({
        event: "notification_materialization_tick_completed",
        selectedWorkspaces: 20,
      }),
    ]);
  });

  it("fails a tick closed when persisted workspaces violate the local installation limit", async () => {
    const materialize = vi.fn(async () => emptyResult);
    const logs = loggerHarness();

    const summary = await runNotificationMaterializationCycle(
      enabledConfig,
      dependencies({
        listWorkspaces: async () =>
          Array.from({ length: 21 }, (_, index) => ({ id: workspaceId(index + 1) })),
        materialize,
      }),
      new AbortController().signal,
      logs.logger,
    );

    expect(materialize).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      selectedWorkspaces: 0,
      attemptedWorkspaces: 0,
      workspaceLimitExceeded: true,
    });
    expect(logs.error).toEqual([
      {
        event: "notification_materialization_workspace_limit_exceeded",
        failureClass: "local_installation_limit_violation",
        maximumWorkspaces: 20,
      },
    ]);
  });

  it("isolates workspace failures, treats missing configuration as a skip, and emits no raw error", async () => {
    const attempted: WorkspaceId[] = [];
    const logs = loggerHarness();
    const secret = "private rule title that must not be logged";

    const summary = await runNotificationMaterializationCycle(
      enabledConfig,
      dependencies({
        listWorkspaces: async () => [
          { id: workspaceId(1) },
          { id: workspaceId(2) },
          { id: workspaceId(3) },
        ],
        materialize: async (command) => {
          attempted.push(command.workspaceId);
          if (command.workspaceId === workspaceId(1)) {
            throw new DomainError("notification_profile.not_found", "Not configured.");
          }
          if (command.workspaceId === workspaceId(2)) throw new Error(secret);
          return {
            created: [{} as never],
            existing: [{} as never, {} as never],
            suppressed: [{} as never],
          };
        },
      }),
      new AbortController().signal,
      logs.logger,
    );

    expect(attempted).toEqual([workspaceId(1), workspaceId(2), workspaceId(3)]);
    expect(summary).toMatchObject({
      skippedWorkspaces: 1,
      failedWorkspaces: 1,
      createdIntents: 1,
      existingIntents: 2,
      suppressedCandidates: 1,
    });
    expect(logs.error).toEqual([
      {
        event: "notification_materialization_workspace_failed",
        failureClass: "materialization_error",
        workspaceId: workspaceId(2),
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("fails a workspace-list tick safely and retries no partial selection", async () => {
    const logs = loggerHarness();
    const materialize = vi.fn(async () => emptyResult);
    const summary = await runNotificationMaterializationCycle(
      enabledConfig,
      dependencies({
        listWorkspaces: async () => {
          throw new Error("postgres password must not be logged");
        },
        materialize,
      }),
      new AbortController().signal,
      logs.logger,
    );

    expect(materialize).not.toHaveBeenCalled();
    expect(summary.workspaceListFailed).toBe(true);
    expect(logs.error).toEqual([
      {
        event: "notification_materialization_workspace_list_failed",
        failureClass: "workspace_list_error",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("postgres password");
  });

  it("does not start another workspace after shutdown begins", async () => {
    const controller = new AbortController();
    const materialize = vi.fn(async () => {
      controller.abort("SIGTERM");
      return emptyResult;
    });

    const summary = await runNotificationMaterializationCycle(
      enabledConfig,
      dependencies({
        listWorkspaces: async () => [{ id: workspaceId(1) }, { id: workspaceId(2) }],
        materialize,
      }),
      controller.signal,
      loggerHarness().logger,
    );

    expect(materialize).toHaveBeenCalledOnce();
    expect(summary.attemptedWorkspaces).toBe(1);
    expect(summary.aborted).toBe(true);
  });

  it("never overlaps ticks and exits promptly from its interval sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const firstMaterialization = deferred<MaterializeNotificationIntentsResult>();
    let materializationCount = 0;
    const listWorkspaces = vi.fn(async () => [{ id: workspaceId(1) }]);
    const worker = runNotificationMaterializationWorker(
      enabledConfig,
      dependencies({
        listWorkspaces,
        materialize: async () => {
          materializationCount += 1;
          if (materializationCount === 1) return await firstMaterialization.promise;
          controller.abort("test complete");
          return emptyResult;
        },
      }),
      controller.signal,
      loggerHarness().logger,
    );

    await vi.waitFor(() => expect(materializationCount).toBe(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listWorkspaces).toHaveBeenCalledOnce();

    firstMaterialization.resolve(emptyResult);
    await vi.waitFor(() => expect(listWorkspaces).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(listWorkspaces).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await worker;

    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    expect(materializationCount).toBe(2);
  });

  it("rejects an invalid clock before listing workspaces", async () => {
    const listWorkspaces = vi.fn(async () => []);
    await expect(
      runNotificationMaterializationCycle(
        enabledConfig,
        dependencies({ clock: { now: () => new Date(Number.NaN) }, listWorkspaces }),
        new AbortController().signal,
        loggerHarness().logger,
      ),
    ).rejects.toThrow(/invalid instant/);
    expect(listWorkspaces).not.toHaveBeenCalled();
  });
});
