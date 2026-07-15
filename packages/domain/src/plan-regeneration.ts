import { createHash } from "node:crypto";

import { invariant } from "./errors.js";
import {
  canonicalPlanningWorkItemDependencies,
  derivePlanItemId,
  generateDailyPlan,
  planSourceKey,
  previewDailyPlanAlternatives,
  selectDailyPlanAlternative,
  type DailyPlan,
  type DailyPlanAlternative,
  type DailyPlanAlternativesPreview,
  type DailyPlanningRequest,
  type GenerateDailyPlanInput,
  type JsonValue,
  type PlanItem,
  type PlanSource,
  type PlanWarning,
} from "./daily-planning.js";
import type { RoutineId } from "./ids.js";
import type { WorkItemId } from "./ids.js";
import { isTerminalPlanItemActivityState } from "./plan-item-activity.js";

export type PlanMutationKind =
  "regenerate" | "replace" | "feedback" | "feedback_reset" | "alternative_select";

export interface ReplanDailyPlanInput extends Pick<
  GenerateDailyPlanInput,
  | "id"
  | "routines"
  | "events"
  | "routineFeedback"
  | "routineSelectionPreferenceFeedback"
  | "workItemDependencies"
  | "config"
  | "generatedAt"
> {
  readonly workItems?: GenerateDailyPlanInput["workItems"];
  readonly sourcePlan: DailyPlan;
  readonly request: DailyPlanningRequest;
  readonly anchoredItems: readonly PlanItem[];
  readonly excludedRoutineIds?: readonly RoutineId[];
  readonly excludedWorkItemIds?: readonly WorkItemId[];
  /** Preferred typed exclusion API; legacy id arrays remain supported. */
  readonly excludedSources?: readonly PlanSource[];
  readonly kind: PlanMutationKind;
  /** Opaque key returned by previewReplanDailyPlanAlternatives. */
  readonly selectedAlternativeKey?: string;
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

/** Fields describing the planned candidate must never be caller-controlled during a replan. */
function immutableAnchorSnapshot(item: PlanItem): JsonValue {
  return {
    sourceType: item.sourceType,
    routineId: item.routineId,
    workItemId: item.workItemId,
    title: item.title,
    position: item.position,
    windowIndex: item.windowIndex,
    scheduledMinutes: item.scheduledMinutes,
    partialSession: item.partialSession,
    score: item.score,
    scoreComponents: item.scoreComponents as JsonValue,
    reasons: item.reasons as JsonValue,
  };
}

function replanDailyPlanInternal(
  input: ReplanDailyPlanInput,
  collectResidualPreview?: (preview: DailyPlanAlternativesPreview) => void,
): DailyPlan {
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
  const canonicalWorkItemDependencies = canonicalPlanningWorkItemDependencies(
    input.workItemDependencies ?? [],
    input.request.workspaceId,
    input.workItems ?? [],
  );
  const sourceItems = new Map(input.sourcePlan.items.map((item) => [item.id, item]));
  const anchorIds = new Set<string>();
  const anchorSources = new Set<string>();
  const occupiedByWindow = new Map<number, number>();
  for (const anchor of input.anchoredItems) {
    const sourceItem = sourceItems.get(anchor.id);
    invariant(
      sourceItem !== undefined,
      "planning.anchor_not_found",
      "Every retained item must belong to the source plan.",
    );
    invariant(
      JSON.stringify(immutableAnchorSnapshot(anchor)) ===
        JSON.stringify(immutableAnchorSnapshot(sourceItem)),
      "planning.anchor_tampered",
      "A retained item cannot alter the source, placement, or candidate payload from its source plan.",
    );
    invariant(
      !isTerminalPlanItemActivityState(anchor.activityState),
      "planning.terminal_item_cannot_be_retained",
      "Completed, skipped, deferred, or dismissed items cannot be retained during replanning.",
    );
    invariant(
      !anchorIds.has(anchor.id) && !anchorSources.has(planSourceKey(anchor)),
      "planning.anchor_duplicate",
      "Retained plan items cannot be duplicated.",
    );
    anchorIds.add(anchor.id);
    anchorSources.add(planSourceKey(anchor));
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
      (anchor.sourceType === "routine" &&
        input.routines.some((candidate) => candidate.id === anchor.routineId)) ||
        (anchor.sourceType === "work_item" &&
          (input.workItems ?? []).some((candidate) => candidate.id === anchor.workItemId)),
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
  const terminalSources = input.sourcePlan.items
    .filter((item) => isTerminalPlanItemActivityState(item.activityState))
    .map(planSourceKey);
  const excluded = new Set<string>([
    ...anchorSources,
    ...terminalSources,
    ...(input.excludedSources ?? []).map(planSourceKey),
    ...(input.excludedRoutineIds ?? []).map((id) => `routine:${id}`),
    ...(input.excludedWorkItemIds ?? []).map((id) => `work_item:${id}`),
  ]);
  const residualWorkItems =
    remainingMaximumMinutes < 1 || remainingMaximumTasks < 1
      ? []
      : (input.workItems ?? []).filter((workItem) => !excluded.has(`work_item:${workItem.id}`));
  const residualWorkItemIds = new Set(residualWorkItems.map((workItem) => workItem.id));
  const residualWorkItemDependencies = canonicalWorkItemDependencies.filter((dependency) =>
    residualWorkItemIds.has(dependency.dependentWorkItemId),
  );
  const resultId = input.id;
  const residualInput = {
    ...(resultId === undefined ? {} : { id: resultId }),
    request: residualRequest,
    routines:
      remainingMaximumMinutes < 1 || remainingMaximumTasks < 1
        ? []
        : input.routines.filter((routine) => !excluded.has(`routine:${routine.id}`)),
    workItems: residualWorkItems,
    workItemDependencies: residualWorkItemDependencies,
    events: input.events,
    ...(input.routineFeedback === undefined ? {} : { routineFeedback: input.routineFeedback }),
    ...(input.routineSelectionPreferenceFeedback === undefined
      ? {}
      : { routineSelectionPreferenceFeedback: input.routineSelectionPreferenceFeedback }),
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
  };
  const residual = (() => {
    if (input.selectedAlternativeKey !== undefined) {
      return selectDailyPlanAlternative(residualInput, input.selectedAlternativeKey);
    }
    if (collectResidualPreview === undefined) return generateDailyPlan(residualInput);
    const preview = previewDailyPlanAlternatives(residualInput);
    collectResidualPreview(preview);
    return preview.primary;
  })();
  const usedPositions = new Set(input.anchoredItems.map((item) => item.position));
  let nextPosition = 0;
  const items = [
    ...input.anchoredItems.map((item) => ({
      ...item,
      id: derivePlanItemId(residual.id, item, item.position),
      activityState: "pending" as const,
      lastActivityEventId: null,
      activityUpdatedAt: null,
    })),
    ...residual.items.map((item) => {
      while (usedPositions.has(nextPosition)) nextPosition += 1;
      const position = nextPosition;
      usedPositions.add(position);
      nextPosition += 1;
      return {
        ...item,
        id: derivePlanItemId(residual.id, item, position),
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
      sourceType: item.sourceType,
      routineId: item.routineId,
      workItemId: item.workItemId,
      position: item.position,
      windowIndex: item.windowIndex,
      scheduledMinutes: item.scheduledMinutes,
      locked: item.locked,
    })),
    excludedRoutineIds: [...new Set(input.excludedRoutineIds ?? [])].sort(),
    excludedWorkItemIds: [...new Set(input.excludedWorkItemIds ?? [])].sort(),
    excludedSources: [...new Set((input.excludedSources ?? []).map(planSourceKey))].sort(),
    workItemDependencies: canonicalWorkItemDependencies.map((dependency) => ({
      ...dependency,
      createdAt: dependency.createdAt.toISOString(),
    })),
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

export function replanDailyPlan(input: ReplanDailyPlanInput): DailyPlan {
  return replanDailyPlanInternal(input);
}

function describeReplanAlternative(
  candidateKey: string,
  baseline: DailyPlan,
  candidate: DailyPlan,
): DailyPlanAlternative {
  const baselineSources = new Map(baseline.items.map((item) => [planSourceKey(item), item]));
  const candidateSources = new Map(candidate.items.map((item) => [planSourceKey(item), item]));
  const addedSourceKeys = [...candidateSources.keys()]
    .filter((key) => !baselineSources.has(key))
    .sort((left, right) => left.localeCompare(right, "en"));
  const removedSourceKeys = [...baselineSources.keys()]
    .filter((key) => !candidateSources.has(key))
    .sort((left, right) => left.localeCompare(right, "en"));
  const changedPlacements = [...candidateSources.entries()]
    .flatMap(([key, item]) => {
      const baselineItem = baselineSources.get(key);
      if (
        baselineItem === undefined ||
        (baselineItem.windowIndex === item.windowIndex &&
          baselineItem.scheduledMinutes === item.scheduledMinutes &&
          baselineItem.partialSession === item.partialSession)
      ) {
        return [];
      }
      return [
        {
          sourceType: item.sourceType,
          routineId: item.routineId,
          workItemId: item.workItemId,
          fromWindowIndex: baselineItem.windowIndex,
          toWindowIndex: item.windowIndex,
          fromScheduledMinutes: baselineItem.scheduledMinutes,
          toScheduledMinutes: item.scheduledMinutes,
          fromPartialSession: baselineItem.partialSession,
          toPartialSession: item.partialSession,
        },
      ];
    })
    .sort((left, right) => planSourceKey(left).localeCompare(planSourceKey(right), "en"));
  return {
    candidateKey,
    items: candidate.items.map((item) => ({
      sourceType: item.sourceType,
      routineId: item.routineId,
      workItemId: item.workItemId,
      title: item.title,
      windowIndex: item.windowIndex,
      scheduledMinutes: item.scheduledMinutes,
      partialSession: item.partialSession,
      score: item.score,
      reasons: item.reasons,
    })),
    totalMinutes: candidate.totalMinutes,
    taskCount: candidate.items.length,
    fitness: candidate.fitness,
    warnings: candidate.warnings,
    deltaMinutes: candidate.totalMinutes - baseline.totalMinutes,
    deltaTaskCount: candidate.items.length - baseline.items.length,
    addedSourceKeys,
    removedSourceKeys,
    changedPlacements,
  };
}

export function previewReplanDailyPlanAlternatives(
  input: ReplanDailyPlanInput,
): DailyPlanAlternativesPreview {
  invariant(
    input.selectedAlternativeKey === undefined,
    "planning.alternative_preview_invalid",
    "An alternative preview cannot preselect a candidate.",
  );
  let residualPreview: DailyPlanAlternativesPreview | null = null;
  const primary = replanDailyPlanInternal(input, (preview) => {
    residualPreview = preview;
  });
  invariant(
    residualPreview !== null,
    "planning.alternative_preview_invalid",
    "The planner did not produce an alternative preview.",
  );
  const alternatives = (residualPreview as DailyPlanAlternativesPreview).alternatives.map(
    (alternative) =>
      describeReplanAlternative(
        alternative.candidateKey,
        input.sourcePlan,
        replanDailyPlanInternal({
          ...input,
          selectedAlternativeKey: alternative.candidateKey,
        }),
      ),
  );
  return { primary, alternatives };
}
