import {
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock3,
  History,
  PauseCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { api, ApiError } from "../api";
import { Button, EmptyState, ErrorNotice, Field, PageHeader, PageSkeleton } from "../components/ui";
import type {
  NotificationDeliveryHistoryItem,
  NotificationIntent,
  NotificationProfile,
  NotificationRule,
  NotificationRuleKind,
  OneOffReminder,
  WorkspaceViewProps,
} from "../types";

type ReminderTab = "policy" | "planned" | "execution";
type NumericFieldValue = number | "";

const DAY_MILLISECONDS = 86_400_000;
const RULE_META: Readonly<
  Record<
    NotificationRuleKind,
    {
      readonly label: string;
      readonly description: string;
      readonly trigger: "local_minute" | "lead_minutes";
    }
  >
> = {
  daily_digest: {
    label: "Daily digest",
    description: "A workspace overview at one local time each day.",
    trigger: "local_minute",
  },
  daily_follow_up: {
    label: "Daily follow-up",
    description: "A check-in when the current plan still has unfinished work.",
    trigger: "local_minute",
  },
  plan_window_open: {
    label: "Plan window opening",
    description: "A reminder before one of Today’s submitted availability windows begins.",
    trigger: "lead_minutes",
  },
  schedule_block_lead: {
    label: "Calendar block lead",
    description: "A reminder before each bounded calendar block.",
    trigger: "lead_minutes",
  },
  work_item_due: {
    label: "Work due",
    description: "A local-time reminder for eligible work items on their due date.",
    trigger: "local_minute",
  },
};

const DELIVERY_STATUS: Readonly<
  Record<
    NotificationDeliveryHistoryItem["status"],
    { readonly label: string; readonly description: string }
  >
> = {
  pending: {
    label: "Pending",
    description: "Available for a delivery adapter to claim.",
  },
  processing: {
    label: "Claimed",
    description: "An adapter holds a lease; this does not prove an external message was sent.",
  },
  delivered: {
    label: "Acknowledged",
    description: "The adapter reported a successful, deduplicated outcome.",
  },
  dead_letter: {
    label: "Needs attention",
    description: "Delivery stopped after a permanent failure or the attempt limit.",
  },
  invalidated: {
    label: "Invalidated",
    description: "The source or policy changed after this command crossed the delivery boundary.",
  },
};

function queryWindow(now = new Date()) {
  return {
    from: new Date(now.getTime() - 7 * DAY_MILLISECONDS).toISOString(),
    to: new Date(now.getTime() + 24 * DAY_MILLISECONDS).toISOString(),
  };
}

function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatDateTime(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function toDateTimeLocal(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid reminder date and time.");
  return date.toISOString();
}

function minuteToTime(value: number | null, fallback: string): string {
  if (value === null) return fallback;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function timeToMinute(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  if (
    hours === undefined ||
    minutes === undefined ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    throw new Error("Choose a valid local time.");
  }
  return hours * 60 + minutes;
}

function numericFieldValue(input: HTMLInputElement): NumericFieldValue {
  return input.value === "" ? "" : input.valueAsNumber;
}

function isBoundedInteger(
  value: NumericFieldValue,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code.endsWith("version_conflict")) {
      return "This reminder setting changed elsewhere. The latest version has been reloaded; review it before saving again.";
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "The reminder request could not be completed.";
}

function kindLabel(kind: NotificationIntent["kind"]): string {
  return kind === "one_off" ? "One-off reminder" : RULE_META[kind].label;
}

function targetLabel(target: NotificationIntent["targetType"]): string {
  return {
    workspace: "Workspace",
    daily_plan: "Daily plan",
    schedule_block: "Calendar block",
    work_item: "Work item",
    one_off: "One-off",
  }[target];
}

function ProfileForm({
  profile,
  busy,
  disabled,
  onSave,
}: {
  readonly profile: NotificationProfile | null;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSave: (input: {
    readonly expectedVersion: number | null;
    readonly enabled: boolean;
    readonly timeZone: string;
    readonly quietHoursStartMinute: number | null;
    readonly quietHoursEndMinute: number | null;
    readonly quietHoursPolicy: "skip" | "next_allowed";
    readonly catchUpWindowMinutes: number;
    readonly dailyIntentLimit: number;
  }) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [timeZone, setTimeZone] = useState(profile?.timeZone ?? deviceTimeZone());
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(
    profile?.quietHoursStartMinute !== null && profile?.quietHoursStartMinute !== undefined,
  );
  const [quietStart, setQuietStart] = useState(
    minuteToTime(profile?.quietHoursStartMinute ?? null, "22:00"),
  );
  const [quietEnd, setQuietEnd] = useState(
    minuteToTime(profile?.quietHoursEndMinute ?? null, "07:00"),
  );
  const [quietPolicy, setQuietPolicy] = useState<"skip" | "next_allowed">(
    profile?.quietHoursPolicy ?? "next_allowed",
  );
  const [catchUpWindowMinutes, setCatchUpWindowMinutes] = useState<NumericFieldValue>(
    profile?.catchUpWindowMinutes ?? 60,
  );
  const [dailyIntentLimit, setDailyIntentLimit] = useState<NumericFieldValue>(
    profile?.dailyIntentLimit ?? 20,
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  useLayoutEffect(() => {
    setEnabled(profile?.enabled ?? true);
    setTimeZone(profile?.timeZone ?? deviceTimeZone());
    setQuietHoursEnabled(
      profile?.quietHoursStartMinute !== null && profile?.quietHoursStartMinute !== undefined,
    );
    setQuietStart(minuteToTime(profile?.quietHoursStartMinute ?? null, "22:00"));
    setQuietEnd(minuteToTime(profile?.quietHoursEndMinute ?? null, "07:00"));
    setQuietPolicy(profile?.quietHoursPolicy ?? "next_allowed");
    setCatchUpWindowMinutes(profile?.catchUpWindowMinutes ?? 60);
    setDailyIntentLimit(profile?.dailyIntentLimit ?? 20);
    setValidationError(null);
  }, [profile]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !isBoundedInteger(catchUpWindowMinutes, 0, 10_080) ||
      !isBoundedInteger(dailyIntentLimit, 1, 100)
    ) {
      setValidationError("Enter whole numbers within the displayed reminder-policy ranges.");
      return;
    }
    let quietHoursStartMinute: number | null = null;
    let quietHoursEndMinute: number | null = null;
    if (quietHoursEnabled) {
      try {
        quietHoursStartMinute = timeToMinute(quietStart);
        quietHoursEndMinute = timeToMinute(quietEnd);
      } catch {
        setValidationError("Choose both a valid quiet-hours start and end time.");
        return;
      }
    }
    setValidationError(null);
    await onSave({
      expectedVersion: profile?.version ?? null,
      enabled,
      timeZone: timeZone.trim(),
      quietHoursStartMinute,
      quietHoursEndMinute,
      quietHoursPolicy: quietPolicy,
      catchUpWindowMinutes,
      dailyIntentLimit,
    });
  }

  return (
    <section className="reminder-panel reminder-profile" aria-labelledby="reminder-profile-heading">
      <div className="reminder-section-heading">
        <div>
          <p className="eyebrow">Workspace policy</p>
          <h2 id="reminder-profile-heading">
            {profile === null ? "Configure reminders" : "Policy and quiet hours"}
          </h2>
        </div>
        {profile === null ? (
          <span className="reminder-state reminder-state-setup">Setup required</span>
        ) : enabled ? (
          <span className="reminder-state reminder-state-active">Active</span>
        ) : (
          <span className="reminder-state reminder-state-paused">Paused</span>
        )}
      </div>
      <p className="reminder-section-copy">
        {profile === null
          ? "Nothing is planned until you review this form and save it. The device time zone is only a starting suggestion."
          : "The policy controls planning. Saving a change invalidates pending intents so they can be rebuilt from current settings."}
      </p>

      <form className="reminder-profile-form" onSubmit={(event) => void submit(event)}>
        <label className="reminder-toggle reminder-profile-enabled">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            <strong>Enable reminder planning</strong>
            <small>Turn this off to suppress every rule without deleting settings.</small>
          </span>
        </label>

        <Field
          label="Policy time zone"
          hint="Use an IANA name such as America/La_Paz or Europe/London."
          className="reminder-time-zone"
        >
          <input
            required
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            maxLength={80}
            autoComplete="off"
          />
        </Field>

        <label className="reminder-toggle reminder-quiet-toggle">
          <input
            type="checkbox"
            checked={quietHoursEnabled}
            onChange={(event) => setQuietHoursEnabled(event.target.checked)}
          />
          <span>
            <strong>Use quiet hours</strong>
            <small>The interval may cross midnight. Equal times disable the interval.</small>
          </span>
        </label>

        <Field label="Quiet hours start">
          <input
            type="time"
            required={quietHoursEnabled}
            value={quietStart}
            disabled={!quietHoursEnabled}
            aria-invalid={quietHoursEnabled && quietStart === ""}
            onChange={(event) => {
              setQuietStart(event.target.value);
              setValidationError(null);
            }}
          />
        </Field>
        <Field label="Quiet hours end">
          <input
            type="time"
            required={quietHoursEnabled}
            value={quietEnd}
            disabled={!quietHoursEnabled}
            aria-invalid={quietHoursEnabled && quietEnd === ""}
            onChange={(event) => {
              setQuietEnd(event.target.value);
              setValidationError(null);
            }}
          />
        </Field>
        <Field label="During quiet hours">
          <select
            value={quietPolicy}
            disabled={!quietHoursEnabled}
            onChange={(event) => setQuietPolicy(event.target.value as "skip" | "next_allowed")}
          >
            <option value="next_allowed">Move to the next allowed time</option>
            <option value="skip">Skip the occurrence</option>
          </select>
        </Field>

        <Field
          label="Catch-up window (minutes)"
          hint="How late Schedule may recreate an occurrence after downtime; 0–10,080."
        >
          <input
            type="number"
            required
            min={0}
            max={10_080}
            value={catchUpWindowMinutes}
            aria-invalid={validationError !== null}
            onChange={(event) => {
              setCatchUpWindowMinutes(numericFieldValue(event.currentTarget));
              setValidationError(null);
            }}
          />
        </Field>
        <Field
          label="Daily planned limit"
          hint="Maximum accepted intents per resulting local date; 1–100."
        >
          <input
            type="number"
            required
            min={1}
            max={100}
            value={dailyIntentLimit}
            aria-invalid={validationError !== null}
            onChange={(event) => {
              setDailyIntentLimit(numericFieldValue(event.currentTarget));
              setValidationError(null);
            }}
          />
        </Field>

        {validationError === null ? null : (
          <p className="reminder-validation-error" role="alert">
            {validationError}
          </p>
        )}

        <div className="reminder-form-actions">
          <Button type="submit" variant="primary" busy={busy} disabled={disabled}>
            {profile === null ? "Save reminder policy" : "Save policy changes"}
          </Button>
          {profile === null ? null : (
            <span>Version {profile.version}. Concurrent edits are checked before saving.</span>
          )}
        </div>
      </form>
    </section>
  );
}

function RuleCard({
  rule,
  busy,
  disabled,
  onSave,
}: {
  readonly rule: NotificationRule;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSave: (
    rule: NotificationRule,
    changes: {
      readonly enabled: boolean;
      readonly localMinute: number | null;
      readonly leadMinutes: number | null;
      readonly cooldownMinutes: number;
      readonly priority: number;
    },
  ) => Promise<void>;
}) {
  const meta = RULE_META[rule.kind];
  const [enabled, setEnabled] = useState(rule.enabled);
  const [localTime, setLocalTime] = useState(minuteToTime(rule.localMinute, "09:00"));
  const [leadMinutes, setLeadMinutes] = useState<NumericFieldValue>(rule.leadMinutes ?? 15);
  const [cooldownMinutes, setCooldownMinutes] = useState<NumericFieldValue>(rule.cooldownMinutes);
  const [priority, setPriority] = useState<NumericFieldValue>(rule.priority);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(rule.enabled);
    setLocalTime(minuteToTime(rule.localMinute, "09:00"));
    setLeadMinutes(rule.leadMinutes ?? 15);
    setCooldownMinutes(rule.cooldownMinutes);
    setPriority(rule.priority);
    setValidationError(null);
  }, [rule]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      (meta.trigger === "lead_minutes" && !isBoundedInteger(leadMinutes, 0, 10_080)) ||
      !isBoundedInteger(cooldownMinutes, 0, 10_080) ||
      !isBoundedInteger(priority, 0, 100)
    ) {
      setValidationError("Enter whole numbers within the displayed rule ranges.");
      return;
    }
    setValidationError(null);
    await onSave(rule, {
      enabled,
      localMinute: meta.trigger === "local_minute" ? timeToMinute(localTime) : null,
      leadMinutes: meta.trigger === "lead_minutes" ? Number(leadMinutes) : null,
      cooldownMinutes,
      priority,
    });
  }

  return (
    <form className="reminder-rule-card" onSubmit={(event) => void submit(event)}>
      <div className="reminder-rule-heading">
        <div>
          <h3>{meta.label}</h3>
          <p>{meta.description}</p>
        </div>
        <label className="reminder-switch">
          <span>{enabled ? "Enabled" : "Paused"}</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            aria-label={`${enabled ? "Pause" : "Enable"} ${meta.label}`}
          />
        </label>
      </div>
      <div className="reminder-rule-fields">
        {meta.trigger === "local_minute" ? (
          <Field label="Local time">
            <input
              type="time"
              value={localTime}
              onChange={(event) => setLocalTime(event.target.value)}
            />
          </Field>
        ) : (
          <Field label="Lead time (minutes)">
            <input
              type="number"
              required
              min={0}
              max={10_080}
              value={leadMinutes}
              aria-invalid={validationError !== null}
              onChange={(event) => {
                setLeadMinutes(numericFieldValue(event.currentTarget));
                setValidationError(null);
              }}
            />
          </Field>
        )}
        <Field label="Cooldown (minutes)">
          <input
            type="number"
            required
            min={0}
            max={10_080}
            value={cooldownMinutes}
            aria-invalid={validationError !== null}
            onChange={(event) => {
              setCooldownMinutes(numericFieldValue(event.currentTarget));
              setValidationError(null);
            }}
          />
        </Field>
        <Field label="Priority">
          <input
            type="number"
            required
            min={0}
            max={100}
            value={priority}
            aria-invalid={validationError !== null}
            onChange={(event) => {
              setPriority(numericFieldValue(event.currentTarget));
              setValidationError(null);
            }}
          />
        </Field>
      </div>
      {validationError === null ? null : (
        <p className="reminder-validation-error" role="alert">
          {validationError}
        </p>
      )}
      <div className="reminder-card-actions">
        <span>Version {rule.version}</span>
        <Button type="submit" busy={busy} disabled={disabled}>
          Save rule
        </Button>
      </div>
    </form>
  );
}

function AddRuleForm({
  busy,
  disabled,
  onCreate,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onCreate: (input: {
    readonly kind: NotificationRuleKind;
    readonly enabled: boolean;
    readonly localMinute: number | null;
    readonly leadMinutes: number | null;
    readonly cooldownMinutes: number;
    readonly priority: number;
  }) => Promise<void>;
}) {
  const [kind, setKind] = useState<NotificationRuleKind>("daily_digest");
  const [localTime, setLocalTime] = useState("09:00");
  const [leadMinutes, setLeadMinutes] = useState<NumericFieldValue>(15);
  const [cooldownMinutes, setCooldownMinutes] = useState<NumericFieldValue>(0);
  const [priority, setPriority] = useState<NumericFieldValue>(50);
  const [validationError, setValidationError] = useState<string | null>(null);
  const meta = RULE_META[kind];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      (meta.trigger === "lead_minutes" && !isBoundedInteger(leadMinutes, 0, 10_080)) ||
      !isBoundedInteger(cooldownMinutes, 0, 10_080) ||
      !isBoundedInteger(priority, 0, 100)
    ) {
      setValidationError("Enter whole numbers within the displayed rule ranges.");
      return;
    }
    setValidationError(null);
    await onCreate({
      kind,
      enabled: true,
      localMinute: meta.trigger === "local_minute" ? timeToMinute(localTime) : null,
      leadMinutes: meta.trigger === "lead_minutes" ? Number(leadMinutes) : null,
      cooldownMinutes,
      priority,
    });
  }

  return (
    <details className="reminder-add-disclosure">
      <summary>Add a reusable rule</summary>
      <form className="reminder-add-rule-form" onSubmit={(event) => void submit(event)}>
        <Field label="Rule type" hint={meta.description}>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as NotificationRuleKind)}
          >
            {Object.entries(RULE_META).map(([value, option]) => (
              <option key={value} value={value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        {meta.trigger === "local_minute" ? (
          <Field label="Local time">
            <input
              type="time"
              value={localTime}
              onChange={(event) => setLocalTime(event.target.value)}
            />
          </Field>
        ) : (
          <Field label="Lead time (minutes)">
            <input
              type="number"
              required
              min={0}
              max={10_080}
              value={leadMinutes}
              aria-invalid={validationError !== null}
              onChange={(event) => {
                setLeadMinutes(numericFieldValue(event.currentTarget));
                setValidationError(null);
              }}
            />
          </Field>
        )}
        <Field label="Cooldown (minutes)">
          <input
            type="number"
            required
            min={0}
            max={10_080}
            value={cooldownMinutes}
            aria-invalid={validationError !== null}
            onChange={(event) => {
              setCooldownMinutes(numericFieldValue(event.currentTarget));
              setValidationError(null);
            }}
          />
        </Field>
        <Field label="Priority">
          <input
            type="number"
            required
            min={0}
            max={100}
            value={priority}
            aria-invalid={validationError !== null}
            onChange={(event) => {
              setPriority(numericFieldValue(event.currentTarget));
              setValidationError(null);
            }}
          />
        </Field>
        {validationError === null ? null : (
          <p className="reminder-validation-error" role="alert">
            {validationError}
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy} disabled={disabled}>
          Create rule
        </Button>
      </form>
    </details>
  );
}

function OneOffCard({
  reminder,
  timeZone,
  busy,
  disabled,
  onSave,
  onCancel,
}: {
  readonly reminder: OneOffReminder;
  readonly timeZone: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSave: (
    reminder: OneOffReminder,
    title: string,
    scheduledFor: string,
  ) => Promise<boolean>;
  readonly onCancel: (reminder: OneOffReminder) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(reminder.title);
  const [scheduledFor, setScheduledFor] = useState(toDateTimeLocal(reminder.scheduledFor));
  const cancelled = reminder.cancelledAt !== null;

  useEffect(() => {
    setTitle(reminder.title);
    setScheduledFor(toDateTimeLocal(reminder.scheduledFor));
    if (reminder.cancelledAt !== null) setEditing(false);
  }, [reminder]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSave(reminder, title.trim(), toInstant(scheduledFor))) setEditing(false);
  }

  if (editing) {
    return (
      <form
        className="reminder-one-off-card reminder-one-off-editor"
        onSubmit={(event) => void submit(event)}
      >
        <Field label="Reminder title">
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={240}
          />
        </Field>
        <Field label="Date and time on this device">
          <input
            required
            type="datetime-local"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
          />
        </Field>
        <div className="reminder-card-actions">
          <Button type="button" variant="quiet" onClick={() => setEditing(false)}>
            Cancel editing
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={disabled}>
            Save reminder
          </Button>
        </div>
      </form>
    );
  }

  return (
    <article className={`reminder-one-off-card${cancelled ? " is-cancelled" : ""}`}>
      <div>
        <h3>{reminder.title}</h3>
        <p>
          {formatDateTime(reminder.scheduledFor, timeZone)} · policy time
          <span className="reminder-version"> · v{reminder.version}</span>
        </p>
      </div>
      {cancelled ? (
        <span className="reminder-state reminder-state-paused">Cancelled</span>
      ) : (
        <div className="reminder-inline-actions">
          <Button
            type="button"
            variant="quiet"
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="danger"
            busy={busy}
            disabled={disabled}
            onClick={() => void onCancel(reminder)}
          >
            Cancel reminder
          </Button>
        </div>
      )}
    </article>
  );
}

function PolicyTab({
  workspaceId,
  profile,
  rules,
  reminders,
  busyKey,
  runMutation,
  refresh,
}: {
  readonly workspaceId: string;
  readonly profile: NotificationProfile | null;
  readonly rules: readonly NotificationRule[];
  readonly reminders: readonly OneOffReminder[];
  readonly busyKey: string | null;
  readonly runMutation: (key: string, operation: () => Promise<string>) => Promise<boolean>;
  readonly refresh: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [scheduledFor, setScheduledFor] = useState(() =>
    toDateTimeLocal(new Date(Date.now() + 60 * 60_000)),
  );

  async function createOneOff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const currentTitle = title.trim();
    if (currentTitle.length === 0) return;
    await runMutation("one-off-new", async () => {
      await api.createOneOffReminder(workspaceId, {
        title: currentTitle,
        scheduledFor: toInstant(scheduledFor),
      });
      setTitle("");
      setScheduledFor(toDateTimeLocal(new Date(Date.now() + 60 * 60_000)));
      await refresh();
      return "One-off reminder created. Refresh planned reminders when you want to materialize it.";
    });
  }

  return (
    <div className="reminder-policy-stack">
      <ProfileForm
        profile={profile}
        busy={busyKey === "profile"}
        disabled={busyKey !== null}
        onSave={async (input) => {
          await runMutation("profile", async () => {
            await api.configureNotificationProfile(workspaceId, input);
            await refresh();
            return profile === null
              ? "Reminder policy configured. You can now add rules and one-off reminders."
              : "Reminder policy saved; pending intents were invalidated for an explicit refresh.";
          });
        }}
      />

      {profile === null ? (
        <div className="reminder-locked-sections" role="note">
          <ShieldCheck size={20} aria-hidden="true" />
          <div>
            <h2>Rules stay locked until policy setup is saved</h2>
            <p>
              This avoids silently choosing a time zone or enabling delivery behavior on your
              behalf.
            </p>
          </div>
        </div>
      ) : (
        <div className="reminder-policy-columns">
          <section className="reminder-panel" aria-labelledby="reminder-rules-heading">
            <div className="reminder-section-heading">
              <div>
                <p className="eyebrow">Reusable automation</p>
                <h2 id="reminder-rules-heading">Rules</h2>
              </div>
              <span className="reminder-count">{rules.length}</span>
            </div>
            <p className="reminder-section-copy">
              A rule’s kind is permanent. Pause or edit it; create a new rule when the behavior
              should change.
            </p>
            <AddRuleForm
              busy={busyKey === "rule-new"}
              disabled={busyKey !== null}
              onCreate={async (input) => {
                await runMutation("rule-new", async () => {
                  await api.createNotificationRule(workspaceId, input);
                  await refresh();
                  return `${RULE_META[input.kind].label} rule created.`;
                });
              }}
            />
            <div className="reminder-rule-list">
              {rules.length === 0 ? (
                <p className="reminder-inline-empty">No reusable rules yet.</p>
              ) : (
                rules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    busy={busyKey === `rule-${rule.id}`}
                    disabled={busyKey !== null}
                    onSave={async (current, changes) => {
                      await runMutation(`rule-${current.id}`, async () => {
                        await api.updateNotificationRule(workspaceId, current.id, {
                          expectedVersion: current.version,
                          ...changes,
                        });
                        await refresh();
                        return `${RULE_META[current.kind].label} rule saved; its pending intents were invalidated.`;
                      });
                    }}
                  />
                ))
              )}
            </div>
          </section>

          <section className="reminder-panel" aria-labelledby="one-off-heading">
            <div className="reminder-section-heading">
              <div>
                <p className="eyebrow">Specific moments</p>
                <h2 id="one-off-heading">One-off reminders</h2>
              </div>
              <span className="reminder-count">{reminders.length}</span>
            </div>
            <p className="reminder-section-copy">
              The editor uses this device’s clock and stores an absolute instant. The list is
              rendered in the policy time zone.
            </p>
            <form
              className="reminder-one-off-create"
              onSubmit={(event) => void createOneOff(event)}
            >
              <Field label="Reminder title">
                <input
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Call home"
                  maxLength={240}
                />
              </Field>
              <Field label="Date and time on this device">
                <input
                  required
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(event) => setScheduledFor(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                busy={busyKey === "one-off-new"}
                disabled={busyKey !== null}
              >
                Add reminder
              </Button>
            </form>
            <div className="reminder-one-off-list">
              {reminders.length === 0 ? (
                <p className="reminder-inline-empty">
                  No one-off reminders in the visible 31-day window.
                </p>
              ) : (
                reminders.map((reminder) => (
                  <OneOffCard
                    key={reminder.id}
                    reminder={reminder}
                    timeZone={profile.timeZone}
                    busy={busyKey === `one-off-${reminder.id}`}
                    disabled={busyKey !== null}
                    onSave={(current, nextTitle, nextScheduledFor) =>
                      runMutation(`one-off-${current.id}`, async () => {
                        await api.updateOneOffReminder(workspaceId, current.id, {
                          expectedVersion: current.version,
                          title: nextTitle,
                          scheduledFor: nextScheduledFor,
                        });
                        await refresh();
                        return "One-off reminder updated; its pending intent was invalidated.";
                      })
                    }
                    onCancel={async (current) => {
                      await runMutation(`one-off-${current.id}`, async () => {
                        await api.cancelOneOffReminder(workspaceId, current.id, current.version);
                        await refresh();
                        return "One-off reminder cancelled. It cannot be revived.";
                      });
                    }}
                  />
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function PlannedTab({
  intents,
  timeZone,
}: {
  readonly intents: readonly NotificationIntent[];
  readonly timeZone: string | undefined;
}) {
  const [visible, setVisible] = useState(50);
  useEffect(() => setVisible(50), [intents]);

  if (intents.length === 0) {
    return (
      <EmptyState title="No planned reminders in this window">
        Configure policy and sources, then use “Refresh planned reminders.” Planning is explicit and
        no periodic materializer runs yet.
      </EmptyState>
    );
  }

  return (
    <section className="reminder-list-section" aria-labelledby="planned-reminders-heading">
      <div className="reminder-list-heading">
        <div>
          <p className="eyebrow">Immutable decisions</p>
          <h2 id="planned-reminders-heading">Planned reminders</h2>
          <p>Recent 7 days and upcoming 24 days, ordered by scheduled instant.</p>
        </div>
        <span className="reminder-count">{intents.length}</span>
      </div>
      <div className="reminder-record-list">
        {intents.slice(0, visible).map((intent) => (
          <article className="reminder-record" key={intent.id}>
            <div className="reminder-record-icon reminder-record-icon-planned" aria-hidden="true">
              <CalendarClock size={18} />
            </div>
            <div className="reminder-record-main">
              <div className="reminder-record-title">
                <h3>{intent.titleSnapshot ?? kindLabel(intent.kind)}</h3>
                <span className="reminder-state reminder-state-planned">Planned</span>
              </div>
              <p>{formatDateTime(intent.scheduledFor, timeZone)}</p>
              <div className="reminder-record-meta">
                <span>{kindLabel(intent.kind)}</span>
                <span>{targetLabel(intent.targetType)}</span>
                <span>Priority {intent.priority}</span>
                {intent.adjustedForQuietHours ? <span>Moved after quiet hours</span> : null}
                {intent.caughtUp ? <span>Caught up after downtime</span> : null}
              </div>
            </div>
          </article>
        ))}
      </div>
      {visible < intents.length ? (
        <Button type="button" variant="quiet" onClick={() => setVisible((count) => count + 50)}>
          Show 50 more
        </Button>
      ) : null}
    </section>
  );
}

function DeliveryIcon({ status }: { readonly status: NotificationDeliveryHistoryItem["status"] }) {
  if (status === "delivered") return <CheckCircle2 size={18} />;
  if (status === "dead_letter") return <TriangleAlert size={18} />;
  if (status === "invalidated") return <PauseCircle size={18} />;
  if (status === "processing") return <Send size={18} />;
  return <Clock3 size={18} />;
}

function ExecutionTab({
  deliveries,
  timeZone,
}: {
  readonly deliveries: readonly NotificationDeliveryHistoryItem[];
  readonly timeZone: string | undefined;
}) {
  const [visible, setVisible] = useState(50);
  useEffect(() => setVisible(50), [deliveries]);

  if (deliveries.length === 0) {
    return (
      <EmptyState title="No delivery commands in this window">
        A command appears only after an authenticated delivery adapter claims a due planned intent.
        No provider or polling worker is connected by this screen.
      </EmptyState>
    );
  }

  return (
    <section className="reminder-list-section" aria-labelledby="delivery-history-heading">
      <div className="reminder-list-heading">
        <div>
          <p className="eyebrow">Provider-neutral boundary</p>
          <h2 id="delivery-history-heading">Execution history</h2>
          <p>
            Safe command status only—no credentials, recipients, provider payloads, or claim tokens.
          </p>
        </div>
        <span className="reminder-count">{deliveries.length}</span>
      </div>
      <div className="reminder-record-list">
        {deliveries.slice(0, visible).map((delivery) => {
          const status = DELIVERY_STATUS[delivery.status];
          return (
            <article className="reminder-record" key={delivery.deliveryId}>
              <div
                className={`reminder-record-icon reminder-record-icon-${delivery.status}`}
                aria-hidden="true"
              >
                <DeliveryIcon status={delivery.status} />
              </div>
              <div className="reminder-record-main">
                <div className="reminder-record-title">
                  <h3>{delivery.title ?? kindLabel(delivery.kind)}</h3>
                  <span className={`reminder-state reminder-delivery-${delivery.status}`}>
                    {status.label}
                  </span>
                </div>
                <p>{formatDateTime(delivery.scheduledFor, timeZone)}</p>
                <p className="reminder-status-explanation">{status.description}</p>
                <div className="reminder-record-meta">
                  <span>{kindLabel(delivery.kind)}</span>
                  <span>{targetLabel(delivery.targetType)}</span>
                  <span>
                    {delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"}
                  </span>
                  {delivery.lastFailureCode === null ? null : (
                    <span>Failure: {delivery.lastFailureCode}</span>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {visible < deliveries.length ? (
        <Button type="button" variant="quiet" onClick={() => setVisible((count) => count + 50)}>
          Show 50 more
        </Button>
      ) : null}
    </section>
  );
}

export function RemindersView({ workspace }: WorkspaceViewProps) {
  const [tab, setTab] = useState<ReminderTab>("policy");
  const [profile, setProfile] = useState<NotificationProfile | null>(null);
  const [rules, setRules] = useState<readonly NotificationRule[]>([]);
  const [reminders, setReminders] = useState<readonly OneOffReminder[]>([]);
  const [intents, setIntents] = useState<readonly NotificationIntent[]>([]);
  const [deliveries, setDeliveries] = useState<readonly NotificationDeliveryHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutationLock = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal, background = false) => {
      if (background) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const range = queryWindow();
      try {
        const profilePromise = api
          .getNotificationProfile(workspace.id, signal)
          .catch((loadError: unknown) => {
            if (
              loadError instanceof ApiError &&
              loadError.status === 404 &&
              loadError.code === "notification_profile.not_found"
            ) {
              return null;
            }
            throw loadError;
          });
        const [nextProfile, nextRules, nextReminders, nextIntents, nextDeliveries] =
          await Promise.all([
            profilePromise,
            api.listNotificationRules(workspace.id, signal),
            api.listOneOffReminders(workspace.id, range.from, range.to, signal),
            api.listNotificationIntents(workspace.id, range.from, range.to, signal),
            api.listNotificationDeliveries(workspace.id, range.from, range.to, signal),
          ]);
        setProfile(nextProfile);
        setRules(nextRules.items);
        setReminders(nextReminders.items);
        setIntents(nextIntents.items);
        setDeliveries(nextDeliveries.items);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(errorMessage(loadError));
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [workspace.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(() => load(undefined, true), [load]);

  const runMutation = useCallback(
    async (key: string, operation: () => Promise<string>): Promise<boolean> => {
      if (mutationLock.current) return false;
      mutationLock.current = true;
      setBusyKey(key);
      setError(null);
      setNotice(null);
      try {
        setNotice(await operation());
        return true;
      } catch (mutationError) {
        const conflict =
          mutationError instanceof ApiError && mutationError.code.endsWith("version_conflict");
        if (conflict) await refresh();
        setError(errorMessage(mutationError));
        return false;
      } finally {
        mutationLock.current = false;
        setBusyKey(null);
      }
    },
    [refresh],
  );

  const materializationRange = useMemo(() => {
    const now = new Date();
    const catchUp = Math.min(profile?.catchUpWindowMinutes ?? 0, 10_080) * 60_000;
    return {
      from: new Date(now.getTime() - catchUp).toISOString(),
      through: new Date(now.getTime() + 7 * DAY_MILLISECONDS).toISOString(),
    };
  }, [profile]);

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: ReminderTab) {
    const order: readonly ReminderTab[] = ["policy", "planned", "execution"];
    const index = order.indexOf(current);
    const next =
      event.key === "Home"
        ? order[0]
        : event.key === "End"
          ? order.at(-1)
          : event.key === "ArrowRight"
            ? order[(index + 1) % order.length]
            : event.key === "ArrowLeft"
              ? order[(index - 1 + order.length) % order.length]
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`reminder-tab-${next}`)?.focus();
  }

  async function materialize() {
    await runMutation("materialize", async () => {
      const result = await api.materializeNotificationIntents(
        workspace.id,
        materializationRange.from,
        materializationRange.through,
      );
      await refresh();
      setTab("planned");
      return `Planning refreshed: ${String(result.created.length)} created, ${String(result.existing.length)} already present, ${String(result.suppressed.length)} suppressed by policy.`;
    });
  }

  return (
    <section className="reminders-view" aria-label="Reminders">
      <PageHeader
        eyebrow="Intentional automation"
        title="Reminders"
        description="Configure deterministic reminder policy, inspect what Schedule planned, and audit the provider-neutral execution boundary."
        actions={
          <>
            <Button type="button" variant="quiet" busy={refreshing} onClick={() => void refresh()}>
              <RefreshCw size={16} aria-hidden="true" />
              Refresh data
            </Button>
            <Button
              type="button"
              variant="primary"
              busy={busyKey === "materialize"}
              disabled={profile === null || busyKey !== null}
              onClick={() => void materialize()}
            >
              <Bell size={16} aria-hidden="true" />
              Refresh planned reminders
            </Button>
          </>
        }
      />

      <div className="reminder-boundary" role="note">
        <ShieldCheck size={21} aria-hidden="true" />
        <div>
          <strong>Schedule decides; adapters only deliver.</strong>
          <p>
            Planning is explicit in this local slice. No periodic worker, WhatsApp account, phone
            destination, email provider, or push transport is connected here. “Claimed” is not proof
            of an external send.
          </p>
        </div>
      </div>

      {error === null ? null : (
        <ErrorNotice
          message={error}
          onDismiss={() => setError(null)}
          action={
            <Button type="button" variant="quiet" onClick={() => void refresh()}>
              Reload
            </Button>
          }
        />
      )}
      {notice === null ? null : (
        <div className="notice reminder-success" role="status" aria-live="polite">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>{notice}</span>
          <button type="button" className="reminder-notice-dismiss" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="reminder-tabs" role="tablist" aria-label="Reminder areas">
        {(
          [
            ["policy", "Policy", ShieldCheck],
            ["planned", "Planned", CalendarClock],
            ["execution", "Execution", History],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`reminder-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`reminder-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => moveTab(event, id)}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{label}</span>
            {id === "planned" && intents.length > 0 ? <small>{intents.length}</small> : null}
            {id === "execution" && deliveries.length > 0 ? (
              <small>{deliveries.length}</small>
            ) : null}
          </button>
        ))}
      </div>

      {loading ? (
        <PageSkeleton rows={5} />
      ) : (
        <div
          className="reminder-tab-panel"
          role="tabpanel"
          id={`reminder-panel-${tab}`}
          aria-labelledby={`reminder-tab-${tab}`}
        >
          {tab === "policy" ? (
            <PolicyTab
              workspaceId={workspace.id}
              profile={profile}
              rules={rules}
              reminders={reminders}
              busyKey={busyKey}
              runMutation={runMutation}
              refresh={refresh}
            />
          ) : null}
          {tab === "planned" ? <PlannedTab intents={intents} timeZone={profile?.timeZone} /> : null}
          {tab === "execution" ? (
            <ExecutionTab deliveries={deliveries} timeZone={profile?.timeZone} />
          ) : null}
        </div>
      )}
    </section>
  );
}
