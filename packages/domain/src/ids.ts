import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

export type BrandedId<Name extends string> = string & { readonly [brand]: Name };

export type WorkspaceId = BrandedId<"WorkspaceId">;
export type WorkItemId = BrandedId<"WorkItemId">;
export type ScheduleBlockId = BrandedId<"ScheduleBlockId">;
export type RoutineId = BrandedId<"RoutineId">;
export type ActivityEventId = BrandedId<"ActivityEventId">;
export type DailyPlanId = BrandedId<"DailyPlanId">;
export type PlanItemId = BrandedId<"PlanItemId">;
export type RoutinePlanningFeedbackId = BrandedId<"RoutinePlanningFeedbackId">;
export type RoutineDurationInsightFeedbackId = BrandedId<"RoutineDurationInsightFeedbackId">;
export type DailyPlanFitInsightFeedbackId = BrandedId<"DailyPlanFitInsightFeedbackId">;
export type NotificationRuleId = BrandedId<"NotificationRuleId">;
export type OneOffReminderId = BrandedId<"OneOffReminderId">;
export type NotificationIntentId = BrandedId<"NotificationIntentId">;
export type UserId = BrandedId<"UserId">;
export type ExternalIdentityId = BrandedId<"ExternalIdentityId">;
export type BrowserSessionId = BrandedId<"BrowserSessionId">;

function toId<Name extends string>(value: string, label: Name): BrandedId<Name> {
  if (value.trim().length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
  return value as BrandedId<Name>;
}

export const workspaceId = (value: string = randomUUID()): WorkspaceId =>
  toId(value, "WorkspaceId");

export const workItemId = (value: string = randomUUID()): WorkItemId => toId(value, "WorkItemId");

export const scheduleBlockId = (value: string = randomUUID()): ScheduleBlockId =>
  toId(value, "ScheduleBlockId");

export const routineId = (value: string = randomUUID()): RoutineId => toId(value, "RoutineId");

export const activityEventId = (value: string = randomUUID()): ActivityEventId =>
  toId(value, "ActivityEventId");

export const dailyPlanId = (value: string = randomUUID()): DailyPlanId =>
  toId(value, "DailyPlanId");

export const planItemId = (value: string = randomUUID()): PlanItemId => toId(value, "PlanItemId");

export const routinePlanningFeedbackId = (
  value: string = randomUUID(),
): RoutinePlanningFeedbackId => toId(value, "RoutinePlanningFeedbackId");

export const routineDurationInsightFeedbackId = (
  value: string = randomUUID(),
): RoutineDurationInsightFeedbackId => toId(value, "RoutineDurationInsightFeedbackId");

export const dailyPlanFitInsightFeedbackId = (
  value: string = randomUUID(),
): DailyPlanFitInsightFeedbackId => toId(value, "DailyPlanFitInsightFeedbackId");

export const notificationRuleId = (value: string = randomUUID()): NotificationRuleId =>
  toId(value, "NotificationRuleId");

export const oneOffReminderId = (value: string = randomUUID()): OneOffReminderId =>
  toId(value, "OneOffReminderId");

export const notificationIntentId = (value: string = randomUUID()): NotificationIntentId =>
  toId(value, "NotificationIntentId");

export const userId = (value: string = randomUUID()): UserId => toId(value, "UserId");

export const externalIdentityId = (value: string = randomUUID()): ExternalIdentityId =>
  toId(value, "ExternalIdentityId");

export const browserSessionId = (value: string = randomUUID()): BrowserSessionId =>
  toId(value, "BrowserSessionId");
