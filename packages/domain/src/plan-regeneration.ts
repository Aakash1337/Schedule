import { createHash } from "node:crypto";

import { invariant } from "./errors.js";
import {
  derivePlanItemId,
  generateDailyPlan,
  type DailyPlan,
  type DailyPlanningRequest,
  type GenerateDailyPlanInput,
  type JsonValue,
  type PlanItem,
  type PlanWarning,
} from "./daily-planning.js";
import type { RoutineId } from "./ids.js";

export type PlanMutationKind = "regenerate" | "replace";

export interface ReplanDailyPlanInput extends Pick<
  GenerateDailyPlanInput,
  "id" | "routines" | "events" | "config" | "generatedAt"
> {
  readonly sourcePlan: DailyPlan;
  readonly request: DailyPlanningRequest;
  readonly anchoredItems: readonly PlanItem[];
  readonly excludedRoutineIds?: readonly RoutineId[];
  readonly kind: PlanMutationKind;
}

function windowMinutes(request: DailyPlanningRequest, index: number): number {
  const window = request.availableWindows[index];
  invariant(
    window !== undefined,
    "planning.locked_constraints_infeasible",
    "A retained item refers to a window that is not available.",
  );
  return Math.floor((window.endsAt.getTime() - window.startsAt.getTime()) / 60_000);
}

function finalWarnings(
  base: readonly PlanWarning[],
  request: DailyPlanningRequest,
  totalMinutes: number,
  itemCount: number,
): readonly PlanWarning[] {
  const warnings = base.filter(
    (warning) =>
      ![
        "minimum_minutes_unmet",
        "minimum_task_count_unmet",
        "target_minutes_unmet",
        "target_task_count_unmet",
      ].includes(warning),
  );
  if (totalMinutes < request.minimumMinutes) warnings.push("minimum_minutes_unmet");
  if (itemCount < request.minimumTaskCount) warnings.push("minimum_task_count_unmet");
  if (totalMinutes < request.targetMinutes) warnings.push("target_minutes_unmet");
  if (itemCount < request.targetTaskCount) warnings.push("target_task_count_unmet");
  return [...new Set(warnings)];
}

export function replanDailyPlan(input: ReplanDailyPlanInput): DailyPlan {
  invariant(
    input.sourcePlan.workspaceId === input.request.workspaceId &&
      input.sourcePlan.date === input.request.date,
    "planning.source_mismatch",
    "The source plan must belong to the requested workspace and date.",
  );
  invariant(
    input.request.requestRevision > input.sourcePlan.requestRevision,
    "planning.revision_not_advanced",
    "A regenerated plan must use a later revision.",
  );
  const sourceItems = new Map(input.sourcePlan.items.map((item) => [item.id, item]));
  const anchorIds = new Set<string>();
  const anchorRoutines = new Set<string>();
  const occupiedByWindow = new Map<number, number>();
  for (const anchor of input.anchoredItems) {
    invariant(
      sourceItems.has(anchor.id),
      "planning.anchor_not_found",
      "Every retained item must belong to the source plan.",
    );
    invariant(
      !anchorIds.has(anchor.id) && !anchorRoutines.has(anchor.routineId),
      "planning.anchor_duplicate",
      "Retained plan items cannot be duplicated.",
    );
    anchorIds.add(anchor.id);
    anchorRoutines.add(anchor.routineId);
    occupiedByWindow.set(
      anchor.windowIndex,
      (occupiedByWindow.get(anchor.windowIndex) ?? 0) + anchor.scheduledMinutes,
    );
    invariant(
      occupiedByWindow.get(anchor.windowIndex)! <= windowMinutes(input.request, anchor.windowIndex),
      "planning.locked_constraints_infeasible",
      "Retained items exceed the capacity of an available window.",
    );
    invariant(
      input.routines.some((candidate) => candidate.id === anchor.routineId),
      "planning.locked_constraints_infeasible",
      "A retained item's routine no longer exists in the planning snapshot.",
    );
  }

  const anchoredMinutes = input.anchoredItems.reduce(
    (total, item) => total + item.scheduledMinutes,
    0,
  );
  invariant(
    anchoredMinutes <= input.request.maximumMinutes &&
      input.anchoredItems.length <= input.request.maximumTaskCount,
    "planning.locked_constraints_infeasible",
    "Retained items exceed the plan's hard time or task-count bounds.",
  );
  const remainingMaximumMinutes = input.request.maximumMinutes - anchoredMinutes;
  const remainingMaximumTasks = input.request.maximumTaskCount - input.anchoredItems.length;
  const residualWindows = input.request.availableWindows
    .map((window, originalIndex) => ({
      originalIndex,
      window: {
        startsAt: window.startsAt,
        endsAt: new Date(
          window.endsAt.getTime() - (occupiedByWindow.get(originalIndex) ?? 0) * 60_000,
        ),
      },
    }))
    .filter((entry) => entry.window.endsAt > entry.window.startsAt);
  const residualRequest: DailyPlanningRequest = {
    ...input.request,
    availableWindows: residualWindows.map((entry) => entry.window),
    minimumMinutes: Math.max(0, input.request.minimumMinutes - anchoredMinutes),
    targetMinutes: Math.max(1, input.request.targetMinutes - anchoredMinutes),
    maximumMinutes: Math.max(1, remainingMaximumMinutes),
    minimumTaskCount: Math.max(0, input.request.minimumTaskCount - input.anchoredItems.length),
    targetTaskCount: Math.max(1, input.request.targetTaskCount - input.anchoredItems.length),
    maximumTaskCount: Math.max(1, remainingMaximumTasks),
  };
  const excluded = new Set<string>([...anchorRoutines, ...(input.excludedRoutineIds ?? [])]);
  const resultId = input.id;
  const residual = generateDailyPlan({
    ...(resultId === undefined ? {} : { id: resultId }),
    request: residualRequest,
    routines:
      remainingMaximumMinutes < 1 || remainingMaximumTasks < 1
        ? []
        : input.routines.filter((routine) => !excluded.has(routine.id)),
    events: input.events,
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
  });
  const usedPositions = new Set(input.anchoredItems.map((item) => item.position));
  let nextPosition = 0;
  const items = [
    ...input.anchoredItems.map((item) => ({
      ...item,
      id: derivePlanItemId(residual.id, item.routineId, item.position),
    })),
    ...residual.items.map((item) => {
      while (usedPositions.has(nextPosition)) nextPosition += 1;
      const position = nextPosition;
      usedPositions.add(position);
      nextPosition += 1;
      return {
        ...item,
        id: derivePlanItemId(residual.id, item.routineId, position),
        position,
        windowIndex: residualWindows[item.windowIndex]!.originalIndex,
      };
    }),
  ].sort((left, right) => left.position - right.position);
  const totalMinutes = items.reduce((total, item) => total + item.scheduledMinutes, 0);
  const canonicalAnchors = [...input.anchoredItems].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
  const mutationSnapshot = {
    kind: input.kind,
    sourcePlanId: input.sourcePlan.id,
    sourceInputHash: input.sourcePlan.inputHash,
    request: JSON.parse(JSON.stringify(input.request)) as JsonValue,
    anchoredItems: canonicalAnchors.map((item) => ({
      id: item.id,
      routineId: item.routineId,
      position: item.position,
      windowIndex: item.windowIndex,
      scheduledMinutes: item.scheduledMinutes,
      locked: item.locked,
    })),
    excludedRoutineIds: [...new Set(input.excludedRoutineIds ?? [])].sort(),
    plannerInput: residual.inputSnapshot,
  } satisfies JsonValue;
  const inputHash = createHash("sha256").update(JSON.stringify(mutationSnapshot)).digest("hex");
  return {
    ...residual,
    items,
    totalMinutes,
    fitness: residual.fitness + input.anchoredItems.reduce((total, item) => total + item.score, 0),
    inputHash,
    inputSnapshot: mutationSnapshot,
    warnings: finalWarnings(residual.warnings, input.request, totalMinutes, items.length),
  };
}
