import {
  cancelOneOffReminder,
  createNotificationProfile,
  createNotificationRule,
  DomainError,
  createOneOffReminder,
  notificationIntentId,
  notificationRuleId,
  oneOffReminderId,
  updateNotificationRule,
  updateOneOffReminder,
  workspaceId,
  type NotificationIntent,
  type NotificationProfile,
  type NotificationRule,
  type OneOffReminder,
} from "@schedule/domain";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { ProductServices } from "./product-routes.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const workspaceUuid = "10101010-1010-4010-8010-101010101010";
const ruleUuid = "20202020-2020-4020-8020-202020202020";
const reminderUuid = "30303030-3030-4030-8030-303030303030";
const intentUuid = "40404040-4040-4040-8040-404040404040";
const deliveryUuid = "50505050-5050-4050-8050-505050505050";
const workspace = workspaceId(workspaceUuid);
const fixedNow = new Date("2026-07-14T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function harness() {
  let profile: NotificationProfile | null = null;
  let rule: NotificationRule | null = null;
  let reminder: OneOffReminder | null = null;
  const intent: NotificationIntent = {
    id: notificationIntentId(intentUuid),
    workspaceId: workspace,
    ruleId: notificationRuleId(ruleUuid),
    oneOffReminderId: null,
    kind: "daily_digest",
    occurrenceKey: `rule:${ruleUuid}:daily_digest:day:2026-07-14`,
    targetType: "workspace",
    targetId: null,
    titleSnapshot: null,
    scheduledFor: new Date("2026-07-14T13:00:00.000Z"),
    localDate: "2026-07-14" as NotificationIntent["localDate"],
    priority: 50,
    policySnapshot: { profileVersion: 1, ruleVersion: 1 },
    localTimeResolution: "exact",
    adjustedForQuietHours: false,
    caughtUp: false,
    createdAt: fixedNow,
  };
  const services = {
    configureNotificationProfile: async (command) => {
      profile = createNotificationProfile({
        workspaceId: command.workspaceId,
        enabled: command.enabled,
        timeZone: command.timeZone,
        quietHoursStartMinute: command.quietHoursStartMinute,
        quietHoursEndMinute: command.quietHoursEndMinute,
        quietHoursPolicy: command.quietHoursPolicy,
        catchUpWindowMinutes: command.catchUpWindowMinutes,
        dailyIntentLimit: command.dailyIntentLimit,
        now: fixedNow,
      });
      return profile;
    },
    getNotificationProfile: async () => profile!,
    createNotificationRule: async (command) => {
      rule = createNotificationRule({
        ...command,
        id: notificationRuleId(ruleUuid),
        now: fixedNow,
      });
      return rule;
    },
    updateNotificationRule: async (command) => {
      rule = updateNotificationRule(rule!, {
        ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
        ...(command.localMinute === undefined ? {} : { localMinute: command.localMinute }),
        ...(command.leadMinutes === undefined ? {} : { leadMinutes: command.leadMinutes }),
        ...(command.cooldownMinutes === undefined
          ? {}
          : { cooldownMinutes: command.cooldownMinutes }),
        ...(command.priority === undefined ? {} : { priority: command.priority }),
        now: fixedNow,
      });
      return rule;
    },
    listNotificationRules: async () => (rule === null ? [] : [rule]),
    createOneOffReminder: async (command) => {
      reminder = createOneOffReminder({
        ...command,
        id: oneOffReminderId(reminderUuid),
        now: fixedNow,
      });
      return reminder;
    },
    updateOneOffReminder: async (command) => {
      reminder = updateOneOffReminder(reminder!, {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.scheduledFor === undefined ? {} : { scheduledFor: command.scheduledFor }),
        now: fixedNow,
      });
      return reminder;
    },
    cancelOneOffReminder: async () => {
      reminder = cancelOneOffReminder(reminder!, fixedNow);
      return reminder;
    },
    listOneOffReminders: async () => (reminder === null ? [] : [reminder]),
    listNotificationIntents: async () => [intent],
    listNotificationDeliveries: async () => [
      {
        deliveryId: deliveryUuid,
        intentId: intentUuid,
        kind: "daily_digest",
        targetType: "workspace",
        title: null,
        scheduledFor: new Date("2026-07-14T13:00:00.000Z"),
        localDate: "2026-07-14",
        priority: 50,
        status: "delivered",
        attempts: 1,
        availableAt: new Date("2026-07-14T13:00:00.000Z"),
        completedAt: new Date("2026-07-14T13:00:05.000Z"),
        lastFailureCode: null,
        createdAt: new Date("2026-07-14T13:00:00.000Z"),
        updatedAt: new Date("2026-07-14T13:00:05.000Z"),
      },
    ],
    materializeNotificationIntents: async () => ({
      created: [intent],
      existing: [],
      suppressed: [],
    }),
    redriveNotificationDelivery: async (command) => ({
      deliveryId: command.deliveryId,
      intentId: intentUuid,
      kind: "daily_digest",
      targetType: "workspace",
      title: null,
      scheduledFor: new Date("2026-07-14T13:00:00.000Z"),
      localDate: "2026-07-14",
      priority: 50,
      status: "pending",
      attempts: 5,
      availableAt: fixedNow,
      completedAt: null,
      lastFailureCode: "transport.rejected",
      createdAt: new Date("2026-07-14T13:00:00.000Z"),
      updatedAt: fixedNow,
    }),
  } as unknown as ProductServices;
  return { services };
}

describe("notification product routes", () => {
  it("wires profile, rules, one-offs, materialization, intent reads, and safe delivery history", async () => {
    const test = harness();
    const app = await buildApp({
      productServices: test.services,
      productApiAccess: { mode: "local_unauthenticated" },
    });
    apps.push(app);

    const profileResponse = await app.inject({
      method: "PUT",
      url: `/v1/workspaces/${workspaceUuid}/notification-profile`,
      payload: {
        expectedVersion: null,
        timeZone: "America/La_Paz",
        quietHoursStartMinute: 1320,
        quietHoursEndMinute: 420,
        catchUpWindowMinutes: 90,
        dailyIntentLimit: 8,
      },
    });
    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json()).toMatchObject({
      workspaceId: workspaceUuid,
      timeZone: "America/La_Paz",
      quietHoursStartMinute: 1320,
      dailyIntentLimit: 8,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/workspaces/${workspaceUuid}/notification-profile`,
        })
      ).statusCode,
    ).toBe(200);

    const createRule = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/notification-rules`,
      payload: { kind: "daily_digest", localMinute: 480, priority: 70 },
    });
    expect(createRule.statusCode).toBe(201);
    expect(createRule.json()).toMatchObject({ id: ruleUuid, kind: "daily_digest", priority: 70 });
    const updateRule = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/notification-rules/${ruleUuid}`,
      payload: { expectedVersion: 1, priority: 90 },
    });
    expect(updateRule.statusCode).toBe(200);
    expect(updateRule.json()).toMatchObject({ id: ruleUuid, priority: 90, version: 2 });
    const listRules = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/notification-rules`,
    });
    expect(listRules.json().items).toHaveLength(1);

    const createReminder = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/one-off-reminders`,
      payload: { title: "Call home", scheduledFor: "2026-07-14T15:00:00.000Z" },
    });
    expect(createReminder.statusCode).toBe(201);
    expect(createReminder.json()).toMatchObject({ id: reminderUuid, title: "Call home" });
    const updateReminder = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/one-off-reminders/${reminderUuid}`,
      payload: { expectedVersion: 1, title: "Call family" },
    });
    expect(updateReminder.json()).toMatchObject({ title: "Call family", version: 2 });
    const cancelReminder = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/one-off-reminders/${reminderUuid}/cancellations`,
      payload: { expectedVersion: 2 },
    });
    expect(cancelReminder.json()).toMatchObject({ version: 3 });
    const listReminders = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/one-off-reminders?from=2026-07-14T00%3A00%3A00.000Z&to=2026-07-15T00%3A00%3A00.000Z`,
    });
    expect(listReminders.statusCode).toBe(200);
    expect(listReminders.json().items).toHaveLength(1);

    const materialize = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/notification-intents/materializations`,
      payload: {
        from: "2026-07-14T08:00:00.000Z",
        through: "2026-07-15T00:00:00.000Z",
      },
    });
    expect(materialize.statusCode).toBe(200);
    expect(materialize.json().created).toHaveLength(1);
    const listIntents = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/notification-intents?from=2026-07-14T00%3A00%3A00.000Z&to=2026-07-15T00%3A00%3A00.000Z&limit=25&offset=0`,
    });
    expect(listIntents.statusCode).toBe(200);
    expect(listIntents.json()).toMatchObject({ page: { limit: 25, offset: 0 } });
    expect(listIntents.json().items).toHaveLength(1);

    const listDeliveries = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/notification-deliveries?from=2026-07-14T00%3A00%3A00.000Z&to=2026-07-15T00%3A00%3A00.000Z&limit=25&offset=0`,
    });
    expect(listDeliveries.statusCode).toBe(200);
    expect(listDeliveries.json()).toMatchObject({
      page: { limit: 25, offset: 0 },
      items: [
        {
          deliveryId: deliveryUuid,
          intentId: intentUuid,
          status: "delivered",
          attempts: 1,
        },
      ],
    });
    expect(listDeliveries.body).not.toContain("claimToken");
    expect(listDeliveries.body).not.toContain("credential");
  });

  it("rejects unpaired quiet hours, mismatched rule configuration, and empty patches", async () => {
    const test = harness();
    const app = await buildApp({
      productServices: test.services,
      productApiAccess: { mode: "local_unauthenticated" },
    });
    apps.push(app);

    const badProfile = await app.inject({
      method: "PUT",
      url: `/v1/workspaces/${workspaceUuid}/notification-profile`,
      payload: {
        expectedVersion: null,
        timeZone: "UTC",
        quietHoursStartMinute: 1320,
      },
    });
    expect(badProfile.statusCode).toBe(400);
    expect(badProfile.json().error.code).toBe("request.validation_failed");

    for (const payload of [
      {
        expectedVersion: null,
        timeZone: "UTC",
        quietHoursStartMinute: null,
        quietHoursEndMinute: 420,
      },
      {
        expectedVersion: null,
        timeZone: "UTC",
        quietHoursStartMinute: 1_320,
        quietHoursEndMinute: null,
      },
    ]) {
      const mixedQuietHours = await app.inject({
        method: "PUT",
        url: `/v1/workspaces/${workspaceUuid}/notification-profile`,
        payload,
      });
      expect(mixedQuietHours.statusCode).toBe(400);
      expect(mixedQuietHours.json().error.code).toBe("request.validation_failed");
    }

    const badRule = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/notification-rules`,
      payload: { kind: "daily_digest", leadMinutes: 15 },
    });
    expect(badRule.statusCode).toBe(422);
    expect(badRule.json().error.code).toBe("notification_rule.configuration_invalid");

    const emptyRulePatch = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/notification-rules/${ruleUuid}`,
      payload: { expectedVersion: 1 },
    });
    expect(emptyRulePatch.statusCode).toBe(400);
    expect(emptyRulePatch.json().error.code).toBe("request.validation_failed");

    const emptyReminderPatch = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/one-off-reminders/${reminderUuid}`,
      payload: { expectedVersion: 1 },
    });
    expect(emptyReminderPatch.statusCode).toBe(400);
  });

  it("redrives a dead-letter delivery with strict identifiers and returns safe history", async () => {
    const calls: unknown[] = [];
    const test = harness();
    test.services.redriveNotificationDelivery = async (command) => {
      calls.push(command);
      return {
        deliveryId: command.deliveryId,
        intentId: intentUuid,
        kind: "daily_digest",
        targetType: "workspace",
        title: null,
        scheduledFor: new Date("2026-07-14T13:00:00.000Z"),
        localDate: "2026-07-14",
        priority: 50,
        status: "pending",
        attempts: 5,
        availableAt: fixedNow,
        completedAt: null,
        lastFailureCode: "transport.rejected",
        createdAt: new Date("2026-07-14T13:00:00.000Z"),
        updatedAt: fixedNow,
      };
    };
    const app = await buildApp({
      productServices: test.services,
      productApiAccess: { mode: "local_unauthenticated" },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/notification-deliveries/${deliveryUuid}/redrives`,
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ workspaceId: workspaceUuid, deliveryId: deliveryUuid }]);
    expect(response.json()).toMatchObject({
      deliveryId: deliveryUuid,
      intentId: intentUuid,
      status: "pending",
      attempts: 5,
      lastFailureCode: "transport.rejected",
    });
    expect(response.body).not.toContain("claimToken");
    expect(response.body).not.toContain("credential");

    const malformed = await app.inject({
      method: "POST",
      url: `/v1/workspaces/not-a-uuid/notification-deliveries/${deliveryUuid}/redrives`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("request.validation_failed");
  });

  it("propagates notification delivery redrive not-found and conflict errors", async () => {
    const test = harness();
    let failure = new DomainError(
      "notification_delivery.command_not_found",
      "The delivery command does not exist.",
    );
    test.services.redriveNotificationDelivery = async () => {
      throw failure;
    };
    const app = await buildApp({
      productServices: test.services,
      productApiAccess: { mode: "local_unauthenticated" },
    });
    apps.push(app);

    const redrive = () =>
      app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceUuid}/notification-deliveries/${deliveryUuid}/redrives`,
      });

    const missing = await redrive();
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("notification_delivery.command_not_found");

    failure = new DomainError(
      "notification_delivery.redrive_conflict",
      "Only dead-letter deliveries can be redriven.",
    );
    const conflict = await redrive();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("notification_delivery.redrive_conflict");
  });
});
