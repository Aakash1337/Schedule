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
const workItemTitle = "Hermes adapter verification item";
const subprocessOutputLimitBytes = 64 * 1024;
const subprocessTimeoutMs = 60_000;

interface ProcessResult {
  readonly stdout: string;
}

interface HarnessPrepareResult {
  readonly phase: "prepare";
  readonly confirmationId: string;
  readonly commandHash: string;
}

interface HarnessConfirmResult {
  readonly phase: "confirm";
  readonly confirmationId: string;
  readonly receiptHash: string;
  readonly outcomeType: "work_item.created";
  readonly workItemId: string;
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
  | "adapter-prepare"
  | "prepared-state"
  | "adapter-confirm"
  | "confirmed-state";

const expectedVerificationChecks = [
  "python-unittest",
  "no-mutation-before-confirmation",
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
        confirmation_id = os.environ.get("SCHEDULE_VERIFY_CONFIRMATION_ID")
        if phase == "prepare":
            request_id = os.environ["SCHEDULE_VERIFY_REQUEST_ID"]
            prepared = client.prepare_change(
                request_id,
                {
                    "type": "work_item.create",
                    "title": os.environ["SCHEDULE_VERIFY_WORK_TITLE"],
                    "status": "planned",
                    "priority": "medium",
                    "planningDurationMinutes": 30,
                    "dueOn": "2026-07-16",
                },
            )
            self.assertEqual(prepared["requestId"], request_id)
            self.assertEqual(prepared["command"]["type"], "work_item.create")
            self.assertEqual(prepared["command"]["title"], os.environ["SCHEDULE_VERIFY_WORK_TITLE"])
            self.assertEqual(len(prepared["commandHash"]), 64)
            self.assertTrue(prepared["confirmationId"])
            result = {
                "phase": "prepare",
                "confirmationId": prepared["confirmationId"],
                "commandHash": prepared["commandHash"],
            }
        elif phase == "confirm":
            self.assertTrue(confirmation_id)
            confirmed = client.confirm_change(
                confirmation_id,
                os.environ["SCHEDULE_VERIFY_IDEMPOTENCY_KEY"],
                "work_item.create",
                os.environ["SCHEDULE_VERIFY_COMMAND_HASH"],
            )
            self.assertEqual(confirmed["receiptVersion"], 2)
            self.assertEqual(confirmed["confirmationId"], confirmation_id)
            self.assertEqual(confirmed["operation"], "work_item.create")
            self.assertEqual(confirmed["outcome"]["type"], "work_item.created")
            self.assertEqual(confirmed["outcome"]["workItem"]["status"], "planned")
            self.assertIsNone(confirmed["outcome"]["workItem"]["parentWorkItemId"])
            self.assertNotIn("title", confirmed["outcome"]["workItem"])
            canonical = json.dumps(confirmed, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
            result = {
                "phase": "confirm",
                "confirmationId": confirmed["confirmationId"],
                "receiptHash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                "outcomeType": confirmed["outcome"]["type"],
                "workItemId": confirmed["outcome"]["workItem"]["id"],
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
      }
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
        reject(
          new Error(
            `Hermes adapter verification subprocess failed (${signal === null ? `exit ${String(code)}` : "terminated"}).`,
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

function parseHarnessResult(stdout: string): HarnessPrepareResult | HarnessConfirmResult {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith("SCHEDULE_HERMES_VERIFY="));
  assert.equal(lines.length, 1, "Hermes harness must emit exactly one result marker");
  const value = JSON.parse(lines[0]!.slice("SCHEDULE_HERMES_VERIFY=".length)) as unknown;
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const record = value as Record<string, unknown>;
  if (record.phase === "prepare") {
    assert.deepEqual(Object.keys(record).sort(), ["commandHash", "confirmationId", "phase"]);
    assert.match(
      String(record.confirmationId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    assert.match(String(record.commandHash), /^[a-f0-9]{64}$/u);
    return record as unknown as HarnessPrepareResult;
  }
  assert.equal(record.phase, "confirm");
  assert.deepEqual(Object.keys(record).sort(), [
    "confirmationId",
    "outcomeType",
    "phase",
    "receiptHash",
    "workItemId",
  ]);
  assert.match(
    String(record.confirmationId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.match(String(record.receiptHash), /^[a-f0-9]{64}$/u);
  assert.equal(record.outcomeType, "work_item.created");
  assert.match(
    String(record.workItemId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
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
): Promise<HarnessPrepareResult | HarnessConfirmResult> {
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
  const requestId = randomUUID();
  const idempotencyKey = randomUUID();
  const harnessEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: hermesHome,
    SCHEDULE_INTEGRATION_URL: `http://127.0.0.1:${String(address.port)}`,
    SCHEDULE_INTEGRATION_TOKEN: token,
    SCHEDULE_VERIFY_IDEMPOTENCY_KEY: idempotencyKey,
    SCHEDULE_VERIFY_REQUEST_ID: requestId,
    SCHEDULE_VERIFY_WORK_TITLE: workItemTitle,
  };

  verificationPhase = "adapter-prepare";
  const prepared = await runLiveHarness(pythonExecutable, {
    ...harnessEnvironment,
    SCHEDULE_VERIFY_PHASE: "prepare",
  });
  assert.equal(prepared.phase, "prepare");

  verificationPhase = "prepared-state";
  // EVIDENCE: hermes-adapter-no-mutation-before-confirmation
  // The production Python client prepares against the real API, while product state stays unchanged.
  const [preparedState] = await activeConnection.sql<
    {
      confirmation_count: number;
      request_count: number;
      work_item_count: number;
      prepared_audit_count: number;
      confirmed_audit_count: number;
    }[]
  >`
    select
      (select count(*)::int from integration_confirmations where id = ${prepared.confirmationId}) as confirmation_count,
      (select count(*)::int from integration_requests where credential_id = ${credential.id}) as request_count,
      (select count(*)::int from work_items where workspace_id = ${targetWorkspaceId}) as work_item_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId}
          and action = 'integration.command_prepared'
          and data ->> 'requestId' = ${requestId}
      ) as prepared_audit_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId}
          and action = 'integration.command_confirmed'
      ) as confirmed_audit_count
  `;
  assert.deepEqual(preparedState, {
    confirmation_count: 1,
    request_count: 0,
    work_item_count: 0,
    prepared_audit_count: 1,
    confirmed_audit_count: 0,
  });
  completedVerificationChecks.add("no-mutation-before-confirmation");

  const confirmEnvironment = {
    ...harnessEnvironment,
    SCHEDULE_VERIFY_PHASE: "confirm",
    SCHEDULE_VERIFY_CONFIRMATION_ID: prepared.confirmationId,
    SCHEDULE_VERIFY_COMMAND_HASH: prepared.commandHash,
  };
  verificationPhase = "adapter-confirm";
  const firstConfirmation = await runLiveHarness(pythonExecutable, confirmEnvironment);
  const replayedConfirmation = await runLiveHarness(pythonExecutable, confirmEnvironment);
  assert.equal(firstConfirmation.phase, "confirm");
  assert.equal(replayedConfirmation.phase, "confirm");
  assert.deepEqual(replayedConfirmation, firstConfirmation);

  verificationPhase = "confirmed-state";
  // EVIDENCE: hermes-adapter-exact-once-confirmation
  // Separate Python client processes replay one durable receipt and produce one mutation and audit.
  const [confirmedState] = await activeConnection.sql<
    {
      confirmation_count: number;
      consumed_confirmation_count: number;
      succeeded_request_count: number;
      work_item_count: number;
      confirmed_audit_count: number;
    }[]
  >`
    select
      (select count(*)::int from integration_confirmations where id = ${prepared.confirmationId}) as confirmation_count,
      (
        select count(*)::int from integration_confirmations
        where id = ${prepared.confirmationId} and consumed_at is not null
      ) as consumed_confirmation_count,
      (
        select count(*)::int from integration_requests
        where credential_id = ${credential.id}
          and idempotency_key = ${idempotencyKey}
          and status = 'succeeded'
      ) as succeeded_request_count,
      (
        select count(*)::int from work_items
        where workspace_id = ${targetWorkspaceId}
          and id = ${firstConfirmation.workItemId}
          and title = ${workItemTitle}
      ) as work_item_count,
      (
        select count(*)::int from audit_events
        where workspace_id = ${targetWorkspaceId}
          and action = 'integration.command_confirmed'
          and data ->> 'confirmationId' = ${prepared.confirmationId}
      ) as confirmed_audit_count
  `;
  assert.deepEqual(confirmedState, {
    confirmation_count: 1,
    consumed_confirmation_count: 1,
    succeeded_request_count: 1,
    work_item_count: 1,
    confirmed_audit_count: 1,
  });
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
  throw new Error(`Hermes adapter verification failed safely during ${verificationPhase}.`);
}
if (cleanupFailures.length > 0) {
  throw new Error(`Hermes adapter verification cleanup failed for: ${cleanupFailures.join(", ")}.`);
}
assert.deepEqual([...completedVerificationChecks], expectedVerificationChecks);
process.stdout.write(
  `Hermes adapter verification passed: ${expectedVerificationChecks.join(",")}\n`,
);
