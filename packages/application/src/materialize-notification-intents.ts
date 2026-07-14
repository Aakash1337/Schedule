import {
  DomainError,
  addLocalDays,
  createNotificationIntent,
  evaluateNotificationCandidate,
  instantToLocalDate,
  isTerminalPlanItemActivityState,
  maximumNotificationCatchUpMinutes,
  maximumNotificationRules,
  resolveLocalMinute,
  type DailyPlan,
  type LocalDate,
  type NotificationCandidate,
  type NotificationEvaluation,
  type NotificationIntent,
  type NotificationKind,
  type NotificationProfile,
  type NotificationRule,
  type NotificationSuppressionReason,
  type OneOffReminder,
  type ScheduleBlock,
  type WorkItem,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, TransactionContext, UnitOfWork } from "./ports.js";

const DAY_MILLISECONDS = 86_400_000;
const MAXIMUM_MATERIALIZATION_DAYS = 31;
const MAXIMUM_SOURCE_ROWS = 5_000;
const MAXIMUM_PLAN_WINDOWS = 64;
const MAXIMUM_CANDIDATES = 10_000;
const MAXIMUM_EXPANDED_LOCAL_DAYS =
  MAXIMUM_MATERIALIZATION_DAYS + Math.ceil(maximumNotificationCatchUpMinutes / 1_440) + 4;

export type MaterializationSuppressionReason =
  NotificationSuppressionReason | "outside_window" | "daily_limit" | "cooldown";

export interface MaterializationSuppression {
  readonly occurrenceKey: string;
  readonly reason: MaterializationSuppressionReason;
}

export interface MaterializeNotificationIntentsCommand {
  readonly workspaceId: WorkspaceId;
  readonly fromInclusive: Date;
  readonly throughExclusive: Date;
}

export interface MaterializeNotificationIntentsResult {
  readonly created: readonly NotificationIntent[];
  readonly existing: readonly NotificationIntent[];
  readonly suppressed: readonly MaterializationSuppression[];
}

interface EvaluatedCandidate {
  readonly candidate: NotificationCandidate;
  readonly evaluation: Extract<NotificationEvaluation, { readonly status: "accepted" }>;
}

function validateWindow(fromInclusive: Date, throughExclusive: Date): void {
  if (
    !(fromInclusive instanceof Date) ||
    !(throughExclusive instanceof Date) ||
    !Number.isFinite(fromInclusive.getTime()) ||
    !Number.isFinite(throughExclusive.getTime()) ||
    throughExclusive <= fromInclusive
  ) {
    throw new DomainError(
      "notification.materialization_window_invalid",
      "A valid increasing materialization window is required.",
    );
  }
  if (
    throughExclusive.getTime() - fromInclusive.getTime() >
    MAXIMUM_MATERIALIZATION_DAYS * DAY_MILLISECONDS
  ) {
    throw new DomainError(
      "notification.materialization_window_too_large",
      "A notification materialization window cannot exceed 31 days.",
    );
  }
}

function datesBetween(from: LocalDate, through: LocalDate): readonly LocalDate[] {
  const result: LocalDate[] = [];
  let current = from;
  while (current <= through) {
    result.push(current);
    if (result.length > MAXIMUM_EXPANDED_LOCAL_DAYS) {
      throw new DomainError(
        "notification.materialization_window_too_large",
        "The local notification materialization window is too large.",
      );
    }
    current = addLocalDays(current, 1);
  }
  return result;
}

function stableCandidate(candidate: NotificationCandidate): NotificationCandidate {
  return {
    ...candidate,
    desiredAt: new Date(candidate.desiredAt),
    policySnapshot: { ...candidate.policySnapshot },
  };
}

function dailyCandidate(
  profile: NotificationProfile,
  rule: NotificationRule,
  date: LocalDate,
  kind: "daily_digest" | "daily_follow_up",
  targetType: "workspace" | "daily_plan",
  targetId: string | null,
): NotificationCandidate {
  const resolved = resolveLocalMinute(date, rule.localMinute!, profile.timeZone);
  return {
    workspaceId: profile.workspaceId,
    sourceType: "rule",
    ruleId: rule.id,
    oneOffReminderId: null,
    kind,
    occurrenceKey: `rule:${rule.id}:${kind}:day:${date}`,
    targetType,
    targetId,
    titleSnapshot: null,
    desiredAt: resolved.instant,
    localTimeResolution: resolved.resolution,
    priority: rule.priority,
    cooldownMinutes: rule.cooldownMinutes,
    policySnapshot: {
      profileVersion: profile.version,
      ruleVersion: rule.version,
      localDate: date,
    },
  };
}

function extractPlanWindowStarts(plan: DailyPlan): readonly Date[] {
  const root = plan.inputSnapshot;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new DomainError(
      "notification.plan_snapshot_invalid",
      "The daily plan snapshot is not a structured object.",
    );
  }
  const request = (root as { readonly [key: string]: unknown }).request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new DomainError(
      "notification.plan_snapshot_invalid",
      "The daily plan snapshot has no structured request.",
    );
  }
  const windows = (request as { readonly [key: string]: unknown }).availableWindows;
  if (!Array.isArray(windows)) {
    throw new DomainError(
      "notification.plan_snapshot_invalid",
      "The daily plan snapshot has no available-window list.",
    );
  }
  if (windows.length > MAXIMUM_PLAN_WINDOWS) {
    throw new DomainError(
      "notification.plan_snapshot_invalid",
      "The daily plan snapshot contains too many availability windows.",
    );
  }
  return windows.map((window) => {
    if (
      typeof window !== "object" ||
      window === null ||
      Array.isArray(window) ||
      typeof window.startsAt !== "string"
    ) {
      throw new DomainError(
        "notification.plan_snapshot_invalid",
        "A daily plan window has an invalid start instant.",
      );
    }
    const startsAt = new Date(window.startsAt);
    if (!Number.isFinite(startsAt.getTime())) {
      throw new DomainError(
        "notification.plan_snapshot_invalid",
        "A daily plan window has an invalid start instant.",
      );
    }
    return startsAt;
  });
}

function scheduleBlockCandidate(
  profile: NotificationProfile,
  rule: NotificationRule,
  block: ScheduleBlock,
): NotificationCandidate {
  return {
    workspaceId: profile.workspaceId,
    sourceType: "rule",
    ruleId: rule.id,
    oneOffReminderId: null,
    kind: "schedule_block_lead",
    occurrenceKey: `rule:${rule.id}:schedule-block:${block.id}`,
    targetType: "schedule_block",
    targetId: block.id,
    titleSnapshot: block.title,
    desiredAt: new Date(block.startsAt.getTime() - rule.leadMinutes! * 60_000),
    localTimeResolution: "exact",
    priority: rule.priority,
    cooldownMinutes: rule.cooldownMinutes,
    policySnapshot: {
      profileVersion: profile.version,
      ruleVersion: rule.version,
      targetVersion: block.version,
    },
  };
}

function workItemCandidate(
  profile: NotificationProfile,
  rule: NotificationRule,
  item: WorkItem,
): NotificationCandidate {
  const resolved = resolveLocalMinute(item.dueOn!, rule.localMinute!, profile.timeZone);
  return {
    workspaceId: profile.workspaceId,
    sourceType: "rule",
    ruleId: rule.id,
    oneOffReminderId: null,
    kind: "work_item_due",
    occurrenceKey: `rule:${rule.id}:work-item:${item.id}:due:${item.dueOn!}`,
    targetType: "work_item",
    targetId: item.id,
    titleSnapshot: item.title,
    desiredAt: resolved.instant,
    localTimeResolution: resolved.resolution,
    priority: rule.priority,
    cooldownMinutes: rule.cooldownMinutes,
    policySnapshot: {
      profileVersion: profile.version,
      ruleVersion: rule.version,
      targetVersion: item.version,
      dueOn: item.dueOn!,
    },
  };
}

function oneOffCandidate(
  profile: NotificationProfile,
  reminder: OneOffReminder,
): NotificationCandidate {
  return {
    workspaceId: profile.workspaceId,
    sourceType: "one_off",
    ruleId: null,
    oneOffReminderId: reminder.id,
    kind: "one_off",
    occurrenceKey: `one-off:${reminder.id}`,
    targetType: "one_off",
    targetId: null,
    titleSnapshot: reminder.title,
    desiredAt: new Date(reminder.scheduledFor),
    localTimeResolution: "exact",
    priority: 100,
    cooldownMinutes: 0,
    policySnapshot: {
      profileVersion: profile.version,
      oneOffReminderVersion: reminder.version,
    },
  };
}

async function loadScheduleBlocks(
  context: TransactionContext,
  workspaceId: WorkspaceId,
  fromInclusive: Date,
  throughExclusive: Date,
): Promise<readonly ScheduleBlock[]> {
  const result: ScheduleBlock[] = [];
  const pageSize = 500;
  while (result.length <= MAXIMUM_SOURCE_ROWS) {
    const remaining = MAXIMUM_SOURCE_ROWS + 1 - result.length;
    const page = await context.scheduleBlocks.listOverlapping(
      workspaceId,
      fromInclusive,
      throughExclusive,
      Math.min(pageSize, remaining),
      result.length,
    );
    result.push(...page);
    if (result.length > MAXIMUM_SOURCE_ROWS) break;
    if (page.length < Math.min(pageSize, remaining)) return result;
  }
  throw new DomainError(
    "notification.materialization_source_limit",
    "Too many schedule blocks match one materialization window.",
  );
}

function candidateKindRank(kind: NotificationKind): number {
  switch (kind) {
    case "one_off":
      return 600;
    case "schedule_block_lead":
      return 500;
    case "work_item_due":
      return 400;
    case "plan_window_open":
      return 300;
    case "daily_follow_up":
      return 200;
    case "daily_digest":
      return 100;
  }
}

function compareEvaluated(left: EvaluatedCandidate, right: EvaluatedCandidate): number {
  return (
    left.evaluation.localDate.localeCompare(right.evaluation.localDate, "en") ||
    candidateKindRank(right.candidate.kind) - candidateKindRank(left.candidate.kind) ||
    right.candidate.priority - left.candidate.priority ||
    left.evaluation.scheduledFor.getTime() - right.evaluation.scheduledFor.getTime() ||
    left.candidate.occurrenceKey.localeCompare(right.candidate.occurrenceKey, "en")
  );
}

function pushUniqueCandidate(
  candidates: Map<string, NotificationCandidate>,
  candidate: NotificationCandidate,
): void {
  const existing = candidates.get(candidate.occurrenceKey);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(candidate)) {
      throw new DomainError(
        "notification.occurrence_conflict",
        "One materialization produced conflicting candidates for the same occurrence.",
      );
    }
    return;
  }
  if (candidates.size >= MAXIMUM_CANDIDATES) {
    throw new DomainError(
      "notification.materialization_candidate_limit",
      "Too many notification candidates match one materialization window.",
    );
  }
  candidates.set(candidate.occurrenceKey, stableCandidate(candidate));
}

async function buildCandidates(
  context: TransactionContext,
  profile: NotificationProfile,
  rules: readonly NotificationRule[],
  fromInclusive: Date,
  throughExclusive: Date,
): Promise<readonly NotificationCandidate[]> {
  const expandedFrom = new Date(
    fromInclusive.getTime() - (profile.catchUpWindowMinutes + 1_440) * 60_000,
  );
  const expandedThrough = new Date(throughExclusive.getTime() + DAY_MILLISECONDS);
  const firstDate = instantToLocalDate(expandedFrom, profile.timeZone);
  const lastDate = instantToLocalDate(expandedThrough, profile.timeZone);
  const dates = datesBetween(firstDate, lastDate);
  const candidates = new Map<string, NotificationCandidate>();

  const needsPlans = rules.some(
    (rule) => rule.enabled && ["daily_follow_up", "plan_window_open"].includes(rule.kind),
  );
  const plans = new Map<LocalDate, DailyPlan>();
  if (needsPlans) {
    for (const date of dates) {
      const current = await context.dailyPlans.findCurrent(profile.workspaceId, date);
      if (current !== null) plans.set(date, current.plan);
    }
  }

  const dueRules = rules.filter((rule) => rule.enabled && rule.kind === "work_item_due");
  const dueItems =
    dueRules.length === 0
      ? []
      : await context.notifications.listDueWorkItems(
          profile.workspaceId,
          firstDate,
          lastDate,
          MAXIMUM_SOURCE_ROWS + 1,
        );
  if (dueItems.length > MAXIMUM_SOURCE_ROWS) {
    throw new DomainError(
      "notification.materialization_source_limit",
      "Too many due work items match one materialization window.",
    );
  }

  const blockRules = rules.filter((rule) => rule.enabled && rule.kind === "schedule_block_lead");
  const maximumLead = Math.max(0, ...blockRules.map((rule) => rule.leadMinutes!));
  const blocks =
    blockRules.length === 0
      ? []
      : await loadScheduleBlocks(
          context,
          profile.workspaceId,
          expandedFrom,
          new Date(expandedThrough.getTime() + maximumLead * 60_000),
        );

  for (const rule of rules) {
    if (!rule.enabled) continue;
    switch (rule.kind) {
      case "daily_digest":
        for (const date of dates) {
          pushUniqueCandidate(
            candidates,
            dailyCandidate(profile, rule, date, "daily_digest", "workspace", null),
          );
        }
        break;
      case "daily_follow_up":
        for (const date of dates) {
          const plan = plans.get(date);
          if (
            plan !== undefined &&
            plan.items.some((item) => !isTerminalPlanItemActivityState(item.activityState))
          ) {
            pushUniqueCandidate(
              candidates,
              dailyCandidate(profile, rule, date, "daily_follow_up", "daily_plan", plan.id),
            );
          }
        }
        break;
      case "plan_window_open":
        for (const date of dates) {
          const plan = plans.get(date);
          if (plan === undefined) continue;
          for (const [windowIndex, startsAt] of extractPlanWindowStarts(plan).entries()) {
            pushUniqueCandidate(candidates, {
              workspaceId: profile.workspaceId,
              sourceType: "rule",
              ruleId: rule.id,
              oneOffReminderId: null,
              kind: "plan_window_open",
              occurrenceKey: `rule:${rule.id}:daily-plan:${plan.id}:window:${String(windowIndex)}`,
              targetType: "daily_plan",
              targetId: plan.id,
              titleSnapshot: null,
              desiredAt: new Date(startsAt.getTime() - rule.leadMinutes! * 60_000),
              localTimeResolution: "exact",
              priority: rule.priority,
              cooldownMinutes: rule.cooldownMinutes,
              policySnapshot: {
                profileVersion: profile.version,
                ruleVersion: rule.version,
                requestRevision: plan.requestRevision,
                windowIndex,
              },
            });
          }
        }
        break;
      case "schedule_block_lead":
        for (const block of blocks) {
          pushUniqueCandidate(candidates, scheduleBlockCandidate(profile, rule, block));
        }
        break;
      case "work_item_due":
        for (const item of dueItems) {
          if (item.dueOn !== null && !["done", "cancelled"].includes(item.status)) {
            pushUniqueCandidate(candidates, workItemCandidate(profile, rule, item));
          }
        }
        break;
    }
  }

  const oneOffs = await context.notifications.listOneOffReminders(
    profile.workspaceId,
    expandedFrom,
    expandedThrough,
    MAXIMUM_SOURCE_ROWS + 1,
  );
  if (oneOffs.length > MAXIMUM_SOURCE_ROWS) {
    throw new DomainError(
      "notification.materialization_source_limit",
      "Too many one-off reminders match one materialization window.",
    );
  }
  for (const reminder of oneOffs) {
    if (reminder.cancelledAt === null) {
      pushUniqueCandidate(candidates, oneOffCandidate(profile, reminder));
    }
  }

  return [...candidates.values()].sort((left, right) =>
    left.occurrenceKey.localeCompare(right.occurrenceKey, "en"),
  );
}

export class MaterializeNotificationIntents {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    command: MaterializeNotificationIntentsCommand,
  ): Promise<MaterializeNotificationIntentsResult> {
    validateWindow(command.fromInclusive, command.throughExclusive);
    return this.unitOfWork.run(
      async (context) => {
        await context.notifications.lockWorkspace(command.workspaceId);
        if ((await context.workspaces.findById(command.workspaceId)) === null) {
          throw new DomainError("workspace.not_found", "The workspace does not exist.");
        }
        const profile = await context.notifications.findProfile(command.workspaceId);
        if (profile === null) {
          throw new DomainError(
            "notification_profile.not_found",
            "Configure the notification profile before materializing intents.",
          );
        }
        const rules = await context.notifications.listRules(
          command.workspaceId,
          maximumNotificationRules + 1,
        );
        if (rules.length > maximumNotificationRules) {
          throw new DomainError(
            "notification.materialization_rule_limit",
            "Too many notification rules are stored for this workspace.",
          );
        }
        const candidates = await buildCandidates(
          context,
          profile,
          rules,
          command.fromInclusive,
          command.throughExclusive,
        );
        const now = this.clock.now();
        const evaluated: EvaluatedCandidate[] = [];
        const suppressed: MaterializationSuppression[] = [];
        for (const candidate of candidates) {
          const evaluation = evaluateNotificationCandidate(profile, candidate, now);
          if (evaluation.status === "suppressed") {
            suppressed.push({
              occurrenceKey: candidate.occurrenceKey,
              reason: evaluation.reason,
            });
          } else if (
            evaluation.scheduledFor < command.fromInclusive ||
            evaluation.scheduledFor >= command.throughExclusive
          ) {
            suppressed.push({
              occurrenceKey: candidate.occurrenceKey,
              reason: "outside_window",
            });
          } else {
            evaluated.push({ candidate, evaluation });
          }
        }
        evaluated.sort(compareEvaluated);

        const maximumCooldownMinutes = Math.max(
          0,
          ...rules.filter((rule) => rule.enabled).map((rule) => rule.cooldownMinutes),
        );
        const cooldownMilliseconds = maximumCooldownMinutes * 60_000;
        const evaluatedDates = evaluated
          .map((entry) => entry.evaluation.localDate)
          .sort((left, right) => left.localeCompare(right, "en"));
        const dailyRangeFrom =
          evaluatedDates[0] === undefined
            ? command.fromInclusive
            : resolveLocalMinute(evaluatedDates[0], 0, profile.timeZone).instant;
        const lastEvaluatedDate = evaluatedDates.at(-1);
        const dailyRangeThrough =
          lastEvaluatedDate === undefined
            ? command.throughExclusive
            : resolveLocalMinute(addLocalDays(lastEvaluatedDate, 1), 0, profile.timeZone).instant;
        const existingRangeFrom = new Date(
          Math.min(
            command.fromInclusive.getTime() - cooldownMilliseconds,
            dailyRangeFrom.getTime(),
          ),
        );
        const existingRangeThrough = new Date(
          Math.max(
            command.throughExclusive.getTime() + cooldownMilliseconds,
            dailyRangeThrough.getTime(),
          ),
        );
        const existingInRange = await context.notifications.listIntents(
          command.workspaceId,
          existingRangeFrom,
          existingRangeThrough,
          MAXIMUM_SOURCE_ROWS + 1,
          0,
        );
        if (existingInRange.length > MAXIMUM_SOURCE_ROWS) {
          throw new DomainError(
            "notification.materialization_source_limit",
            "Too many existing intents overlap one materialization window.",
          );
        }
        const existingByOccurrence = new Map(
          existingInRange.map((intent) => [intent.occurrenceKey, intent]),
        );
        const countByLocalDate = new Map<LocalDate, number>();
        const timesByRule = new Map<string, number[]>();
        for (const intent of existingInRange) {
          const currentLocalDate = instantToLocalDate(intent.scheduledFor, profile.timeZone);
          countByLocalDate.set(currentLocalDate, (countByLocalDate.get(currentLocalDate) ?? 0) + 1);
          if (intent.ruleId !== null) {
            const times = timesByRule.get(intent.ruleId) ?? [];
            times.push(intent.scheduledFor.getTime());
            timesByRule.set(intent.ruleId, times);
          }
        }

        const created: NotificationIntent[] = [];
        const existing: NotificationIntent[] = [];
        for (const entry of evaluated) {
          const prior = existingByOccurrence.get(entry.candidate.occurrenceKey);
          if (prior !== undefined) {
            existing.push(prior);
            continue;
          }
          const dailyCount = countByLocalDate.get(entry.evaluation.localDate) ?? 0;
          if (dailyCount >= profile.dailyIntentLimit) {
            suppressed.push({
              occurrenceKey: entry.candidate.occurrenceKey,
              reason: "daily_limit",
            });
            continue;
          }
          if (entry.candidate.ruleId !== null && entry.candidate.cooldownMinutes > 0) {
            const candidateTime = entry.evaluation.scheduledFor.getTime();
            const cooldownMilliseconds = entry.candidate.cooldownMinutes * 60_000;
            const conflicts = (timesByRule.get(entry.candidate.ruleId) ?? []).some(
              (existingTime) => Math.abs(existingTime - candidateTime) < cooldownMilliseconds,
            );
            if (conflicts) {
              suppressed.push({
                occurrenceKey: entry.candidate.occurrenceKey,
                reason: "cooldown",
              });
              continue;
            }
          }

          const proposed = createNotificationIntent({
            candidate: entry.candidate,
            evaluation: entry.evaluation,
            createdAt: now,
          });
          const persisted = await context.notifications.insertIntent(proposed);
          if (persisted.id === proposed.id) {
            created.push(persisted);
            countByLocalDate.set(entry.evaluation.localDate, dailyCount + 1);
            if (persisted.ruleId !== null) {
              const times = timesByRule.get(persisted.ruleId) ?? [];
              times.push(persisted.scheduledFor.getTime());
              timesByRule.set(persisted.ruleId, times);
            }
          } else {
            existing.push(persisted);
          }
          existingByOccurrence.set(entry.candidate.occurrenceKey, persisted);
        }

        if (created.length > 0) {
          await context.auditEvents.append({
            workspaceId: command.workspaceId,
            action: "notification_intents.materialized",
            entityType: "notification_intent_batch",
            entityId: created[0]!.id,
            data: {
              created: created.length,
              existing: existing.length,
              fromInclusive: command.fromInclusive.toISOString(),
              throughExclusive: command.throughExclusive.toISOString(),
            },
            occurredAt: now,
          });
        }
        return {
          created,
          existing,
          suppressed: suppressed.sort((left, right) =>
            left.occurrenceKey.localeCompare(right.occurrenceKey, "en"),
          ),
        };
      },
      { isolationLevel: "read_committed" },
    );
  }
}
