import {
  DomainError,
  cancelOneOffReminder,
  createNotificationProfile,
  createNotificationRule,
  createOneOffReminder,
  maximumNotificationRules,
  updateNotificationProfile,
  updateNotificationRule,
  updateOneOffReminder,
  type LocalDate,
  type NotificationIntent,
  type NotificationProfile,
  type NotificationRule,
  type NotificationRuleId,
  type NotificationRuleKind,
  type OneOffReminder,
  type OneOffReminderId,
  type QuietHoursPolicy,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

const DAY_MILLISECONDS = 86_400_000;
const MAXIMUM_NOTIFICATION_LIST_DAYS = 31;
const MAXIMUM_ONE_OFF_LIST_ROWS = 500;

function validateExpectedVersion(value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 1)) {
    throw new DomainError(
      "notification.expected_version_invalid",
      "Expected version must be a positive integer or null for creation.",
    );
  }
}

async function requireWorkspace(
  workspaceId: WorkspaceId,
  workspaces: { findById(id: WorkspaceId): Promise<unknown | null> },
): Promise<void> {
  if ((await workspaces.findById(workspaceId)) === null) {
    throw new DomainError("workspace.not_found", "The workspace does not exist.");
  }
}

export interface ConfigureNotificationProfileCommand {
  readonly workspaceId: WorkspaceId;
  /** Null creates the profile; a positive value updates the existing profile. */
  readonly expectedVersion: number | null;
  readonly enabled?: boolean;
  readonly timeZone: string;
  readonly quietHoursStartMinute?: number | null;
  readonly quietHoursEndMinute?: number | null;
  readonly quietHoursPolicy?: QuietHoursPolicy;
  readonly catchUpWindowMinutes?: number;
  readonly dailyIntentLimit?: number;
}

export class ConfigureNotificationProfile {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: ConfigureNotificationProfileCommand): Promise<NotificationProfile> {
    validateExpectedVersion(command.expectedVersion);
    return this.unitOfWork.run(async ({ auditEvents, notifications, workspaces }) => {
      await notifications.lockWorkspace(command.workspaceId);
      await requireWorkspace(command.workspaceId, workspaces);
      const existing = await notifications.findProfile(command.workspaceId);
      const now = this.clock.now();
      if (existing === null) {
        if (command.expectedVersion !== null) {
          throw new DomainError(
            "notification_profile.version_conflict",
            "The notification profile does not exist at the expected version.",
          );
        }
        const created = createNotificationProfile({
          workspaceId: command.workspaceId,
          timeZone: command.timeZone,
          ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
          ...(command.quietHoursStartMinute === undefined
            ? {}
            : { quietHoursStartMinute: command.quietHoursStartMinute }),
          ...(command.quietHoursEndMinute === undefined
            ? {}
            : { quietHoursEndMinute: command.quietHoursEndMinute }),
          ...(command.quietHoursPolicy === undefined
            ? {}
            : { quietHoursPolicy: command.quietHoursPolicy }),
          ...(command.catchUpWindowMinutes === undefined
            ? {}
            : { catchUpWindowMinutes: command.catchUpWindowMinutes }),
          ...(command.dailyIntentLimit === undefined
            ? {}
            : { dailyIntentLimit: command.dailyIntentLimit }),
          now,
        });
        await notifications.insertProfile(created);
        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "notification_profile.created",
          entityType: "notification_profile",
          entityId: command.workspaceId,
          data: { version: created.version },
          occurredAt: now,
        });
        return created;
      }
      if (command.expectedVersion === null || existing.version !== command.expectedVersion) {
        throw new DomainError(
          "notification_profile.version_conflict",
          "The notification profile changed before this update could be applied.",
        );
      }
      const updated = updateNotificationProfile(existing, {
        timeZone: command.timeZone,
        ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
        ...(command.quietHoursStartMinute === undefined
          ? {}
          : { quietHoursStartMinute: command.quietHoursStartMinute }),
        ...(command.quietHoursEndMinute === undefined
          ? {}
          : { quietHoursEndMinute: command.quietHoursEndMinute }),
        ...(command.quietHoursPolicy === undefined
          ? {}
          : { quietHoursPolicy: command.quietHoursPolicy }),
        ...(command.catchUpWindowMinutes === undefined
          ? {}
          : { catchUpWindowMinutes: command.catchUpWindowMinutes }),
        ...(command.dailyIntentLimit === undefined
          ? {}
          : { dailyIntentLimit: command.dailyIntentLimit }),
        now,
      });
      if (updated !== existing) {
        await notifications.saveProfile(updated, command.expectedVersion);
        const invalidatedIntents = await notifications.deleteIntentsForWorkspace(
          command.workspaceId,
        );
        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "notification_profile.updated",
          entityType: "notification_profile",
          entityId: command.workspaceId,
          data: {
            previousVersion: command.expectedVersion,
            version: updated.version,
            invalidatedIntents,
          },
          occurredAt: now,
        });
      }
      return updated;
    });
  }
}

export class GetNotificationProfile {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(workspaceId: WorkspaceId): Promise<NotificationProfile> {
    return this.unitOfWork.run(async ({ notifications, workspaces }) => {
      await requireWorkspace(workspaceId, workspaces);
      const result = await notifications.findProfile(workspaceId);
      if (result === null) {
        throw new DomainError(
          "notification_profile.not_found",
          "The workspace has no notification profile.",
        );
      }
      return result;
    });
  }
}

export interface CreateNotificationRuleCommand {
  readonly workspaceId: WorkspaceId;
  readonly kind: NotificationRuleKind;
  readonly enabled?: boolean;
  readonly localMinute?: number | null;
  readonly leadMinutes?: number | null;
  readonly cooldownMinutes?: number;
  readonly priority?: number;
}

export class CreateNotificationRule {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: CreateNotificationRuleCommand): Promise<NotificationRule> {
    return this.unitOfWork.run(async ({ auditEvents, notifications, workspaces }) => {
      await notifications.lockWorkspace(command.workspaceId);
      await requireWorkspace(command.workspaceId, workspaces);
      if ((await notifications.findProfile(command.workspaceId)) === null) {
        throw new DomainError(
          "notification_profile.not_found",
          "Configure the notification profile before creating rules.",
        );
      }
      if (
        (await notifications.listRules(command.workspaceId, maximumNotificationRules + 1)).length >=
        maximumNotificationRules
      ) {
        throw new DomainError(
          "notification_rule.limit_reached",
          `A workspace cannot have more than ${String(maximumNotificationRules)} notification rules.`,
        );
      }
      const now = this.clock.now();
      const rule = createNotificationRule({ ...command, now });
      await notifications.insertRule(rule);
      await auditEvents.append({
        workspaceId: command.workspaceId,
        action: "notification_rule.created",
        entityType: "notification_rule",
        entityId: rule.id,
        data: { kind: rule.kind, version: rule.version },
        occurredAt: now,
      });
      return rule;
    });
  }
}

export interface UpdateNotificationRuleCommand {
  readonly workspaceId: WorkspaceId;
  readonly ruleId: NotificationRuleId;
  readonly expectedVersion: number;
  readonly enabled?: boolean;
  readonly localMinute?: number | null;
  readonly leadMinutes?: number | null;
  readonly cooldownMinutes?: number;
  readonly priority?: number;
}

export class UpdateNotificationRule {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: UpdateNotificationRuleCommand): Promise<NotificationRule> {
    validateExpectedVersion(command.expectedVersion);
    return this.unitOfWork.run(async ({ auditEvents, notifications, workspaces }) => {
      await notifications.lockWorkspace(command.workspaceId);
      await requireWorkspace(command.workspaceId, workspaces);
      const existing = await notifications.findRule(command.workspaceId, command.ruleId);
      if (existing === null) {
        throw new DomainError(
          "notification_rule.not_found",
          "The notification rule does not exist.",
        );
      }
      if (existing.version !== command.expectedVersion) {
        throw new DomainError(
          "notification_rule.version_conflict",
          "The notification rule changed before this update could be applied.",
        );
      }
      const now = this.clock.now();
      const updated = updateNotificationRule(existing, {
        ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
        ...(command.localMinute === undefined ? {} : { localMinute: command.localMinute }),
        ...(command.leadMinutes === undefined ? {} : { leadMinutes: command.leadMinutes }),
        ...(command.cooldownMinutes === undefined
          ? {}
          : { cooldownMinutes: command.cooldownMinutes }),
        ...(command.priority === undefined ? {} : { priority: command.priority }),
        now,
      });
      if (updated !== existing) {
        await notifications.saveRule(updated, command.expectedVersion);
        const invalidatedIntents = await notifications.deleteIntentsForRule(
          command.workspaceId,
          updated.id,
        );
        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "notification_rule.updated",
          entityType: "notification_rule",
          entityId: updated.id,
          data: {
            previousVersion: command.expectedVersion,
            version: updated.version,
            invalidatedIntents,
          },
          occurredAt: now,
        });
      }
      return updated;
    });
  }
}

export class ListNotificationRules {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(workspaceId: WorkspaceId): Promise<readonly NotificationRule[]> {
    return this.unitOfWork.run(async ({ notifications, workspaces }) => {
      await requireWorkspace(workspaceId, workspaces);
      const rules = await notifications.listRules(workspaceId, maximumNotificationRules + 1);
      if (rules.length > maximumNotificationRules) {
        throw new DomainError(
          "notification_rule.result_limit",
          "Too many notification rules are stored for this workspace.",
        );
      }
      return rules;
    });
  }
}

export interface CreateOneOffReminderCommand {
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly scheduledFor: Date;
}

export class CreateOneOffReminder {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: CreateOneOffReminderCommand): Promise<OneOffReminder> {
    return this.unitOfWork.run(async ({ auditEvents, notifications, workspaces }) => {
      await notifications.lockWorkspace(command.workspaceId);
      await requireWorkspace(command.workspaceId, workspaces);
      if ((await notifications.findProfile(command.workspaceId)) === null) {
        throw new DomainError(
          "notification_profile.not_found",
          "Configure the notification profile before creating reminders.",
        );
      }
      const now = this.clock.now();
      const reminder = createOneOffReminder({ ...command, now });
      await notifications.insertOneOffReminder(reminder);
      await auditEvents.append({
        workspaceId: command.workspaceId,
        action: "one_off_reminder.created",
        entityType: "one_off_reminder",
        entityId: reminder.id,
        data: { version: reminder.version },
        occurredAt: now,
      });
      return reminder;
    });
  }
}

export interface UpdateOneOffReminderCommand {
  readonly workspaceId: WorkspaceId;
  readonly reminderId: OneOffReminderId;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly scheduledFor?: Date;
}

export class UpdateOneOffReminder {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: UpdateOneOffReminderCommand): Promise<OneOffReminder> {
    validateExpectedVersion(command.expectedVersion);
    return this.unitOfWork.run(async ({ auditEvents, notifications, workspaces }) => {
      await notifications.lockWorkspace(command.workspaceId);
      await requireWorkspace(command.workspaceId, workspaces);
      const existing = await notifications.findOneOffReminder(
        command.workspaceId,
        command.reminderId,
      );
      if (existing === null) {
        throw new DomainError("one_off_reminder.not_found", "The one-off reminder does not exist.");
      }
      if (existing.version !== command.expectedVersion) {
        throw new DomainError(
          "one_off_reminder.version_conflict",
          "The one-off reminder changed before this update could be applied.",
        );
      }
      const now = this.clock.now();
      const updated = updateOneOffReminder(existing, {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.scheduledFor === undefined ? {} : { scheduledFor: command.scheduledFor }),
        now,
      });
      if (updated !== existing) {
        await notifications.saveOneOffReminder(updated, command.expectedVersion);
        const invalidatedIntents = await notifications.deleteIntentsForOneOff(
          command.workspaceId,
          updated.id,
        );
        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "one_off_reminder.updated",
          entityType: "one_off_reminder",
          entityId: updated.id,
          data: {
            previousVersion: command.expectedVersion,
            version: updated.version,
            invalidatedIntents,
          },
          occurredAt: now,
        });
      }
      return updated;
    });
  }
}

export interface CancelOneOffReminderCommand {
  readonly workspaceId: WorkspaceId;
  readonly reminderId: OneOffReminderId;
  readonly expectedVersion: number;
}

export class CancelOneOffReminder {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: CancelOneOffReminderCommand): Promise<OneOffReminder> {
    validateExpectedVersion(command.expectedVersion);
    return this.unitOfWork.run(async ({ auditEvents, notifications, workspaces }) => {
      await notifications.lockWorkspace(command.workspaceId);
      await requireWorkspace(command.workspaceId, workspaces);
      const existing = await notifications.findOneOffReminder(
        command.workspaceId,
        command.reminderId,
      );
      if (existing === null) {
        throw new DomainError("one_off_reminder.not_found", "The one-off reminder does not exist.");
      }
      if (existing.version !== command.expectedVersion) {
        throw new DomainError(
          "one_off_reminder.version_conflict",
          "The one-off reminder changed before this cancellation could be applied.",
        );
      }
      const now = this.clock.now();
      const cancelled = cancelOneOffReminder(existing, now);
      if (cancelled !== existing) {
        await notifications.saveOneOffReminder(cancelled, command.expectedVersion);
        const invalidatedIntents = await notifications.deleteIntentsForOneOff(
          command.workspaceId,
          cancelled.id,
        );
        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "one_off_reminder.cancelled",
          entityType: "one_off_reminder",
          entityId: cancelled.id,
          data: {
            previousVersion: command.expectedVersion,
            version: cancelled.version,
            invalidatedIntents,
          },
          occurredAt: now,
        });
      }
      return cancelled;
    });
  }
}

export interface ListOneOffRemindersQuery {
  readonly workspaceId: WorkspaceId;
  readonly fromInclusive: Date;
  readonly throughExclusive: Date;
}

function validateRange(fromInclusive: Date, throughExclusive: Date): void {
  if (
    !Number.isFinite(fromInclusive.getTime()) ||
    !Number.isFinite(throughExclusive.getTime()) ||
    throughExclusive <= fromInclusive
  ) {
    throw new DomainError(
      "notification.range_invalid",
      "A valid increasing notification time range is required.",
    );
  }
}

export class ListOneOffReminders {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListOneOffRemindersQuery): Promise<readonly OneOffReminder[]> {
    validateRange(query.fromInclusive, query.throughExclusive);
    if (
      query.throughExclusive.getTime() - query.fromInclusive.getTime() >
      MAXIMUM_NOTIFICATION_LIST_DAYS * DAY_MILLISECONDS
    ) {
      throw new DomainError(
        "notification.range_too_large",
        "A one-off reminder list range cannot exceed 31 days.",
      );
    }
    return this.unitOfWork.run(async ({ notifications, workspaces }) => {
      await requireWorkspace(query.workspaceId, workspaces);
      const reminders = await notifications.listOneOffReminders(
        query.workspaceId,
        query.fromInclusive,
        query.throughExclusive,
        MAXIMUM_ONE_OFF_LIST_ROWS + 1,
      );
      if (reminders.length > MAXIMUM_ONE_OFF_LIST_ROWS) {
        throw new DomainError(
          "notification.one_off_result_limit",
          "Too many one-off reminders match this range; request a narrower range.",
        );
      }
      return reminders;
    });
  }
}

export interface ListNotificationIntentsQuery {
  readonly workspaceId: WorkspaceId;
  readonly fromInclusive: Date;
  readonly throughExclusive: Date;
  readonly limit: number;
  readonly offset: number;
}

export class ListNotificationIntents {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListNotificationIntentsQuery): Promise<readonly NotificationIntent[]> {
    validateRange(query.fromInclusive, query.throughExclusive);
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
      throw new DomainError("notification.limit_invalid", "Limit must be between 1 and 500.");
    }
    if (!Number.isInteger(query.offset) || query.offset < 0) {
      throw new DomainError("notification.offset_invalid", "Offset must be non-negative.");
    }
    return this.unitOfWork.run(async ({ notifications, workspaces }) => {
      await requireWorkspace(query.workspaceId, workspaces);
      return notifications.listIntents(
        query.workspaceId,
        query.fromInclusive,
        query.throughExclusive,
        query.limit,
        query.offset,
      );
    });
  }
}

export interface NotificationDueDateRange {
  readonly fromInclusive: LocalDate;
  readonly throughInclusive: LocalDate;
}
