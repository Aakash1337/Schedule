import {
  createWorkspace,
  localDate,
  maximumNotificationRules,
  notificationIntentId,
  notificationRuleId,
  oneOffReminderId,
  workspaceId,
  type NotificationIntent,
  type NotificationProfile,
  type NotificationRule,
  type OneOffReminder,
  type DomainError,
} from "@schedule/domain";
import { describe, expect, it } from "vitest";

import {
  CancelOneOffReminder,
  ConfigureNotificationProfile,
  CreateNotificationRule,
  CreateOneOffReminder,
  GetNotificationProfile,
  ListNotificationIntents,
  ListNotificationRules,
  ListOneOffReminders,
  UpdateNotificationRule,
  UpdateOneOffReminder,
} from "./notification-management.js";
import type {
  AuditEventRecord,
  NotificationRepository,
  TransactionContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from "./ports.js";

const workspace = createWorkspace({
  id: workspaceId("workspace-notification-management"),
  name: "Notifications",
  now: new Date("2026-07-14T08:00:00.000Z"),
});
const clock = { now: () => new Date("2026-07-14T09:00:00.000Z") };

function ruleIntent(rule: NotificationRule): NotificationIntent {
  return {
    id: notificationIntentId(`intent-for-${rule.id}`),
    workspaceId: workspace.id,
    ruleId: rule.id,
    oneOffReminderId: null,
    kind: rule.kind,
    occurrenceKey: `rule:${rule.id}:test`,
    targetType: "workspace",
    targetId: null,
    titleSnapshot: null,
    scheduledFor: new Date("2026-07-15T12:00:00.000Z"),
    localDate: localDate("2026-07-15"),
    priority: rule.priority,
    policySnapshot: { profileVersion: 1, ruleVersion: rule.version },
    localTimeResolution: "exact",
    adjustedForQuietHours: false,
    caughtUp: false,
    createdAt: clock.now(),
  };
}

function oneOffIntent(reminder: OneOffReminder): NotificationIntent {
  return {
    id: notificationIntentId(`intent-for-${reminder.id}-${String(reminder.version)}`),
    workspaceId: workspace.id,
    ruleId: null,
    oneOffReminderId: reminder.id,
    kind: "one_off",
    occurrenceKey: `one-off:${reminder.id}`,
    targetType: "one_off",
    targetId: null,
    titleSnapshot: reminder.title,
    scheduledFor: new Date(reminder.scheduledFor),
    localDate: localDate("2026-07-15"),
    priority: 100,
    policySnapshot: { profileVersion: 1, oneOffReminderVersion: reminder.version },
    localTimeResolution: "exact",
    adjustedForQuietHours: false,
    caughtUp: false,
    createdAt: clock.now(),
  };
}

class MemoryNotificationRepository implements NotificationRepository {
  profile: NotificationProfile | null = null;
  readonly rules = new Map<string, NotificationRule>();
  readonly reminders = new Map<string, OneOffReminder>();
  readonly intents = new Map<string, NotificationIntent>();
  lockCount = 0;
  profileSaveCount = 0;

  async lockWorkspace(): Promise<void> {
    this.lockCount += 1;
  }

  async findProfile(): Promise<NotificationProfile | null> {
    return this.profile;
  }

  async insertProfile(profile: NotificationProfile): Promise<void> {
    if (this.profile !== null) throw new Error("duplicate profile");
    this.profile = profile;
  }

  async saveProfile(profile: NotificationProfile, expectedVersion: number): Promise<void> {
    if (this.profile?.version !== expectedVersion) throw new Error("profile conflict");
    this.profile = profile;
    this.profileSaveCount += 1;
  }

  async findRule(_workspaceId: unknown, id: string): Promise<NotificationRule | null> {
    return this.rules.get(id) ?? null;
  }

  async listRules(_workspaceId: unknown, limit: number): Promise<readonly NotificationRule[]> {
    return [...this.rules.values()]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .slice(0, limit);
  }

  async insertRule(rule: NotificationRule): Promise<void> {
    this.rules.set(rule.id, rule);
  }

  async saveRule(rule: NotificationRule, expectedVersion: number): Promise<void> {
    if (this.rules.get(rule.id)?.version !== expectedVersion) throw new Error("rule conflict");
    this.rules.set(rule.id, rule);
  }

  async findOneOffReminder(_workspaceId: unknown, id: string): Promise<OneOffReminder | null> {
    return this.reminders.get(id) ?? null;
  }

  async listOneOffReminders(
    _workspaceId: unknown,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
  ): Promise<readonly OneOffReminder[]> {
    return [...this.reminders.values()]
      .filter(
        (reminder) =>
          reminder.scheduledFor >= fromInclusive && reminder.scheduledFor < throughExclusive,
      )
      .slice(0, limit);
  }

  async insertOneOffReminder(reminder: OneOffReminder): Promise<void> {
    this.reminders.set(reminder.id, reminder);
  }

  async saveOneOffReminder(reminder: OneOffReminder, expectedVersion: number): Promise<void> {
    if (this.reminders.get(reminder.id)?.version !== expectedVersion) {
      throw new Error("reminder conflict");
    }
    this.reminders.set(reminder.id, reminder);
  }

  async listDueWorkItems(): Promise<readonly never[]> {
    return [];
  }

  async listIntents(
    _workspaceId: unknown,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
    offset: number,
  ): Promise<readonly NotificationIntent[]> {
    return [...this.intents.values()]
      .filter(
        (intent) => intent.scheduledFor >= fromInclusive && intent.scheduledFor < throughExclusive,
      )
      .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime())
      .slice(offset, offset + limit);
  }

  async insertIntent(intent: NotificationIntent): Promise<NotificationIntent> {
    const existing = this.intents.get(intent.occurrenceKey);
    if (existing !== undefined) return existing;
    this.intents.set(intent.occurrenceKey, intent);
    return intent;
  }

  async deleteIntentsForWorkspace(): Promise<number> {
    const count = this.intents.size;
    this.intents.clear();
    return count;
  }

  async deleteIntentsForRule(_workspaceId: unknown, ruleId: string): Promise<number> {
    return this.deleteMatchingIntents((intent) => intent.ruleId === ruleId);
  }

  async deleteIntentsForOneOff(_workspaceId: unknown, reminderId: string): Promise<number> {
    return this.deleteMatchingIntents((intent) => intent.oneOffReminderId === reminderId);
  }

  async deleteIntentsForTarget(
    _workspaceId: unknown,
    targetType: NotificationIntent["targetType"],
    targetId: string,
    kind?: NotificationIntent["kind"],
  ): Promise<number> {
    return this.deleteMatchingIntents(
      (intent) =>
        intent.targetType === targetType &&
        intent.targetId === targetId &&
        (kind === undefined || intent.kind === kind),
    );
  }

  async deleteIntentsForTargetType(
    _workspaceId: unknown,
    targetType: NotificationIntent["targetType"],
  ): Promise<number> {
    return this.deleteMatchingIntents((intent) => intent.targetType === targetType);
  }

  private deleteMatchingIntents(predicate: (intent: NotificationIntent) => boolean): number {
    let count = 0;
    for (const [key, intent] of this.intents) {
      if (predicate(intent)) {
        this.intents.delete(key);
        count += 1;
      }
    }
    return count;
  }
}

function harness() {
  const notifications = new MemoryNotificationRepository();
  const audits: AuditEventRecord[] = [];
  const context = {
    workspaces: { findById: async (id: string) => (id === workspace.id ? workspace : null) },
    notifications,
    auditEvents: { append: async (event: AuditEventRecord) => void audits.push(event) },
  } as unknown as TransactionContext;
  const options: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork: UnitOfWork = {
    run: async <Result>(
      operation: (transaction: TransactionContext) => Promise<Result>,
      option?: UnitOfWorkOptions,
    ) => {
      options.push(option);
      return operation(context);
    },
  };
  return { audits, notifications, options, unitOfWork };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code } satisfies Partial<DomainError>);
}

describe("notification profile application service", () => {
  it("creates, reads, updates, audits, and preserves a no-op", async () => {
    const { audits, notifications, unitOfWork } = harness();
    const configure = new ConfigureNotificationProfile(unitOfWork, clock);
    const created = await configure.execute({
      workspaceId: workspace.id,
      expectedVersion: null,
      timeZone: "America/La_Paz",
      quietHoursStartMinute: 1_320,
      quietHoursEndMinute: 420,
    });
    expect(created.version).toBe(1);
    await expect(new GetNotificationProfile(unitOfWork).execute(workspace.id)).resolves.toBe(
      created,
    );
    const reminder: OneOffReminder = {
      id: oneOffReminderId("profile-invalidation-reminder"),
      workspaceId: workspace.id,
      title: "Pending reminder",
      scheduledFor: new Date("2026-07-15T12:00:00.000Z"),
      cancelledAt: null,
      version: 1,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };
    const pending = oneOffIntent(reminder);
    notifications.intents.set(pending.occurrenceKey, pending);

    const updated = await configure.execute({
      workspaceId: workspace.id,
      expectedVersion: 1,
      timeZone: "America/La_Paz",
      quietHoursStartMinute: 1_320,
      quietHoursEndMinute: 420,
      dailyIntentLimit: 8,
    });
    expect(updated).toMatchObject({ version: 2, dailyIntentLimit: 8 });
    expect(notifications.intents.size).toBe(0);
    expect(audits.at(-1)?.data).toMatchObject({ invalidatedIntents: 1 });
    const unchanged = await configure.execute({
      workspaceId: workspace.id,
      expectedVersion: 2,
      timeZone: "America/La_Paz",
      quietHoursStartMinute: 1_320,
      quietHoursEndMinute: 420,
      dailyIntentLimit: 8,
    });
    expect(unchanged).toBe(updated);
    expect(notifications.profileSaveCount).toBe(1);
    expect(audits.map((audit) => audit.action)).toEqual([
      "notification_profile.created",
      "notification_profile.updated",
    ]);
    expect(notifications.lockCount).toBe(3);
  });

  it("rejects create/update version mismatches and missing workspaces", async () => {
    const { unitOfWork } = harness();
    const configure = new ConfigureNotificationProfile(unitOfWork, clock);
    await expectCode(
      configure.execute({
        workspaceId: workspace.id,
        expectedVersion: 1,
        timeZone: "UTC",
      }),
      "notification_profile.version_conflict",
    );
    await expectCode(
      configure.execute({
        workspaceId: workspaceId("missing"),
        expectedVersion: null,
        timeZone: "UTC",
      }),
      "workspace.not_found",
    );
    await expectCode(
      Promise.resolve().then(() =>
        configure.execute({
          workspaceId: workspace.id,
          expectedVersion: 0,
          timeZone: "UTC",
        }),
      ),
      "notification.expected_version_invalid",
    );
  });
});

describe("notification rule application service", () => {
  it("enforces a bounded per-workspace rule count", async () => {
    const { unitOfWork } = harness();
    await new ConfigureNotificationProfile(unitOfWork, clock).execute({
      workspaceId: workspace.id,
      expectedVersion: null,
      timeZone: "UTC",
    });
    const create = new CreateNotificationRule(unitOfWork, clock);
    for (let index = 0; index < maximumNotificationRules; index += 1) {
      await create.execute({
        workspaceId: workspace.id,
        kind: "daily_digest",
        localMinute: index,
      });
    }
    await expect(new ListNotificationRules(unitOfWork).execute(workspace.id)).resolves.toHaveLength(
      maximumNotificationRules,
    );
    await expectCode(
      create.execute({
        workspaceId: workspace.id,
        kind: "daily_digest",
        localMinute: 600,
      }),
      "notification_rule.limit_reached",
    );
  });

  it("requires a profile and performs optimistic versioned rule updates", async () => {
    const { audits, notifications, unitOfWork } = harness();
    const create = new CreateNotificationRule(unitOfWork, clock);
    await expectCode(
      create.execute({
        workspaceId: workspace.id,
        kind: "daily_digest",
        localMinute: 480,
      }),
      "notification_profile.not_found",
    );
    await new ConfigureNotificationProfile(unitOfWork, clock).execute({
      workspaceId: workspace.id,
      expectedVersion: null,
      timeZone: "UTC",
    });
    const rule = await create.execute({
      workspaceId: workspace.id,
      kind: "daily_digest",
      localMinute: 480,
    });
    const pending = ruleIntent(rule);
    notifications.intents.set(pending.occurrenceKey, pending);
    const updated = await new UpdateNotificationRule(unitOfWork, clock).execute({
      workspaceId: workspace.id,
      ruleId: rule.id,
      expectedVersion: 1,
      priority: 90,
    });
    expect(updated).toMatchObject({ priority: 90, version: 2 });
    expect(notifications.intents.size).toBe(0);
    expect(audits.at(-1)?.data).toMatchObject({ invalidatedIntents: 1 });
    await expect(new ListNotificationRules(unitOfWork).execute(workspace.id)).resolves.toEqual([
      updated,
    ]);
    await expectCode(
      new UpdateNotificationRule(unitOfWork, clock).execute({
        workspaceId: workspace.id,
        ruleId: rule.id,
        expectedVersion: 1,
        enabled: false,
      }),
      "notification_rule.version_conflict",
    );
    await expectCode(
      new UpdateNotificationRule(unitOfWork, clock).execute({
        workspaceId: workspace.id,
        ruleId: notificationRuleId("missing-rule"),
        expectedVersion: 1,
        enabled: false,
      }),
      "notification_rule.not_found",
    );
    expect(notifications.rules.get(rule.id)).toBe(updated);
    expect(audits.map((audit) => audit.action)).toContain("notification_rule.updated");
  });
});

describe("one-off reminder application service", () => {
  it("creates, lists, updates, cancels, and audits one-off reminders", async () => {
    const { audits, notifications, unitOfWork } = harness();
    await new ConfigureNotificationProfile(unitOfWork, clock).execute({
      workspaceId: workspace.id,
      expectedVersion: null,
      timeZone: "UTC",
    });
    const create = new CreateOneOffReminder(unitOfWork, clock);
    const reminder = await create.execute({
      workspaceId: workspace.id,
      title: "Call home",
      scheduledFor: new Date("2026-07-15T12:00:00.000Z"),
    });
    await expect(
      new ListOneOffReminders(unitOfWork).execute({
        workspaceId: workspace.id,
        fromInclusive: new Date("2026-07-15T00:00:00.000Z"),
        throughExclusive: new Date("2026-07-16T00:00:00.000Z"),
      }),
    ).resolves.toEqual([reminder]);

    const pendingBeforeUpdate = oneOffIntent(reminder);
    notifications.intents.set(pendingBeforeUpdate.occurrenceKey, pendingBeforeUpdate);
    const updated = await new UpdateOneOffReminder(unitOfWork, clock).execute({
      workspaceId: workspace.id,
      reminderId: reminder.id,
      expectedVersion: 1,
      title: "Call family",
    });
    expect(notifications.intents.size).toBe(0);
    expect(audits.at(-1)?.data).toMatchObject({ invalidatedIntents: 1 });
    const pendingBeforeCancel = oneOffIntent(updated);
    notifications.intents.set(pendingBeforeCancel.occurrenceKey, pendingBeforeCancel);
    const cancelled = await new CancelOneOffReminder(unitOfWork, clock).execute({
      workspaceId: workspace.id,
      reminderId: reminder.id,
      expectedVersion: 2,
    });
    expect(cancelled).toMatchObject({ title: "Call family", version: 3 });
    expect(notifications.intents.size).toBe(0);
    expect(audits.at(-1)?.data).toMatchObject({ invalidatedIntents: 1 });
    expect(cancelled.cancelledAt).toEqual(clock.now());
    expect(notifications.reminders.get(reminder.id)).toBe(cancelled);
    expect(audits.map((audit) => audit.action)).toEqual([
      "notification_profile.created",
      "one_off_reminder.created",
      "one_off_reminder.updated",
      "one_off_reminder.cancelled",
    ]);
  });

  it("rejects missing reminders, conflicts, missing profiles, and bad ranges", async () => {
    const { unitOfWork } = harness();
    await expectCode(
      new CreateOneOffReminder(unitOfWork, clock).execute({
        workspaceId: workspace.id,
        title: "No profile",
        scheduledFor: new Date(),
      }),
      "notification_profile.not_found",
    );
    await expectCode(
      new UpdateOneOffReminder(unitOfWork, clock).execute({
        workspaceId: workspace.id,
        reminderId: oneOffReminderId("missing"),
        expectedVersion: 1,
        title: "Missing",
      }),
      "one_off_reminder.not_found",
    );
    await expectCode(
      Promise.resolve().then(() =>
        new ListOneOffReminders(unitOfWork).execute({
          workspaceId: workspace.id,
          fromInclusive: new Date("2026-07-16T00:00:00.000Z"),
          throughExclusive: new Date("2026-07-15T00:00:00.000Z"),
        }),
      ),
      "notification.range_invalid",
    );
    await expectCode(
      Promise.resolve().then(() =>
        new ListOneOffReminders(unitOfWork).execute({
          workspaceId: workspace.id,
          fromInclusive: new Date("2026-07-01T00:00:00.000Z"),
          throughExclusive: new Date("2026-08-02T00:00:00.000Z"),
        }),
      ),
      "notification.range_too_large",
    );
  });

  it("fails closed when a bounded one-off list still exceeds its result cap", async () => {
    const { notifications, unitOfWork } = harness();
    const scheduledFor = new Date("2026-07-15T12:00:00.000Z");
    for (let index = 0; index <= 500; index += 1) {
      const id = oneOffReminderId(`one-off-list-limit-${String(index)}`);
      notifications.reminders.set(id, {
        id,
        workspaceId: workspace.id,
        title: `Reminder ${String(index)}`,
        scheduledFor,
        cancelledAt: null,
        version: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
    }
    await expectCode(
      new ListOneOffReminders(unitOfWork).execute({
        workspaceId: workspace.id,
        fromInclusive: new Date("2026-07-15T00:00:00.000Z"),
        throughExclusive: new Date("2026-07-16T00:00:00.000Z"),
      }),
      "notification.one_off_result_limit",
    );
  });
});

describe("notification intent query validation", () => {
  it("validates range, pagination, and workspace existence", async () => {
    const { unitOfWork } = harness();
    const list = new ListNotificationIntents(unitOfWork);
    const query = {
      workspaceId: workspace.id,
      fromInclusive: new Date("2026-07-15T00:00:00.000Z"),
      throughExclusive: new Date("2026-07-16T00:00:00.000Z"),
      limit: 50,
      offset: 0,
    };
    await expect(list.execute(query)).resolves.toEqual([]);
    await expectCode(
      Promise.resolve().then(() => list.execute({ ...query, limit: 0 })),
      "notification.limit_invalid",
    );
    await expectCode(
      Promise.resolve().then(() => list.execute({ ...query, offset: -1 })),
      "notification.offset_invalid",
    );
    await expectCode(
      list.execute({ ...query, workspaceId: workspaceId("missing") }),
      "workspace.not_found",
    );
  });
});
