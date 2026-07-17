import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProvisionIntegrationCredential } from "../packages/application/src/index.js";
import {
  createDatabase,
  PostgresIntegrationUnitOfWork,
  PostgresUnitOfWork,
  type DatabaseConnection,
} from "../packages/database/src/index.js";
import { workspaceId } from "../packages/domain/src/index.js";

import { buildApp } from "../apps/api/src/app.js";
import { createIntegrationServices } from "../apps/api/src/integration-services.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import {
  generateIntegrationCredentialSecret,
  hashIntegrationCredentialSecret,
} from "./integration-credentials.js";
import { requireLocalHermesVerificationDatabaseUrl } from "./hermes-verification-safety.js";

const sourceDatabaseUrl = requireLocalHermesVerificationDatabaseUrl(
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule",
);
const verificationDatabase = `schedule_hermes_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_hermes_verify_[a-f0-9]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "integrations", "hermes-schedule");
const pepper = "hermes-adapter-verification-pepper-32-characters";
const reminderTitle = "Hermes adapter verification reminder";
const reminderScheduledFor = "2026-07-16T12:00:00.000Z";
const updatedReminderTitle = "Hermes adapter verification reminder rescheduled";
const updatedReminderScheduledFor = "2026-07-17T13:00:00.000Z";
const reminderRange = {
  from: "2026-07-16T00:00:00.000Z",
  through: "2026-07-18T00:00:00.000Z",
} as const;
const materializationRange = {
  from: "2026-07-15T07:00:00.000Z",
  through: "2026-07-18T00:00:00.000Z",
} as const;
const subprocessOutputLimitBytes = 64 * 1024;
const subprocessTimeoutMs = 60_000;

type ReminderOperation =
  "one_off_reminder.create" | "one_off_reminder.update" | "one_off_reminder.cancel";
type ReminderOutcomeType =
  "one_off_reminder.created" | "one_off_reminder.updated" | "one_off_reminder.cancelled";

interface ProcessResult {
  readonly stdout: string;
}

interface HarnessPrepareResult {
  readonly phase: "prepare";
  readonly operation: ReminderOperation;
  readonly confirmationId: string;
  readonly commandHash: string;
}

interface HarnessConfirmResult {
  readonly phase: "confirm";
  readonly operation: ReminderOperation;
  readonly confirmationId: string;
  readonly receiptHash: string;
  readonly outcomeType: ReminderOutcomeType;
  readonly reminderId: string;
  readonly reminderVersion: number;
  readonly effectiveAt: string;
}

interface HarnessListResult {
  readonly phase: "list";
  readonly reminderId: string;
  readonly reminderVersion: number;
}

interface HarnessPlanFitResult {
  readonly phase: "plan-fit";
  readonly status: "insufficient_history";
  readonly sampleCount: 0;
}

interface CleanupStep {
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

type VerificationPhase =
  | "python-unit-tests"
  | "database-create"
  | "database-migrations"
  | "application-startup"
  | "workspace-and-credential"
  | "plan-fit-read"
  | "create-prepare"
  | "create-confirm"
  | "reminder-list"
  | "intent-materialization"
  | "update-prepare"
  | "update-confirm"
  | "cancel-prepare"
  | "cancel-confirm"
  | "final-state";

const expectedVerificationChecks = [
  "python-unittest",
  "plan-fit-read",
  "one-off-reminder-discovery",
  "no-mutation-before-confirmation",
  "one-off-reminder-intent-invalidation",
  "exact-once-confirmation",
] as const;
const completedVerificationChecks = new Set<string>();

const liveHarness = String.raw`
import hashlib
import json
import os
import sys
import unittest

plugin_root = os.environ["SCHEDULE_VERIFY_PLUGIN_ROOT"]
sys.path.insert(0, plugin_root)
from client import ScheduleClient

class LiveAdapterContract(unittest.TestCase):
    def test_requested_phase(self):
        client = ScheduleClient.from_environment()
        phase = os.environ["SCHEDULE_VERIFY_PHASE"]
        operation = os.environ.get("SCHEDULE_VERIFY_OPERATION")
        confirmation_id = os.environ.get("SCHEDULE_VERIFY_CONFIRMATION_ID")
        if phase == "prepare":
            request_id = os.environ["SCHEDULE_VERIFY_REQUEST_ID"]
            command = json.loads(os.environ["SCHEDULE_VERIFY_COMMAND"])
            self.assertEqual(command["type"], operation)
            prepared = client.prepare_change(request_id, command)
            self.assertEqual(prepared["requestId"], request_id)
            self.assertEqual(prepared["command"], command)
            self.assertEqual(len(prepared["commandHash"]), 64)
            self.assertTrue(prepared["confirmationId"])
            result = {
                "phase": "prepare",
                "operation": operation,
                "confirmationId": prepared["confirmationId"],
                "commandHash": prepared["commandHash"],
            }
        elif phase == "plan-fit":
            guidance = client.get_daily_plan_fit(os.environ["SCHEDULE_VERIFY_PLAN_FIT_DATE"])
            self.assertEqual(
                set(guidance),
                {
                    "forDate",
                    "status",
                    "disposition",
                    "sampleCount",
                    "minimumSamples",
                    "suggestedTargetMinutes",
                    "suggestedTargetTaskCount",
                },
            )
            self.assertEqual(guidance["forDate"], os.environ["SCHEDULE_VERIFY_PLAN_FIT_DATE"])
            self.assertEqual(guidance["status"], "insufficient_history")
            self.assertEqual(guidance["disposition"], "available")
            self.assertEqual(guidance["sampleCount"], 0)
            self.assertEqual(guidance["minimumSamples"], 3)
            self.assertIsNone(guidance["suggestedTargetMinutes"])
            self.assertIsNone(guidance["suggestedTargetTaskCount"])
            result = {
                "phase": "plan-fit",
                "status": guidance["status"],
                "sampleCount": guidance["sampleCount"],
            }
        elif phase == "list":
            page = client.list_one_off_reminders(
                os.environ["SCHEDULE_VERIFY_RANGE_FROM"],
                os.environ["SCHEDULE_VERIFY_RANGE_THROUGH"],
            )
            self.assertEqual(len(page["items"]), 1)
            reminder = page["items"][0]
            self.assertEqual(reminder["id"], os.environ["SCHEDULE_VERIFY_REMINDER_ID"])
            self.assertEqual(reminder["title"], os.environ["SCHEDULE_VERIFY_REMINDER_TITLE"])
            self.assertEqual(
                reminder["scheduledFor"],
                os.environ["SCHEDULE_VERIFY_REMINDER_SCHEDULED_FOR"],
            )
            self.assertIsNone(reminder["cancelledAt"])
            self.assertEqual(reminder["version"], 1)
            result = {
                "phase": "list",
                "reminderId": reminder["id"],
                "reminderVersion": reminder["version"],
            }
        elif phase == "confirm":
            self.assertTrue(confirmation_id)
            confirmed = client.confirm_change(
                confirmation_id,
                os.environ["SCHEDULE_VERIFY_IDEMPOTENCY_KEY"],
                operation,
                os.environ["SCHEDULE_VERIFY_COMMAND_HASH"],
            )
            self.assertEqual(confirmed["receiptVersion"], 2)
            self.assertEqual(confirmed["confirmationId"], confirmation_id)
            self.assertEqual(confirmed["operation"], operation)
            expected_type = {
                "one_off_reminder.create": "one_off_reminder.created",
                "one_off_reminder.update": "one_off_reminder.updated",
                "one_off_reminder.cancel": "one_off_reminder.cancelled",
            }[operation]
            self.assertEqual(confirmed["outcome"]["type"], expected_type)
            reminder = confirmed["outcome"]["oneOffReminder"]
            effective_field = "cancelledAt" if operation == "one_off_reminder.cancel" else "scheduledFor"
            self.assertEqual(set(reminder), {"id", "version", effective_field})
            expected_id = os.environ.get("SCHEDULE_VERIFY_REMINDER_ID")
            if expected_id:
                self.assertEqual(reminder["id"], expected_id)
            self.assertEqual(reminder["version"], int(os.environ["SCHEDULE_VERIFY_REMINDER_VERSION"]))
            self.assertEqual(
                reminder[effective_field],
                os.environ["SCHEDULE_VERIFY_EFFECTIVE_AT"],
            )
            canonical = json.dumps(confirmed, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
            result = {
                "phase": "confirm",
                "operation": operation,
                "confirmationId": confirmed["confirmationId"],
                "receiptHash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                "outcomeType": confirmed["outcome"]["type"],
                "reminderId": reminder["id"],
                "reminderVersion": reminder["version"],
                "effectiveAt": reminder[effective_field],
            }
        else:
            self.fail("unsupported verification phase")
        print("SCHEDULE_HERMES_VERIFY=" + json.dumps(result, separators=(",", ":"), sort_keys=True))

suite = unittest.defaultTestLoader.loadTestsFromTestCase(LiveAdapterContract)
outcome = unittest.TextTestRunner(stream=sys.stderr, verbosity=0).run(suite)
if not outcome.wasSuccessful():
    raise SystemExit(1)
`;

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Hermes adapter verification generated an unsafe database identifier.");
  }
  return `"${verificationDatabase}"`;
}

async function collectCleanupFailures(steps: readonly CleanupStep[]): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      failures.push(step.label);
    }
  }
  return failures;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const retain = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > subprocessOutputLimitBytes) {
        outputExceeded = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    };
    child.stdout?.on("data", retain);
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > subprocessOutputLimitBytes) {
        outputExceeded = true;
        child.kill();
        return;
      }
      stderr.push(chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, subprocessTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error("Hermes adapter verification could not start a subprocess.", { cause: error }),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (outputExceeded) {
        reject(new Error("Hermes adapter verification subprocess output exceeded its safe bound."));
      } else if (timedOut) {
        reject(new Error("Hermes adapter verification subprocess exceeded its time bound."));
      } else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `Hermes adapter verification subprocess failed (${signal === null ? `exit ${String(code)}` : "terminated"})${diagnostic === "" ? "." : `: ${diagnostic}`}`,
          ),
        );
      } else {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
      }
    });
  });
}

async function applyCurrentMigrations(databaseUrl: string): Promise<void> {
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "pnpm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm.cmd", "--filter", "@schedule/database", "run", "db:migrate"]
      : ["--filter", "@schedule/database", "run", "db:migrate"];
  await runProcess(executable, args, {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
  });
}

const reminderOutcomes: Readonly<Record<ReminderOperation, ReminderOutcomeType>> = {
  "one_off_reminder.create": "one_off_reminder.created",
  "one_off_reminder.update": "one_off_reminder.updated",
  "one_off_reminder.cancel": "one_off_reminder.cancelled",
};

function isReminderOperation(value: unknown): value is ReminderOperation {
  return typeof value === "string" && Object.hasOwn(reminderOutcomes, value);
}

function assertUuid(value: unknown): asserts value is string {
  assert.match(
    String(value),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
}

function parseHarnessResult(
  stdout: string,
): HarnessPrepareResult | HarnessConfirmResult | HarnessListResult | HarnessPlanFitResult {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith("SCHEDULE_HERMES_VERIFY="));
  assert.equal(lines.length, 1, "Hermes harness must emit exactly one result marker");
  const value = JSON.parse(lines[0]!.slice("SCHEDULE_HERMES_VERIFY=".length)) as unknown;
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const record = value as Record<string, unknown>;
  if (record.phase === "prepare") {
    assert.deepEqual(Object.keys(record).sort(), [
      "commandHash",
      "confirmationId",
      "operation",
      "phase",
    ]);
    assertUuid(record.confirmationId);
    assert.ok(isReminderOperation(record.operation));
    assert.match(String(record.commandHash), /^[a-f0-9]{64}$/u);
    return record as unknown as HarnessPrepareResult;
  }
  if (record.phase === "list") {
    assert.deepEqual(Object.keys(record).sort(), ["phase", "reminderId", "reminderVersion"]);
    assertUuid(record.reminderId);
    assert.equal(record.reminderVersion, 1);
    return record as unknown as HarnessListResult;
  }
  if (record.phase === "plan-fit") {
    assert.deepEqual(Object.keys(record).sort(), ["phase", "sampleCount", "status"]);
    assert.equal(record.status, "insufficient_history");
    assert.equal(record.sampleCount, 0);
    return record as unknown as HarnessPlanFitResult;
  }
  assert.equal(record.phase, "confirm");
  assert.deepEqual(Object.keys(record).sort(), [
    "confirmationId",
    "effectiveAt",
    "operation",
    "outcomeType",
    "phase",
    "receiptHash",
    "reminderId",
    "reminderVersion",
  ]);
  assertUuid(record.confirmationId);
  assertUuid(record.reminderId);
  assert.ok(isReminderOperation(record.operation));
  assert.match(String(record.receiptHash), /^[a-f0-9]{64}$/u);
  assert.equal(record.outcomeType, reminderOutcomes[record.operation]);
  assert.ok(Number.isInteger(record.reminderVersion) && Number(record.reminderVersion) > 0);
  assert.match(String(record.effectiveAt), /^\d{4}-\d{2}-\d{2}T/u);
  return record as unknown as HarnessConfirmResult;
}

async function runPythonUnitTests(pythonExecutable: string): Promise<void> {
  await runProcess(
    pythonExecutable,
    [
      "-m",
      "unittest",
      "discover",
      "-s",
      path.join("integrations", "hermes-schedule", "tests"),
      "-p",
      "test_*.py",
    ],
    { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  );
}

async function runLiveHarness(
  pythonExecutable: string,
  environment: NodeJS.ProcessEnv,
): Promise<HarnessPrepareResult | HarnessConfirmResult | HarnessListResult | HarnessPlanFitResult> {
  const result = await runProcess(pythonExecutable, ["-c", liveHarness], {
    ...environment,
    PYTHONDONTWRITEBYTECODE: "1",
    SCHEDULE_VERIFY_PLUGIN_ROOT: pluginRoot,
  });
  return parseHarnessResult(result.stdout);
}

const pythonExecutable = process.env.SCHEDULE_VERIFY_PYTHON ?? "python";
const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let connection: DatabaseConnection | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let hermesHome: string | null = null;
let databaseCreated = false;
let verificationFailure: unknown;
let verificationPhase: VerificationPhase = "python-unit-tests";

try {
  // EVIDENCE: hermes-adapter-python-unittest
  // The adapter first passes its deterministic stdlib-only HTTP and state boundary suite.
  await runPythonUnitTests(pythonExecutable);
  completedVerificationChecks.add("python-unittest");

  verificationPhase = "database-create";
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  verificationPhase = "database-migrations";
  await applyCurrentMigrations(disposableDatabaseUrl);

  verificationPhase = "application-startup";
  const activeConnection = createDatabase(disposableDatabaseUrl, 4);
  connection = activeConnection;
  const productUnitOfWork = new PostgresUnitOfWork(activeConnection);
  const integrationUnitOfWork = new PostgresIntegrationUnitOfWork(activeConnection);
  const now = new Date("2026-07-15T07:00:00.000Z");
  const clock = { now: () => new Date(now) };
  app = await buildApp({
    readinessCheck: async () => {
      await activeConnection.sql`select 1`;
    },
    productServices: createProductServices(productUnitOfWork, clock),
    integrationServices: createIntegrationServices(integrationUnitOfWork, clock, pepper, 60),
    integrationApiLimits: { requestsPerMinute: 1_000 },
  });

  verificationPhase = "workspace-and-credential";
  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    payload: { name: "Hermes adapter verification" },
  });
  assert.equal(workspaceResponse.statusCode, 201, "verification workspace creation failed");
  const targetWorkspaceId = workspaceResponse.json<{ id: string }>().id;
  const secret = generateIntegrationCredentialSecret();
  const credential = await new ProvisionIntegrationCredential(integrationUnitOfWork, clock).execute(
    {
      workspaceId: workspaceId(targetWorkspaceId),
      name: "Hermes adapter verifier",
      scopes: ["schedule:read", "schedule:write"],
      secretHash: hashIntegrationCredentialSecret(secret, pepper),
    },
  );
  const token = `${credential.id}.${secret}`;

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  hermesHome = await mkdtemp(path.join(os.tmpdir(), "schedule-hermes-verify-"));
  const harnessEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: hermesHome,
    SCHEDULE_INTEGRATION_URL: `http://127.0.0.1:${String(address.port)}`,
    SCHEDULE_INTEGRATION_TOKEN: token,
  };
  const snapshotPlanFitReadState = async () => {
    const [state] = await activeConnection.sql<
      {
        audit_count: number;
        confirmation_count: number;
        feedback_count: number;
        request_count: number;
      }[]
    >`
      select
        (select count(*)::int from audit_events where workspace_id = ${targetWorkspaceId}) as audit_count,
        (select count(*)::int from integration_confirmations where workspace_id = ${targetWorkspaceId}) as confirmation_count,
        (select count(*)::int from daily_plan_fit_insight_feedback_events where workspace_id = ${targetWorkspaceId}) as feedback_count,
        (select count(*)::int from integration_requests where workspace_id = ${targetWorkspaceId}) as request_count
    `;
    assert.ok(state);
    return state;
  };

  verificationPhase = "plan-fit-read";
  const planFitStateBefore = await snapshotPlanFitReadState();
  // EVIDENCE: hermes-adapter-daily-plan-fit-read
  // The production Python client reads a strict, non-actionable projection without confirmation.
  const planFit = await runLiveHarness(pythonExecutable, {
    ...harnessEnvironment,
    SCHEDULE_VERIFY_PHASE: "plan-fit",
    SCHEDULE_VERIFY_PLAN_FIT_DATE: "2026-07-15",
  });
  assert.equal(planFit.phase, "plan-fit");
  assert.equal(planFit.status, "insufficient_history");
  assert.equal(planFit.sampleCount, 0);
  assert.deepEqual(await snapshotPlanFitReadState(), planFitStateBefore);
  completedVerificationChecks.add("plan-fit-read");

  const prepare = async (operation: ReminderOperation, command: object) => {
    const requestId = randomUUID();
    const result = await runLiveHarness(pythonExecutable, {
      ...harnessEnvironment,
      SCHEDULE_VERIFY_PHASE: "prepare",
      SCHEDULE_VERIFY_OPERATION: operation,
      SCHEDULE_VERIFY_REQUEST_ID: requestId,
      SCHEDULE_VERIFY_COMMAND: JSON.stringify(command),
    });
    assert.equal(result.phase, "prepare");
    assert.equal(result.operation, operation);
    return result;
  };
  const confirmAndReplay = async (
    prepared: HarnessPrepareResult,
    reminderVersion: number,
    effectiveAt: string,
    reminderId?: string,
  ) => {
    const environment = {
      ...harnessEnvironment,
      SCHEDULE_VERIFY_PHASE: "confirm",
      SCHEDULE_VERIFY_OPERATION: prepared.operation,
      SCHEDULE_VERIFY_CONFIRMATION_ID: prepared.confirmationId,
      SCHEDULE_VERIFY_COMMAND_HASH: prepared.commandHash,
      SCHEDULE_VERIFY_IDEMPOTENCY_KEY: randomUUID(),
      SCHEDULE_VERIFY_REMINDER_VERSION: String(reminderVersion),
      SCHEDULE_VERIFY_EFFECTIVE_AT: effectiveAt,
      ...(reminderId === undefined ? {} : { SCHEDULE_VERIFY_REMINDER_ID: reminderId }),
    };
    const first = await runLiveHarness(pythonExecutable, environment);
    const replay = await runLiveHarness(pythonExecutable, environment);
    assert.equal(first.phase, "confirm");
    assert.equal(first.operation, prepared.operation);
    assert.equal(first.reminderVersion, reminderVersion);
    assert.deepEqual(replay, first);
    return first;
  };
  const materialize = async () => {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/workspaces/${targetWorkspaceId}/notification-intents/materializations`,
      payload: materializationRange,
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const assertReminderState = async (
    expected: {
      readonly id: string;
      readonly title: string;
      readonly scheduledFor: string;
      readonly cancelledAt: string | null;
      readonly version: number;
    },
    intentCount: number,
  ) => {
    const [state] = await activeConnection.sql<
      {
        reminder_count: number;
        matching_count: number;
        intent_count: number;
        matching_intent_count: number;
      }[]
    >`
      select
        (
          select count(*)::int from one_off_reminders
          where workspace_id = ${targetWorkspaceId}
        ) as reminder_count,
        (
          select count(*)::int from one_off_reminders
          where workspace_id = ${targetWorkspaceId}
            and id = ${expected.id}
            and title = ${expected.title}
            and scheduled_for = ${expected.scheduledFor}::timestamptz
            and cancelled_at is not distinct from ${expected.cancelledAt}::timestamptz
            and version = ${expected.version}
        ) as matching_count,
        (
          select count(*)::int from notification_intents
          where workspace_id = ${targetWorkspaceId} and one_off_reminder_id = ${expected.id}
        ) as intent_count,
        (
          select count(*)::int from notification_intents
          where workspace_id = ${targetWorkspaceId}
            and one_off_reminder_id = ${expected.id}
            and scheduled_for = ${expected.scheduledFor}::timestamptz
        ) as matching_intent_count
    `;
    assert.deepEqual(state, {
      reminder_count: 1,
      matching_count: 1,
      intent_count: intentCount,
      matching_intent_count: intentCount,
    });
  };
  const assertPreparedState = async (
    prepared: HarnessPrepareResult,
    reminderCount: number,
    intentCount: number,
    requestCount: number,
  ) => {
    const [state] = await activeConnection.sql<
      {
        confirmation_count: number;
        reminder_count: number;
        intent_count: number;
        request_count: number;
      }[]
    >`
      select
        (
          select count(*)::int from integration_confirmations
          where id = ${prepared.confirmationId} and consumed_at is null
        ) as confirmation_count,
        (
          select count(*)::int from one_off_reminders where workspace_id = ${targetWorkspaceId}
        ) as reminder_count,
        (
          select count(*)::int from notification_intents
          where workspace_id = ${targetWorkspaceId}
        ) as intent_count,
        (
          select count(*)::int from integration_requests where credential_id = ${credential.id}
        ) as request_count
    `;
    assert.deepEqual(state, {
      confirmation_count: 1,
      reminder_count: reminderCount,
      intent_count: intentCount,
      request_count: requestCount,
    });
  };

  verificationPhase = "create-prepare";
  const create = await prepare("one_off_reminder.create", {
    type: "one_off_reminder.create",
    title: reminderTitle,
    scheduledFor: reminderScheduledFor,
  });

  // EVIDENCE: hermes-adapter-no-mutation-before-confirmation
  // Every production-client preparation leaves the reminder and pending intent unchanged.
  await assertPreparedState(create, 0, 0, 0);

  const missingProfileResponse = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/confirm",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": "hermes-reminder-profile-required",
    },
    payload: {
      version: "schedule.integration/v1",
      confirmationId: create.confirmationId,
    },
  });
  assert.equal(missingProfileResponse.statusCode, 404);
  assert.equal(
    missingProfileResponse.json<{ error: { code: string } }>().error.code,
    "notification_profile.not_found",
  );
  const [rollbackState] = await activeConnection.sql<
    {
      consumed_confirmation_count: number;
      request_count: number;
      reminder_count: number;
      created_audit_count: number;
      confirmed_audit_count: number;
    }[]
  >`
    select
      (select count(*)::int from integration_confirmations where id = ${create.confirmationId} and consumed_at is not null) as consumed_confirmation_count,
      (select count(*)::int from integration_requests where credential_id = ${credential.id}) as request_count,
      (select count(*)::int from one_off_reminders where workspace_id = ${targetWorkspaceId}) as reminder_count,
      (select count(*)::int from audit_events where workspace_id = ${targetWorkspaceId} and action = 'one_off_reminder.created') as created_audit_count,
      (select count(*)::int from audit_events where workspace_id = ${targetWorkspaceId} and action = 'integration.command_confirmed') as confirmed_audit_count
  `;
  assert.deepEqual(rollbackState, {
    consumed_confirmation_count: 0,
    request_count: 0,
    reminder_count: 0,
    created_audit_count: 0,
    confirmed_audit_count: 0,
  });

  const profileResponse = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${targetWorkspaceId}/notification-profile`,
    payload: { expectedVersion: null, enabled: true, timeZone: "UTC" },
  });
  assert.equal(profileResponse.statusCode, 200, "verification reminder policy setup failed");

  verificationPhase = "create-confirm";
  const created = await confirmAndReplay(create, 1, reminderScheduledFor);
  const createdReminder = {
    id: created.reminderId,
    title: reminderTitle,
    scheduledFor: reminderScheduledFor,
    cancelledAt: null,
    version: 1,
  } as const;
  await assertReminderState(createdReminder, 0);

  verificationPhase = "reminder-list";
  // EVIDENCE: hermes-adapter-one-off-reminder-discovery
  // The production Python client discovers the created reminder through the bounded read API.
  const listed = await runLiveHarness(pythonExecutable, {
    ...harnessEnvironment,
    SCHEDULE_VERIFY_PHASE: "list",
    SCHEDULE_VERIFY_RANGE_FROM: reminderRange.from,
    SCHEDULE_VERIFY_RANGE_THROUGH: reminderRange.through,
    SCHEDULE_VERIFY_REMINDER_ID: created.reminderId,
    SCHEDULE_VERIFY_REMINDER_TITLE: reminderTitle,
    SCHEDULE_VERIFY_REMINDER_SCHEDULED_FOR: reminderScheduledFor,
  });
  assert.equal(listed.phase, "list");
  assert.equal(listed.reminderId, created.reminderId);
  completedVerificationChecks.add("one-off-reminder-discovery");

  verificationPhase = "intent-materialization";
  await materialize();
  await assertReminderState(createdReminder, 1);

  verificationPhase = "update-prepare";
  const update = await prepare("one_off_reminder.update", {
    type: "one_off_reminder.update",
    oneOffReminderId: created.reminderId,
    expectedVersion: 1,
    title: updatedReminderTitle,
    scheduledFor: updatedReminderScheduledFor,
  });
  await assertPreparedState(update, 1, 1, 1);
  await assertReminderState(createdReminder, 1);

  verificationPhase = "update-confirm";
  const updated = await confirmAndReplay(
    update,
    2,
    updatedReminderScheduledFor,
    created.reminderId,
  );
  assert.equal(updated.reminderId, created.reminderId);
  const updatedReminder = {
    ...createdReminder,
    title: updatedReminderTitle,
    scheduledFor: updatedReminderScheduledFor,
    version: 2,
  } as const;
  await assertReminderState(updatedReminder, 0);

  verificationPhase = "intent-materialization";
  await materialize();
  await assertReminderState(updatedReminder, 1);

  verificationPhase = "cancel-prepare";
  const cancel = await prepare("one_off_reminder.cancel", {
    type: "one_off_reminder.cancel",
    oneOffReminderId: created.reminderId,
    expectedVersion: 2,
  });
  await assertPreparedState(cancel, 1, 1, 2);
  await assertReminderState(updatedReminder, 1);
  completedVerificationChecks.add("no-mutation-before-confirmation");

  verificationPhase = "cancel-confirm";
  const cancelled = await confirmAndReplay(cancel, 3, now.toISOString(), created.reminderId);
  assert.equal(cancelled.reminderId, created.reminderId);
  await assertReminderState({ ...updatedReminder, cancelledAt: now.toISOString(), version: 3 }, 0);

  verificationPhase = "final-state";
  // EVIDENCE: hermes-adapter-one-off-reminder-intent-invalidation
  // Reschedule and cancel each delete the currently materialized pending one-off intent.
  // EVIDENCE: hermes-adapter-exact-once-confirmation
  // Separate Python processes replay three durable receipts without duplicate rows or audits.
  const [finalState] = await activeConnection.sql<
    {
      confirmation_count: number;
      consumed_confirmation_count: number;
      request_count: number;
      succeeded_request_count: number;
      prepared_audit_count: number;
      confirmed_audit_count: number;
      created_audit_count: number;
      updated_audit_count: number;
      cancelled_audit_count: number;
    }[]
  >`
    select
      (
        select count(*)::int from integration_confirmations
        where credential_id = ${credential.id}
      ) as confirmation_count,
      (
        select count(*)::int from integration_confirmations
        where credential_id = ${credential.id} and consumed_at is not null
      ) as consumed_confirmation_count,
      (
        select count(*)::int from integration_requests where credential_id = ${credential.id}
      ) as request_count,
      (
        select count(*)::int from integration_requests
        where credential_id = ${credential.id} and status = 'succeeded'
      ) as succeeded_request_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId} and action = 'integration.command_prepared'
      ) as prepared_audit_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId} and action = 'integration.command_confirmed'
      ) as confirmed_audit_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId} and action = 'one_off_reminder.created'
      ) as created_audit_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId} and action = 'one_off_reminder.updated'
      ) as updated_audit_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId} and action = 'one_off_reminder.cancelled'
      ) as cancelled_audit_count
  `;
  assert.deepEqual(finalState, {
    confirmation_count: 3,
    consumed_confirmation_count: 3,
    request_count: 3,
    succeeded_request_count: 3,
    prepared_audit_count: 3,
    confirmed_audit_count: 3,
    created_audit_count: 1,
    updated_audit_count: 1,
    cancelled_audit_count: 1,
  });
  completedVerificationChecks.add("one-off-reminder-intent-invalidation");
  completedVerificationChecks.add("exact-once-confirmation");
} catch (error) {
  verificationFailure = error;
}

const cleanupSteps: CleanupStep[] = [];
if (app !== null) cleanupSteps.push({ label: "Fastify application", run: () => app!.close() });
if (connection !== null) {
  cleanupSteps.push({ label: "disposable database connection", run: () => connection!.close() });
}
if (databaseCreated) {
  cleanupSteps.push({
    label: "disposable database",
    run: () =>
      adminConnection.sql.unsafe(
        `drop database if exists ${quotedVerificationDatabase()} with (force)`,
      ),
  });
}
cleanupSteps.push({
  label: "administrative database connection",
  run: () => adminConnection.close(),
});
if (hermesHome !== null) {
  cleanupSteps.push({
    label: "disposable Hermes home",
    run: () => rm(hermesHome!, { recursive: true, force: true }),
  });
}
const cleanupFailures = await collectCleanupFailures(cleanupSteps);

if (verificationFailure !== undefined) {
  throw new Error(`Hermes adapter verification failed safely during ${verificationPhase}.`, {
    cause: verificationFailure,
  });
}
if (cleanupFailures.length > 0) {
  throw new Error(`Hermes adapter verification cleanup failed for: ${cleanupFailures.join(", ")}.`);
}
assert.deepEqual([...completedVerificationChecks], expectedVerificationChecks);
process.stdout.write(
  `Hermes adapter verification passed: ${expectedVerificationChecks.join(",")}\n`,
);
