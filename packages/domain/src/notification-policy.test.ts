import { describe, expect, it } from "vitest";

import { DomainError } from "./errors.js";
import { notificationRuleId, oneOffReminderId, workspaceId } from "./ids.js";
import {
  cancelOneOffReminder,
  createNotificationIntent,
  createNotificationProfile,
  createNotificationRule,
  createOneOffReminder,
  evaluateNotificationCandidate,
  maximumNotificationPolicyVersion,
  resolveLocalMinute,
  updateNotificationProfile,
  updateNotificationRule,
  updateOneOffReminder,
  type NotificationCandidate,
  type NotificationProfile,
  type NotificationRule,
  type OneOffReminder,
} from "./notification-policy.js";

function expectDomainError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected a DomainError.");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

const workspace = workspaceId("workspace-notifications");
const createdAt = new Date("2026-07-14T12:00:00.000Z");

function profile(overrides: Partial<NotificationProfile> = {}): NotificationProfile {
  return {
    ...createNotificationProfile({
      workspaceId: workspace,
      timeZone: "America/New_York",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 12,
      now: createdAt,
    }),
    ...overrides,
  };
}

function candidate(
  desiredAt: Date,
  overrides: Partial<NotificationCandidate> = {},
): NotificationCandidate {
  return {
    workspaceId: workspace,
    sourceType: "rule",
    ruleId: notificationRuleId("rule-digest"),
    oneOffReminderId: null,
    kind: "daily_digest",
    occurrenceKey: "rule-digest:day:2026-07-14",
    targetType: "workspace",
    targetId: null,
    titleSnapshot: null,
    desiredAt,
    localTimeResolution: "exact",
    priority: 50,
    cooldownMinutes: 0,
    policySnapshot: { profileVersion: 1, ruleVersion: 1 },
    ...overrides,
  };
}

describe("notification profile policy", () => {
  it("creates normalized defaults and clones timestamps", () => {
    const result = createNotificationProfile({
      workspaceId: workspace,
      timeZone: "America/La_Paz",
      now: createdAt,
    });

    expect(result).toMatchObject({
      enabled: true,
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 12,
      version: 1,
    });
    expect(result.createdAt).toEqual(createdAt);
    expect(result.createdAt).not.toBe(createdAt);
  });

  it("requires valid paired quiet hours, timezone, catch-up, and daily cap", () => {
    expectDomainError(
      () =>
        createNotificationProfile({
          workspaceId: workspace,
          timeZone: "UTC",
          quietHoursStartMinute: 1_320,
        }),
      "notification_profile.quiet_hours_pair_invalid",
    );
    expectDomainError(
      () => createNotificationProfile({ workspaceId: workspace, timeZone: "Mars/Olympus" }),
      "notification_profile.time_zone_invalid",
    );
    expectDomainError(
      () =>
        createNotificationProfile({
          workspaceId: workspace,
          timeZone: "UTC",
          catchUpWindowMinutes: 10_081,
        }),
      "notification_profile.catch_up_invalid",
    );
    expectDomainError(
      () =>
        createNotificationProfile({
          workspaceId: workspace,
          timeZone: "UTC",
          dailyIntentLimit: 0,
        }),
      "notification_profile.daily_limit_invalid",
    );
  });

  it("versions changes, preserves no-ops, and rejects exhaustion", () => {
    const original = profile();
    expect(updateNotificationProfile(original, { now: new Date(createdAt) })).toBe(original);

    const updated = updateNotificationProfile(original, {
      quietHoursStartMinute: 1_320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "skip",
      dailyIntentLimit: 8,
      now: new Date("2026-07-14T13:00:00.000Z"),
    });
    expect(updated).toMatchObject({
      quietHoursStartMinute: 1_320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "skip",
      dailyIntentLimit: 8,
      version: 2,
    });

    expectDomainError(
      () =>
        updateNotificationProfile(profile({ version: maximumNotificationPolicyVersion }), {
          enabled: false,
          now: new Date(),
        }),
      "notification_profile.version_exhausted",
    );
  });
});

describe("notification rules", () => {
  it("enforces kind-specific local-time and lead configuration", () => {
    const digest = createNotificationRule({
      workspaceId: workspace,
      kind: "daily_digest",
      localMinute: 480,
      now: createdAt,
    });
    const block = createNotificationRule({
      workspaceId: workspace,
      kind: "schedule_block_lead",
      leadMinutes: 15,
      now: createdAt,
    });

    expect(digest).toMatchObject({ localMinute: 480, leadMinutes: null, priority: 50 });
    expect(block).toMatchObject({ localMinute: null, leadMinutes: 15 });
    expectDomainError(
      () =>
        createNotificationRule({
          workspaceId: workspace,
          kind: "daily_follow_up",
          leadMinutes: 5,
        }),
      "notification_rule.configuration_invalid",
    );
    expectDomainError(
      () =>
        createNotificationRule({
          workspaceId: workspace,
          kind: "plan_window_open",
          localMinute: 600,
        }),
      "notification_rule.configuration_invalid",
    );
  });

  it("versions changes, preserves no-ops, and rejects bad bounds and exhaustion", () => {
    const original = createNotificationRule({
      workspaceId: workspace,
      kind: "work_item_due",
      localMinute: 540,
      now: createdAt,
    });
    expect(updateNotificationRule(original, { now: new Date(createdAt) })).toBe(original);
    expect(updateNotificationRule(original, { priority: 90, now: new Date() })).toMatchObject({
      priority: 90,
      version: 2,
    });
    expectDomainError(
      () => createNotificationRule({ ...original, kind: "work_item_due", priority: 101 }),
      "notification_rule.priority_invalid",
    );
    expectDomainError(
      () =>
        updateNotificationRule(
          { ...original, version: maximumNotificationPolicyVersion } as NotificationRule,
          { enabled: false, now: new Date() },
        ),
      "notification_rule.version_exhausted",
    );
  });
});

describe("one-off reminder lifecycle", () => {
  function reminder(overrides: Partial<OneOffReminder> = {}): OneOffReminder {
    return {
      ...createOneOffReminder({
        workspaceId: workspace,
        title: "  Take medicine  ",
        scheduledFor: new Date("2026-07-15T14:00:00.000Z"),
        now: createdAt,
      }),
      ...overrides,
    };
  }

  it("normalizes, updates, cancels, and makes cancellation idempotent", () => {
    const original = reminder();
    expect(original.title).toBe("Take medicine");
    expect(updateOneOffReminder(original, { now: new Date() })).toBe(original);

    const updated = updateOneOffReminder(original, {
      title: "Call home",
      scheduledFor: new Date("2026-07-15T15:00:00.000Z"),
      now: new Date("2026-07-14T13:00:00.000Z"),
    });
    expect(updated).toMatchObject({ title: "Call home", version: 2 });
    const cancelled = cancelOneOffReminder(updated, new Date("2026-07-14T14:00:00.000Z"));
    expect(cancelled.version).toBe(3);
    expect(cancelOneOffReminder(cancelled, new Date())).toBe(cancelled);
    expectDomainError(
      () => updateOneOffReminder(cancelled, { title: "Too late", now: new Date() }),
      "one_off_reminder.cancelled",
    );
  });

  it("rejects empty titles and version exhaustion", () => {
    expectDomainError(
      () =>
        createOneOffReminder({
          workspaceId: workspace,
          title: "   ",
          scheduledFor: new Date(),
        }),
      "one_off_reminder.title_invalid",
    );
    expectDomainError(
      () =>
        cancelOneOffReminder(reminder({ version: maximumNotificationPolicyVersion }), new Date()),
      "one_off_reminder.version_exhausted",
    );
  });
});

describe("local-time resolution", () => {
  it("resolves an ordinary local minute exactly", () => {
    const result = resolveLocalMinute("2024-07-01", 8 * 60 + 30, "America/New_York");
    expect(result.resolution).toBe("exact");
    expect(result.instant.toISOString()).toBe("2024-07-01T12:30:00.000Z");
  });

  it("moves through a spring-forward gap using compatible/later semantics", () => {
    const result = resolveLocalMinute("2024-03-10", 2 * 60 + 30, "America/New_York");
    expect(result.resolution).toBe("gap_later");
    expect(result.instant.toISOString()).toBe("2024-03-10T07:30:00.000Z");
  });

  it("chooses the earlier instant during a fall-back overlap", () => {
    const result = resolveLocalMinute("2024-11-03", 90, "America/New_York");
    expect(result.resolution).toBe("overlap_earlier");
    expect(result.instant.toISOString()).toBe("2024-11-03T05:30:00.000Z");
  });

  it("rejects invalid local dates, minutes, and zones", () => {
    expectDomainError(
      () => resolveLocalMinute("2024-02-30", 60, "UTC"),
      "notification.local_date_invalid",
    );
    expectDomainError(
      () => resolveLocalMinute("2024-02-29", 1_440, "UTC"),
      "notification.local_minute_invalid",
    );
    expectDomainError(
      () => resolveLocalMinute("2024-02-29", 60, "Invalid/Zone"),
      "notification.time_zone_invalid",
    );
  });
});

describe("candidate evaluation", () => {
  it("suppresses a disabled profile and rejects a workspace mismatch", () => {
    const desired = new Date("2026-07-14T14:00:00.000Z");
    expect(
      evaluateNotificationCandidate(profile({ enabled: false }), candidate(desired), createdAt),
    ).toEqual({
      status: "suppressed",
      occurrenceKey: "rule-digest:day:2026-07-14",
      reason: "profile_disabled",
    });
    expectDomainError(
      () =>
        evaluateNotificationCandidate(
          profile(),
          candidate(desired, { workspaceId: workspaceId("other-workspace") }),
          createdAt,
        ),
      "notification.workspace_mismatch",
    );
  });

  it("treats quiet hours as half-open and supports a disabled equal range", () => {
    const skipProfile = profile({
      quietHoursStartMinute: 1_320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "skip",
    });
    const atStart = new Date("2026-07-15T02:00:00.000Z"); // 22:00 local
    const atEnd = new Date("2026-07-15T11:00:00.000Z"); // 07:00 local

    expect(evaluateNotificationCandidate(skipProfile, candidate(atStart), createdAt)).toMatchObject(
      {
        status: "suppressed",
        reason: "quiet_hours",
      },
    );
    expect(evaluateNotificationCandidate(skipProfile, candidate(atEnd), createdAt)).toMatchObject({
      status: "accepted",
      scheduledFor: atEnd,
    });
    expect(
      evaluateNotificationCandidate(
        profile({ quietHoursStartMinute: 600, quietHoursEndMinute: 600 }),
        candidate(new Date("2026-07-14T14:00:00.000Z")),
        createdAt,
      ),
    ).toMatchObject({ status: "accepted", adjustedForQuietHours: false });
  });

  it("moves same-day and overnight quiet candidates to the next allowed minute", () => {
    const sameDay = profile({ quietHoursStartMinute: 600, quietHoursEndMinute: 720 });
    const sameDayResult = evaluateNotificationCandidate(
      sameDay,
      candidate(new Date("2026-07-14T15:00:00.000Z")), // 11:00 local
      createdAt,
    );
    expect(sameDayResult).toMatchObject({
      status: "accepted",
      adjustedForQuietHours: true,
      localDate: "2026-07-14",
    });
    if (sameDayResult.status === "accepted") {
      expect(sameDayResult.scheduledFor.toISOString()).toBe("2026-07-14T16:00:00.000Z");
    }

    const overnight = profile({ quietHoursStartMinute: 1_320, quietHoursEndMinute: 420 });
    const overnightResult = evaluateNotificationCandidate(
      overnight,
      candidate(new Date("2026-07-15T03:30:00.000Z")), // 23:30 local
      createdAt,
    );
    expect(overnightResult).toMatchObject({
      status: "accepted",
      adjustedForQuietHours: true,
      localDate: "2026-07-15",
    });
    if (overnightResult.status === "accepted") {
      expect(overnightResult.scheduledFor.toISOString()).toBe("2026-07-15T11:00:00.000Z");
    }
  });

  it("catches up at the inclusive boundary and suppresses beyond it", () => {
    const now = new Date("2026-07-14T13:00:00.000Z");
    const inclusive = evaluateNotificationCandidate(
      profile({ catchUpWindowMinutes: 60 }),
      candidate(new Date("2026-07-14T12:00:00.000Z")),
      now,
    );
    expect(inclusive).toMatchObject({ status: "accepted", caughtUp: true });
    if (inclusive.status === "accepted") {
      expect(inclusive.scheduledFor).toEqual(now);
      expect(inclusive.scheduledFor).not.toBe(now);
    }

    expect(
      evaluateNotificationCandidate(
        profile({ catchUpWindowMinutes: 59 }),
        candidate(new Date("2026-07-14T12:00:00.000Z")),
        now,
      ),
    ).toMatchObject({ status: "suppressed", reason: "outside_catch_up" });
  });

  it("reapplies quiet policy when catch-up lands inside quiet hours", () => {
    const result = evaluateNotificationCandidate(
      profile({
        quietHoursStartMinute: 1_320,
        quietHoursEndMinute: 420,
        quietHoursPolicy: "skip",
        catchUpWindowMinutes: 180,
      }),
      candidate(new Date("2026-07-15T00:00:00.000Z")), // 20:00 local
      new Date("2026-07-15T02:30:00.000Z"), // 22:30 local
    );
    expect(result).toMatchObject({ status: "suppressed", reason: "quiet_hours" });
  });

  it("validates exact rule and one-off source shapes", () => {
    expectDomainError(
      () =>
        evaluateNotificationCandidate(
          profile(),
          candidate(new Date("2026-07-14T14:00:00.000Z"), {
            sourceType: "rule",
            ruleId: null,
          }),
          createdAt,
        ),
      "notification.source_invalid",
    );

    const oneOff = candidate(new Date("2026-07-14T14:00:00.000Z"), {
      sourceType: "one_off",
      ruleId: null,
      oneOffReminderId: oneOffReminderId("one-off-1"),
      kind: "one_off",
      targetType: "one_off",
      occurrenceKey: "one_off:one-off-1",
    });
    expect(evaluateNotificationCandidate(profile(), oneOff, createdAt)).toMatchObject({
      status: "accepted",
      occurrenceKey: "one_off:one-off-1",
    });
  });

  it("rejects non-primitive snapshots and target/source inconsistencies at runtime", () => {
    const badSnapshot = {
      nested: { secret: "value" },
    } as unknown as NotificationCandidate["policySnapshot"];
    expectDomainError(
      () =>
        evaluateNotificationCandidate(
          profile(),
          candidate(new Date("2026-07-14T14:00:00.000Z"), {
            policySnapshot: badSnapshot,
          }),
          createdAt,
        ),
      "notification.policy_snapshot_invalid",
    );
    expectDomainError(
      () =>
        evaluateNotificationCandidate(
          profile(),
          candidate(new Date("2026-07-14T14:00:00.000Z"), {
            targetType: "work_item",
            targetId: "work-item-wrong-kind",
          }),
          createdAt,
        ),
      "notification.kind_target_mismatch",
    );
    expectDomainError(
      () =>
        evaluateNotificationCandidate(
          profile(),
          candidate(new Date("2026-07-14T14:00:00.000Z"), {
            targetType: "work_item",
            targetId: null,
          }),
          createdAt,
        ),
      "notification.target_invalid",
    );
  });

  it("creates an immutable intent snapshot only from the matching accepted evaluation", () => {
    const source = candidate(new Date("2026-07-14T14:00:00.000Z"));
    const evaluation = evaluateNotificationCandidate(profile(), source, createdAt);
    expect(evaluation.status).toBe("accepted");
    if (evaluation.status !== "accepted") return;

    const intent = createNotificationIntent({ candidate: source, evaluation, createdAt });
    expect(intent).toMatchObject({
      occurrenceKey: source.occurrenceKey,
      kind: "daily_digest",
      priority: 50,
      localTimeResolution: "exact",
    });
    expect(intent.scheduledFor).not.toBe(evaluation.scheduledFor);
    expect(intent.createdAt).not.toBe(createdAt);

    expectDomainError(
      () =>
        createNotificationIntent({
          candidate: { ...source, occurrenceKey: "different" },
          evaluation,
          createdAt,
        }),
      "notification_intent.evaluation_invalid",
    );
  });
});
