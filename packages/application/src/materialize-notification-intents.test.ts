import {
  createNotificationProfile,
  createNotificationRule,
  createOneOffReminder,
  createScheduleBlock,
  createWorkItem,
  createWorkspace,
  dailyPlanId,
  localDate,
  notificationIntentId,
  planItemId,
  scheduleBlockId,
  workspaceId,
  type DailyPlan,
  type NotificationIntent,
  type NotificationProfile,
  type NotificationRule,
  type OneOffReminder,
  type ScheduleBlock,
  type WorkItem,
} from "@schedule/domain";
import { describe, expect, it } from "vitest";

import { MaterializeNotificationIntents } from "./materialize-notification-intents.js";
import type {
  AuditEventRecord,
  NotificationRepository,
  TransactionContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from "./ports.js";

const workspace = createWorkspace({
  id: workspaceId("workspace-materialization"),
  name: "Materialization",
  now: new Date("2026-07-14T07:00:00.000Z"),
});
const now = new Date("2026-07-14T08:00:00.000Z");
const window = {
  workspaceId: workspace.id,
  fromInclusive: new Date("2026-07-14T08:00:00.000Z"),
  throughExclusive: new Date("2026-07-15T00:00:00.000Z"),
};

function makePlan(
  inputSnapshot: DailyPlan["inputSnapshot"] = {
    request: {
      availableWindows: [
        {
          startsAt: "2026-07-14T10:00:00.000Z",
          endsAt: "2026-07-14T11:00:00.000Z",
        },
      ],
    },
  },
): DailyPlan {
  return {
    id: dailyPlanId("plan-materialization"),
    workspaceId: workspace.id,
    date: localDate("2026-07-14"),
    timeZone: "UTC",
    items: [
      {
        id: planItemId("plan-item-materialization"),
        sourceType: "work_item",
        routineId: null,
        workItemId: null,
        title: "Pending item",
        position: 0,
        windowIndex: 0,
        scheduledMinutes: 30,
        partialSession: false,
        score: 1,
        scoreComponents: {},
        reasons: [],
        locked: false,
        activityState: "pending",
        lastActivityEventId: null,
        activityUpdatedAt: null,
      },
    ],
    totalMinutes: 30,
    fitness: 1,
    algorithmVersion: "test",
    configVersion: "test",
    prngVersion: "test",
    seed: "test",
    requestRevision: 1,
    inputHash: "a".repeat(64),
    inputSnapshot,
    exclusions: [],
    warnings: [],
    generatedAt: new Date("2026-07-14T07:30:00.000Z"),
  };
}

interface HarnessOptions {
  readonly dailyIntentLimit?: number;
  readonly rules?: readonly NotificationRule[];
  readonly reminders?: readonly OneOffReminder[];
  readonly blocks?: readonly ScheduleBlock[];
  readonly plan?: DailyPlan | null;
  readonly dueItems?: readonly WorkItem[];
  readonly profile?: NotificationProfile | null;
  readonly existingIntents?: readonly NotificationIntent[];
  readonly oneOffResultCount?: number;
  readonly dueResultCount?: number;
  readonly blockResultCount?: number;
  readonly concurrentInsertWinner?: boolean;
}

function defaultRules(): readonly NotificationRule[] {
  const common = { workspaceId: workspace.id, now: new Date("2026-07-14T07:00:00.000Z") };
  return [
    createNotificationRule({ ...common, kind: "daily_digest", localMinute: 540 }),
    createNotificationRule({ ...common, kind: "daily_follow_up", localMinute: 1_080 }),
    createNotificationRule({ ...common, kind: "plan_window_open", leadMinutes: 10 }),
    createNotificationRule({ ...common, kind: "schedule_block_lead", leadMinutes: 15 }),
    createNotificationRule({ ...common, kind: "work_item_due", localMinute: 720 }),
  ];
}

function harness(options: HarnessOptions = {}) {
  const profile =
    options.profile === undefined
      ? createNotificationProfile({
          workspaceId: workspace.id,
          timeZone: "UTC",
          catchUpWindowMinutes: 60,
          dailyIntentLimit: options.dailyIntentLimit ?? 10,
          now: new Date("2026-07-14T07:00:00.000Z"),
        })
      : options.profile;
  const rules = options.rules ?? defaultRules();
  const reminders = options.reminders ?? [
    createOneOffReminder({
      workspaceId: workspace.id,
      title: "Explicit reminder",
      scheduledFor: new Date("2026-07-14T13:00:00.000Z"),
      now: new Date("2026-07-14T07:00:00.000Z"),
    }),
  ];
  const blocks = options.blocks ?? [
    createScheduleBlock({
      id: scheduleBlockId("block-materialization"),
      workspaceId: workspace.id,
      title: "Meeting",
      startsAt: new Date("2026-07-14T11:00:00.000Z"),
      endsAt: new Date("2026-07-14T11:30:00.000Z"),
      timeZone: "UTC",
      now: new Date("2026-07-14T07:00:00.000Z"),
    }),
  ];
  const dueItems = options.dueItems ?? [
    createWorkItem({
      workspaceId: workspace.id,
      title: "Due item",
      dueOn: localDate("2026-07-14"),
      now: new Date("2026-07-14T07:00:00.000Z"),
    }),
  ];
  const plan = options.plan === undefined ? makePlan() : options.plan;
  const intents = new Map(
    (options.existingIntents ?? []).map((intent) => [intent.occurrenceKey, intent]),
  );
  const audits: AuditEventRecord[] = [];
  let lockCount = 0;
  let oneOffLimit = 0;
  let dueLimit = 0;
  const scheduleBlockReadLimits: number[] = [];
  let planLookupDates: readonly string[] = [];
  let planLookupCount = 0;
  let concurrentInsertWinnerAvailable = options.concurrentInsertWinner ?? false;
  const repository: NotificationRepository = {
    lockWorkspace: async () => void (lockCount += 1),
    findProfile: async () => profile,
    insertProfile: async () => undefined,
    saveProfile: async () => undefined,
    findRule: async (_workspaceId, id) => rules.find((rule) => rule.id === id) ?? null,
    listRules: async (_workspaceId, limit) => rules.slice(0, limit),
    insertRule: async () => undefined,
    saveRule: async () => undefined,
    findOneOffReminder: async (_workspaceId, id) =>
      reminders.find((reminder) => reminder.id === id) ?? null,
    listOneOffReminders: async (_workspaceId, fromInclusive, throughExclusive, limit) => {
      oneOffLimit = limit;
      const matching = reminders.filter(
        (reminder) =>
          reminder.scheduledFor >= fromInclusive && reminder.scheduledFor < throughExclusive,
      );
      if (options.oneOffResultCount !== undefined && matching[0] !== undefined) {
        return Array.from(
          { length: Math.min(options.oneOffResultCount, limit) },
          () => matching[0]!,
        );
      }
      return matching.slice(0, limit);
    },
    insertOneOffReminder: async () => undefined,
    saveOneOffReminder: async () => undefined,
    listDueWorkItems: async (_workspaceId, fromInclusive, throughInclusive, limit) => {
      dueLimit = limit;
      const matching = dueItems.filter(
        (item) =>
          item.dueOn !== null && item.dueOn >= fromInclusive && item.dueOn <= throughInclusive,
      );
      if (options.dueResultCount !== undefined && matching[0] !== undefined) {
        return Array.from({ length: Math.min(options.dueResultCount, limit) }, () => matching[0]!);
      }
      return matching.slice(0, limit);
    },
    listIntents: async (_workspaceId, fromInclusive, throughExclusive, limit, offset) =>
      [...intents.values()]
        .filter(
          (intent) =>
            intent.scheduledFor >= fromInclusive && intent.scheduledFor < throughExclusive,
        )
        .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime())
        .slice(offset, offset + limit),
    listDeliveryHistory: async () => [],
    redriveDeadLetterDelivery: async () => ({ kind: "not_found" }),
    insertIntent: async (intent) => {
      const existing = intents.get(intent.occurrenceKey);
      if (existing !== undefined) return existing;
      if (concurrentInsertWinnerAvailable) {
        concurrentInsertWinnerAvailable = false;
        const winner = {
          ...intent,
          id: notificationIntentId("intent-concurrent-natural-key-winner"),
        };
        intents.set(intent.occurrenceKey, winner);
        return winner;
      }
      intents.set(intent.occurrenceKey, intent);
      return intent;
    },
    deleteIntentsForWorkspace: async () => {
      const count = intents.size;
      intents.clear();
      return count;
    },
    deleteIntentsForRule: async (_workspaceId, ruleId) => {
      let count = 0;
      for (const [key, intent] of intents) {
        if (intent.ruleId === ruleId) {
          intents.delete(key);
          count += 1;
        }
      }
      return count;
    },
    deleteIntentsForOneOff: async (_workspaceId, reminderId) => {
      let count = 0;
      for (const [key, intent] of intents) {
        if (intent.oneOffReminderId === reminderId) {
          intents.delete(key);
          count += 1;
        }
      }
      return count;
    },
    deleteIntentsForTarget: async (_workspaceId, targetType, targetId, kind) => {
      let count = 0;
      for (const [key, intent] of intents) {
        if (
          intent.targetType === targetType &&
          intent.targetId === targetId &&
          (kind === undefined || intent.kind === kind)
        ) {
          intents.delete(key);
          count += 1;
        }
      }
      return count;
    },
    deleteIntentsForTargetType: async (_workspaceId, targetType) => {
      let count = 0;
      for (const [key, intent] of intents) {
        if (intent.targetType === targetType) {
          intents.delete(key);
          count += 1;
        }
      }
      return count;
    },
  };
  const context = {
    workspaces: { findById: async (id: string) => (id === workspace.id ? workspace : null) },
    notifications: repository,
    scheduleBlocks: {
      listOverlapping: async (
        _workspaceId: string,
        fromInclusive: Date,
        throughExclusive: Date,
        limit: number,
        offset: number,
      ) =>
        (() => {
          scheduleBlockReadLimits.push(limit);
          const matching = blocks.filter(
            (block) => block.startsAt < throughExclusive && block.endsAt > fromInclusive,
          );
          if (options.blockResultCount !== undefined && matching[0] !== undefined) {
            return Array.from({ length: options.blockResultCount }, () => matching[0]!).slice(
              offset,
              offset + limit,
            );
          }
          return matching.slice(offset, offset + limit);
        })(),
    },
    dailyPlans: {
      findCurrent: async (_workspaceId: string, date: string) =>
        plan !== null && plan.date === date ? { plan, headVersion: 1 } : null,
      findCurrentForDates: async (_workspaceId: string, dates: readonly string[]) => {
        planLookupCount += 1;
        planLookupDates = [...dates];
        return new Map(
          plan === null || !dates.includes(plan.date)
            ? []
            : [[plan.date, { plan, headVersion: 1 }]],
        );
      },
    },
    auditEvents: { append: async (event: AuditEventRecord) => void audits.push(event) },
  } as unknown as TransactionContext;
  const transactionOptions: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork: UnitOfWork = {
    run: async <Result>(
      operation: (transaction: TransactionContext) => Promise<Result>,
      options?: UnitOfWorkOptions,
    ) => {
      transactionOptions.push(options);
      return operation(context);
    },
  };
  return {
    audits,
    get lockCount() {
      return lockCount;
    },
    get oneOffLimit() {
      return oneOffLimit;
    },
    get dueLimit() {
      return dueLimit;
    },
    get scheduleBlockReadLimits() {
      return scheduleBlockReadLimits;
    },
    get planLookupDates() {
      return planLookupDates;
    },
    get planLookupCount() {
      return planLookupCount;
    },
    intents,
    service: new MaterializeNotificationIntents(unitOfWork, { now: () => new Date(now) }),
    transactionOptions,
  };
}

describe("notification intent materialization", () => {
  it("materializes all supported deterministic sources and makes replay exact-once", async () => {
    const test = harness();
    const first = await test.service.execute(window);
    expect(first.created.map((intent) => intent.kind).sort()).toEqual(
      [
        "daily_digest",
        "daily_follow_up",
        "one_off",
        "plan_window_open",
        "schedule_block_lead",
        "work_item_due",
      ].sort(),
    );
    expect(test.planLookupCount).toBe(1);
    expect(test.planLookupDates).toContain("2026-07-14");
    expect(test.planLookupDates.length).toBeGreaterThan(1);
    expect(new Set(first.created.map((intent) => intent.occurrenceKey)).size).toBe(6);
    expect(first.existing).toEqual([]);
    expect(test.intents.size).toBe(6);
    expect(test.audits).toHaveLength(1);
    expect(test.audits[0]).toMatchObject({
      action: "notification_intents.materialized",
      data: { created: 6, existing: 0 },
    });
    expect(test.transactionOptions).toEqual([{ isolationLevel: "read_committed" }]);

    const second = await test.service.execute(window);
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(6);
    expect(test.intents.size).toBe(6);
    expect(test.audits).toHaveLength(1);
    expect(test.lockCount).toBe(2);
  });

  it("applies the stable source-priority order before the daily cap", async () => {
    const test = harness({ dailyIntentLimit: 2 });
    const result = await test.service.execute(window);
    expect(result.created.map((intent) => intent.kind)).toEqual(["one_off", "schedule_block_lead"]);
    expect(result.suppressed.filter((item) => item.reason === "daily_limit")).toHaveLength(4);
  });

  it("counts intents outside a narrow instant window toward the same local-day cap", async () => {
    const priorRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 510,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const candidateRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 540,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const prior: NotificationIntent = {
      id: notificationIntentId("intent-prior-local-day-cap"),
      workspaceId: workspace.id,
      ruleId: priorRule.id,
      oneOffReminderId: null,
      kind: "daily_digest",
      occurrenceKey: `rule:${priorRule.id}:daily_digest:day:2026-07-14`,
      targetType: "workspace",
      targetId: null,
      titleSnapshot: null,
      scheduledFor: new Date("2026-07-14T08:30:00.000Z"),
      localDate: localDate("2026-07-14"),
      priority: priorRule.priority,
      policySnapshot: { profileVersion: 1, ruleVersion: 1 },
      localTimeResolution: "exact",
      adjustedForQuietHours: false,
      caughtUp: false,
      createdAt: new Date("2026-07-14T08:00:00.000Z"),
    };
    const test = harness({
      dailyIntentLimit: 1,
      rules: [candidateRule],
      reminders: [],
      blocks: [],
      dueItems: [],
      plan: null,
      existingIntents: [prior],
    });
    const result = await test.service.execute({
      ...window,
      fromInclusive: new Date("2026-07-14T08:50:00.000Z"),
      throughExclusive: new Date("2026-07-14T09:10:00.000Z"),
    });
    expect(result.created).toEqual([]);
    expect(result.suppressed).toContainEqual({
      occurrenceKey: `rule:${candidateRule.id}:daily_digest:day:2026-07-14`,
      reason: "daily_limit",
    });
  });

  it("keeps persisted local dates authoritative after the profile timezone changes", async () => {
    const candidateRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 1_380,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const priorRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 1_350,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const prior: NotificationIntent = {
      id: notificationIntentId("intent-prior-old-timezone-date"),
      workspaceId: workspace.id,
      ruleId: priorRule.id,
      oneOffReminderId: null,
      kind: "daily_digest",
      occurrenceKey: `rule:${priorRule.id}:daily_digest:day:old-zone-date`,
      targetType: "workspace",
      targetId: null,
      titleSnapshot: null,
      scheduledFor: new Date("2026-07-14T08:30:00.000Z"),
      localDate: localDate("2026-07-13"),
      priority: priorRule.priority,
      policySnapshot: { profileVersion: 1, ruleVersion: 1 },
      localTimeResolution: "exact",
      adjustedForQuietHours: false,
      caughtUp: false,
      createdAt: new Date("2026-07-14T08:00:00.000Z"),
    };
    const test = harness({
      profile: createNotificationProfile({
        workspaceId: workspace.id,
        timeZone: "Pacific/Kiritimati",
        dailyIntentLimit: 1,
        now: new Date("2026-07-14T07:00:00.000Z"),
      }),
      rules: [candidateRule],
      reminders: [],
      blocks: [],
      dueItems: [],
      plan: null,
      existingIntents: [prior],
    });
    const result = await test.service.execute({
      ...window,
      fromInclusive: new Date("2026-07-14T08:50:00.000Z"),
      throughExclusive: new Date("2026-07-14T09:10:00.000Z"),
    });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.occurrenceKey).toBe(
      `rule:${candidateRule.id}:daily_digest:day:2026-07-14`,
    );
    expect(result.suppressed).not.toContainEqual(
      expect.objectContaining({ reason: "daily_limit" }),
    );
  });

  it("applies a rule cooldown deterministically across nearby targets", async () => {
    const scheduleRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "schedule_block_lead",
      leadMinutes: 15,
      cooldownMinutes: 30,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const secondBlock = createScheduleBlock({
      id: scheduleBlockId("block-materialization-second"),
      workspaceId: workspace.id,
      title: "Nearby meeting",
      startsAt: new Date("2026-07-14T11:10:00.000Z"),
      endsAt: new Date("2026-07-14T11:40:00.000Z"),
      timeZone: "UTC",
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const firstBlock = createScheduleBlock({
      id: scheduleBlockId("block-materialization-first"),
      workspaceId: workspace.id,
      title: "First meeting",
      startsAt: new Date("2026-07-14T11:00:00.000Z"),
      endsAt: new Date("2026-07-14T11:30:00.000Z"),
      timeZone: "UTC",
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const test = harness({
      rules: [scheduleRule],
      reminders: [],
      blocks: [secondBlock, firstBlock],
      dueItems: [],
      plan: null,
    });
    const result = await test.service.execute(window);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.targetId).toBe(firstBlock.id);
    expect(result.suppressed).toContainEqual({
      occurrenceKey: `rule:${scheduleRule.id}:schedule-block:${secondBlock.id}`,
      reason: "cooldown",
    });
  });

  it("counts a concurrent natural-key winner against the remaining daily budget", async () => {
    const firstRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 540,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const secondRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 600,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const test = harness({
      dailyIntentLimit: 1,
      rules: [firstRule, secondRule],
      reminders: [],
      blocks: [],
      dueItems: [],
      plan: null,
      concurrentInsertWinner: true,
    });
    const result = await test.service.execute(window);
    expect(result.created).toEqual([]);
    expect(result.existing).toHaveLength(1);
    expect(result.suppressed).toContainEqual({
      occurrenceKey: `rule:${secondRule.id}:daily_digest:day:2026-07-14`,
      reason: "daily_limit",
    });
  });

  it("uses a concurrent natural-key winner for later cooldown checks", async () => {
    const scheduleRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "schedule_block_lead",
      leadMinutes: 15,
      cooldownMinutes: 30,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const firstBlock = createScheduleBlock({
      id: scheduleBlockId("concurrent-cooldown-first"),
      workspaceId: workspace.id,
      title: "First meeting",
      startsAt: new Date("2026-07-14T11:00:00.000Z"),
      endsAt: new Date("2026-07-14T11:30:00.000Z"),
      timeZone: "UTC",
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const secondBlock = createScheduleBlock({
      id: scheduleBlockId("concurrent-cooldown-second"),
      workspaceId: workspace.id,
      title: "Second meeting",
      startsAt: new Date("2026-07-14T11:10:00.000Z"),
      endsAt: new Date("2026-07-14T11:40:00.000Z"),
      timeZone: "UTC",
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const test = harness({
      rules: [scheduleRule],
      reminders: [],
      blocks: [firstBlock, secondBlock],
      dueItems: [],
      plan: null,
      concurrentInsertWinner: true,
    });
    const result = await test.service.execute(window);
    expect(result.created).toEqual([]);
    expect(result.existing).toHaveLength(1);
    expect(result.suppressed).toContainEqual({
      occurrenceKey: `rule:${scheduleRule.id}:schedule-block:${secondBlock.id}`,
      reason: "cooldown",
    });
  });

  it("loads the full configured cooldown history before accepting a candidate", async () => {
    const digestRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 540,
      cooldownMinutes: 10_080,
      now: new Date("2026-07-10T07:00:00.000Z"),
    });
    const prior: NotificationIntent = {
      id: notificationIntentId("intent-prior-seven-day-cooldown"),
      workspaceId: workspace.id,
      ruleId: digestRule.id,
      oneOffReminderId: null,
      kind: "daily_digest",
      occurrenceKey: `rule:${digestRule.id}:daily_digest:day:2026-07-11`,
      targetType: "workspace",
      targetId: null,
      titleSnapshot: null,
      scheduledFor: new Date("2026-07-11T09:00:00.000Z"),
      localDate: localDate("2026-07-11"),
      priority: digestRule.priority,
      policySnapshot: { profileVersion: 1, ruleVersion: 1 },
      localTimeResolution: "exact",
      adjustedForQuietHours: false,
      caughtUp: false,
      createdAt: new Date("2026-07-11T08:00:00.000Z"),
    };
    const test = harness({
      rules: [digestRule],
      reminders: [],
      blocks: [],
      dueItems: [],
      plan: null,
      existingIntents: [prior],
    });
    const result = await test.service.execute(window);
    expect(result.created).toEqual([]);
    expect(result.suppressed).toContainEqual({
      occurrenceKey: `rule:${digestRule.id}:daily_digest:day:2026-07-14`,
      reason: "cooldown",
    });
  });

  it("bounds one-off source reads at one row beyond the accepted limit", async () => {
    const accepted = harness({
      rules: [],
      blocks: [],
      dueItems: [],
      plan: null,
      oneOffResultCount: 5_000,
    });
    await expect(accepted.service.execute(window)).resolves.toMatchObject({
      created: expect.any(Array),
    });
    expect(accepted.oneOffLimit).toBe(5_001);

    const rejected = harness({
      rules: [],
      blocks: [],
      dueItems: [],
      plan: null,
      oneOffResultCount: 5_001,
    });
    await expect(rejected.service.execute(window)).rejects.toMatchObject({
      code: "notification.materialization_source_limit",
    });
    expect(rejected.oneOffLimit).toBe(5_001);
  });

  it("bounds due-work source reads at one row beyond the accepted limit", async () => {
    const rule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "work_item_due",
      localMinute: 720,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const accepted = harness({
      rules: [rule],
      reminders: [],
      blocks: [],
      plan: null,
      dueResultCount: 5_000,
    });
    await expect(accepted.service.execute(window)).resolves.toMatchObject({
      created: expect.any(Array),
    });
    expect(accepted.dueLimit).toBe(5_001);

    const rejected = harness({
      rules: [rule],
      reminders: [],
      blocks: [],
      plan: null,
      dueResultCount: 5_001,
    });
    await expect(rejected.service.execute(window)).rejects.toMatchObject({
      code: "notification.materialization_source_limit",
    });
    expect(rejected.dueLimit).toBe(5_001);
  });

  it("bounds paged schedule-block source reads at one row beyond the accepted limit", async () => {
    const rule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "schedule_block_lead",
      leadMinutes: 15,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const accepted = harness({
      rules: [rule],
      reminders: [],
      dueItems: [],
      plan: null,
      blockResultCount: 5_000,
    });
    await expect(accepted.service.execute(window)).resolves.toMatchObject({
      created: expect.any(Array),
    });
    expect(accepted.scheduleBlockReadLimits).toEqual([...Array.from({ length: 10 }, () => 500), 1]);

    const rejected = harness({
      rules: [rule],
      reminders: [],
      dueItems: [],
      plan: null,
      blockResultCount: 5_001,
    });
    await expect(rejected.service.execute(window)).rejects.toMatchObject({
      code: "notification.materialization_source_limit",
    });
    expect(rejected.scheduleBlockReadLimits.at(-1)).toBe(1);
  });

  it("ignores cancelled one-offs, terminal work, and completed follow-up plans", async () => {
    const reminder = createOneOffReminder({
      workspaceId: workspace.id,
      title: "Cancelled",
      scheduledFor: new Date("2026-07-14T13:00:00.000Z"),
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const cancelled = { ...reminder, cancelledAt: new Date("2026-07-14T07:30:00.000Z") };
    const done = createWorkItem({
      workspaceId: workspace.id,
      title: "Done",
      status: "done",
      dueOn: localDate("2026-07-14"),
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const completePlan = makePlan();
    const completed = {
      ...completePlan,
      items: completePlan.items.map((item) => ({ ...item, activityState: "completed" as const })),
    };
    const rules = defaultRules().filter((rule) =>
      ["daily_follow_up", "work_item_due"].includes(rule.kind),
    );
    const test = harness({
      rules,
      reminders: [cancelled],
      blocks: [],
      dueItems: [done],
      plan: completed,
    });
    const result = await test.service.execute(window);
    expect(result.created).toEqual([]);
  });

  it("fails closed for malformed plan snapshots and invalid or unconfigured windows", async () => {
    const windowRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "plan_window_open",
      leadMinutes: 10,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    await expect(
      harness({
        rules: [windowRule],
        reminders: [],
        blocks: [],
        dueItems: [],
        plan: makePlan({ request: {} }),
      }).service.execute(window),
    ).rejects.toMatchObject({ code: "notification.plan_snapshot_invalid" });
    await expect(harness({ profile: null }).service.execute(window)).rejects.toMatchObject({
      code: "notification_profile.not_found",
    });
    await expect(
      harness().service.execute({
        ...window,
        throughExclusive: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "notification.materialization_window_too_large" });
    await expect(
      harness().service.execute({
        ...window,
        throughExclusive: new Date("2026-07-14T07:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "notification.materialization_window_invalid" });
  });

  it("supports the maximum window together with the maximum catch-up horizon", async () => {
    const digestRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 540,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    const test = harness({
      profile: createNotificationProfile({
        workspaceId: workspace.id,
        timeZone: "UTC",
        catchUpWindowMinutes: 10_080,
        dailyIntentLimit: 100,
        now: new Date("2026-07-14T07:00:00.000Z"),
      }),
      rules: [digestRule],
      reminders: [],
      blocks: [],
      dueItems: [],
      plan: null,
    });
    await expect(
      test.service.execute({
        workspaceId: workspace.id,
        fromInclusive: new Date("2026-07-14T08:00:00.000Z"),
        throughExclusive: new Date("2026-08-14T08:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ created: expect.any(Array) });
  });

  it("rejects overlarge persisted rule, window, and aggregate candidate sets", async () => {
    const tooManyRules = Array.from({ length: 101 }, (_, index) =>
      createNotificationRule({
        workspaceId: workspace.id,
        kind: "daily_digest",
        localMinute: index,
        now: new Date("2026-07-14T07:00:00.000Z"),
      }),
    );
    await expect(
      harness({
        rules: tooManyRules,
        reminders: [],
        blocks: [],
        dueItems: [],
        plan: null,
      }).service.execute(window),
    ).rejects.toMatchObject({ code: "notification.materialization_rule_limit" });

    const windows = Array.from({ length: 65 }, (_, index) => ({
      startsAt: new Date(Date.UTC(2026, 6, 14, 10, index)).toISOString(),
      endsAt: new Date(Date.UTC(2026, 6, 14, 10, index + 1)).toISOString(),
    }));
    const windowRule = createNotificationRule({
      workspaceId: workspace.id,
      kind: "plan_window_open",
      leadMinutes: 0,
      now: new Date("2026-07-14T07:00:00.000Z"),
    });
    await expect(
      harness({
        rules: [windowRule],
        reminders: [],
        blocks: [],
        dueItems: [],
        plan: makePlan({ request: { availableWindows: windows } }),
      }).service.execute(window),
    ).rejects.toMatchObject({ code: "notification.plan_snapshot_invalid" });

    const blocks = Array.from({ length: 5_000 }, (_, index) =>
      createScheduleBlock({
        id: scheduleBlockId(`candidate-budget-block-${String(index)}`),
        workspaceId: workspace.id,
        title: `Block ${String(index)}`,
        startsAt: new Date("2026-07-14T11:00:00.000Z"),
        endsAt: new Date("2026-07-14T11:30:00.000Z"),
        timeZone: "UTC",
        now: new Date("2026-07-14T07:00:00.000Z"),
      }),
    );
    const scheduleRules = Array.from({ length: 3 }, () =>
      createNotificationRule({
        workspaceId: workspace.id,
        kind: "schedule_block_lead",
        leadMinutes: 15,
        now: new Date("2026-07-14T07:00:00.000Z"),
      }),
    );
    await expect(
      harness({
        rules: scheduleRules,
        reminders: [],
        blocks,
        dueItems: [],
        plan: null,
      }).service.execute(window),
    ).rejects.toMatchObject({ code: "notification.materialization_candidate_limit" });
  });
});
