import {
  DomainError,
  isValidLocalDate,
  type DailyPlanId,
  type LocalDate,
  type PlanItemActivityState,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, TransactionContext, UnitOfWork } from "./ports.js";

export const SCHEDULING_ADVICE_VERSION = "schedule.advisor/v1" as const;
export const SCHEDULING_ADVISOR_CONTEXT_VERSION = "schedule.advisor-context/v1" as const;
export const SCHEDULING_ADVISOR_OUTPUT_VERSION = "schedule.advisor-output/v1" as const;

/** Version 1 always reviews the current plan and its eligible backlog together. */
export type SchedulingAdviceFocus = "both";
export type SchedulingAdviceSuggestionKind =
  "focus" | "sequence" | "consider_backlog" | "plan_observation";
export type SchedulingAdviceTargetType = "plan_item" | "work_item" | null;
export type SchedulingAdviceConfidence = "low" | "medium";

export interface SchedulingAdvisorPlanItemContext {
  readonly id: string;
  readonly title: string;
  readonly position: number;
  readonly scheduledMinutes: number;
  readonly locked: boolean;
  readonly activityState: PlanItemActivityState;
  readonly sourceType: "routine" | "work_item";
  readonly reasons: readonly string[];
}

export interface SchedulingAdvisorPlanContext {
  readonly id: string;
  readonly headVersion: number;
  readonly date: LocalDate;
  readonly totalMinutes: number;
  readonly warnings: readonly string[];
  readonly items: readonly SchedulingAdvisorPlanItemContext[];
}

export interface SchedulingAdvisorBacklogItemContext {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly priority: WorkItemPriority;
  readonly dueOn: LocalDate | null;
  readonly planningDurationMinutes: number | null;
}

export interface SchedulingAdvisorContext {
  readonly version: typeof SCHEDULING_ADVISOR_CONTEXT_VERSION;
  readonly requestId: string;
  readonly date: LocalDate;
  readonly focus: SchedulingAdviceFocus;
  readonly plan: SchedulingAdvisorPlanContext;
  readonly backlog: readonly SchedulingAdvisorBacklogItemContext[];
  readonly truncated: {
    readonly planItems: boolean;
    readonly backlog: boolean;
  };
}

export interface SchedulingAdvisorSuggestion {
  readonly kind: SchedulingAdviceSuggestionKind;
  readonly targetType: SchedulingAdviceTargetType;
  readonly targetId: string | null;
  readonly title: string;
  readonly rationale: string;
  readonly confidence: SchedulingAdviceConfidence;
}

export interface SchedulingAdvisorOutput {
  readonly version: typeof SCHEDULING_ADVISOR_OUTPUT_VERSION;
  readonly summary: string;
  readonly suggestions: readonly SchedulingAdvisorSuggestion[];
}

export const schedulingAdvisorUnavailableReasons = [
  "disabled",
  "busy",
  "timeout",
  "unreachable",
  "provider_rejected",
  "response_too_large",
  "malformed_response",
] as const;
export type SchedulingAdvisorUnavailableReason =
  (typeof schedulingAdvisorUnavailableReasons)[number];
export type SchedulingAdviceUnavailableReason =
  SchedulingAdvisorUnavailableReason | "invalid_advice";

export type SchedulingAdvisorProviderResult =
  | {
      readonly status: "available";
      readonly output: SchedulingAdvisorOutput;
    }
  | {
      readonly status: "unavailable";
      readonly reason: SchedulingAdvisorUnavailableReason;
    };

/** A read-only provider boundary. Implementations receive no repositories or command services. */
export interface SchedulingAdvisor {
  readonly provider: string;
  readonly model: string | null;
  advise(
    context: SchedulingAdvisorContext,
    signal?: AbortSignal,
  ): Promise<SchedulingAdvisorProviderResult>;
}

export interface GetSchedulingAdviceCommand {
  readonly version: typeof SCHEDULING_ADVICE_VERSION;
  readonly requestId: string;
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly focus: SchedulingAdviceFocus;
  readonly expectedPlanId: DailyPlanId;
  readonly expectedHeadVersion: number;
}

export interface SchedulingAdviceSnapshotReference {
  readonly date: LocalDate;
  readonly planId: string;
  readonly headVersion: number;
}

export interface SchedulingAdviceInputSummary {
  readonly planItemCount: number;
  readonly backlogCount: number;
  readonly truncated: {
    readonly planItems: boolean;
    readonly backlog: boolean;
  };
}

export interface SchedulingAdviceProvenance {
  readonly provider: "disabled" | "ollama" | "unknown";
  readonly model: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date;
  readonly latencyMs: number;
}

export interface SchedulingAdviceSuggestion {
  readonly id: string;
  readonly kind: SchedulingAdviceSuggestionKind;
  readonly targetType: SchedulingAdviceTargetType;
  readonly targetId: string | null;
  readonly title: string;
  readonly rationale: string;
  readonly confidence: SchedulingAdviceConfidence;
}

export interface SchedulingAdviceResult {
  readonly version: typeof SCHEDULING_ADVICE_VERSION;
  readonly requestId: string;
  readonly status: "available" | "unavailable";
  readonly reason: SchedulingAdviceUnavailableReason | null;
  readonly snapshot: SchedulingAdviceSnapshotReference;
  readonly input: SchedulingAdviceInputSummary;
  readonly provenance: SchedulingAdviceProvenance;
  readonly summary: string | null;
  readonly suggestions: readonly SchedulingAdviceSuggestion[];
}

const MAXIMUM_PLAN_ITEMS = 50;
const MAXIMUM_BACKLOG_ITEMS = 50;
const MAXIMUM_CONTEXT_BYTES = 65_536;
const MAXIMUM_IDENTIFIER_CHARACTERS = 128;
const MAXIMUM_TITLE_CHARACTERS = 240;
const MAXIMUM_REASON_CHARACTERS = 160;
const MAXIMUM_REASONS = 3;
const MAXIMUM_WARNING_CHARACTERS = 160;
const MAXIMUM_WARNINGS = 10;
const MAXIMUM_SUMMARY_CHARACTERS = 280;
const MAXIMUM_SUGGESTIONS = 5;
const MAXIMUM_SUGGESTION_TITLE_CHARACTERS = 120;
const MAXIMUM_RATIONALE_CHARACTERS = 400;
const MAXIMUM_PROVIDER_CHARACTERS = 40;
const MAXIMUM_MODEL_CHARACTERS = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_TEXT_PATTERN = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(
    0x7f,
  )}-${String.fromCodePoint(0x9f)}${String.fromCodePoint(0x61c, 0x200e, 0x200f)}${String.fromCodePoint(
    0x202a,
  )}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(
    0x2069,
  )}]`,
  "gu",
);

function invalidRequest(message: string): never {
  throw new DomainError("advisor.request_invalid", message);
}

function validateCommand(command: GetSchedulingAdviceCommand): void {
  if (command.version !== SCHEDULING_ADVICE_VERSION) {
    invalidRequest("A supported scheduling-advice request version is required.");
  }
  if (typeof command.requestId !== "string" || !UUID_PATTERN.test(command.requestId)) {
    invalidRequest("A UUID scheduling-advice request ID is required.");
  }
  if (typeof command.date !== "string" || !isValidLocalDate(command.date)) {
    invalidRequest("A valid scheduling-advice date is required.");
  }
  if (command.focus !== "both") {
    invalidRequest("Scheduling-advice version 1 requires the combined plan and backlog focus.");
  }
  if (typeof command.expectedPlanId !== "string" || command.expectedPlanId.trim().length === 0) {
    invalidRequest("An expected plan ID is required.");
  }
  if (!Number.isInteger(command.expectedHeadVersion) || command.expectedHeadVersion < 1) {
    invalidRequest("A positive expected plan head version is required.");
  }
}

function sanitizeText(value: string, maximumCharacters: number): string {
  const normalized = value
    .normalize("NFC")
    .replace(UNSAFE_TEXT_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...normalized].slice(0, maximumCharacters).join("");
}

function safeIdentifier(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_IDENTIFIER_CHARACTERS ||
    sanitizeText(value, MAXIMUM_IDENTIFIER_CHARACTERS) !== value
  ) {
    throw new DomainError(
      "advisor.context_invalid",
      "The scheduling-advice context contains an unsafe identifier.",
    );
  }
  return value;
}

function finiteWholeNumber(value: number, field: string, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new DomainError(
      "advisor.context_invalid",
      `The scheduling-advice context contains an invalid ${field}.`,
    );
  }
  return value;
}

function validClockInstant(clock: Clock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError(
      "advisor.clock_invalid",
      "A valid scheduling-advice timestamp is required.",
    );
  }
  return new Date(value);
}

function compareBacklogItems(
  left: SchedulingAdvisorBacklogItemContext,
  right: SchedulingAdvisorBacklogItemContext,
): number {
  if (left.dueOn !== right.dueOn) {
    if (left.dueOn === null) return 1;
    if (right.dueOn === null) return -1;
    return left.dueOn.localeCompare(right.dueOn);
  }
  const priorityRank: Readonly<Record<WorkItemPriority, number>> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
    none: 4,
  };
  const priorityDifference = priorityRank[left.priority] - priorityRank[right.priority];
  return priorityDifference !== 0 ? priorityDifference : left.id.localeCompare(right.id);
}

function snapshotReference(context: SchedulingAdvisorContext): SchedulingAdviceSnapshotReference {
  return {
    date: context.date,
    planId: context.plan.id,
    headVersion: context.plan.headVersion,
  };
}

function inputSummary(context: SchedulingAdvisorContext): SchedulingAdviceInputSummary {
  return {
    planItemCount: context.plan.items.length,
    backlogCount: context.backlog.length,
    truncated: context.truncated,
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotConflict(): never {
  throw new DomainError(
    "advisor.snapshot_conflict",
    "The scheduling context changed while advice was being prepared.",
  );
}

async function buildContext(
  transaction: TransactionContext,
  command: GetSchedulingAdviceCommand,
  verifying: boolean,
): Promise<SchedulingAdvisorContext> {
  const workspace = await transaction.workspaces.findById(command.workspaceId);
  if (workspace === null) {
    if (verifying) snapshotConflict();
    throw new DomainError("workspace.not_found", "The workspace does not exist.");
  }

  const current = await transaction.dailyPlans.findCurrent(command.workspaceId, command.date);
  if (current === null) {
    if (verifying) snapshotConflict();
    throw new DomainError("planning.current_not_found", "No current plan exists for this date.");
  }
  if (
    current.plan.id !== command.expectedPlanId ||
    current.headVersion !== command.expectedHeadVersion
  ) {
    snapshotConflict();
  }

  const planItems = [...current.plan.items]
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .slice(0, MAXIMUM_PLAN_ITEMS)
    .map((item): SchedulingAdvisorPlanItemContext => ({
      id: safeIdentifier(item.id),
      title: sanitizeText(item.title, MAXIMUM_TITLE_CHARACTERS),
      position: finiteWholeNumber(item.position, "plan-item position"),
      scheduledMinutes: finiteWholeNumber(item.scheduledMinutes, "scheduled duration", 1),
      locked: item.locked,
      activityState: item.activityState,
      sourceType: item.sourceType,
      reasons: item.reasons
        .slice(0, MAXIMUM_REASONS)
        .map((reason) => sanitizeText(reason, MAXIMUM_REASON_CHARACTERS)),
    }));

  const selectedWorkItemIds = new Set(
    current.plan.items.flatMap((item) => (item.workItemId === null ? [] : [item.workItemId])),
  );
  const candidates = (await transaction.workItems.listPlanningCandidates(command.workspaceId))
    .filter((item) => item.workspaceId === command.workspaceId && !selectedWorkItemIds.has(item.id))
    .map((item): SchedulingAdvisorBacklogItemContext => ({
      id: safeIdentifier(item.id),
      version: finiteWholeNumber(item.version, "work-item version", 1),
      title: sanitizeText(item.title, MAXIMUM_TITLE_CHARACTERS),
      status: item.status,
      priority: item.priority,
      dueOn: item.dueOn,
      planningDurationMinutes:
        item.planningDurationMinutes === null
          ? null
          : finiteWholeNumber(item.planningDurationMinutes, "planning duration", 1),
    }))
    .sort(compareBacklogItems);

  const context: SchedulingAdvisorContext = {
    version: SCHEDULING_ADVISOR_CONTEXT_VERSION,
    requestId: command.requestId,
    date: command.date,
    focus: command.focus,
    plan: {
      id: safeIdentifier(current.plan.id),
      headVersion: finiteWholeNumber(current.headVersion, "plan head version", 1),
      date: current.plan.date,
      totalMinutes: finiteWholeNumber(current.plan.totalMinutes, "total scheduled duration"),
      warnings: current.plan.warnings
        .slice(0, MAXIMUM_WARNINGS)
        .map((warning) => sanitizeText(warning, MAXIMUM_WARNING_CHARACTERS))
        .sort(),
      items: planItems,
    },
    backlog: candidates.slice(0, MAXIMUM_BACKLOG_ITEMS),
    truncated: {
      planItems: current.plan.items.length > MAXIMUM_PLAN_ITEMS,
      backlog: candidates.length > MAXIMUM_BACKLOG_ITEMS,
    },
  };

  if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAXIMUM_CONTEXT_BYTES) {
    throw new DomainError(
      "advisor.context_too_large",
      "The scheduling-advice context exceeds the safe input limit.",
    );
  }
  return context;
}

function normalizeProviderIdentity(advisor: SchedulingAdvisor): {
  readonly provider: SchedulingAdviceProvenance["provider"];
  readonly model: string | null;
} {
  const provider =
    typeof advisor.provider === "string"
      ? sanitizeText(advisor.provider, MAXIMUM_PROVIDER_CHARACTERS)
      : "";
  const model =
    typeof advisor.model === "string"
      ? sanitizeText(advisor.model, MAXIMUM_MODEL_CHARACTERS) || null
      : null;
  return {
    provider: provider === "disabled" || provider === "ollama" ? provider : "unknown",
    model,
  };
}

function isProviderUnavailableReason(value: unknown): value is SchedulingAdvisorUnavailableReason {
  return schedulingAdvisorUnavailableReasons.some((reason) => reason === value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProviderResult(
  value: unknown,
):
  | SchedulingAdvisorProviderResult
  | { readonly status: "invalid"; readonly reason: "malformed_response" } {
  if (!isRecord(value) || typeof value.status !== "string") {
    return { status: "invalid", reason: "malformed_response" };
  }
  if (value.status === "unavailable") {
    if (!exactKeys(value, ["reason", "status"]) || !isProviderUnavailableReason(value.reason)) {
      return { status: "invalid", reason: "malformed_response" };
    }
    return value as SchedulingAdvisorProviderResult;
  }
  if (value.status === "available" && exactKeys(value, ["output", "status"])) {
    return value as SchedulingAdvisorProviderResult;
  }
  return { status: "invalid", reason: "malformed_response" };
}

function normalizeSuggestion(
  value: unknown,
  planItemIds: ReadonlySet<string>,
  backlogIds: ReadonlySet<string>,
  index: number,
): SchedulingAdviceSuggestion | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["confidence", "kind", "rationale", "targetId", "targetType", "title"]) ||
    (value.kind !== "focus" &&
      value.kind !== "sequence" &&
      value.kind !== "consider_backlog" &&
      value.kind !== "plan_observation") ||
    (value.confidence !== "low" && value.confidence !== "medium") ||
    typeof value.title !== "string" ||
    typeof value.rationale !== "string"
  ) {
    return null;
  }
  const title = sanitizeText(value.title, MAXIMUM_SUGGESTION_TITLE_CHARACTERS);
  const rationale = sanitizeText(value.rationale, MAXIMUM_RATIONALE_CHARACTERS);
  if (
    title.length < 1 ||
    rationale.length < 1 ||
    title !== value.title ||
    rationale !== value.rationale
  ) {
    return null;
  }

  if (value.kind === "focus" || value.kind === "sequence") {
    if (
      value.targetType !== "plan_item" ||
      typeof value.targetId !== "string" ||
      !planItemIds.has(value.targetId)
    ) {
      return null;
    }
  } else if (value.kind === "consider_backlog") {
    if (
      value.targetType !== "work_item" ||
      typeof value.targetId !== "string" ||
      !backlogIds.has(value.targetId)
    ) {
      return null;
    }
  } else if (value.targetType !== null || value.targetId !== null) {
    return null;
  }

  return {
    id: `advice-${index + 1}`,
    kind: value.kind,
    targetType: value.targetType as SchedulingAdviceTargetType,
    targetId: value.targetId as string | null,
    title,
    rationale,
    confidence: value.confidence,
  };
}

function normalizeOutput(
  value: unknown,
  context: SchedulingAdvisorContext,
): {
  readonly summary: string;
  readonly suggestions: readonly SchedulingAdviceSuggestion[];
} | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["suggestions", "summary", "version"]) ||
    value.version !== SCHEDULING_ADVISOR_OUTPUT_VERSION ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.suggestions) ||
    value.suggestions.length > MAXIMUM_SUGGESTIONS
  ) {
    return null;
  }
  const summary = sanitizeText(value.summary, MAXIMUM_SUMMARY_CHARACTERS);
  if (summary.length < 1 || summary !== value.summary) return null;

  const planItemIds = new Set(context.plan.items.map((item) => item.id));
  const backlogIds = new Set(context.backlog.map((item) => item.id));
  const suggestions = value.suggestions.map((suggestion, index) =>
    normalizeSuggestion(suggestion, planItemIds, backlogIds, index),
  );
  if (suggestions.some((suggestion) => suggestion === null)) return null;
  const validSuggestions = suggestions as readonly SchedulingAdviceSuggestion[];
  const fingerprints = validSuggestions.map(({ id: _id, ...suggestion }) =>
    JSON.stringify(suggestion),
  );
  return new Set(fingerprints).size === fingerprints.length
    ? { summary, suggestions: validSuggestions }
    : null;
}

function unavailableResult(
  command: GetSchedulingAdviceCommand,
  context: SchedulingAdvisorContext,
  provenance: SchedulingAdviceProvenance,
  reason: SchedulingAdviceUnavailableReason,
): SchedulingAdviceResult {
  return {
    version: SCHEDULING_ADVICE_VERSION,
    requestId: command.requestId,
    status: "unavailable",
    reason,
    snapshot: snapshotReference(context),
    input: inputSummary(context),
    provenance,
    summary: null,
    suggestions: [],
  };
}

export class GetSchedulingAdvice {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly advisor: SchedulingAdvisor,
    private readonly clock: Clock,
  ) {}

  async execute(
    command: GetSchedulingAdviceCommand,
    signal?: AbortSignal,
  ): Promise<SchedulingAdviceResult> {
    validateCommand(command);
    const initial = await this.unitOfWork.run((transaction) =>
      buildContext(transaction, command, false),
    );
    deepFreeze(initial);
    const canonicalInitial = JSON.stringify(initial);
    const identity = normalizeProviderIdentity(this.advisor);
    const requestedAt = validClockInstant(this.clock);
    let rawResult: unknown;
    try {
      rawResult = await this.advisor.advise(initial, signal);
    } catch {
      rawResult = { status: "unavailable", reason: "unreachable" };
    }
    const completedAt = validClockInstant(this.clock);
    const provenance: SchedulingAdviceProvenance = {
      ...identity,
      requestedAt,
      completedAt,
      latencyMs: Math.max(0, completedAt.getTime() - requestedAt.getTime()),
    };

    const providerResult = validateProviderResult(rawResult);
    if (providerResult.status === "invalid") {
      return unavailableResult(command, initial, provenance, providerResult.reason);
    }
    if (providerResult.status === "unavailable") {
      return unavailableResult(command, initial, provenance, providerResult.reason);
    }

    const output = normalizeOutput(providerResult.output, initial);
    if (output === null) {
      return unavailableResult(command, initial, provenance, "invalid_advice");
    }

    const current = await this.unitOfWork.run((transaction) =>
      buildContext(transaction, command, true),
    );
    if (JSON.stringify(current) !== canonicalInitial) snapshotConflict();

    return {
      version: SCHEDULING_ADVICE_VERSION,
      requestId: command.requestId,
      status: "available",
      reason: null,
      snapshot: snapshotReference(initial),
      input: inputSummary(initial),
      provenance,
      summary: output.summary,
      suggestions: output.suggestions,
    };
  }
}
