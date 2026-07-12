import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

export type BrandedId<Name extends string> = string & { readonly [brand]: Name };

export type WorkspaceId = BrandedId<"WorkspaceId">;
export type WorkItemId = BrandedId<"WorkItemId">;
export type ScheduleBlockId = BrandedId<"ScheduleBlockId">;
export type RoutineId = BrandedId<"RoutineId">;
export type ActivityEventId = BrandedId<"ActivityEventId">;
export type DailyPlanId = BrandedId<"DailyPlanId">;

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
