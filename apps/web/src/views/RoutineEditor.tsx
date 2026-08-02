import { Field } from "../components/ui";
import { splitTags } from "../date";
import type {
  CadencePeriod,
  EffortLevel,
  EnergyLevel,
  PreferenceLevel,
  Routine,
  RoutineGroup,
  RoutinePriority,
  RoutineStatus,
} from "../types";

export type ConsecutivePolicy = "allow" | "discourage" | "prohibit";

export interface RoutineDraft {
  title: string;
  description: string;
  priority: RoutinePriority;
  effort: EffortLevel;
  energy: EnergyLevel;
  preference: PreferenceLevel;
  contexts: string;
  categories: string;
  freeForm: string;
  minimumMinutes: string;
  expectedMinutes: string;
  maximumMinutes: string;
  splittable: boolean;
  minimumSessionMinutes: string;
  overheadMinutes: string;
  period: CadencePeriod;
  rollingIntervalDays: string;
  targetCompletions: string;
  minimumCompletions: string;
  maximumCompletions: string;
  minimumSpacingDays: string;
  consecutivePolicy: ConsecutivePolicy;
  preferredWeekdays: readonly number[];
  excludedWeekdays: readonly number[];
  weekStartsOn: number;
  startsOn: string | null;
  pausedUntil: string | null;
  endsOn: string | null;
}

export type RoutinePayload = Omit<
  Routine,
  "id" | "workspaceId" | "version" | "createdAt" | "updatedAt"
>;

const priorities: readonly RoutinePriority[] = ["low", "medium", "high", "critical"];
const efforts: readonly EffortLevel[] = ["quick", "short", "medium", "deep"];
const energies: readonly EnergyLevel[] = ["low", "normal", "high"];
const preferences: readonly PreferenceLevel[] = ["enjoyable", "neutral", "unpleasant"];
const periods: readonly { readonly id: CadencePeriod; readonly label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "rolling_days", label: "Rolling days" },
];
const weekdays = [
  { id: 1, label: "Mon" },
  { id: 2, label: "Tue" },
  { id: 3, label: "Wed" },
  { id: 4, label: "Thu" },
  { id: 5, label: "Fri" },
  { id: 6, label: "Sat" },
  { id: 0, label: "Sun" },
] as const;

const titleCase = (value: string) =>
  value
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

export function createRoutineDraft(): RoutineDraft {
  return {
    title: "",
    description: "",
    priority: "medium",
    effort: "medium",
    energy: "normal",
    preference: "neutral",
    contexts: "",
    categories: "",
    freeForm: "",
    minimumMinutes: "15",
    expectedMinutes: "30",
    maximumMinutes: "60",
    splittable: false,
    minimumSessionMinutes: "15",
    overheadMinutes: "0",
    period: "week",
    rollingIntervalDays: "7",
    targetCompletions: "3",
    minimumCompletions: "",
    maximumCompletions: "",
    minimumSpacingDays: "1",
    consecutivePolicy: "discourage",
    preferredWeekdays: [],
    excludedWeekdays: [],
    weekStartsOn: 1,
    startsOn: null,
    pausedUntil: null,
    endsOn: null,
  };
}

export function routineDraftFromRoutine(
  routine: Pick<Routine, "title" | "description" | "tags" | "duration" | "cadence">,
): RoutineDraft {
  return {
    title: routine.title,
    description: routine.description ?? "",
    priority: routine.tags.priority,
    effort: routine.tags.effort,
    energy: routine.tags.energy,
    preference: routine.tags.preference,
    contexts: routine.tags.contexts.join(", "),
    categories: routine.tags.categories.join(", "),
    freeForm: routine.tags.freeForm.join(", "),
    minimumMinutes: String(routine.duration.minimumMinutes),
    expectedMinutes: String(routine.duration.expectedMinutes),
    maximumMinutes: String(routine.duration.maximumMinutes),
    splittable: routine.duration.splittable,
    minimumSessionMinutes: String(
      routine.duration.minimumSessionMinutes ?? routine.duration.minimumMinutes,
    ),
    overheadMinutes: String(routine.duration.overheadMinutes),
    period: routine.cadence.period,
    rollingIntervalDays: String(routine.cadence.rollingIntervalDays ?? 7),
    targetCompletions: String(routine.cadence.targetCompletions),
    minimumCompletions:
      routine.cadence.minimumCompletions === null ? "" : String(routine.cadence.minimumCompletions),
    maximumCompletions:
      routine.cadence.maximumCompletions === null ? "" : String(routine.cadence.maximumCompletions),
    minimumSpacingDays: String(routine.cadence.minimumSpacingDays),
    consecutivePolicy: routine.cadence.prohibitConsecutiveDays
      ? "prohibit"
      : routine.cadence.discourageConsecutiveDays
        ? "discourage"
        : "allow",
    preferredWeekdays: routine.cadence.preferredWeekdays,
    excludedWeekdays: routine.cadence.excludedWeekdays,
    weekStartsOn: routine.cadence.weekStartsOn,
    startsOn: routine.cadence.startsOn,
    pausedUntil: routine.cadence.pausedUntil,
    endsOn: routine.cadence.endsOn,
  };
}

function integer(value: string, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return parsed;
}
function optionalInteger(value: string, label: string, min: number, max: number): number | null {
  return value.trim() === "" ? null : integer(value, label, min, max);
}
function tags(value: string, label: string): string[] {
  const result = splitTags(value);
  if (result.length > 32 || result.some((item) => item.length > 64))
    throw new Error(`${label} must contain at most 32 values of 64 characters or fewer.`);
  return result;
}

export function parseRoutineDraft(
  draft: RoutineDraft,
  status: RoutineStatus,
): { readonly payload: RoutinePayload | null; readonly error: string | null } {
  try {
    const title = draft.title.trim();
    if (!title) throw new Error("Give the routine a title.");
    if (title.length > 240) throw new Error("The title must be 240 characters or fewer.");
    if (draft.description.length > 4_000)
      throw new Error("The description must be 4,000 characters or fewer.");
    const minimumMinutes = integer(draft.minimumMinutes, "Minimum duration", 1, 43_200);
    const expectedMinutes = integer(draft.expectedMinutes, "Expected duration", 1, 43_200);
    const maximumMinutes = integer(draft.maximumMinutes, "Maximum duration", 1, 43_200);
    if (minimumMinutes > expectedMinutes || expectedMinutes > maximumMinutes)
      throw new Error("Duration must follow minimum, expected, then maximum.");
    const targetCompletions = integer(draft.targetCompletions, "Cadence target", 1, 10_000);
    const minimumCompletions = optionalInteger(
      draft.minimumCompletions,
      "Cadence minimum",
      1,
      10_000,
    );
    const maximumCompletions = optionalInteger(
      draft.maximumCompletions,
      "Cadence maximum",
      1,
      10_000,
    );
    if (minimumCompletions !== null && minimumCompletions > targetCompletions)
      throw new Error("Cadence minimum cannot be greater than its target.");
    if (maximumCompletions !== null && maximumCompletions < targetCompletions)
      throw new Error("Cadence maximum cannot be less than its target.");
    return {
      payload: {
        title,
        description: draft.description.trim() || null,
        status,
        tags: {
          priority: draft.priority,
          effort: draft.effort,
          energy: draft.energy,
          preference: draft.preference,
          contexts: tags(draft.contexts, "Contexts"),
          categories: tags(draft.categories, "Categories"),
          freeForm: tags(draft.freeForm, "Free-form tags"),
        },
        duration: {
          minimumMinutes,
          expectedMinutes,
          maximumMinutes,
          splittable: draft.splittable,
          minimumSessionMinutes: draft.splittable
            ? integer(draft.minimumSessionMinutes, "Minimum session", 1, minimumMinutes)
            : null,
          overheadMinutes: integer(draft.overheadMinutes, "Setup time", 0, 1_440),
        },
        cadence: {
          period: draft.period,
          rollingIntervalDays:
            draft.period === "rolling_days"
              ? integer(draft.rollingIntervalDays, "Rolling window", 1, 3_650)
              : null,
          targetCompletions,
          minimumCompletions,
          maximumCompletions,
          minimumSpacingDays: integer(draft.minimumSpacingDays, "Minimum spacing", 0, 3_650),
          preferredWeekdays: draft.preferredWeekdays,
          excludedWeekdays: draft.excludedWeekdays,
          discourageConsecutiveDays: draft.consecutivePolicy !== "allow",
          prohibitConsecutiveDays: draft.consecutivePolicy === "prohibit",
          weekStartsOn: draft.weekStartsOn,
          startsOn: draft.startsOn,
          pausedUntil: draft.pausedUntil,
          endsOn: draft.endsOn,
        },
      },
      error: null,
    };
  } catch (error) {
    return {
      payload: null,
      error: error instanceof Error ? error.message : "Check the routine fields and try again.",
    };
  }
}

export function RoutineFields({
  draft,
  onChange,
  disabled = false,
  autoFocus = false,
  status,
  onStatusChange,
  groups,
  selectedGroupIds = [],
  onSelectedGroupIdsChange,
}: {
  readonly draft: RoutineDraft;
  readonly onChange: (changes: Partial<RoutineDraft>) => void;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly status?: RoutineStatus;
  readonly onStatusChange?: (status: RoutineStatus) => void;
  readonly groups?: readonly RoutineGroup[];
  readonly selectedGroupIds?: readonly string[];
  readonly onSelectedGroupIdsChange?: (groupIds: readonly string[]) => void;
}) {
  const toggleWeekday = (kind: "preferred" | "excluded", weekday: number) => {
    const selected = kind === "preferred" ? draft.preferredWeekdays : draft.excludedWeekdays;
    const next = selected.includes(weekday)
      ? selected.filter((candidate) => candidate !== weekday)
      : [...selected, weekday].sort((a, b) => a - b);
    onChange(
      kind === "preferred"
        ? {
            preferredWeekdays: next,
            excludedWeekdays: draft.excludedWeekdays.filter((candidate) => candidate !== weekday),
          }
        : {
            excludedWeekdays: next,
            preferredWeekdays: draft.preferredWeekdays.filter((candidate) => candidate !== weekday),
          },
    );
  };
  return (
    <>
      {status === undefined || onStatusChange === undefined ? null : (
        <section className="routines-form-section">
          <Field label="Status">
            <select
              disabled={disabled}
              value={status}
              onChange={(event) => onStatusChange(event.target.value as RoutineStatus)}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
            </select>
          </Field>
        </section>
      )}
      <section className="routines-form-section" aria-labelledby="routine-basics-heading">
        <div className="routines-section-heading">
          <h3 id="routine-basics-heading">Basics</h3>
          <p>Name the activity and add enough context to recognize it later.</p>
        </div>
        <div className="routines-form-grid routines-form-grid-basics">
          <Field label="Title" className="routines-field-wide">
            <input
              autoFocus={autoFocus}
              required
              maxLength={240}
              disabled={disabled}
              value={draft.title}
              onChange={(event) => onChange({ title: event.target.value })}
              placeholder="Strength training"
            />
          </Field>
          <Field label="Description" className="routines-field-wide">
            <textarea
              maxLength={4_000}
              disabled={disabled}
              value={draft.description}
              onChange={(event) => onChange({ description: event.target.value })}
              placeholder="What counts as a useful session?"
            />
          </Field>
        </div>
      </section>
      {groups === undefined || onSelectedGroupIdsChange === undefined ? null : (
        <section className="routines-form-section" aria-labelledby="routine-groups-heading">
          <div className="routines-section-heading">
            <h3 id="routine-groups-heading">Groups</h3>
            <p>Use overarching collections for quick browsing and manual plan choices.</p>
          </div>
          <fieldset className="routines-groups-fieldset">
            <legend className="sr-only">Group membership</legend>
            {groups.length === 0 ? (
              <p className="routines-groups-empty">Create a group from the routine pool first.</p>
            ) : (
              <div className="routines-groups-checks">
                {groups.map((group) => (
                  <label key={group.id}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={selectedGroupIds.includes(group.id)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...selectedGroupIds, group.id]
                          : selectedGroupIds.filter((id) => id !== group.id);
                        onSelectedGroupIdsChange(next);
                      }}
                    />
                    <span>{group.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </section>
      )}
      <section className="routines-form-section" aria-labelledby="routine-tags-heading">
        <div className="routines-section-heading">
          <h3 id="routine-tags-heading">Planning signals</h3>
          <p>Structured tags affect planning. Lists accept comma-separated values.</p>
        </div>
        <div className="routines-form-grid routines-form-grid-tags">
          {[
            ["Priority", "priority", priorities],
            ["Effort", "effort", efforts],
            ["Energy", "energy", energies],
            ["Preference", "preference", preferences],
          ].map(([label, field, options]) => (
            <Field key={field as string} label={label as string}>
              <select
                disabled={disabled}
                value={draft[field as keyof RoutineDraft] as string}
                onChange={(event) =>
                  onChange({ [field as string]: event.target.value } as Partial<RoutineDraft>)
                }
              >
                {(options as readonly string[]).map((option) => (
                  <option key={option} value={option}>
                    {titleCase(option)}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          <Field label="Contexts" hint="Examples: home, computer, errands">
            <input
              disabled={disabled}
              value={draft.contexts}
              onChange={(event) => onChange({ contexts: event.target.value })}
              placeholder="home, gym"
            />
          </Field>
          <Field label="Categories" hint="Used to balance the day">
            <input
              disabled={disabled}
              value={draft.categories}
              onChange={(event) => onChange({ categories: event.target.value })}
              placeholder="health, maintenance"
            />
          </Field>
          <Field label="Free-form tags" hint="For filtering and your own vocabulary">
            <input
              disabled={disabled}
              value={draft.freeForm}
              onChange={(event) => onChange({ freeForm: event.target.value })}
              placeholder="outdoors, solo"
            />
          </Field>
        </div>
      </section>
      <section className="routines-form-section" aria-labelledby="routine-duration-heading">
        <div className="routines-section-heading">
          <h3 id="routine-duration-heading">Duration</h3>
          <p>Minutes are used to fit routines into the time available that day.</p>
        </div>
        <div className="routines-form-grid routines-form-grid-duration">
          {[
            ["Minimum minutes", "minimumMinutes", 1, 43_200],
            ["Expected minutes", "expectedMinutes", 1, 43_200],
            ["Maximum minutes", "maximumMinutes", 1, 43_200],
            ["Setup minutes", "overheadMinutes", 0, 1_440],
          ].map(([label, field, min, max]) => (
            <Field key={field as string} label={label as string}>
              <input
                type="number"
                min={min as number}
                max={max as number}
                required
                disabled={disabled}
                value={draft[field as keyof RoutineDraft] as string}
                onChange={(event) =>
                  onChange({ [field as string]: event.target.value } as Partial<RoutineDraft>)
                }
              />
            </Field>
          ))}
          <label className="routines-check">
            <input
              type="checkbox"
              disabled={disabled}
              checked={draft.splittable}
              onChange={(event) => onChange({ splittable: event.target.checked })}
            />
            <span>
              <strong>Allow split sessions</strong>
              <small>The planner may use a shorter useful session when time is tight.</small>
            </span>
          </label>
          {draft.splittable ? (
            <Field label="Minimum session minutes">
              <input
                type="number"
                min={1}
                max={draft.minimumMinutes || 43_200}
                required
                disabled={disabled}
                value={draft.minimumSessionMinutes}
                onChange={(event) => onChange({ minimumSessionMinutes: event.target.value })}
              />
            </Field>
          ) : null}
        </div>
      </section>
      <section className="routines-form-section" aria-labelledby="routine-cadence-heading">
        <div className="routines-section-heading">
          <h3 id="routine-cadence-heading">Cadence</h3>
          <p>A target raises priority while a maximum creates a hard stop for the period.</p>
        </div>
        <div className="routines-form-grid routines-form-grid-cadence">
          <Field label="Period">
            <select
              disabled={disabled}
              value={draft.period}
              onChange={(event) => onChange({ period: event.target.value as CadencePeriod })}
            >
              {periods.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          {draft.period === "rolling_days" ? (
            <Field label="Rolling window days">
              <input
                type="number"
                min={1}
                max={3_650}
                required
                disabled={disabled}
                value={draft.rollingIntervalDays}
                onChange={(event) => onChange({ rollingIntervalDays: event.target.value })}
              />
            </Field>
          ) : null}
          {[
            ["Target completions", "targetCompletions", true],
            ["Minimum completions", "minimumCompletions", false],
            ["Maximum completions", "maximumCompletions", false],
            ["Minimum spacing days", "minimumSpacingDays", true],
          ].map(([label, field, required]) => (
            <Field key={field as string} label={label as string}>
              <input
                type="number"
                min={field === "minimumSpacingDays" ? 0 : 1}
                max={field === "minimumSpacingDays" ? 3_650 : 10_000}
                required={required as boolean}
                disabled={disabled}
                value={draft[field as keyof RoutineDraft] as string}
                onChange={(event) =>
                  onChange({ [field as string]: event.target.value } as Partial<RoutineDraft>)
                }
              />
            </Field>
          ))}
          <Field label="Consecutive-day policy">
            <select
              disabled={disabled}
              value={draft.consecutivePolicy}
              onChange={(event) =>
                onChange({ consecutivePolicy: event.target.value as ConsecutivePolicy })
              }
            >
              <option value="allow">Allow</option>
              <option value="discourage">Discourage</option>
              <option value="prohibit">Prohibit</option>
            </select>
          </Field>
          <Field label="Week starts on">
            <select
              disabled={disabled}
              value={draft.weekStartsOn}
              onChange={(event) => onChange({ weekStartsOn: Number(event.target.value) })}
            >
              {weekdays.map((weekday) => (
                <option key={weekday.id} value={weekday.id}>
                  {weekday.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <details className="routines-advanced">
          <summary>Advanced availability</summary>
          <p>Prefer or exclude weekdays, and optionally limit when this routine is active.</p>
          <div className="routines-weekday-groups">
            {(["preferred", "excluded"] as const).map((kind) => (
              <fieldset key={kind}>
                <legend>{kind === "preferred" ? "Preferred weekdays" : "Excluded weekdays"}</legend>
                <div
                  className={`routines-weekday-options${kind === "excluded" ? " routines-weekday-options-excluded" : ""}`}
                >
                  {weekdays.map((weekday) => (
                    <button
                      key={weekday.id}
                      type="button"
                      disabled={disabled}
                      aria-pressed={(kind === "preferred"
                        ? draft.preferredWeekdays
                        : draft.excludedWeekdays
                      ).includes(weekday.id)}
                      onClick={() => toggleWeekday(kind, weekday.id)}
                    >
                      {weekday.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <div className="routines-form-grid routines-form-grid-dates">
            <Field label="Starts on" hint="Optional">
              <input
                type="date"
                disabled={disabled}
                value={draft.startsOn ?? ""}
                onChange={(event) => onChange({ startsOn: event.target.value || null })}
              />
            </Field>
            <Field label="Pause through" hint="Optional">
              <input
                type="date"
                disabled={disabled}
                value={draft.pausedUntil ?? ""}
                onChange={(event) => onChange({ pausedUntil: event.target.value || null })}
              />
            </Field>
            <Field label="Ends on" hint="Optional">
              <input
                type="date"
                disabled={disabled}
                min={draft.startsOn ?? undefined}
                value={draft.endsOn ?? ""}
                onChange={(event) => onChange({ endsOn: event.target.value || null })}
              />
            </Field>
          </div>
        </details>
      </section>
    </>
  );
}
