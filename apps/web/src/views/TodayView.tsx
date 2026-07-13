import { Check, Clock3, Lock, Play, RefreshCw, RotateCcw, Shuffle, Unlock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { api, ApiError, newIdempotencyKey } from "../api";
import { Button, EmptyState, ErrorNotice, Field, PageHeader, PageSkeleton } from "../components/ui";
import {
  browserTimeZone,
  formatDay,
  formatMinutes,
  formatTime,
  localDateTimeToIso,
  splitTags,
  todayKey,
} from "../date";
import type {
  CurrentDailyPlan,
  EnergyLevel,
  PlanExclusion,
  PlanItem,
  PlanItemActivityState,
  PlanSettings,
  PlanningFitPreference,
  RoutinePlanningFeedbackSuppressionKind,
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

function planQueryKey(workspaceId: string, date: string): string {
  return JSON.stringify([workspaceId, date]);
}

function messageForError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The local API could not complete this request.";
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
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [targetMinutes, setTargetMinutes] = useState("180");
  const [targetTaskCount, setTargetTaskCount] = useState("4");
  const [fitPreference, setFitPreference] = useState<PlanningFitPreference>("balanced");
  const [energy, setEnergy] = useState<EnergyLevel | "">("");
  const [contexts, setContexts] = useState("");
  const [durationByItem, setDurationByItem] = useState<Readonly<Record<string, string>>>({});
  const pendingCommandsRef = useRef(new Map<string, PendingIdempotentCommand>());
  const recentFeedbackRef = useRef<HTMLDivElement>(null);
  const shouldFocusRecentFeedbackUndoRef = useRef(false);
  const activeQueryKey = planQueryKey(workspace.id, date);
  const activeQueryKeyRef = useRef(activeQueryKey);
  activeQueryKeyRef.current = activeQueryKey;

  const dayLabel = useMemo(
    () =>
      formatDay(new Date(`${date}T12:00:00`), {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    [date],
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
        if (requestIsActive()) setPlan(current);
      } catch (error) {
        if (!requestIsActive()) return;
        if (error instanceof ApiError && error.status === 404) {
          setPlan(null);
        } else {
          setLoadError(messageForError(error));
        }
      } finally {
        if (requestIsActive()) setLoading(false);
      }
    },
    [date, workspace.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setPlan(null);
    setCommandError(null);
    setFeedback(null);
    setBusyAction(null);
    shouldFocusRecentFeedbackUndoRef.current = false;
    pendingCommandsRef.current.clear();
    void loadCurrentPlan(controller.signal);
    return () => controller.abort();
  }, [loadCurrentPlan]);

  useEffect(() => {
    if (plan === null) {
      setDurationByItem({});
      return;
    }
    setDurationByItem((current) =>
      Object.fromEntries(plan.items.map((item) => [item.id, current[item.id] ?? ""])),
    );
  }, [plan]);

  async function refreshPlan(requestKey = activeQueryKey): Promise<boolean> {
    if (activeQueryKeyRef.current !== requestKey) return false;
    const current = await api.getCurrentPlan(workspace.id, date);
    if (activeQueryKeyRef.current !== requestKey) return false;
    setPlan(current);
    return true;
  }

  async function handleCommandFailure(error: unknown, requestKey: string): Promise<void> {
    if (activeQueryKeyRef.current !== requestKey) return;
    if (error instanceof ApiError && error.status === 409) {
      const conflictMessage =
        error.code === "planning.feedback_head_conflict"
          ? "Newer planning feedback exists for this routine on another plan date. Use that newer plan to change it."
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
    operation: (requestKey: string) => Promise<void>,
    success: string | CommandSuccess,
    retryIdentity?: string,
  ): Promise<void> {
    const requestKey = activeQueryKey;
    setBusyAction(key);
    setCommandError(null);
    setFeedback(null);
    try {
      await operation(requestKey);
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

    const seed = [
      "today",
      workspace.id,
      date,
      startTime,
      endTime,
      String(minutes),
      String(count),
      fitPreference,
      energy || "any",
      ...availableContexts,
    ]
      .join(":")
      .slice(0, 240);

    await runCommand(
      "generate",
      async (requestKey) => {
        await api.generatePlan(workspace.id, {
          date,
          timeZone,
          availableWindows: [{ startsAt, endsAt }],
          targetMinutes: minutes,
          targetTaskCount: count,
          fitPreference,
          energy: energy || null,
          availableContexts,
          seed,
          requestRevision: 1,
        });
        await refreshPlan(requestKey);
      },
      "Today's plan is ready.",
    );
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

  return (
    <section className="today-view" aria-label="Today">
      <PageHeader
        eyebrow={dayLabel}
        title="Today"
        description="Build a realistic plan from routines and selected work, then adjust it without losing control."
        actions={
          plan === null ? undefined : (
            <Button
              type="button"
              busy={busyAction === "regenerate"}
              disabled={commandInProgress || plan.request === null}
              onClick={() => void regenerate()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              Regenerate unlocked
            </Button>
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
              Start with one availability window. The planner will balance duration, task count,
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
            </fieldset>

            <fieldset className="today-form-group">
              <legend>Plan targets</legend>
              <div className="today-form-row">
                <Field label="Target minutes" hint="Total focused time for this plan.">
                  <input
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
              <Button type="submit" variant="primary" busy={busyAction === "generate"}>
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
              <h2 id="today-plan-summary-heading">
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
