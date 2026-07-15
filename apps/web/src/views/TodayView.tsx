import {
  Check,
  Clock3,
  GitCompareArrows,
  Lock,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCcw,
  Shuffle,
  Unlock,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import { api, ApiError, newIdempotencyKey } from "../api";
import {
  availabilitySnapshotKey,
  countIntersectingScheduleBlocks,
  deriveFreeAvailability,
  totalAvailabilityMinutes,
  type AvailabilityWindow,
} from "../availability";
import { Button, EmptyState, ErrorNotice, Field, PageHeader, PageSkeleton } from "../components/ui";
import {
  addDays,
  browserTimeZone,
  formatDay,
  formatMinutes,
  formatTime,
  localDateKey,
  localDateTimeToIso,
  splitTags,
  todayKey,
} from "../date";
import type {
  CurrentDailyPlan,
  DailyPlanAlternative,
  DailyPlanAlternativesResult,
  DailyPlanFitInsight,
  DailyPlanFitUsageOutcome,
  EnergyLevel,
  PlanExclusion,
  PlanItem,
  PlanItemActivityState,
  PlanSettings,
  PlanningFitPreference,
  RoutinePlanningFeedbackSuppressionKind,
  ScheduleBlock,
  SchedulingAdviceResult,
  SchedulingAdviceUnavailableReason,
  WorkspaceViewProps,
} from "../types";

type ActivityCommand = Exclude<PlanItemActivityState, "pending"> | "completion_reversed";

interface PendingIdempotentCommand {
  readonly key: string;
  readonly occurredAt: string;
}

interface ActiveRoutineFeedback {
  readonly routineId: string;
  readonly title: string;
  readonly kind: RoutinePlanningFeedbackSuppressionKind;
}

interface CommandSuccess {
  readonly message: string;
  readonly undo?: ActiveRoutineFeedback;
}

type AdvisorPhase = "idle" | "loading";
type CalendarAvailabilityPhase = "idle" | "loading" | "ready" | "error";
type PlanFitFeedbackAction = "dismiss" | "restore" | null;
type AlternativePreviewPhase = "idle" | "loading" | "ready";

interface LoadedAlternativePreview extends DailyPlanAlternativesResult {
  readonly request: PlanSettings;
}

interface DailyPlanFitPanelProps {
  readonly insight: DailyPlanFitInsight | null;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly feedbackError: string | null;
  readonly feedbackAction: PlanFitFeedbackAction;
  readonly announcement: string | null;
  readonly selectionActive: boolean;
  readonly outcomes: readonly DailyPlanFitUsageOutcome[];
  readonly historyLoading: boolean;
  readonly historyError: string | null;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onRetry: () => void;
  readonly onApply: () => void;
  readonly onDismiss: () => void;
  readonly onRestore: () => void;
  readonly onHistoryRetry: () => void;
}

function planCountLabel(count: number): string {
  return `${count} resolved ${count === 1 ? "plan" : "plans"}`;
}

function taskCountLabel(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

function DailyPlanFitPanel({
  insight,
  loading,
  loadError,
  feedbackError,
  feedbackAction,
  announcement,
  selectionActive,
  outcomes,
  historyLoading,
  historyError,
  headingRef,
  onRetry,
  onApply,
  onDismiss,
  onRestore,
  onHistoryRetry,
}: DailyPlanFitPanelProps) {
  if (loading && insight === null) {
    return (
      <section
        className="today-plan-fit"
        aria-labelledby="today-plan-fit-heading"
        aria-busy="true"
        aria-live="polite"
        role="status"
      >
        <p className="eyebrow">Deterministic Plan Fit</p>
        <h3 id="today-plan-fit-heading">Checking your resolved plans…</h3>
        <p>No targets will change while this evidence is loaded.</p>
      </section>
    );
  }

  if (loadError !== null) {
    return (
      <section className="today-plan-fit" aria-labelledby="today-plan-fit-heading">
        <p className="eyebrow">Deterministic Plan Fit</p>
        <h3 id="today-plan-fit-heading">Plan Fit is unavailable</h3>
        <ErrorNotice
          message={loadError}
          action={
            <Button type="button" variant="quiet" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      </section>
    );
  }

  if (insight === null) return null;

  const hasEvidence =
    insight.typicalPlannedMinutes !== null &&
    insight.typicalCompletedMinutes !== null &&
    insight.typicalPlannedTaskCount !== null &&
    insight.typicalCompletedTaskCount !== null;
  const hasSuggestion =
    insight.status === "suggested" &&
    insight.insightKey !== null &&
    insight.suggestedTargetMinutes !== null &&
    insight.suggestedTargetTaskCount !== null;
  const remainingSamples = Math.max(0, insight.minimumSamples - insight.sampleCount);
  const title =
    insight.status === "insufficient_history"
      ? "Plan Fit is learning"
      : insight.status === "aligned"
        ? "Your recent targets fit"
        : insight.disposition === "dismissed"
          ? "Plan Fit suggestion paused"
          : `Try ${insight.suggestedTargetMinutes} minutes and ${taskCountLabel(insight.suggestedTargetTaskCount!)}`;

  return (
    <section className="today-plan-fit" aria-labelledby="today-plan-fit-heading">
      <div className="today-plan-fit-heading">
        <div>
          <p className="eyebrow">Deterministic Plan Fit</p>
          <h3 id="today-plan-fit-heading" ref={headingRef} tabIndex={-1}>
            {title}
          </h3>
        </div>
        <span>{planCountLabel(insight.sampleCount)}</span>
      </div>

      {insight.status === "insufficient_history" ? (
        <p>
          Resolve {remainingSamples} more {remainingSamples === 1 ? "plan" : "plans"} to get a
          target recommendation. A plan counts after every item is completed, skipped, deferred, or
          dismissed.
        </p>
      ) : insight.status === "aligned" ? (
        <p>
          Your typical completed workload is close to what you planned, so there is nothing to
          adjust right now.
        </p>
      ) : insight.disposition === "dismissed" ? (
        <p>
          This exact evidence snapshot is hidden. New resolved-plan evidence will create a new
          suggestion automatically.
        </p>
      ) : (
        <p>
          Recent resolved plans suggest a smaller joint target. Using it only prefills both fields;
          you still review the values and choose when to generate.
        </p>
      )}

      {hasEvidence ? (
        <dl className="today-plan-fit-facts">
          <div>
            <dt>Typical plan</dt>
            <dd>
              {formatMinutes(insight.typicalPlannedMinutes!)} · {insight.typicalPlannedTaskCount}{" "}
              {insight.typicalPlannedTaskCount === 1 ? "task" : "tasks"}
            </dd>
          </div>
          <div>
            <dt>Typical completed</dt>
            <dd>
              {formatMinutes(insight.typicalCompletedMinutes!)} ·{" "}
              {insight.typicalCompletedTaskCount}{" "}
              {insight.typicalCompletedTaskCount === 1 ? "task" : "tasks"}
            </dd>
          </div>
        </dl>
      ) : null}

      {hasEvidence ? (
        <p className="today-plan-fit-note">
          Completed time is the scheduled time on items marked complete—not optional stopwatch data.
          The calculation uses at most {insight.maximumSamples} resolved plans from the prior{" "}
          {insight.lookbackDays} days.
        </p>
      ) : null}

      {feedbackError === null ? null : <ErrorNotice message={feedbackError} />}
      {announcement === null ? null : (
        <p className="today-plan-fit-status" role="status" aria-live="polite">
          {announcement}
        </p>
      )}

      {hasSuggestion ? (
        <div className="today-plan-fit-actions">
          {insight.disposition === "available" ? (
            <>
              <Button
                type="button"
                variant="quiet"
                disabled={feedbackAction !== null || selectionActive}
                aria-pressed={selectionActive}
                onClick={onApply}
              >
                Use {insight.suggestedTargetMinutes} minutes and{" "}
                {taskCountLabel(insight.suggestedTargetTaskCount)}
              </Button>
              <Button
                type="button"
                variant="quiet"
                busy={feedbackAction === "dismiss"}
                disabled={feedbackAction !== null}
                onClick={onDismiss}
              >
                Not now
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="quiet"
              busy={feedbackAction === "restore"}
              disabled={feedbackAction !== null}
              onClick={onRestore}
            >
              Show again
            </Button>
          )}
        </div>
      ) : null}

      <div className="today-plan-fit-history" aria-labelledby="today-plan-fit-history-heading">
        <div className="today-plan-fit-history-heading">
          <h4 id="today-plan-fit-history-heading">After using Plan Fit</h4>
          <span>Read-only</span>
        </div>
        {historyLoading && outcomes.length === 0 ? (
          <p role="status" aria-live="polite">
            Loading explicit Plan Fit outcomes…
          </p>
        ) : historyError !== null ? (
          <ErrorNotice
            message={historyError}
            action={
              <Button type="button" variant="quiet" onClick={onHistoryRetry}>
                Retry history
              </Button>
            }
          />
        ) : outcomes.length === 0 ? (
          <p>
            No generated plan has used a Plan Fit suggestion yet. Prefilling alone creates no
            history.
          </p>
        ) : (
          <ul className="today-plan-fit-history-list">
            {outcomes.map((outcome) => (
              <li key={outcome.usageId}>
                <div>
                  <strong>
                    {formatDay(new Date(`${outcome.forDate}T12:00:00`), {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </strong>
                  <span>
                    {outcome.status === "resolved"
                      ? "Resolved"
                      : outcome.status === "pending"
                        ? "Waiting for final outcomes"
                        : "Not evaluable"}
                  </span>
                </div>
                <p>
                  Suggested {formatMinutes(outcome.suggestedTargetMinutes)} and{" "}
                  {taskCountLabel(outcome.suggestedTargetTaskCount)}; generated with{" "}
                  {formatMinutes(outcome.appliedTargetMinutes)} and{" "}
                  {taskCountLabel(outcome.appliedTargetTaskCount)}.
                </p>
                {outcome.status === "resolved" &&
                outcome.completedMinutes !== null &&
                outcome.completedTaskCount !== null &&
                outcome.plannedMinutes !== null &&
                outcome.plannedTaskCount !== null ? (
                  <p>
                    Completed {formatMinutes(outcome.completedMinutes)} and{" "}
                    {taskCountLabel(outcome.completedTaskCount)} from{" "}
                    {formatMinutes(outcome.plannedMinutes)} across{" "}
                    {taskCountLabel(outcome.plannedTaskCount)}.
                  </p>
                ) : outcome.status === "pending" ? (
                  <p>Every item in the current plan must resolve before completion is compared.</p>
                ) : (
                  <p>The current plan has no evaluable items for this comparison.</p>
                )}
                {outcome.revisedSinceUsage ? (
                  <p>The day was revised after Plan Fit was used.</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const ADVISOR_UNAVAILABLE_MESSAGES: Readonly<Record<SchedulingAdviceUnavailableReason, string>> = {
  disabled: "Local advice is turned off in the server configuration.",
  busy: "The local advisor is already reviewing another request. Wait a moment and ask again.",
  timeout: "The local advisor took too long to respond. Your plan was not changed.",
  unreachable:
    "The local advisor could not be reached. Check that the configured model is running.",
  provider_rejected: "The local model could not complete this review. Your plan was not changed.",
  response_too_large: "The local model returned more advice than the app can safely display.",
  malformed_response: "The local model returned advice that did not pass validation.",
  invalid_advice: "The local model returned advice that did not match this plan.",
};

function planQueryKey(workspaceId: string, date: string): string {
  return JSON.stringify([workspaceId, date]);
}

function calendarDayRange(date: string): AvailabilityWindow {
  const nextDate = localDateKey(addDays(new Date(`${date}T12:00:00`), 1));
  return {
    startsAt: localDateTimeToIso(date, "00:00"),
    endsAt: localDateTimeToIso(nextDate, "00:00"),
  };
}

function planSnapshotKey(plan: CurrentDailyPlan): string {
  return JSON.stringify([plan.workspaceId, plan.date, plan.id, plan.headVersion]);
}

function messageForError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The local API could not complete this request.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function displayCode(value: string): string {
  const words = value.replace(/[._]/g, " ").trim();
  return words.length === 0 ? value : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function stateLabel(state: PlanItemActivityState): string {
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}

function sourceLabel(item: Pick<PlanItem, "sourceType">): string {
  return item.sourceType === "work_item" ? "Work item" : "Routine";
}

function sourceKey(source: Pick<PlanItem, "sourceType" | "routineId" | "workItemId">): string {
  const id = source.sourceType === "work_item" ? source.workItemId : source.routineId;
  return `${source.sourceType}:${id ?? "missing"}`;
}

function feedbackKindForExclusion(
  exclusion: PlanExclusion,
): RoutinePlanningFeedbackSuppressionKind | null {
  if (exclusion.codes.includes("feedback_not_this_week")) return "not_this_week";
  if (exclusion.codes.includes("feedback_not_today")) return "not_today";
  return null;
}

function activeFeedbackFromExclusion(exclusion: PlanExclusion): ActiveRoutineFeedback | null {
  const kind = feedbackKindForExclusion(exclusion);
  if (kind === null || exclusion.sourceType !== "routine" || exclusion.routineId === null) {
    return null;
  }
  return { routineId: exclusion.routineId, title: exclusion.title, kind };
}

function feedbackTimeframe(kind: RoutinePlanningFeedbackSuppressionKind): string {
  return kind === "not_today" ? "Hidden today" : "Hidden through the end of this week";
}

function advisorUnavailableMessage(reason: SchedulingAdviceUnavailableReason | null): string {
  return reason === null
    ? "Local advice is unavailable right now. Your plan was not changed."
    : ADVISOR_UNAVAILABLE_MESSAGES[reason];
}

function advisorCompletedTime(value: string): string {
  return Number.isFinite(new Date(value).getTime()) ? formatTime(value) : "an unknown time";
}

function SchedulingAdvisorPanel({
  phase,
  result,
  error,
}: {
  readonly phase: AdvisorPhase;
  readonly result: SchedulingAdviceResult | null;
  readonly error: string | null;
}) {
  const available = result?.status === "available" ? result : null;
  const unavailable = result?.status === "unavailable" ? result : null;

  return (
    <section id="today-advisor" className="today-advisor" aria-labelledby="today-advisor-heading">
      <div className="today-advisor-heading">
        <div>
          <p className="eyebrow">Optional local model</p>
          <h2 id="today-advisor-heading">Local advisor</h2>
        </div>
        <p id="today-advisor-safety">Advice only. It cannot change your schedule.</p>
      </div>

      {phase === "loading" ? (
        <p className="today-advisor-state" role="status" aria-live="polite">
          Reviewing this plan and its eligible backlog.
        </p>
      ) : null}

      {phase === "idle" && result === null && error === null ? (
        <p className="today-advisor-intro">
          Ask for a short, read-only review based on the current plan snapshot.
        </p>
      ) : null}

      {error === null ? null : (
        <p className="today-advisor-state today-advisor-state-error" role="alert">
          {error}
        </p>
      )}

      {unavailable === null ? null : (
        <p className="today-advisor-state today-advisor-state-unavailable" role="alert">
          {advisorUnavailableMessage(unavailable.reason)}
        </p>
      )}

      {available === null ? null : (
        <div className="today-advisor-result">
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            Local advisor review ready.
          </p>
          {available.summary === null ? null : (
            <p className="today-advisor-summary">{available.summary}</p>
          )}
          {available.suggestions.length === 0 ? (
            <p className="today-advisor-empty">No additional suggestions for this snapshot.</p>
          ) : (
            <ol className="today-advisor-suggestions" aria-label="Local advisor suggestions">
              {available.suggestions.map((suggestion, index) => (
                <li key={suggestion.id}>
                  <span className="today-advisor-suggestion-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div>
                    <div className="today-advisor-suggestion-heading">
                      <h3>{suggestion.title}</h3>
                      <span>{displayCode(suggestion.kind)}</span>
                    </div>
                    <p>{suggestion.rationale}</p>
                    <span className="today-advisor-confidence">
                      {displayCode(suggestion.confidence)} confidence
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="today-advisor-provenance">
            Generated with {available.provenance.model ?? "the local advisor"} at{" "}
            {advisorCompletedTime(available.provenance.completedAt)}, based on plan head{" "}
            {available.snapshot.headVersion}. Reviewed {available.input.planItemCount} plan{" "}
            {available.input.planItemCount === 1 ? "item" : "items"} and{" "}
            {available.input.backlogCount} backlog{" "}
            {available.input.backlogCount === 1 ? "item" : "items"}.
            {available.input.truncated.planItems || available.input.truncated.backlog
              ? " A bounded subset was used."
              : ""}
          </p>
        </div>
      )}
    </section>
  );
}

function CalendarAvailabilityControl({
  enabled,
  phase,
  error,
  windowIsValid,
  freeWindows,
  intersectingBlockCount,
  disabled,
  onEnabledChange,
  onRefresh,
}: {
  readonly enabled: boolean;
  readonly phase: CalendarAvailabilityPhase;
  readonly error: string | null;
  readonly windowIsValid: boolean;
  readonly freeWindows: readonly AvailabilityWindow[];
  readonly intersectingBlockCount: number;
  readonly disabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onRefresh: () => void;
}) {
  const totalMinutes = totalAvailabilityMinutes(freeWindows);
  return (
    <div className="today-calendar-availability">
      <label className="today-calendar-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          aria-label="Exclude calendar blocks"
          aria-describedby="today-calendar-availability-hint"
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        <span>
          <strong>Exclude calendar blocks</strong>
          <small id="today-calendar-availability-hint">
            Treat reservations inside this range as unavailable planning time.
          </small>
        </span>
      </label>

      {!enabled ? null : (
        <div className="today-calendar-preview">
          <div className="today-calendar-preview-heading">
            <span>Free planning windows</span>
            {phase === "loading" ? null : (
              <Button
                type="button"
                variant="quiet"
                disabled={disabled}
                aria-label="Refresh calendar availability"
                onClick={onRefresh}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Refresh
              </Button>
            )}
          </div>

          {phase === "loading" ? (
            <p className="today-calendar-state" role="status" aria-live="polite">
              Checking today&apos;s calendar.
            </p>
          ) : null}

          {phase === "error" ? (
            <p className="today-calendar-state today-calendar-state-error" role="alert">
              {error ?? "Calendar availability could not be loaded."} Retry, or turn this option off
              to use the range manually.
            </p>
          ) : null}

          {phase === "ready" && !windowIsValid ? (
            <p className="today-calendar-state today-calendar-state-error" role="alert">
              Choose a planning range that ends after it starts.
            </p>
          ) : null}

          {phase === "ready" && windowIsValid && freeWindows.length === 0 ? (
            <p className="today-calendar-state today-calendar-state-error" role="alert">
              Calendar blocks fill this entire range. Expand the range or turn this option off.
            </p>
          ) : null}

          {phase === "ready" && windowIsValid && freeWindows.length > 0 ? (
            <>
              <p className="today-calendar-state" role="status" aria-live="polite">
                <strong>{formatMinutes(totalMinutes)} free</strong> across {freeWindows.length}{" "}
                {freeWindows.length === 1 ? "window" : "windows"}.
                {intersectingBlockCount === 0
                  ? " No calendar blocks overlap this range."
                  : ` Excluding ${intersectingBlockCount} calendar ${
                      intersectingBlockCount === 1 ? "block" : "blocks"
                    }.`}
              </p>
              <ol className="today-calendar-windows" aria-label="Free planning windows">
                {freeWindows.map((window) => (
                  <li key={`${window.startsAt}:${window.endsAt}`}>
                    <span>{formatTime(window.startsAt)}</span>
                    <span aria-hidden="true">–</span>
                    <span>{formatTime(window.endsAt)}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function retainedSettings(plan: CurrentDailyPlan): PlanSettings | null {
  if (plan.request === null) return null;
  return {
    timeZone: plan.request.timeZone,
    availableWindows: plan.request.availableWindows,
    targetMinutes: plan.request.targetMinutes,
    minimumMinutes: plan.request.minimumMinutes,
    maximumMinutes: plan.request.maximumMinutes,
    targetTaskCount: plan.request.targetTaskCount,
    minimumTaskCount: plan.request.minimumTaskCount,
    maximumTaskCount: plan.request.maximumTaskCount,
    fitPreference: plan.request.fitPreference,
    energy: plan.request.energy,
    availableContexts: plan.request.availableContexts,
    seed: plan.request.seed,
  };
}

function settingsWithFreshSeed(
  plan: CurrentDailyPlan,
  settings: PlanSettings,
  commandKey: string,
): PlanSettings {
  return {
    ...settings,
    seed: `today:${plan.date}:revision:${plan.requestRevision + 1}:${commandKey}`,
  };
}

function PlanItemActions({
  item,
  busyAction,
  durationValue,
  onDurationChange,
  onActivity,
}: {
  readonly item: PlanItem;
  readonly busyAction: string | null;
  readonly durationValue: string;
  readonly onDurationChange: (value: string) => void;
  readonly onActivity: (type: ActivityCommand, durationMinutes?: number | null) => void;
}) {
  const disabled = busyAction !== null;
  const activityKey = (type: ActivityCommand) => `activity:${item.id}:${type}`;
  const canAct = item.activityState === "pending" || item.activityState === "started";
  const parsedDuration = durationValue.trim().length === 0 ? null : Number(durationValue);
  const durationIsValid =
    parsedDuration === null ||
    (Number.isInteger(parsedDuration) && parsedDuration > 0 && parsedDuration <= 43_200);

  if (item.activityState === "completed") {
    const key = activityKey("completion_reversed");
    return (
      <div className="today-item-actions">
        <Button
          type="button"
          variant="quiet"
          busy={busyAction === key}
          disabled={disabled}
          onClick={() => onActivity("completion_reversed")}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Undo completion
        </Button>
      </div>
    );
  }

  if (!canAct) return null;

  const completeKey = activityKey("completed");
  return (
    <div className="today-item-actions">
      {item.activityState === "pending" ? (
        <Button
          type="button"
          variant="quiet"
          busy={busyAction === activityKey("started")}
          disabled={disabled}
          onClick={() => onActivity("started")}
        >
          <Play size={15} aria-hidden="true" />
          Start
        </Button>
      ) : null}

      <label className="today-completion-duration">
        <span>Actual minutes</span>
        <input
          type="number"
          min={1}
          max={43_200}
          step={1}
          inputMode="numeric"
          value={durationValue}
          placeholder={String(item.scheduledMinutes)}
          disabled={disabled}
          aria-invalid={!durationIsValid}
          aria-label={`Actual minutes for ${item.title}`}
          onChange={(event) => onDurationChange(event.target.value)}
        />
      </label>
      <Button
        type="button"
        variant="primary"
        busy={busyAction === completeKey}
        disabled={disabled || !durationIsValid}
        onClick={() => onActivity("completed", parsedDuration)}
      >
        <Check size={15} aria-hidden="true" />
        Complete
      </Button>

      {(["skipped", "deferred", "dismissed"] as const).map((type) => {
        const key = activityKey(type);
        return (
          <Button
            key={type}
            type="button"
            variant="quiet"
            busy={busyAction === key}
            disabled={disabled}
            onClick={() => onActivity(type)}
          >
            {type === "skipped" ? "Skip" : type === "deferred" ? "Defer" : "Dismiss"}
          </Button>
        );
      })}
    </div>
  );
}

export function TodayView({ workspace, onNavigate }: WorkspaceViewProps) {
  const date = todayKey();
  const timeZone = browserTimeZone();
  const [plan, setPlan] = useState<CurrentDailyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<CommandSuccess | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [advisorPhase, setAdvisorPhase] = useState<AdvisorPhase>("idle");
  const [advisorResult, setAdvisorResult] = useState<SchedulingAdviceResult | null>(null);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [calendarAware, setCalendarAware] = useState(false);
  const [calendarPhase, setCalendarPhase] = useState<CalendarAvailabilityPhase>("idle");
  const [calendarBlocks, setCalendarBlocks] = useState<readonly ScheduleBlock[]>([]);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [targetMinutes, setTargetMinutes] = useState("180");
  const [targetTaskCount, setTargetTaskCount] = useState("4");
  const [planFitInsight, setPlanFitInsight] = useState<DailyPlanFitInsight | null>(null);
  const [planFitLoading, setPlanFitLoading] = useState(true);
  const [planFitLoadError, setPlanFitLoadError] = useState<string | null>(null);
  const [planFitFeedbackError, setPlanFitFeedbackError] = useState<string | null>(null);
  const [planFitFeedbackAction, setPlanFitFeedbackAction] = useState<PlanFitFeedbackAction>(null);
  const [planFitAnnouncement, setPlanFitAnnouncement] = useState<string | null>(null);
  const [planFitSelectedInsightKey, setPlanFitSelectedInsightKey] = useState<string | null>(null);
  const [planFitUsageOutcomes, setPlanFitUsageOutcomes] = useState<
    readonly DailyPlanFitUsageOutcome[]
  >([]);
  const [planFitHistoryLoading, setPlanFitHistoryLoading] = useState(true);
  const [planFitHistoryError, setPlanFitHistoryError] = useState<string | null>(null);
  const [planFitFocusPending, setPlanFitFocusPending] = useState(false);
  const [planFitTargetFocusPending, setPlanFitTargetFocusPending] = useState(false);
  const [fitPreference, setFitPreference] = useState<PlanningFitPreference>("balanced");
  const [energy, setEnergy] = useState<EnergyLevel | "">("");
  const [contexts, setContexts] = useState("");
  const [durationByItem, setDurationByItem] = useState<Readonly<Record<string, string>>>({});
  const [alternativePhase, setAlternativePhase] = useState<AlternativePreviewPhase>("idle");
  const [alternativePreview, setAlternativePreview] = useState<LoadedAlternativePreview | null>(
    null,
  );
  const [alternativeError, setAlternativeError] = useState<string | null>(null);
  const pendingCommandsRef = useRef(new Map<string, PendingIdempotentCommand>());
  const recentFeedbackRef = useRef<HTMLDivElement>(null);
  const shouldFocusRecentFeedbackUndoRef = useRef(false);
  const todayViewRef = useRef<HTMLElement>(null);
  const advisorControllerRef = useRef<AbortController | null>(null);
  const calendarControllerRef = useRef<AbortController | null>(null);
  const generationControllerRef = useRef<AbortController | null>(null);
  const planFitControllerRef = useRef<AbortController | null>(null);
  const planFitHistoryControllerRef = useRef<AbortController | null>(null);
  const planFitFeedbackControllerRef = useRef<AbortController | null>(null);
  const planFitFeedbackCommandsRef = useRef(new Map<string, string>());
  const planFitHeadingRef = useRef<HTMLHeadingElement>(null);
  const targetMinutesRef = useRef<HTMLInputElement>(null);
  const planSummaryHeadingRef = useRef<HTMLHeadingElement>(null);
  const alternativeControllerRef = useRef<AbortController | null>(null);
  const advisorEpochRef = useRef(0);
  const shouldRestoreAdvisorFocusRef = useRef(false);
  const activeQueryKey = planQueryKey(workspace.id, date);
  const activeQueryKeyRef = useRef(activeQueryKey);
  activeQueryKeyRef.current = activeQueryKey;
  const renderedPlanSnapshotKey = plan === null ? null : planSnapshotKey(plan);
  const planSnapshotKeyRef = useRef<string | null>(renderedPlanSnapshotKey);
  planSnapshotKeyRef.current = renderedPlanSnapshotKey;

  const dayLabel = useMemo(
    () =>
      formatDay(new Date(`${date}T12:00:00`), {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    [date],
  );
  const calendarRange = useMemo(() => {
    try {
      return calendarDayRange(date);
    } catch {
      return null;
    }
  }, [date]);
  const planningWindow = useMemo<AvailabilityWindow | null>(() => {
    try {
      const startsAt = localDateTimeToIso(date, startTime);
      const endsAt = localDateTimeToIso(date, endTime);
      return new Date(endsAt) > new Date(startsAt) ? { startsAt, endsAt } : null;
    } catch {
      return null;
    }
  }, [date, endTime, startTime]);
  const calendarFreeWindows = useMemo(() => {
    if (calendarPhase !== "ready" || planningWindow === null) return [];
    try {
      return deriveFreeAvailability(planningWindow, calendarBlocks);
    } catch {
      return [];
    }
  }, [calendarBlocks, calendarPhase, planningWindow]);
  const intersectingCalendarBlockCount = useMemo(() => {
    if (calendarPhase !== "ready" || planningWindow === null) return 0;
    try {
      return countIntersectingScheduleBlocks(planningWindow, calendarBlocks);
    } catch {
      return 0;
    }
  }, [calendarBlocks, calendarPhase, planningWindow]);

  const invalidateAdvisor = useCallback(() => {
    advisorEpochRef.current += 1;
    advisorControllerRef.current?.abort();
    advisorControllerRef.current = null;
    shouldRestoreAdvisorFocusRef.current = false;
    setAdvisorPhase("idle");
    setAdvisorResult(null);
    setAdvisorError(null);
  }, []);

  const clearAlternativePreview = useCallback(() => {
    alternativeControllerRef.current?.abort();
    alternativeControllerRef.current = null;
    setAlternativePhase("idle");
    setAlternativePreview(null);
    setAlternativeError(null);
  }, []);

  const acceptLoadedPlan = useCallback(
    (current: CurrentDailyPlan | null) => {
      const nextSnapshotKey = current === null ? null : planSnapshotKey(current);
      if (planSnapshotKeyRef.current !== nextSnapshotKey) {
        invalidateAdvisor();
        clearAlternativePreview();
      }
      planSnapshotKeyRef.current = nextSnapshotKey;
      setPlan(current);
    },
    [clearAlternativePreview, invalidateAdvisor],
  );

  const loadCurrentPlan = useCallback(
    async (signal?: AbortSignal) => {
      const requestKey = planQueryKey(workspace.id, date);
      const requestIsActive = () =>
        signal?.aborted !== true && activeQueryKeyRef.current === requestKey;
      setLoading(true);
      setLoadError(null);
      try {
        const current = await api.getCurrentPlan(workspace.id, date, signal);
        if (requestIsActive()) acceptLoadedPlan(current);
      } catch (error) {
        if (!requestIsActive()) return;
        if (error instanceof ApiError && error.status === 404) {
          acceptLoadedPlan(null);
        } else {
          setLoadError(messageForError(error));
        }
      } finally {
        if (requestIsActive()) setLoading(false);
      }
    },
    [acceptLoadedPlan, date, workspace.id],
  );

  const loadPlanFitInsight = useCallback(async () => {
    planFitControllerRef.current?.abort();
    const controller = new AbortController();
    planFitControllerRef.current = controller;
    const requestKey = planQueryKey(workspace.id, date);
    const requestIsActive = () =>
      !controller.signal.aborted &&
      planFitControllerRef.current === controller &&
      activeQueryKeyRef.current === requestKey;

    setPlanFitLoading(true);
    setPlanFitLoadError(null);
    try {
      const insight = await api.getDailyPlanFitInsight(workspace.id, date, controller.signal);
      if (requestIsActive()) {
        setPlanFitInsight(insight);
        setPlanFitSelectedInsightKey((current) =>
          current === null || current === insight.insightKey ? current : null,
        );
      }
    } catch (error) {
      if (!requestIsActive() || isAbortError(error)) return;
      setPlanFitLoadError(messageForError(error));
    } finally {
      if (requestIsActive()) setPlanFitLoading(false);
      if (planFitControllerRef.current === controller) planFitControllerRef.current = null;
    }
  }, [date, workspace.id]);

  const loadPlanFitUsageOutcomes = useCallback(async () => {
    planFitHistoryControllerRef.current?.abort();
    const controller = new AbortController();
    planFitHistoryControllerRef.current = controller;
    const requestKey = planQueryKey(workspace.id, date);
    const requestIsActive = () =>
      !controller.signal.aborted &&
      planFitHistoryControllerRef.current === controller &&
      activeQueryKeyRef.current === requestKey;

    setPlanFitHistoryLoading(true);
    setPlanFitHistoryError(null);
    try {
      const page = await api.listDailyPlanFitUsageOutcomes(workspace.id, 5, controller.signal);
      if (requestIsActive()) setPlanFitUsageOutcomes(page.items);
    } catch (error) {
      if (!requestIsActive() || isAbortError(error)) return;
      setPlanFitHistoryError(messageForError(error));
    } finally {
      if (requestIsActive()) setPlanFitHistoryLoading(false);
      if (planFitHistoryControllerRef.current === controller) {
        planFitHistoryControllerRef.current = null;
      }
    }
  }, [date, workspace.id]);

  const loadCalendarAvailability = useCallback(async () => {
    calendarControllerRef.current?.abort();
    const controller = new AbortController();
    calendarControllerRef.current = controller;
    const requestKey = activeQueryKey;
    const requestIsActive = () =>
      !controller.signal.aborted &&
      calendarControllerRef.current === controller &&
      activeQueryKeyRef.current === requestKey;

    setCalendarPhase("loading");
    setCalendarError(null);
    try {
      if (calendarRange === null) {
        throw new RangeError("The local calendar day could not be represented safely.");
      }
      const page = await api.listScheduleBlocks(
        workspace.id,
        calendarRange.startsAt,
        calendarRange.endsAt,
        controller.signal,
      );
      if (!requestIsActive()) return;
      deriveFreeAvailability(calendarRange, page.items);
      setCalendarBlocks(page.items);
      setCalendarPhase("ready");
    } catch (error) {
      if (!requestIsActive() || isAbortError(error)) return;
      setCalendarBlocks([]);
      setCalendarPhase("error");
      setCalendarError(`Calendar availability could not be loaded. ${messageForError(error)}`);
    } finally {
      if (calendarControllerRef.current === controller) calendarControllerRef.current = null;
    }
  }, [activeQueryKey, calendarRange, workspace.id]);

  useEffect(() => {
    if (!calendarAware) {
      calendarControllerRef.current?.abort();
      calendarControllerRef.current = null;
      setCalendarBlocks([]);
      setCalendarPhase("idle");
      setCalendarError(null);
      return;
    }
    void loadCalendarAvailability();
    return () => calendarControllerRef.current?.abort();
  }, [calendarAware, loadCalendarAvailability]);

  useEffect(() => {
    const controller = new AbortController();
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    invalidateAdvisor();
    clearAlternativePreview();
    planSnapshotKeyRef.current = null;
    setPlan(null);
    setCommandError(null);
    setFeedback(null);
    setBusyAction(null);
    shouldFocusRecentFeedbackUndoRef.current = false;
    pendingCommandsRef.current.clear();
    void loadCurrentPlan(controller.signal);
    return () => {
      controller.abort();
      advisorControllerRef.current?.abort();
      generationControllerRef.current?.abort();
      alternativeControllerRef.current?.abort();
    };
  }, [clearAlternativePreview, invalidateAdvisor, loadCurrentPlan]);

  useEffect(() => {
    planFitControllerRef.current?.abort();
    planFitHistoryControllerRef.current?.abort();
    planFitFeedbackControllerRef.current?.abort();
    setPlanFitInsight(null);
    setPlanFitLoadError(null);
    setPlanFitFeedbackError(null);
    setPlanFitFeedbackAction(null);
    setPlanFitAnnouncement(null);
    setPlanFitSelectedInsightKey(null);
    setPlanFitUsageOutcomes([]);
    setPlanFitHistoryError(null);
    setPlanFitHistoryLoading(true);
    setPlanFitFocusPending(false);
    setPlanFitTargetFocusPending(false);
    planFitFeedbackCommandsRef.current.clear();
    void loadPlanFitInsight();
    void loadPlanFitUsageOutcomes();
    return () => {
      planFitControllerRef.current?.abort();
      planFitHistoryControllerRef.current?.abort();
      planFitFeedbackControllerRef.current?.abort();
    };
  }, [loadPlanFitInsight, loadPlanFitUsageOutcomes]);

  useEffect(() => {
    if (!planFitFocusPending || planFitLoading || planFitInsight === null) return;
    planFitHeadingRef.current?.focus();
    setPlanFitFocusPending(false);
  }, [planFitFocusPending, planFitInsight, planFitLoading]);

  useEffect(() => {
    if (!planFitTargetFocusPending) return;
    targetMinutesRef.current?.focus();
    setPlanFitTargetFocusPending(false);
  }, [planFitTargetFocusPending, targetMinutes, targetTaskCount]);

  useEffect(() => {
    if (plan === null) {
      setDurationByItem({});
      return;
    }
    setDurationByItem((current) =>
      Object.fromEntries(plan.items.map((item) => [item.id, current[item.id] ?? ""])),
    );
  }, [plan]);

  useEffect(() => {
    if (
      alternativePreview !== null &&
      (plan === null ||
        alternativePreview.sourcePlanId !== plan.id ||
        alternativePreview.sourceHeadVersion !== plan.headVersion)
    ) {
      clearAlternativePreview();
    }
  }, [alternativePreview, clearAlternativePreview, plan]);

  async function refreshPlan(requestKey = activeQueryKey): Promise<boolean> {
    if (activeQueryKeyRef.current !== requestKey) return false;
    const current = await api.getCurrentPlan(workspace.id, date);
    if (activeQueryKeyRef.current !== requestKey) return false;
    acceptLoadedPlan(current);
    return true;
  }

  async function handleCommandFailure(error: unknown, requestKey: string): Promise<void> {
    if (activeQueryKeyRef.current !== requestKey) return;
    if (error instanceof ApiError && error.status === 409) {
      if (error.code === "planning.alternative_stale") clearAlternativePreview();
      const conflictMessage =
        error.code === "planning.feedback_head_conflict"
          ? "Newer planning feedback exists for this routine on another plan date. Use that newer plan to change it."
          : error.code === "planning.alternative_stale"
            ? "This plan changed. The latest plan is shown; compare again."
            : "This plan changed in another action. The latest version is now shown.";
      try {
        const refreshed = await refreshPlan(requestKey);
        if (!refreshed) return;
        setCommandError(conflictMessage);
      } catch (refreshError) {
        if (activeQueryKeyRef.current !== requestKey) return;
        if (refreshError instanceof ApiError && refreshError.status === 404) setPlan(null);
        setCommandError(
          `This plan changed, and the latest version could not be loaded. ${messageForError(refreshError)}`,
        );
      }
      return;
    }
    setCommandError(messageForError(error));
  }

  async function runCommand(
    key: string,
    operation: (requestKey: string) => Promise<void | false>,
    success: string | CommandSuccess,
    retryIdentity?: string,
  ): Promise<void> {
    const requestKey = activeQueryKey;
    invalidateAdvisor();
    setBusyAction(key);
    setCommandError(null);
    setFeedback(null);
    try {
      const completed = await operation(requestKey);
      if (completed === false) return;
      if (retryIdentity !== undefined) pendingCommandsRef.current.delete(retryIdentity);
      if (activeQueryKeyRef.current !== requestKey) return;
      setFeedback(typeof success === "string" ? { message: success } : success);
    } catch (error) {
      if (retryIdentity !== undefined && error instanceof ApiError && error.status === 409) {
        pendingCommandsRef.current.delete(retryIdentity);
      }
      await handleCommandFailure(error, requestKey);
    } finally {
      if (activeQueryKeyRef.current === requestKey) setBusyAction(null);
    }
  }

  function pendingCommand(identity: string): PendingIdempotentCommand {
    const existing = pendingCommandsRef.current.get(identity);
    if (existing !== undefined) return existing;
    const command = { key: newIdempotencyKey(), occurredAt: new Date().toISOString() };
    pendingCommandsRef.current.set(identity, command);
    return command;
  }

  function applyPlanFitSuggestion(): void {
    const insight = planFitInsight;
    if (
      insight === null ||
      insight.status !== "suggested" ||
      insight.disposition !== "available" ||
      insight.insightKey === null ||
      insight.suggestedTargetMinutes === null ||
      insight.suggestedTargetTaskCount === null
    ) {
      return;
    }
    setTargetMinutes(String(insight.suggestedTargetMinutes));
    setTargetTaskCount(String(insight.suggestedTargetTaskCount));
    setPlanFitSelectedInsightKey(insight.insightKey);
    setPlanFitAnnouncement(
      `Prefilled ${insight.suggestedTargetMinutes} minutes and ${insight.suggestedTargetTaskCount} tasks. Review both targets, then generate when you are ready.`,
    );
    setPlanFitTargetFocusPending(true);
  }

  async function mutatePlanFitFeedback(kind: "dismissed" | "reset"): Promise<void> {
    const insight = planFitInsight;
    if (
      insight === null ||
      insight.status !== "suggested" ||
      insight.insightKey === null ||
      (kind === "dismissed" && insight.disposition !== "available") ||
      (kind === "reset" && insight.disposition !== "dismissed")
    ) {
      return;
    }

    planFitFeedbackControllerRef.current?.abort();
    const controller = new AbortController();
    planFitFeedbackControllerRef.current = controller;
    const requestKey = activeQueryKey;
    const identity = `${kind}:${insight.forDate}:${insight.insightKey}`;
    const existingKey = planFitFeedbackCommandsRef.current.get(identity);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    planFitFeedbackCommandsRef.current.set(identity, idempotencyKey);
    const requestIsActive = () =>
      !controller.signal.aborted &&
      planFitFeedbackControllerRef.current === controller &&
      activeQueryKeyRef.current === requestKey;

    setPlanFitFeedbackAction(kind === "dismissed" ? "dismiss" : "restore");
    setPlanFitFeedbackError(null);
    setPlanFitAnnouncement(null);
    try {
      const input = { forDate: insight.forDate, insightKey: insight.insightKey };
      if (kind === "dismissed") {
        await api.dismissDailyPlanFitInsight(
          workspace.id,
          input,
          idempotencyKey,
          controller.signal,
        );
      } else {
        await api.resetDailyPlanFitInsightDismissal(
          workspace.id,
          input,
          idempotencyKey,
          controller.signal,
        );
      }
      if (!requestIsActive()) return;
      planFitFeedbackCommandsRef.current.delete(identity);
      if (kind === "dismissed") setPlanFitSelectedInsightKey(null);
      setPlanFitAnnouncement(
        kind === "dismissed"
          ? "This exact Plan Fit suggestion is hidden. New evidence can still produce a new suggestion."
          : "This Plan Fit suggestion is available again.",
      );
      setPlanFitFocusPending(true);
      await loadPlanFitInsight();
    } catch (error) {
      if (!requestIsActive() || isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 409) {
        planFitFeedbackCommandsRef.current.delete(identity);
        setPlanFitAnnouncement(
          "Recent resolved-plan evidence changed. The current Plan Fit result is now shown; no old suggestion was applied.",
        );
        setPlanFitFocusPending(true);
        await loadPlanFitInsight();
      } else {
        setPlanFitFeedbackError(messageForError(error));
      }
    } finally {
      if (requestIsActive()) setPlanFitFeedbackAction(null);
      if (planFitFeedbackControllerRef.current === controller) {
        planFitFeedbackControllerRef.current = null;
      }
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const minutes = Number(targetMinutes);
    const count = Number(targetTaskCount);
    const availableContexts = splitTags(contexts);
    let startsAt: string;
    let endsAt: string;
    try {
      startsAt = localDateTimeToIso(date, startTime);
      endsAt = localDateTimeToIso(date, endTime);
    } catch {
      setCommandError(
        "That planning time does not exist in your browser time zone. Choose another time.",
      );
      return;
    }

    if (!Number.isInteger(minutes) || minutes < 1) {
      setCommandError("Target minutes must be a positive whole number.");
      return;
    }
    if (!Number.isInteger(count) || count < 1) {
      setCommandError("Target tasks must be a positive whole number.");
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      setCommandError("The planning window must end after it starts.");
      return;
    }
    if (availableContexts.length > 32 || availableContexts.some((context) => context.length > 64)) {
      setCommandError("Use up to 32 contexts, with no more than 64 characters in each one.");
      return;
    }

    const outerWindow = { startsAt, endsAt };
    let availableWindows: readonly AvailabilityWindow[] = [outerWindow];
    let loadedCalendarSnapshot: string | null = null;
    if (calendarAware) {
      if (calendarPhase !== "ready" || calendarRange === null) {
        setCommandError(
          "Calendar availability is not ready. Refresh it, or turn the option off to use the range manually.",
        );
        return;
      }
      try {
        availableWindows = deriveFreeAvailability(outerWindow, calendarBlocks);
        loadedCalendarSnapshot = availabilitySnapshotKey(outerWindow, calendarBlocks);
      } catch (error) {
        setCommandError(`Calendar availability is invalid. ${messageForError(error)}`);
        return;
      }
      if (availableWindows.length === 0) {
        setCommandError(
          "Calendar blocks fill this entire planning range. Expand the range or turn the option off.",
        );
        return;
      }
    }

    const seed = [
      "today",
      workspace.id,
      date,
      startTime,
      endTime,
      calendarAware ? "calendar-aware" : "manual",
      String(minutes),
      String(count),
      fitPreference,
      energy || "any",
      ...availableContexts,
    ]
      .join(":")
      .slice(0, 240);

    generationControllerRef.current?.abort();
    const generationController = new AbortController();
    generationControllerRef.current = generationController;
    const generationIsActive = (requestKey: string) =>
      !generationController.signal.aborted &&
      generationControllerRef.current === generationController &&
      activeQueryKeyRef.current === requestKey;

    try {
      await runCommand(
        "generate",
        async (requestKey) => {
          if (loadedCalendarSnapshot !== null && calendarRange !== null) {
            let freshBlocks: readonly ScheduleBlock[];
            try {
              const freshPage = await api.listScheduleBlocks(
                workspace.id,
                calendarRange.startsAt,
                calendarRange.endsAt,
                generationController.signal,
              );
              if (!generationIsActive(requestKey)) return false;
              deriveFreeAvailability(calendarRange, freshPage.items);
              freshBlocks = freshPage.items;
            } catch (error) {
              if (!generationIsActive(requestKey) || isAbortError(error)) return false;
              const detail = `Calendar availability could not be refreshed. ${messageForError(error)}`;
              setCalendarBlocks([]);
              setCalendarPhase("error");
              setCalendarError(detail);
              throw new Error(detail, { cause: error });
            }

            const freshSnapshot = availabilitySnapshotKey(outerWindow, freshBlocks);
            setCalendarBlocks(freshBlocks);
            setCalendarPhase("ready");
            setCalendarError(null);
            if (freshSnapshot !== loadedCalendarSnapshot) {
              throw new Error(
                "Your calendar changed. Review the updated free windows, then generate again.",
              );
            }
          }
          if (!generationIsActive(requestKey)) return false;
          try {
            await api.generatePlan(workspace.id, {
              date,
              timeZone,
              availableWindows,
              targetMinutes: minutes,
              targetTaskCount: count,
              fitPreference,
              energy: energy || null,
              availableContexts,
              seed,
              requestRevision: 1,
              ...(planFitSelectedInsightKey === null
                ? {}
                : { planFitInsightKey: planFitSelectedInsightKey }),
            });
            if (!generationIsActive(requestKey)) return false;
            const current = await api.getCurrentPlan(
              workspace.id,
              date,
              generationController.signal,
            );
            if (!generationIsActive(requestKey)) return false;
            acceptLoadedPlan(current);
            setPlanFitSelectedInsightKey(null);
            await loadPlanFitUsageOutcomes();
          } catch (error) {
            if (!generationIsActive(requestKey) || isAbortError(error)) return false;
            if (
              error instanceof ApiError &&
              error.code === "daily_plan_fit_insight.evidence_conflict"
            ) {
              setPlanFitSelectedInsightKey(null);
              setPlanFitAnnouncement(
                "Resolved-plan evidence changed before generation. Review the current Plan Fit suggestion; no old selection was recorded.",
              );
              await loadPlanFitInsight();
            }
            throw error;
          }
        },
        "Today's plan is ready.",
      );
    } finally {
      if (generationControllerRef.current === generationController) {
        generationControllerRef.current = null;
      }
    }
  }

  async function setLock(item: PlanItem): Promise<void> {
    if (plan === null) return;
    const key = `lock:${item.id}`;
    const retryIdentity = `${plan.id}:${plan.headVersion}:${key}:${String(!item.locked)}`;
    const command = pendingCommand(retryIdentity);
    await runCommand(
      key,
      async (requestKey) => {
        const result = await api.setPlanItemLock(
          workspace.id,
          date,
          item.id,
          {
            expectedPlanId: plan.id,
            expectedHeadVersion: plan.headVersion,
            locked: !item.locked,
          },
          command.key,
        );
        if (activeQueryKeyRef.current !== requestKey) return;
        setPlan((current) =>
          current?.id !== result.planId
            ? current
            : {
                ...current,
                headVersion: result.headVersion,
                items: current.items.map((candidate) =>
                  candidate.id === result.itemId
                    ? { ...candidate, locked: result.locked }
                    : candidate,
                ),
              },
        );
        await loadPlanFitUsageOutcomes();
      },
      item.locked ? `${item.title} is unlocked.` : `${item.title} is locked.`,
      retryIdentity,
    );
  }

  async function recordActivity(
    item: PlanItem,
    type: ActivityCommand,
    durationMinutes: number | null = null,
  ): Promise<void> {
    if (plan === null) return;
    const key = `activity:${item.id}:${type}`;
    const success =
      type === "completion_reversed"
        ? `${item.title} is pending again.`
        : `${item.title} was marked ${type}.`;
    const retryIdentity = `${plan.id}:${plan.headVersion}:${key}:${String(durationMinutes)}`;
    const command = pendingCommand(retryIdentity);
    await runCommand(
      key,
      async (requestKey) => {
        const result = await api.recordPlanItemActivity(
          workspace.id,
          date,
          item.id,
          {
            expectedPlanId: plan.id,
            expectedHeadVersion: plan.headVersion,
            type,
            occurredAt: command.occurredAt,
            timeZone: plan.timeZone,
            durationMinutes: type === "completed" ? durationMinutes : null,
            reason: null,
            metadata: {},
          },
          command.key,
        );
        if (activeQueryKeyRef.current !== requestKey) return;
        setPlan((current) =>
          current?.id !== result.planId
            ? current
            : {
                ...current,
                headVersion: result.headVersion,
                items: current.items.map((candidate) =>
                  candidate.id === result.itemId
                    ? { ...candidate, activityState: result.activityState }
                    : candidate,
                ),
              },
        );
        await loadPlanFitUsageOutcomes();
      },
      success,
      retryIdentity,
    );
  }

  async function regenerate(): Promise<void> {
    if (plan === null) return;
    const settings = retainedSettings(plan);
    if (settings === null) {
      setCommandError("This plan does not include the settings needed to regenerate it.");
      return;
    }
    const retryIdentity = `${plan.id}:${plan.headVersion}:regenerate`;
    const command = pendingCommand(retryIdentity);
    await runCommand(
      "regenerate",
      async (requestKey) => {
        const current = await api.regeneratePlan(
          workspace.id,
          date,
          {
            expectedPlanId: plan.id,
            expectedHeadVersion: plan.headVersion,
            request: settingsWithFreshSeed(plan, settings, command.key),
          },
          command.key,
        );
        if (activeQueryKeyRef.current === requestKey) setPlan(current);
      },
      "The unlocked part of today's plan was regenerated.",
      retryIdentity,
    );
  }

  async function compareAlternatives(): Promise<void> {
    if (plan === null) return;
    const settings = retainedSettings(plan);
    if (settings === null) {
      setAlternativeError(
        "This plan does not include the settings needed to compare alternatives.",
      );
      return;
    }
    alternativeControllerRef.current?.abort();
    const controller = new AbortController();
    alternativeControllerRef.current = controller;
    const requestKey = activeQueryKey;
    const sourceSnapshot = planSnapshotKey(plan);
    const request = settingsWithFreshSeed(plan, settings, newIdempotencyKey());
    setAlternativePhase("loading");
    setAlternativePreview(null);
    setAlternativeError(null);
    try {
      const preview = await api.previewDailyPlanAlternatives(
        workspace.id,
        date,
        {
          expectedPlanId: plan.id,
          expectedHeadVersion: plan.headVersion,
          request,
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        alternativeControllerRef.current !== controller ||
        activeQueryKeyRef.current !== requestKey
      ) {
        return;
      }
      if (planSnapshotKeyRef.current !== sourceSnapshot) {
        clearAlternativePreview();
        return;
      }
      setAlternativePreview({ ...preview, request });
      setAlternativePhase("ready");
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 409) {
        clearAlternativePreview();
        await handleCommandFailure(error, requestKey);
        return;
      }
      setAlternativeError(messageForError(error));
      setAlternativePhase("idle");
    } finally {
      if (alternativeControllerRef.current === controller) {
        alternativeControllerRef.current = null;
      }
    }
  }

  async function selectAlternative(
    candidate: DailyPlanAlternative,
    alternativeNumber: number,
  ): Promise<void> {
    if (plan === null || alternativePreview === null) return;
    const sourcePlan = plan;
    const preview = alternativePreview;
    const retryIdentity = `${sourcePlan.id}:${sourcePlan.headVersion}:alternative:${candidate.candidateKey}`;
    const command = pendingCommand(retryIdentity);
    await runCommand(
      `alternative:${candidate.candidateKey}`,
      async (requestKey) => {
        const current = await api.selectDailyPlanAlternative(
          workspace.id,
          date,
          {
            expectedPlanId: sourcePlan.id,
            expectedHeadVersion: sourcePlan.headVersion,
            candidateKey: candidate.candidateKey,
            request: preview.request,
          },
          command.key,
        );
        if (activeQueryKeyRef.current !== requestKey) return false;
        acceptLoadedPlan(current);
        globalThis.setTimeout(() => planSummaryHeadingRef.current?.focus(), 0);
      },
      `Alternative ${String(alternativeNumber)} is now today's plan.`,
      retryIdentity,
    );
  }

  async function replace(item: PlanItem): Promise<void> {
    if (plan === null) return;
    const settings = retainedSettings(plan);
    if (settings === null) {
      setCommandError("This plan does not include the settings needed to replace an item.");
      return;
    }
    const key = `replace:${item.id}`;
    const retryIdentity = `${plan.id}:${plan.headVersion}:${key}`;
    const command = pendingCommand(retryIdentity);
    await runCommand(
      key,
      async (requestKey) => {
        const current = await api.replacePlanItem(
          workspace.id,
          date,
          item.id,
          {
            expectedPlanId: plan.id,
            expectedHeadVersion: plan.headVersion,
            request: settingsWithFreshSeed(plan, settings, command.key),
          },
          command.key,
        );
        if (activeQueryKeyRef.current === requestKey) setPlan(current);
      },
      `${item.title} was replaced while the rest of the plan stayed in place.`,
      retryIdentity,
    );
  }

  async function applyRoutineFeedback(
    item: PlanItem,
    kind: RoutinePlanningFeedbackSuppressionKind,
  ): Promise<void> {
    if (plan === null || item.routineId === null) return;
    const settings = retainedSettings(plan);
    if (settings === null) {
      setCommandError("This plan does not include the settings needed to apply feedback.");
      return;
    }
    const key = `routine-feedback:${item.id}:${kind}`;
    const retryIdentity = `${plan.id}:${plan.headVersion}:${key}`;
    const command = pendingCommand(retryIdentity);
    await runCommand(
      key,
      async (requestKey) => {
        const current = await api.applyRoutineFeedback(
          workspace.id,
          date,
          item.id,
          {
            expectedPlanId: plan.id,
            expectedHeadVersion: plan.headVersion,
            kind,
            request: settingsWithFreshSeed(plan, settings, command.key),
          },
          command.key,
        );
        if (activeQueryKeyRef.current === requestKey) {
          shouldFocusRecentFeedbackUndoRef.current = true;
          setPlan(current);
        }
      },
      {
        message:
          kind === "not_today"
            ? `${item.title} is hidden for today. Today's plan was recalculated.`
            : `${item.title} is hidden through this week. Today's plan was recalculated.`,
        undo: { routineId: item.routineId, title: item.title, kind },
      },
      retryIdentity,
    );
  }

  async function resetRoutineFeedback(entry: ActiveRoutineFeedback): Promise<void> {
    if (plan === null) return;
    const settings = retainedSettings(plan);
    if (settings === null) {
      setCommandError("This plan does not include the settings needed to clear feedback.");
      return;
    }
    const key = `routine-feedback-reset:${entry.routineId}`;
    const retryIdentity = `${plan.id}:${plan.headVersion}:${key}`;
    const command = pendingCommand(retryIdentity);
    await runCommand(
      key,
      async (requestKey) => {
        const current = await api.resetRoutineFeedback(
          workspace.id,
          date,
          entry.routineId,
          {
            expectedPlanId: plan.id,
            expectedHeadVersion: plan.headVersion,
            request: settingsWithFreshSeed(plan, settings, command.key),
          },
          command.key,
        );
        if (activeQueryKeyRef.current === requestKey) setPlan(current);
      },
      `Temporary feedback for ${entry.title} was cleared. Today's plan was recalculated.`,
      retryIdentity,
    );
  }

  async function askLocalAdvisor(): Promise<void> {
    if (plan === null) return;

    invalidateAdvisor();
    const requestKey = activeQueryKey;
    const requestedPlan = plan;
    const requestedSnapshotKey = planSnapshotKey(requestedPlan);
    const requestEpoch = advisorEpochRef.current;
    const controller = new AbortController();
    advisorControllerRef.current = controller;
    shouldRestoreAdvisorFocusRef.current = true;
    setAdvisorPhase("loading");

    const requestEpochIsActive = () =>
      !controller.signal.aborted &&
      advisorEpochRef.current === requestEpoch &&
      activeQueryKeyRef.current === requestKey;
    const requestSnapshotIsActive = () =>
      requestEpochIsActive() && planSnapshotKeyRef.current === requestedSnapshotKey;

    const recoverFromSnapshotConflict = async () => {
      try {
        const current = await api.getCurrentPlan(workspace.id, date, controller.signal);
        if (!requestEpochIsActive()) return;
        planSnapshotKeyRef.current = planSnapshotKey(current);
        setPlan(current);
        setAdvisorResult(null);
        setAdvisorError(
          "The plan changed while the advisor was working. Review the current plan and ask again.",
        );
      } catch {
        if (!requestEpochIsActive()) return;
        setAdvisorResult(null);
        setAdvisorError(
          "The plan changed while the advisor was working, and the current plan could not be refreshed. Refresh Today before asking again.",
        );
      }
    };

    try {
      const result = await api.getSchedulingAdvice(
        workspace.id,
        {
          date,
          expectedPlanId: requestedPlan.id,
          expectedHeadVersion: requestedPlan.headVersion,
        },
        controller.signal,
      );
      if (!requestSnapshotIsActive()) return;
      if (
        result.snapshot.date !== date ||
        result.snapshot.planId !== requestedPlan.id ||
        result.snapshot.headVersion !== requestedPlan.headVersion
      ) {
        await recoverFromSnapshotConflict();
        return;
      }
      setAdvisorError(null);
      setAdvisorResult(result);
    } catch (error) {
      if (!requestEpochIsActive()) return;
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "advisor.snapshot_conflict"
      ) {
        await recoverFromSnapshotConflict();
      } else {
        setAdvisorResult(null);
        setAdvisorError("Local advice could not be loaded. Your plan was not changed.");
      }
    } finally {
      if (
        advisorEpochRef.current === requestEpoch &&
        activeQueryKeyRef.current === requestKey &&
        advisorControllerRef.current === controller
      ) {
        advisorControllerRef.current = null;
        setAdvisorPhase("idle");
      }
    }
  }

  const sortedItems = useMemo(
    () => plan?.items.slice().sort((left, right) => left.position - right.position) ?? [],
    [plan],
  );
  const activeRoutineFeedback = useMemo(
    () =>
      plan?.exclusions
        .map(activeFeedbackFromExclusion)
        .filter((entry): entry is ActiveRoutineFeedback => entry !== null) ?? [],
    [plan],
  );
  const ordinaryExclusions = useMemo(
    () =>
      plan?.exclusions.filter((exclusion) => feedbackKindForExclusion(exclusion) === null) ?? [],
    [plan],
  );
  const commandInProgress = busyAction !== null;
  const calendarGenerationBlocked =
    calendarAware &&
    (calendarPhase !== "ready" || planningWindow === null || calendarFreeWindows.length === 0);

  useEffect(() => {
    if (
      !shouldFocusRecentFeedbackUndoRef.current ||
      feedback?.undo === undefined ||
      commandInProgress
    ) {
      return;
    }

    const undo = recentFeedbackRef.current?.querySelector<HTMLButtonElement>(
      "[data-recent-feedback-undo]",
    );
    if (undo === undefined || undo === null || undo.disabled) return;

    shouldFocusRecentFeedbackUndoRef.current = false;
    undo.focus();
  }, [commandInProgress, feedback]);

  useEffect(() => {
    if (advisorPhase === "loading" || !shouldRestoreAdvisorFocusRef.current) return;
    const trigger = todayViewRef.current?.querySelector<HTMLButtonElement>(
      "[data-local-advisor-trigger]",
    );
    if (trigger === undefined || trigger === null || trigger.disabled) return;
    shouldRestoreAdvisorFocusRef.current = false;
    trigger.focus();
  }, [advisorError, advisorPhase, advisorResult]);

  return (
    <section ref={todayViewRef} className="today-view" aria-label="Today">
      <PageHeader
        eyebrow={dayLabel}
        title="Today"
        description="Build a realistic plan from routines and selected work, then adjust it without losing control."
        actions={
          plan === null ? undefined : (
            <>
              <Button
                type="button"
                variant="quiet"
                busy={advisorPhase === "loading"}
                disabled={commandInProgress || advisorPhase === "loading"}
                aria-controls="today-advisor"
                aria-describedby="today-advisor-safety"
                data-local-advisor-trigger
                onClick={() => void askLocalAdvisor()}
              >
                <MessageSquareText size={15} aria-hidden="true" />
                Ask local advisor
              </Button>
              <Button
                type="button"
                variant="quiet"
                busy={alternativePhase === "loading"}
                disabled={commandInProgress || plan.request === null}
                aria-expanded={alternativePreview !== null}
                aria-controls="today-plan-alternatives"
                onClick={() => void compareAlternatives()}
              >
                <GitCompareArrows size={15} aria-hidden="true" />
                Compare alternatives
              </Button>
              <Button
                type="button"
                busy={busyAction === "regenerate"}
                disabled={commandInProgress || plan.request === null}
                onClick={() => void regenerate()}
              >
                <RefreshCw size={15} aria-hidden="true" />
                Regenerate unlocked
              </Button>
            </>
          )
        }
      />

      {commandError === null ? null : (
        <ErrorNotice message={commandError} onDismiss={() => setCommandError(null)} />
      )}
      {feedback === null ? null : (
        <div ref={recentFeedbackRef} className="today-feedback" role="status" aria-live="polite">
          <span>{feedback.message}</span>
          {feedback.undo === undefined ? null : (
            <Button
              type="button"
              variant="quiet"
              disabled={commandInProgress || plan?.request === null}
              data-recent-feedback-undo
              aria-label={`Undo recent feedback for ${feedback.undo.title}`}
              onClick={() => void resetRoutineFeedback(feedback.undo!)}
            >
              <RotateCcw size={15} aria-hidden="true" />
              Undo
            </Button>
          )}
        </div>
      )}

      {loading ? <PageSkeleton rows={5} /> : null}

      {!loading && loadError !== null ? (
        <div className="today-load-error">
          <ErrorNotice
            message={loadError}
            action={
              <Button type="button" variant="quiet" onClick={() => void loadCurrentPlan()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : null}

      {!loading && loadError === null && plan === null ? (
        <section className="today-plan-setup" aria-labelledby="today-plan-setup-heading">
          <div className="today-section-heading">
            <p className="eyebrow">First plan</p>
            <h2 id="today-plan-setup-heading">Shape the time you have</h2>
            <p>
              Start with an outer availability range. The planner will balance duration, task count,
              cadence, and recent activity.
            </p>
          </div>

          <form className="today-planning-form" onSubmit={(event) => void generate(event)}>
            <fieldset className="today-form-group">
              <legend>Availability</legend>
              <div className="today-form-row">
                <Field label="Starts">
                  <input
                    type="time"
                    required
                    value={startTime}
                    disabled={commandInProgress}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                </Field>
                <Field label="Ends">
                  <input
                    type="time"
                    required
                    value={endTime}
                    disabled={commandInProgress}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                </Field>
              </div>
              <CalendarAvailabilityControl
                enabled={calendarAware}
                phase={calendarPhase}
                error={calendarError}
                windowIsValid={planningWindow !== null}
                freeWindows={calendarFreeWindows}
                intersectingBlockCount={intersectingCalendarBlockCount}
                disabled={commandInProgress}
                onEnabledChange={setCalendarAware}
                onRefresh={() => void loadCalendarAvailability()}
              />
            </fieldset>

            <DailyPlanFitPanel
              insight={planFitInsight}
              loading={planFitLoading}
              loadError={planFitLoadError}
              feedbackError={planFitFeedbackError}
              feedbackAction={planFitFeedbackAction}
              announcement={planFitAnnouncement}
              headingRef={planFitHeadingRef}
              onRetry={() => void loadPlanFitInsight()}
              onApply={applyPlanFitSuggestion}
              onDismiss={() => void mutatePlanFitFeedback("dismissed")}
              onRestore={() => void mutatePlanFitFeedback("reset")}
              selectionActive={
                planFitInsight?.insightKey !== null &&
                planFitInsight?.insightKey === planFitSelectedInsightKey
              }
              outcomes={planFitUsageOutcomes}
              historyLoading={planFitHistoryLoading}
              historyError={planFitHistoryError}
              onHistoryRetry={() => void loadPlanFitUsageOutcomes()}
            />

            <fieldset className="today-form-group">
              <legend>Plan targets</legend>
              <div className="today-form-row">
                <Field label="Target minutes" hint="Total focused time for this plan.">
                  <input
                    ref={targetMinutesRef}
                    type="number"
                    required
                    min={1}
                    max={43_200}
                    step={1}
                    inputMode="numeric"
                    value={targetMinutes}
                    disabled={commandInProgress}
                    onChange={(event) => setTargetMinutes(event.target.value)}
                  />
                </Field>
                <Field label="Target tasks" hint="A preference, not a quota.">
                  <input
                    type="number"
                    required
                    min={1}
                    max={512}
                    step={1}
                    inputMode="numeric"
                    value={targetTaskCount}
                    disabled={commandInProgress}
                    onChange={(event) => setTargetTaskCount(event.target.value)}
                  />
                </Field>
              </div>
              <div className="today-form-row">
                <Field label="Fit preference">
                  <select
                    value={fitPreference}
                    disabled={commandInProgress}
                    onChange={(event) =>
                      setFitPreference(event.target.value as PlanningFitPreference)
                    }
                  >
                    <option value="balanced">Balance time and tasks</option>
                    <option value="time">Prioritize time fit</option>
                    <option value="task_count">Prioritize task count</option>
                  </select>
                </Field>
                <Field label="Energy">
                  <select
                    value={energy}
                    disabled={commandInProgress}
                    onChange={(event) => setEnergy(event.target.value as EnergyLevel | "")}
                  >
                    <option value="">Any energy level</option>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </Field>
              </div>
              <Field label="Available contexts" hint="Comma-separated, for example home, computer.">
                <input
                  value={contexts}
                  maxLength={2_079}
                  disabled={commandInProgress}
                  placeholder="home, computer"
                  onChange={(event) => setContexts(event.target.value)}
                />
              </Field>
            </fieldset>

            <div className="today-form-actions">
              <Button
                type="submit"
                variant="primary"
                busy={busyAction === "generate"}
                disabled={commandInProgress || calendarGenerationBlocked}
              >
                Generate today's plan
              </Button>
              <span>{timeZone}</span>
            </div>
          </form>
        </section>
      ) : null}

      {!loading && loadError === null && plan !== null ? (
        <div className="today-plan">
          <section className="today-plan-summary" aria-labelledby="today-plan-summary-heading">
            <div>
              <p className="eyebrow">Plan revision {plan.requestRevision}</p>
              <h2 ref={planSummaryHeadingRef} id="today-plan-summary-heading" tabIndex={-1}>
                {formatMinutes(plan.totalMinutes)} across {plan.items.length}{" "}
                {plan.items.length === 1 ? "item" : "items"}
              </h2>
            </div>
            <dl className="today-summary-facts">
              <div>
                <dt>Target</dt>
                <dd>
                  {plan.request === null
                    ? "Not available"
                    : formatMinutes(plan.request.targetMinutes)}
                </dd>
              </div>
              <div>
                <dt>Fit</dt>
                <dd>
                  {plan.request === null
                    ? "Not available"
                    : displayCode(plan.request.fitPreference)}
                </dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>{plan.timeZone}</dd>
              </div>
            </dl>
          </section>

          {alternativeError === null ? null : (
            <div className="today-alternative-error">
              <ErrorNotice
                message={alternativeError}
                onDismiss={() => setAlternativeError(null)}
                action={
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={commandInProgress}
                    onClick={() => void compareAlternatives()}
                  >
                    Retry comparison
                  </Button>
                }
              />
            </div>
          )}

          {alternativePhase === "loading" ? (
            <section
              id="today-plan-alternatives"
              className="today-alternatives"
              aria-labelledby="today-alternatives-heading"
              aria-busy="true"
              role="status"
            >
              <div className="today-section-heading">
                <p className="eyebrow">Plan comparison</p>
                <h2 id="today-alternatives-heading">Finding distinct options…</h2>
              </div>
            </section>
          ) : null}

          {alternativePreview === null ? null : (
            <section
              id="today-plan-alternatives"
              className="today-alternatives"
              aria-labelledby="today-alternatives-heading"
            >
              <div className="today-section-heading">
                <p className="eyebrow">Plan comparison</p>
                <h2 id="today-alternatives-heading">Compare before changing Today</h2>
                <p>Nothing changes until you explicitly choose an alternative.</p>
              </div>
              {alternativePreview.alternatives.length === 0 ? (
                <p className="today-alternatives-empty" role="status">
                  No distinct alternative fits the current limits. Your plan is unchanged.
                </p>
              ) : (
                <ul className="today-alternative-grid">
                  <li>
                    <article className="today-alternative-card today-alternative-current">
                      <div>
                        <p className="eyebrow">Current plan</p>
                        <h3>
                          {formatMinutes(plan.totalMinutes)} · {plan.items.length}{" "}
                          {plan.items.length === 1 ? "item" : "items"}
                        </h3>
                      </div>
                      <ol>
                        {sortedItems.map((item) => (
                          <li key={item.id}>{item.title}</li>
                        ))}
                      </ol>
                    </article>
                  </li>
                  {alternativePreview.alternatives.map((candidate, index) => {
                    const number = index + 1;
                    const selectKey = `alternative:${candidate.candidateKey}`;
                    return (
                      <li key={candidate.candidateKey}>
                        <article className="today-alternative-card">
                          <div>
                            <p className="eyebrow">Alternative {number}</p>
                            <h3>
                              {formatMinutes(candidate.totalMinutes)} · {candidate.taskCount}{" "}
                              {candidate.taskCount === 1 ? "item" : "items"}
                            </h3>
                            <p className="today-alternative-delta">
                              {candidate.deltaMinutes === 0
                                ? "Same total time"
                                : `${candidate.deltaMinutes > 0 ? "+" : "−"}${formatMinutes(Math.abs(candidate.deltaMinutes))}`}
                              {" · "}
                              {candidate.deltaTaskCount === 0
                                ? "same item count"
                                : `${candidate.deltaTaskCount > 0 ? "+" : "−"}${String(Math.abs(candidate.deltaTaskCount))} ${Math.abs(candidate.deltaTaskCount) === 1 ? "item" : "items"}`}
                            </p>
                          </div>
                          <ol>
                            {candidate.items.map((item) => (
                              <li key={`${item.sourceType}:${item.routineId ?? item.workItemId}`}>
                                {item.title} · {formatMinutes(item.scheduledMinutes)}
                              </li>
                            ))}
                          </ol>
                          <Button
                            type="button"
                            variant="primary"
                            aria-label={`Use alternative ${String(number)} as today's plan`}
                            busy={busyAction === selectKey}
                            disabled={commandInProgress}
                            onClick={() => void selectAlternative(candidate, number)}
                          >
                            Use this plan
                          </Button>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          <SchedulingAdvisorPanel
            phase={advisorPhase}
            result={advisorResult}
            error={advisorError}
          />

          {plan.warnings.length === 0 ? null : (
            <section className="today-warnings" aria-labelledby="today-warnings-heading">
              <h2 id="today-warnings-heading">Plan notes</h2>
              <ul>
                {plan.warnings.map((warning, index) => (
                  <li key={`${warning}:${index}`}>{displayCode(warning)}</li>
                ))}
              </ul>
            </section>
          )}

          {activeRoutineFeedback.length === 0 ? null : (
            <section
              className="today-temporary-feedback"
              aria-labelledby="today-temporary-feedback-heading"
            >
              <div>
                <h2 id="today-temporary-feedback-heading">Temporarily hidden</h2>
                <p>These instructions expire automatically and do not change routine cadence.</p>
              </div>
              <ul>
                {activeRoutineFeedback.map((entry) => {
                  const resetKey = `routine-feedback-reset:${entry.routineId}`;
                  return (
                    <li key={entry.routineId}>
                      <div>
                        <strong>{entry.title}</strong>
                        <span>{feedbackTimeframe(entry.kind)}</span>
                      </div>
                      <Button
                        type="button"
                        variant="quiet"
                        busy={busyAction === resetKey}
                        disabled={commandInProgress || plan.request === null}
                        aria-label={`Undo temporary feedback for ${entry.title}`}
                        onClick={() => void resetRoutineFeedback(entry)}
                      >
                        <RotateCcw size={15} aria-hidden="true" />
                        Undo
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {sortedItems.length === 0 ? (
            <EmptyState
              title="No eligible items fit this plan"
              action={
                <Button type="button" variant="primary" onClick={() => onNavigate("routines")}>
                  Go to routines
                </Button>
              }
            >
              Add or activate a routine, opt a work item into Today, or adjust its planning rules,
              then regenerate this plan.
            </EmptyState>
          ) : (
            <ol className="today-plan-items" aria-label="Today's planned items">
              {sortedItems.map((item) => {
                const window = plan.request?.availableWindows[item.windowIndex];
                const lockKey = `lock:${item.id}`;
                const replaceKey = `replace:${item.id}`;
                const canGiveRoutineFeedback =
                  item.sourceType === "routine" &&
                  item.routineId !== null &&
                  item.activityState === "pending" &&
                  !item.locked;
                return (
                  <li className="today-plan-item" key={item.id}>
                    <article aria-labelledby={`today-item-${item.id}`}>
                      <header className="today-item-header">
                        <div>
                          <span
                            className="today-item-position"
                            aria-label={`Item ${item.position + 1}`}
                          >
                            {item.position + 1}
                          </span>
                          <div>
                            <h3 id={`today-item-${item.id}`}>{item.title}</h3>
                            <p className="today-item-meta">
                              <span
                                className={`today-item-source today-item-source-${item.sourceType}`}
                              >
                                {sourceLabel(item)}
                              </span>
                              <Clock3 size={14} aria-hidden="true" />
                              {formatMinutes(item.scheduledMinutes)}
                              {window === undefined
                                ? ` in window ${item.windowIndex + 1}`
                                : ` within ${formatTime(window.startsAt)} to ${formatTime(window.endsAt)}`}
                              {item.partialSession ? " as a partial session" : ""}
                            </p>
                          </div>
                        </div>
                        <span
                          className={`today-state today-state-${item.activityState}`}
                          aria-label={`Status: ${stateLabel(item.activityState)}`}
                        >
                          {stateLabel(item.activityState)}
                        </span>
                      </header>

                      {item.reasons.length === 0 ? null : (
                        <div className="today-item-reasons">
                          <h4>Why this was selected</h4>
                          <ul>
                            {item.reasons.map((reason, index) => (
                              <li key={`${reason}:${index}`}>{reason}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="today-item-controls">
                        <div className="today-item-plan-controls">
                          <Button
                            type="button"
                            variant="quiet"
                            busy={busyAction === lockKey}
                            disabled={commandInProgress}
                            aria-pressed={item.locked}
                            onClick={() => void setLock(item)}
                          >
                            {item.locked ? (
                              <Unlock size={15} aria-hidden="true" />
                            ) : (
                              <Lock size={15} aria-hidden="true" />
                            )}
                            {item.locked ? "Unlock" : "Lock"}
                          </Button>
                          {item.activityState === "pending" ? (
                            <Button
                              type="button"
                              variant="quiet"
                              busy={busyAction === replaceKey}
                              disabled={commandInProgress || item.locked || plan.request === null}
                              onClick={() => void replace(item)}
                            >
                              <Shuffle size={15} aria-hidden="true" />
                              Replace
                            </Button>
                          ) : null}
                          {canGiveRoutineFeedback ? (
                            <div
                              className="today-routine-feedback-controls"
                              role="group"
                              aria-label={`Planning feedback for ${item.title}`}
                            >
                              <span aria-hidden="true">Hide from planner</span>
                              {(["not_today", "not_this_week"] as const).map((kind) => {
                                const feedbackKey = `routine-feedback:${item.id}:${kind}`;
                                return (
                                  <Button
                                    key={kind}
                                    type="button"
                                    variant="quiet"
                                    busy={busyAction === feedbackKey}
                                    disabled={commandInProgress || plan.request === null}
                                    onClick={() => void applyRoutineFeedback(item, kind)}
                                  >
                                    {kind === "not_today" ? "Not today" : "Not this week"}
                                  </Button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>

                        <PlanItemActions
                          item={item}
                          busyAction={busyAction}
                          durationValue={durationByItem[item.id] ?? ""}
                          onDurationChange={(value) =>
                            setDurationByItem((current) => ({ ...current, [item.id]: value }))
                          }
                          onActivity={(type, durationMinutes) =>
                            void recordActivity(item, type, durationMinutes)
                          }
                        />
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>
          )}

          {ordinaryExclusions.length === 0 ? null : (
            <details className="today-exclusions">
              <summary>
                Why {ordinaryExclusions.length} other{" "}
                {ordinaryExclusions.length === 1 ? "item was" : "items were"} excluded
              </summary>
              <ul>
                {ordinaryExclusions.map((exclusion) => (
                  <li key={sourceKey(exclusion)}>
                    <strong>{exclusion.title}</strong>
                    <span>{exclusion.codes.map(displayCode).join(", ")}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <footer className="today-plan-footer">
            <span>
              Generated with {plan.algorithmVersion}, head {plan.headVersion}
            </span>
            <Button
              type="button"
              variant="quiet"
              disabled={commandInProgress}
              onClick={() => void loadCurrentPlan()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              Refresh
            </Button>
          </footer>
        </div>
      ) : null}
    </section>
  );
}
