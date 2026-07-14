import { Temporal } from "@js-temporal/polyfill";

import { isIanaTimeZone, isValidLocalDate, type LocalDate } from "./calendar.js";
import { invariant } from "./errors.js";
import {
  notificationIntentId,
  notificationRuleId,
  oneOffReminderId,
  type NotificationIntentId,
  type NotificationRuleId,
  type OneOffReminderId,
  type WorkspaceId,
} from "./ids.js";

export const maximumNotificationPolicyVersion = 2_147_483_647;
export const maximumNotificationLeadMinutes = 10_080;
export const maximumNotificationCatchUpMinutes = 10_080;
export const maximumDailyIntentLimit = 100;
export const maximumNotificationRules = 100;

export const quietHoursPolicies = ["skip", "next_allowed"] as const;
export type QuietHoursPolicy = (typeof quietHoursPolicies)[number];

export const notificationRuleKinds = [
  "daily_digest",
  "daily_follow_up",
  "plan_window_open",
  "schedule_block_lead",
  "work_item_due",
] as const;
export type NotificationRuleKind = (typeof notificationRuleKinds)[number];
export type NotificationKind = NotificationRuleKind | "one_off";

export const notificationTargetTypes = [
  "workspace",
  "daily_plan",
  "schedule_block",
  "work_item",
  "one_off",
] as const;
export type NotificationTargetType = (typeof notificationTargetTypes)[number];

const notificationTargetByKind: Readonly<Record<NotificationKind, NotificationTargetType>> = {
  daily_digest: "workspace",
  daily_follow_up: "daily_plan",
  plan_window_open: "daily_plan",
  schedule_block_lead: "schedule_block",
  work_item_due: "work_item",
  one_off: "one_off",
};

export const notificationSourceTypes = ["rule", "one_off"] as const;
export type NotificationSourceType = (typeof notificationSourceTypes)[number];

export const localTimeResolutions = ["exact", "gap_later", "overlap_earlier"] as const;
export type LocalTimeResolution = (typeof localTimeResolutions)[number];

export type NotificationSnapshotPrimitive = string | number | boolean | null;
export type NotificationPolicySnapshot = Readonly<Record<string, NotificationSnapshotPrimitive>>;

export interface NotificationProfile {
  readonly workspaceId: WorkspaceId;
  readonly enabled: boolean;
  readonly timeZone: string;
  readonly quietHoursStartMinute: number | null;
  readonly quietHoursEndMinute: number | null;
  readonly quietHoursPolicy: QuietHoursPolicy;
  readonly catchUpWindowMinutes: number;
  readonly dailyIntentLimit: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateNotificationProfileInput {
  readonly workspaceId: WorkspaceId;
  readonly enabled?: boolean;
  readonly timeZone: string;
  readonly quietHoursStartMinute?: number | null;
  readonly quietHoursEndMinute?: number | null;
  readonly quietHoursPolicy?: QuietHoursPolicy;
  readonly catchUpWindowMinutes?: number;
  readonly dailyIntentLimit?: number;
  readonly now?: Date;
}

export interface UpdateNotificationProfileInput {
  readonly enabled?: boolean;
  readonly timeZone?: string;
  readonly quietHoursStartMinute?: number | null;
  readonly quietHoursEndMinute?: number | null;
  readonly quietHoursPolicy?: QuietHoursPolicy;
  readonly catchUpWindowMinutes?: number;
  readonly dailyIntentLimit?: number;
  readonly now: Date;
}

export interface NotificationRule {
  readonly id: NotificationRuleId;
  readonly workspaceId: WorkspaceId;
  readonly kind: NotificationRuleKind;
  readonly enabled: boolean;
  readonly localMinute: number | null;
  readonly leadMinutes: number | null;
  readonly cooldownMinutes: number;
  readonly priority: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateNotificationRuleInput {
  readonly id?: NotificationRuleId;
  readonly workspaceId: WorkspaceId;
  readonly kind: NotificationRuleKind;
  readonly enabled?: boolean;
  readonly localMinute?: number | null;
  readonly leadMinutes?: number | null;
  readonly cooldownMinutes?: number;
  readonly priority?: number;
  readonly now?: Date;
}

export interface UpdateNotificationRuleInput {
  readonly enabled?: boolean;
  readonly localMinute?: number | null;
  readonly leadMinutes?: number | null;
  readonly cooldownMinutes?: number;
  readonly priority?: number;
  readonly now: Date;
}

export interface OneOffReminder {
  readonly id: OneOffReminderId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly scheduledFor: Date;
  readonly cancelledAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateOneOffReminderInput {
  readonly id?: OneOffReminderId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly scheduledFor: Date;
  readonly now?: Date;
}

export interface UpdateOneOffReminderInput {
  readonly title?: string;
  readonly scheduledFor?: Date;
  readonly now: Date;
}

export interface NotificationCandidate {
  readonly workspaceId: WorkspaceId;
  readonly sourceType: NotificationSourceType;
  readonly ruleId: NotificationRuleId | null;
  readonly oneOffReminderId: OneOffReminderId | null;
  readonly kind: NotificationKind;
  readonly occurrenceKey: string;
  readonly targetType: NotificationTargetType;
  readonly targetId: string | null;
  readonly titleSnapshot: string | null;
  readonly desiredAt: Date;
  readonly localTimeResolution: LocalTimeResolution;
  readonly priority: number;
  readonly cooldownMinutes: number;
  readonly policySnapshot: NotificationPolicySnapshot;
}

export interface NotificationIntent {
  readonly id: NotificationIntentId;
  readonly workspaceId: WorkspaceId;
  readonly ruleId: NotificationRuleId | null;
  readonly oneOffReminderId: OneOffReminderId | null;
  readonly kind: NotificationKind;
  readonly occurrenceKey: string;
  readonly targetType: NotificationTargetType;
  readonly targetId: string | null;
  readonly titleSnapshot: string | null;
  readonly scheduledFor: Date;
  readonly localDate: LocalDate;
  readonly priority: number;
  readonly policySnapshot: NotificationPolicySnapshot;
  readonly localTimeResolution: LocalTimeResolution;
  readonly adjustedForQuietHours: boolean;
  readonly caughtUp: boolean;
  readonly createdAt: Date;
}

export interface CreateNotificationIntentInput {
  readonly id?: NotificationIntentId;
  readonly candidate: NotificationCandidate;
  readonly evaluation: AcceptedNotificationEvaluation;
  readonly createdAt: Date;
}

export interface ResolvedLocalMinute {
  readonly instant: Date;
  readonly resolution: LocalTimeResolution;
}

export type NotificationSuppressionReason = "profile_disabled" | "quiet_hours" | "outside_catch_up";

export interface AcceptedNotificationEvaluation {
  readonly status: "accepted";
  readonly occurrenceKey: string;
  readonly scheduledFor: Date;
  readonly localDate: LocalDate;
  readonly resolution: LocalTimeResolution;
  readonly adjustedForQuietHours: boolean;
  readonly caughtUp: boolean;
}

export interface SuppressedNotificationEvaluation {
  readonly status: "suppressed";
  readonly occurrenceKey: string;
  readonly reason: NotificationSuppressionReason;
}

export type NotificationEvaluation =
  AcceptedNotificationEvaluation | SuppressedNotificationEvaluation;

function validDate(value: unknown, code: string, message: string): asserts value is Date {
  invariant(value instanceof Date && Number.isFinite(value.getTime()), code, message);
}

function validVersion(value: number, entity: string): void {
  invariant(
    Number.isInteger(value) && value >= 1 && value <= maximumNotificationPolicyVersion,
    `${entity}.version_invalid`,
    "The notification policy record has an invalid version.",
  );
}

function validMinute(value: unknown, code: string, message: string): asserts value is number {
  invariant(
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_439,
    code,
    message,
  );
}

function validBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
  message: string,
): asserts value is number {
  invariant(
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum,
    code,
    message,
  );
}

function validateQuietHours(start: number | null, end: number | null): void {
  invariant(
    (start === null) === (end === null),
    "notification_profile.quiet_hours_pair_invalid",
    "Quiet-hours start and end must both be provided or both be null.",
  );
  if (start !== null && end !== null) {
    validMinute(
      start,
      "notification_profile.quiet_hours_start_invalid",
      "Quiet-hours start must be a minute from 0 through 1439.",
    );
    validMinute(
      end,
      "notification_profile.quiet_hours_end_invalid",
      "Quiet-hours end must be a minute from 0 through 1439.",
    );
  }
}

function validateProfileValues(
  profile: Omit<NotificationProfile, "workspaceId" | "createdAt" | "updatedAt">,
): void {
  invariant(
    typeof profile.enabled === "boolean",
    "notification_profile.enabled_invalid",
    "Notification profile enabled must be boolean.",
  );
  invariant(
    typeof profile.timeZone === "string" && isIanaTimeZone(profile.timeZone),
    "notification_profile.time_zone_invalid",
    "A valid IANA time zone is required.",
  );
  validateQuietHours(profile.quietHoursStartMinute, profile.quietHoursEndMinute);
  invariant(
    quietHoursPolicies.some((candidate) => candidate === profile.quietHoursPolicy),
    "notification_profile.quiet_hours_policy_invalid",
    "A valid quiet-hours policy is required.",
  );
  validBoundedInteger(
    profile.catchUpWindowMinutes,
    0,
    maximumNotificationCatchUpMinutes,
    "notification_profile.catch_up_invalid",
    "Catch-up must be between 0 and 10080 whole minutes.",
  );
  validBoundedInteger(
    profile.dailyIntentLimit,
    1,
    maximumDailyIntentLimit,
    "notification_profile.daily_limit_invalid",
    "The daily intent limit must be between 1 and 100.",
  );
  validVersion(profile.version, "notification_profile");
}

export function createNotificationProfile(
  input: CreateNotificationProfileInput,
): NotificationProfile {
  const now = input.now ?? new Date();
  validDate(
    now,
    "notification_profile.timestamp_invalid",
    "A valid profile timestamp is required.",
  );
  const profile: NotificationProfile = {
    workspaceId: input.workspaceId,
    enabled: input.enabled ?? true,
    timeZone: input.timeZone,
    quietHoursStartMinute: input.quietHoursStartMinute ?? null,
    quietHoursEndMinute: input.quietHoursEndMinute ?? null,
    quietHoursPolicy: input.quietHoursPolicy ?? "next_allowed",
    catchUpWindowMinutes: input.catchUpWindowMinutes ?? 60,
    dailyIntentLimit: input.dailyIntentLimit ?? 12,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  validateProfileValues(profile);
  return profile;
}

export function updateNotificationProfile(
  existing: NotificationProfile,
  input: UpdateNotificationProfileInput,
): NotificationProfile {
  validateProfileValues(existing);
  validDate(
    input.now,
    "notification_profile.timestamp_invalid",
    "A valid profile timestamp is required.",
  );
  const candidate = {
    enabled: input.enabled ?? existing.enabled,
    timeZone: input.timeZone ?? existing.timeZone,
    quietHoursStartMinute:
      input.quietHoursStartMinute === undefined
        ? existing.quietHoursStartMinute
        : input.quietHoursStartMinute,
    quietHoursEndMinute:
      input.quietHoursEndMinute === undefined
        ? existing.quietHoursEndMinute
        : input.quietHoursEndMinute,
    quietHoursPolicy: input.quietHoursPolicy ?? existing.quietHoursPolicy,
    catchUpWindowMinutes: input.catchUpWindowMinutes ?? existing.catchUpWindowMinutes,
    dailyIntentLimit: input.dailyIntentLimit ?? existing.dailyIntentLimit,
    version: existing.version,
  };
  validateProfileValues(candidate);
  const unchanged =
    candidate.enabled === existing.enabled &&
    candidate.timeZone === existing.timeZone &&
    candidate.quietHoursStartMinute === existing.quietHoursStartMinute &&
    candidate.quietHoursEndMinute === existing.quietHoursEndMinute &&
    candidate.quietHoursPolicy === existing.quietHoursPolicy &&
    candidate.catchUpWindowMinutes === existing.catchUpWindowMinutes &&
    candidate.dailyIntentLimit === existing.dailyIntentLimit;
  if (unchanged) return existing;
  invariant(
    existing.version < maximumNotificationPolicyVersion,
    "notification_profile.version_exhausted",
    "The notification profile has reached its maximum supported version.",
  );
  return {
    ...existing,
    ...candidate,
    version: existing.version + 1,
    updatedAt: new Date(input.now),
  };
}

function validateRuleConfiguration(
  kind: NotificationRuleKind,
  localMinute: number | null,
  leadMinutes: number | null,
): void {
  invariant(
    notificationRuleKinds.some((candidate) => candidate === kind),
    "notification_rule.kind_invalid",
    "A valid notification rule kind is required.",
  );
  const usesLocalMinute = ["daily_digest", "daily_follow_up", "work_item_due"].includes(kind);
  if (usesLocalMinute) {
    invariant(
      leadMinutes === null,
      "notification_rule.configuration_invalid",
      "This notification rule kind cannot define lead minutes.",
    );
    validMinute(
      localMinute,
      "notification_rule.local_minute_invalid",
      "This notification rule kind requires a local minute from 0 through 1439.",
    );
    return;
  }
  invariant(
    localMinute === null,
    "notification_rule.configuration_invalid",
    "This notification rule kind cannot define a local minute.",
  );
  validBoundedInteger(
    leadMinutes,
    0,
    maximumNotificationLeadMinutes,
    "notification_rule.lead_minutes_invalid",
    "This notification rule kind requires lead minutes between 0 and 10080.",
  );
}

function validateRule(rule: NotificationRule): void {
  invariant(
    typeof rule.enabled === "boolean",
    "notification_rule.enabled_invalid",
    "Notification rule enabled must be boolean.",
  );
  validateRuleConfiguration(rule.kind, rule.localMinute, rule.leadMinutes);
  validBoundedInteger(
    rule.cooldownMinutes,
    0,
    maximumNotificationLeadMinutes,
    "notification_rule.cooldown_invalid",
    "Notification cooldown must be between 0 and 10080 whole minutes.",
  );
  validBoundedInteger(
    rule.priority,
    0,
    100,
    "notification_rule.priority_invalid",
    "Notification priority must be between 0 and 100.",
  );
  validVersion(rule.version, "notification_rule");
}

export function createNotificationRule(input: CreateNotificationRuleInput): NotificationRule {
  const now = input.now ?? new Date();
  validDate(
    now,
    "notification_rule.timestamp_invalid",
    "A valid notification rule timestamp is required.",
  );
  const rule: NotificationRule = {
    id: input.id ?? notificationRuleId(),
    workspaceId: input.workspaceId,
    kind: input.kind,
    enabled: input.enabled ?? true,
    localMinute: input.localMinute ?? null,
    leadMinutes: input.leadMinutes ?? null,
    cooldownMinutes: input.cooldownMinutes ?? 0,
    priority: input.priority ?? 50,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  validateRule(rule);
  return rule;
}

export function updateNotificationRule(
  existing: NotificationRule,
  input: UpdateNotificationRuleInput,
): NotificationRule {
  validateRule(existing);
  validDate(
    input.now,
    "notification_rule.timestamp_invalid",
    "A valid notification rule timestamp is required.",
  );
  const candidate: NotificationRule = {
    ...existing,
    enabled: input.enabled ?? existing.enabled,
    localMinute: input.localMinute === undefined ? existing.localMinute : input.localMinute,
    leadMinutes: input.leadMinutes === undefined ? existing.leadMinutes : input.leadMinutes,
    cooldownMinutes: input.cooldownMinutes ?? existing.cooldownMinutes,
    priority: input.priority ?? existing.priority,
  };
  validateRule(candidate);
  const unchanged =
    candidate.enabled === existing.enabled &&
    candidate.localMinute === existing.localMinute &&
    candidate.leadMinutes === existing.leadMinutes &&
    candidate.cooldownMinutes === existing.cooldownMinutes &&
    candidate.priority === existing.priority;
  if (unchanged) return existing;
  invariant(
    existing.version < maximumNotificationPolicyVersion,
    "notification_rule.version_exhausted",
    "The notification rule has reached its maximum supported version.",
  );
  return {
    ...candidate,
    version: existing.version + 1,
    updatedAt: new Date(input.now),
  };
}

function normalizeReminderTitle(value: unknown): string {
  invariant(
    typeof value === "string",
    "one_off_reminder.title_invalid",
    "A one-off reminder title must be text.",
  );
  const title = value.trim();
  invariant(
    title.length >= 1 && title.length <= 240,
    "one_off_reminder.title_invalid",
    "A one-off reminder title must contain between 1 and 240 characters.",
  );
  return title;
}

function validateOneOffReminder(reminder: OneOffReminder): void {
  normalizeReminderTitle(reminder.title);
  validDate(
    reminder.scheduledFor,
    "one_off_reminder.scheduled_for_invalid",
    "A valid one-off reminder instant is required.",
  );
  if (reminder.cancelledAt !== null) {
    validDate(
      reminder.cancelledAt,
      "one_off_reminder.cancelled_at_invalid",
      "A valid cancellation instant is required.",
    );
  }
  validVersion(reminder.version, "one_off_reminder");
}

export function createOneOffReminder(input: CreateOneOffReminderInput): OneOffReminder {
  const now = input.now ?? new Date();
  validDate(
    now,
    "one_off_reminder.timestamp_invalid",
    "A valid one-off reminder timestamp is required.",
  );
  validDate(
    input.scheduledFor,
    "one_off_reminder.scheduled_for_invalid",
    "A valid one-off reminder instant is required.",
  );
  return {
    id: input.id ?? oneOffReminderId(),
    workspaceId: input.workspaceId,
    title: normalizeReminderTitle(input.title),
    scheduledFor: new Date(input.scheduledFor),
    cancelledAt: null,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export function updateOneOffReminder(
  existing: OneOffReminder,
  input: UpdateOneOffReminderInput,
): OneOffReminder {
  validateOneOffReminder(existing);
  validDate(
    input.now,
    "one_off_reminder.timestamp_invalid",
    "A valid one-off reminder timestamp is required.",
  );
  invariant(
    existing.cancelledAt === null,
    "one_off_reminder.cancelled",
    "A cancelled one-off reminder cannot be changed.",
  );
  const title = input.title === undefined ? existing.title : normalizeReminderTitle(input.title);
  const scheduledFor = input.scheduledFor ?? existing.scheduledFor;
  validDate(
    scheduledFor,
    "one_off_reminder.scheduled_for_invalid",
    "A valid one-off reminder instant is required.",
  );
  if (title === existing.title && scheduledFor.getTime() === existing.scheduledFor.getTime()) {
    return existing;
  }
  invariant(
    existing.version < maximumNotificationPolicyVersion,
    "one_off_reminder.version_exhausted",
    "The one-off reminder has reached its maximum supported version.",
  );
  return {
    ...existing,
    title,
    scheduledFor: new Date(scheduledFor),
    version: existing.version + 1,
    updatedAt: new Date(input.now),
  };
}

export function cancelOneOffReminder(existing: OneOffReminder, now: Date): OneOffReminder {
  validateOneOffReminder(existing);
  validDate(
    now,
    "one_off_reminder.timestamp_invalid",
    "A valid one-off reminder timestamp is required.",
  );
  if (existing.cancelledAt !== null) return existing;
  invariant(
    existing.version < maximumNotificationPolicyVersion,
    "one_off_reminder.version_exhausted",
    "The one-off reminder has reached its maximum supported version.",
  );
  return {
    ...existing,
    cancelledAt: new Date(now),
    version: existing.version + 1,
    updatedAt: new Date(now),
  };
}

function plainDateTimeFor(localDateValue: LocalDate, minute: number): Temporal.PlainDateTime {
  return Temporal.PlainDateTime.from({
    year: Number(localDateValue.slice(0, 4)),
    month: Number(localDateValue.slice(5, 7)),
    day: Number(localDateValue.slice(8, 10)),
    hour: Math.floor(minute / 60),
    minute: minute % 60,
  });
}

export function resolveLocalMinute(
  localDateValue: string,
  minute: number,
  timeZone: string,
): ResolvedLocalMinute {
  invariant(
    isValidLocalDate(localDateValue),
    "notification.local_date_invalid",
    "A valid local date in YYYY-MM-DD format is required.",
  );
  validMinute(
    minute,
    "notification.local_minute_invalid",
    "A local minute from 0 through 1439 is required.",
  );
  invariant(
    typeof timeZone === "string" && isIanaTimeZone(timeZone),
    "notification.time_zone_invalid",
    "A valid IANA time zone is required.",
  );

  const requested = plainDateTimeFor(localDateValue, minute);
  const fields = {
    year: requested.year,
    month: requested.month,
    day: requested.day,
    hour: requested.hour,
    minute: requested.minute,
    second: requested.second,
    millisecond: requested.millisecond,
    microsecond: requested.microsecond,
    nanosecond: requested.nanosecond,
    timeZone,
  };
  const earlier = Temporal.ZonedDateTime.from(fields, { disambiguation: "earlier" });
  const later = Temporal.ZonedDateTime.from(fields, { disambiguation: "later" });
  const compatible = Temporal.ZonedDateTime.from(fields, { disambiguation: "compatible" });
  let resolution: LocalTimeResolution = "exact";
  if (earlier.epochNanoseconds !== later.epochNanoseconds) {
    resolution =
      earlier.toPlainDateTime().equals(requested) && later.toPlainDateTime().equals(requested)
        ? "overlap_earlier"
        : "gap_later";
  }
  return {
    instant: new Date(Number(compatible.epochMilliseconds)),
    resolution,
  };
}

function validateCandidate(candidate: NotificationCandidate): void {
  invariant(
    candidate.occurrenceKey.trim().length >= 1 && candidate.occurrenceKey.length <= 200,
    "notification.occurrence_key_invalid",
    "An occurrence key must contain between 1 and 200 characters.",
  );
  invariant(
    localTimeResolutions.some((resolution) => resolution === candidate.localTimeResolution),
    "notification.local_time_resolution_invalid",
    "A valid local-time resolution is required.",
  );
  validDate(
    candidate.desiredAt,
    "notification.desired_at_invalid",
    "A valid desired notification instant is required.",
  );
  validBoundedInteger(
    candidate.priority,
    0,
    100,
    "notification.priority_invalid",
    "Notification priority must be between 0 and 100.",
  );
  validBoundedInteger(
    candidate.cooldownMinutes,
    0,
    maximumNotificationLeadMinutes,
    "notification.cooldown_invalid",
    "Notification cooldown must be between 0 and 10080 whole minutes.",
  );
  invariant(
    notificationTargetTypes.some((target) => target === candidate.targetType),
    "notification.target_type_invalid",
    "A valid notification target type is required.",
  );
  const targetNeedsId = !["workspace", "one_off"].includes(candidate.targetType);
  invariant(
    targetNeedsId
      ? typeof candidate.targetId === "string" && candidate.targetId.trim().length > 0
      : candidate.targetId === null,
    "notification.target_invalid",
    "The notification target identifier does not match its target type.",
  );
  invariant(
    notificationTargetByKind[candidate.kind] === candidate.targetType,
    "notification.kind_target_mismatch",
    "The notification target type does not match its notification kind.",
  );
  invariant(
    candidate.titleSnapshot === null ||
      (typeof candidate.titleSnapshot === "string" && candidate.titleSnapshot.length <= 240),
    "notification.title_snapshot_invalid",
    "A notification title snapshot must be at most 240 characters or null.",
  );
  if (candidate.sourceType === "rule") {
    invariant(
      candidate.ruleId !== null &&
        candidate.oneOffReminderId === null &&
        candidate.kind !== "one_off",
      "notification.source_invalid",
      "A rule candidate must identify exactly one notification rule.",
    );
  } else {
    invariant(
      candidate.sourceType === "one_off" &&
        candidate.ruleId === null &&
        candidate.oneOffReminderId !== null &&
        candidate.kind === "one_off" &&
        candidate.targetType === "one_off",
      "notification.source_invalid",
      "A one-off candidate must identify exactly one one-off reminder.",
    );
  }
  invariant(
    Object.keys(candidate.policySnapshot).length <= 32 &&
      Object.entries(candidate.policySnapshot).every(
        ([key, value]) =>
          key.length >= 1 &&
          key.length <= 80 &&
          (value === null || ["string", "number", "boolean"].includes(typeof value)) &&
          (typeof value !== "number" || Number.isFinite(value)),
      ),
    "notification.policy_snapshot_invalid",
    "The notification policy snapshot must contain bounded JSON-safe primitive values.",
  );
}

interface LocalInstantParts {
  readonly localDate: LocalDate;
  readonly minute: number;
}

function localParts(instant: Date, timeZone: string): LocalInstantParts {
  const zoned = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(
    timeZone,
  );
  return {
    localDate: zoned.toPlainDate().toString() as LocalDate,
    minute: zoned.hour * 60 + zoned.minute,
  };
}

function isQuietMinute(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

type QuietResult =
  | {
      readonly status: "allowed";
      readonly scheduledFor: Date;
      readonly resolution: LocalTimeResolution;
      readonly adjusted: boolean;
    }
  | { readonly status: "suppressed" };

function applyQuietHours(
  profile: NotificationProfile,
  scheduledFor: Date,
  currentResolution: LocalTimeResolution,
): QuietResult {
  const start = profile.quietHoursStartMinute;
  const end = profile.quietHoursEndMinute;
  if (start === null || end === null || start === end) {
    return {
      status: "allowed",
      scheduledFor: new Date(scheduledFor),
      resolution: currentResolution,
      adjusted: false,
    };
  }
  const parts = localParts(scheduledFor, profile.timeZone);
  if (!isQuietMinute(parts.minute, start, end)) {
    return {
      status: "allowed",
      scheduledFor: new Date(scheduledFor),
      resolution: currentResolution,
      adjusted: false,
    };
  }
  if (profile.quietHoursPolicy === "skip") return { status: "suppressed" };

  let allowedDate = Temporal.PlainDate.from(parts.localDate);
  if (start > end && parts.minute >= start) allowedDate = allowedDate.add({ days: 1 });
  const resolved = resolveLocalMinute(allowedDate.toString(), end, profile.timeZone);
  return {
    status: "allowed",
    scheduledFor: resolved.instant,
    resolution: resolved.resolution,
    adjusted: true,
  };
}

export function evaluateNotificationCandidate(
  profile: NotificationProfile,
  candidate: NotificationCandidate,
  now: Date,
): NotificationEvaluation {
  validateProfileValues(profile);
  validateCandidate(candidate);
  validDate(now, "notification.timestamp_invalid", "A valid evaluation timestamp is required.");
  invariant(
    profile.workspaceId === candidate.workspaceId,
    "notification.workspace_mismatch",
    "The notification profile and candidate must belong to the same workspace.",
  );
  if (!profile.enabled) {
    return {
      status: "suppressed",
      occurrenceKey: candidate.occurrenceKey,
      reason: "profile_disabled",
    };
  }

  const firstQuietResult = applyQuietHours(
    profile,
    candidate.desiredAt,
    candidate.localTimeResolution,
  );
  if (firstQuietResult.status === "suppressed") {
    return {
      status: "suppressed",
      occurrenceKey: candidate.occurrenceKey,
      reason: "quiet_hours",
    };
  }

  let scheduledFor = firstQuietResult.scheduledFor;
  let resolution = firstQuietResult.resolution;
  let adjustedForQuietHours = firstQuietResult.adjusted;
  let caughtUp = false;
  if (scheduledFor.getTime() < now.getTime()) {
    const lateness = now.getTime() - scheduledFor.getTime();
    if (lateness > profile.catchUpWindowMinutes * 60_000) {
      return {
        status: "suppressed",
        occurrenceKey: candidate.occurrenceKey,
        reason: "outside_catch_up",
      };
    }
    caughtUp = true;
    scheduledFor = new Date(now);
    resolution = "exact";
    const catchUpQuietResult = applyQuietHours(profile, scheduledFor, resolution);
    if (catchUpQuietResult.status === "suppressed") {
      return {
        status: "suppressed",
        occurrenceKey: candidate.occurrenceKey,
        reason: "quiet_hours",
      };
    }
    scheduledFor = catchUpQuietResult.scheduledFor;
    resolution = catchUpQuietResult.resolution;
    adjustedForQuietHours ||= catchUpQuietResult.adjusted;
  }

  return {
    status: "accepted",
    occurrenceKey: candidate.occurrenceKey,
    scheduledFor: new Date(scheduledFor),
    localDate: localParts(scheduledFor, profile.timeZone).localDate,
    resolution,
    adjustedForQuietHours,
    caughtUp,
  };
}

export function createNotificationIntent(input: CreateNotificationIntentInput): NotificationIntent {
  validateCandidate(input.candidate);
  validDate(
    input.createdAt,
    "notification_intent.timestamp_invalid",
    "A valid notification intent timestamp is required.",
  );
  invariant(
    input.evaluation.status === "accepted" &&
      input.evaluation.occurrenceKey === input.candidate.occurrenceKey,
    "notification_intent.evaluation_invalid",
    "An accepted evaluation for the same occurrence is required.",
  );
  validDate(
    input.evaluation.scheduledFor,
    "notification_intent.scheduled_for_invalid",
    "A valid notification intent instant is required.",
  );
  return {
    id: input.id ?? notificationIntentId(),
    workspaceId: input.candidate.workspaceId,
    ruleId: input.candidate.ruleId,
    oneOffReminderId: input.candidate.oneOffReminderId,
    kind: input.candidate.kind,
    occurrenceKey: input.candidate.occurrenceKey,
    targetType: input.candidate.targetType,
    targetId: input.candidate.targetId,
    titleSnapshot: input.candidate.titleSnapshot,
    scheduledFor: new Date(input.evaluation.scheduledFor),
    localDate: input.evaluation.localDate,
    priority: input.candidate.priority,
    policySnapshot: { ...input.candidate.policySnapshot },
    localTimeResolution: input.evaluation.resolution,
    adjustedForQuietHours: input.evaluation.adjustedForQuietHours,
    caughtUp: input.evaluation.caughtUp,
    createdAt: new Date(input.createdAt),
  };
}
