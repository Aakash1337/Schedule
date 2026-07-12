import { describe, expect, it } from "vitest";

import {
  DomainError,
  activityEventId,
  dailyPlanId,
  localDate,
  planItemId,
  recordActivityEvent,
  routineId,
  workspaceId,
} from "@schedule/domain";

import type { RecordPlanItemActivityInput, TransactionContext, UnitOfWork } from "./ports.js";
import { RecordPlanItemActivity } from "./record-plan-item-activity.js";

describe("RecordPlanItemActivity", () => {
  const workspace = workspaceId("plan-item-activity-workspace");
  const plan = dailyPlanId("plan-item-activity-plan");
  const item = planItemId("plan-item-activity-item");
  const occurredAt = new Date("2026-07-15T10:00:00.000Z");
  const now = new Date("2026-07-15T10:01:00.000Z");

  function harness(clockNow = now) {
    let captured: RecordPlanItemActivityInput | null = null;
    let transactionRuns = 0;
    const context = {
      dailyPlans: {
        recordItemActivity: async (input: RecordPlanItemActivityInput) => {
          captured = input;
          return {
            planId: input.expectedPlanId,
            itemId: input.itemId,
            activityState: input.type === "completion_reversed" ? "pending" : input.type,
            activityEvent: recordActivityEvent({
              id: activityEventId("plan-item-activity-event"),
              workspaceId: input.workspaceId,
              routineId: routineId("plan-item-activity-routine"),
              planId: input.expectedPlanId,
              planItemId: input.itemId,
              type: input.type,
              occurredAt: input.occurredAt,
              timeZone: input.timeZone,
              durationMinutes: input.durationMinutes,
              reason: input.reason,
              ...(input.type === "completion_reversed"
                ? { referenceEventId: activityEventId("prior-completion") }
                : {}),
              metadata: input.metadata,
              idempotencyKey: input.idempotencyKey,
              recordedAt: input.now,
            }),
            headVersion: input.expectedHeadVersion + 1,
          };
        },
      } as TransactionContext["dailyPlans"],
    } as TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => {
        transactionRuns += 1;
        return operation(context);
      },
    };
    return {
      useCase: new RecordPlanItemActivity(unitOfWork, { now: () => new Date(clockNow) }),
      captured: () => captured,
      transactionRuns: () => transactionRuns,
    };
  }

  it("normalizes and delegates an item-scoped completion", async () => {
    const test = harness();
    const result = await test.useCase.execute({
      workspaceId: workspace,
      date: localDate("2026-07-15"),
      expectedPlanId: plan,
      itemId: item,
      expectedHeadVersion: 4,
      type: "completed",
      occurredAt,
      timeZone: "UTC",
      durationMinutes: 31,
      metadata: { source: "today" },
      idempotencyKey: "  complete-item  ",
    });

    expect(result).toMatchObject({ activityState: "completed", headVersion: 5 });
    expect(test.captured()).toMatchObject({
      durationMinutes: 31,
      reason: null,
      idempotencyKey: "complete-item",
      now,
    });
  });

  it("rejects duration on a non-completion before opening a transaction", () => {
    const test = harness();

    expect(() =>
      test.useCase.execute({
        workspaceId: workspace,
        date: localDate("2026-07-15"),
        expectedPlanId: plan,
        itemId: item,
        expectedHeadVersion: 4,
        type: "started",
        occurredAt,
        timeZone: "UTC",
        durationMinutes: 5,
        idempotencyKey: "invalid-duration",
      }),
    ).toThrowError(DomainError);
    expect(test.transactionRuns()).toBe(0);
  });

  it("delegates completion reversal with its normalized nullable fields", async () => {
    const test = harness();
    const result = await test.useCase.execute({
      workspaceId: workspace,
      date: localDate("2026-07-15"),
      expectedPlanId: plan,
      itemId: item,
      expectedHeadVersion: 4,
      type: "completion_reversed",
      occurredAt,
      timeZone: "UTC",
      reason: "  corrected duplicate  ",
      idempotencyKey: " reverse-completion ",
    });

    expect(result.activityState).toBe("pending");
    expect(test.captured()).toMatchObject({
      type: "completion_reversed",
      durationMinutes: null,
      reason: "  corrected duplicate  ",
      idempotencyKey: "reverse-completion",
      metadata: {},
    });
  });

  it.each([
    ["invalid head", { expectedHeadVersion: 0 }, "planning.head_version_invalid"],
    ["blank idempotency key", { idempotencyKey: "   " }, "planning.idempotency_key_invalid"],
  ] as const)("rejects %s before opening a transaction", (_label, override, code) => {
    const test = harness();
    expect(() =>
      test.useCase.execute({
        workspaceId: workspace,
        date: localDate("2026-07-15"),
        expectedPlanId: plan,
        itemId: item,
        expectedHeadVersion: 4,
        type: "started",
        occurredAt,
        timeZone: "UTC",
        idempotencyKey: "valid-key",
        ...override,
      }),
    ).toThrowError(expect.objectContaining({ code }));
    expect(test.transactionRuns()).toBe(0);
  });

  it("rejects an invalid interaction clock before opening a transaction", () => {
    const test = harness(new Date("invalid"));
    expect(() =>
      test.useCase.execute({
        workspaceId: workspace,
        date: localDate("2026-07-15"),
        expectedPlanId: plan,
        itemId: item,
        expectedHeadVersion: 4,
        type: "started",
        occurredAt,
        timeZone: "UTC",
        idempotencyKey: "invalid-clock",
      }),
    ).toThrowError(expect.objectContaining({ code: "planning.timestamp_invalid" }));
    expect(test.transactionRuns()).toBe(0);
  });
});
