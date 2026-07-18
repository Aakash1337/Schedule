import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CreateWorkItem,
  GenerateDailyPlan,
  RecordPlanItemActivity,
  UpdateWorkItem,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  enableHostedWorkItemSyncCapture,
  PostgresHostedWorkItemSyncStore,
  PostgresUnitOfWork,
  purgeHostedWorkItemSyncChanges,
  type DatabaseConnection,
} from "../packages/database/src/index.js";
import {
  browserSessionId,
  createDailyPlanningRequest,
  localDate,
  userId,
  workspaceId,
  type WorkItem,
} from "../packages/domain/src/index.js";

import { buildApp } from "../apps/api/src/app.js";
import {
  HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE,
  HOSTED_WORK_ITEM_SYNC_CHANGES_ROUTE,
  registerHostedWorkItemBoundary,
  type HostedWorkItemServices,
} from "../apps/api/src/hosted-work-item-routes.js";

function requireLocalVerificationDatabaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Hosted work-item sync verification requires a local PostgreSQL database.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.pathname.length <= 1 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Hosted work-item sync verification requires a local PostgreSQL database.");
  }
  return url.toString();
}

const sourceDatabaseUrl = requireLocalVerificationDatabaseUrl(
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule",
);
const databaseName = `schedule_host_sync_verify_${randomUUID().replaceAll("-", "")}`;
const databaseNamePattern = /^schedule_host_sync_verify_[a-f0-9]{32}$/u;
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/database/drizzle",
);
const adminUrl = new URL(sourceDatabaseUrl);
adminUrl.pathname = "/postgres";
const verificationUrl = new URL(sourceDatabaseUrl);
verificationUrl.pathname = `/${databaseName}`;

function quotedDatabase(): string {
  if (!databaseNamePattern.test(databaseName))
    throw new Error("Unsafe sync verification database.");
  return `"${databaseName}"`;
}

interface CleanupStep {
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

async function collectCleanupFailures(steps: readonly CleanupStep[]): Promise<readonly Error[]> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      // Driver diagnostics can contain credentials; retain only deterministic labels.
      failures.push(new Error(`Cleanup failed: ${step.label}.`));
    }
  }
  return failures;
}

async function waitForBlockedSession(
  observer: DatabaseConnection,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [session] = await observer.sql<{ blockers: number; waitEventType: string | null }[]>`
      select cardinality(pg_blocking_pids(pid))::integer as blockers,
        wait_event_type as "waitEventType"
      from pg_stat_activity
      where datname = current_database() and application_name = ${applicationName}
    `;
    if (session?.waitEventType === "Lock" && session.blockers > 0) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${applicationName} to reach its lock barrier.`);
}

async function migrationEntries(): Promise<readonly { idx: number; tag: string }[]> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries?: { idx?: unknown; tag?: unknown }[] };
  if (!Array.isArray(journal.entries)) throw new Error("Migration journal is missing entries.");
  const entries = journal.entries.map((entry) => {
    if (typeof entry.idx !== "number" || typeof entry.tag !== "string") {
      throw new Error("Migration journal contains an invalid entry.");
    }
    return { idx: entry.idx, tag: entry.tag };
  });
  entries.forEach((entry, index) => assert.equal(entry.idx, index));
  assert.match(entries[40]?.tag ?? "", /^0040_/u);
  assert.equal(entries[41]?.tag, "0041_hosted_work_item_sync");
  return entries;
}

async function applyMigration(connection: DatabaseConnection, tag: string): Promise<void> {
  const migration = await readFile(path.join(migrationsFolder, `${tag}.sql`), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await connection.sql.unsafe(statement);
  }
}

function route(route: string, workspace: string): string {
  return route.replace(":workspaceId", workspace);
}

function isCorruptStoreFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "HostedWorkItemSyncStoreError" &&
    "reason" in error &&
    error.reason === "corrupt"
  );
}

async function syncState(connection: DatabaseConnection, workspace: string) {
  const [state] = await connection.sql<{ head: string; minimum: string; changes: number }[]>`
    select state.head_cursor::text as head, state.minimum_cursor::text as minimum,
      count(change.cursor)::integer as changes
    from hosted_work_item_sync_states as state
    left join hosted_work_item_sync_changes as change
      on change.workspace_id = state.workspace_id
    where state.workspace_id = ${workspace}
    group by state.workspace_id
  `;
  assert.ok(state, "workspace sync state must exist");
  return state;
}

function publicItem(item: WorkItem) {
  return {
    id: item.id,
    parentWorkItemId: item.parentWorkItemId,
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    dueOn: item.dueOn,
    planningDurationMinutes: item.planningDurationMinutes,
    version: item.version,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

async function currentItems(connection: DatabaseConnection, workspace: string) {
  return connection.sql<
    {
      id: string;
      parentWorkItemId: string | null;
      title: string;
      description: string | null;
      status: WorkItem["status"];
      priority: WorkItem["priority"];
      dueOn: string | null;
      planningDurationMinutes: number | null;
      version: number;
      createdAt: string | Date;
      updatedAt: string | Date;
    }[]
  >`
    select id::text, parent_work_item_id::text as "parentWorkItemId", title, description,
      status::text, priority::text, due_on::text as "dueOn",
      planning_duration_minutes as "planningDurationMinutes", version,
      created_at as "createdAt", updated_at as "updatedAt"
    from work_items as item where item.workspace_id = ${workspace} order by item.id
  `;
}

async function createSyncApp(
  connection: DatabaseConnection,
  allowedWorkspaces: ReadonlySet<string>,
): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const principal = {
    userId: userId("00000000-0000-4000-8000-000000000101"),
    sessionId: browserSessionId("00000000-0000-4000-8000-000000000201"),
    idleExpiresAt: new Date("2026-07-19T00:00:00.000Z"),
    absoluteExpiresAt: new Date("2026-07-20T00:00:00.000Z"),
  };
  const store = new PostgresHostedWorkItemSyncStore(connection);
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected non-sync hosted operation.");
  };
  const services: HostedWorkItemServices = {
    syncCursorSigningKey: new Uint8Array(32).fill(17),
    createWorkItem: unexpected,
    listWorkItems: unexpected,
    listWorkItemSnapshot: unexpected,
    updateWorkItemStatus: unexpected,
    bootstrapWorkItemSync: ({ authorization, limit, checkpoint, afterId }) =>
      store.bootstrap(authorization.workspaceId, {
        limit,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(afterId === undefined ? {} : { afterId }),
      }),
    listWorkItemSyncChanges: ({ authorization, limit, afterCursor, throughCursor }) =>
      store.listChanges(authorization.workspaceId, {
        limit,
        afterCursor,
        ...(throughCursor === undefined ? {} : { throughCursor }),
      }),
  };
  const app = await buildApp();
  await registerHostedWorkItemBoundary(
    app,
    {
      csrfGuard: { verify: () => true },
      authenticator: { authenticate: async () => principal },
      authorizer: {
        execute: async (candidate, requestedWorkspace) =>
          allowedWorkspaces.has(requestedWorkspace)
            ? Object.freeze({ ...candidate, workspaceId: requestedWorkspace })
            : null,
      },
    },
    services,
  );
  await app.ready();
  return app;
}

const admin = createDatabase(adminUrl.toString(), 1);
let databaseCreated = false;
let connection: DatabaseConnection | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let verificationError: unknown;
const raceConnections: { readonly label: string; readonly connection: DatabaseConnection }[] = [];

try {
  await admin.sql.unsafe(`create database ${quotedDatabase()} owner schedule`);
  databaseCreated = true;
  connection = createDatabase(verificationUrl.toString(), 12);
  await connection.sql`set client_min_messages = warning`;
  const migrations = await migrationEntries();
  for (const migration of migrations.filter((entry) => entry.idx < 41)) {
    await applyMigration(connection, migration.tag);
  }

  const legacyWorkspace = workspaceId(randomUUID());
  const legacyItemId = randomUUID();
  await connection.sql`
    insert into workspaces (id, name) values (${legacyWorkspace}, 'Legacy sync upgrade')
  `;
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${legacyItemId}, ${legacyWorkspace}, 'Legacy item')
  `;
  await applyMigration(connection, migrations[41]!.tag);

  assert.deepEqual(await syncState(connection, legacyWorkspace), {
    head: "0",
    minimum: "0",
    changes: 0,
  });
  const [legacyCursor] = await connection.sql<{ cursor: string }[]>`
    select item.hosted_sync_cursor::text as cursor from work_items as item
    where item.workspace_id = ${legacyWorkspace} and item.id = ${legacyItemId}
  `;
  assert.equal(legacyCursor?.cursor, "0");
  const [disabledCapability] = await connection.sql<{ enabled: boolean }[]>`
    select capture_enabled as enabled from hosted_work_item_sync_capability where singleton
  `;
  assert.equal(disabledCapability?.enabled, false);
  await connection.sql`
    update work_items set title = 'Legacy item before enrollment', version = version + 1,
      updated_at = clock_timestamp()
    where workspace_id = ${legacyWorkspace} and id = ${legacyItemId}
  `;
  assert.deepEqual(await syncState(connection, legacyWorkspace), {
    head: "0",
    minimum: "0",
    changes: 0,
  });
  const [preEnrollmentCursor] = await connection.sql<{ cursor: string }[]>`
    select item.hosted_sync_cursor::text as cursor from work_items as item
    where item.workspace_id = ${legacyWorkspace} and item.id = ${legacyItemId}
  `;
  assert.equal(preEnrollmentCursor?.cursor, "0");
  const store = new PostgresHostedWorkItemSyncStore(connection);
  await assert.rejects(store.bootstrap(legacyWorkspace, { limit: 1 }), isCorruptStoreFailure);
  await assert.rejects(
    store.listChanges(legacyWorkspace, { afterCursor: "0", limit: 1 }),
    isCorruptStoreFailure,
  );
  const fenceWorkspace = workspaceId(randomUUID());
  const fenceItemId = randomUUID();
  await connection.sql`
    insert into workspaces (id, name) values (${fenceWorkspace}, 'Sync activation fence')
  `;
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${fenceItemId}, ${fenceWorkspace}, 'Before sync activation')
  `;
  const blockerName = "schedule_sync_fence_blocker";
  const enablerName = "schedule_sync_fence_enabler";
  const mutatorName = "schedule_sync_fence_mutator";
  const raceOptions = { statementTimeoutMs: 20_000 } as const;
  const blocker = createDatabase(verificationUrl.toString(), 1, {
    ...raceOptions,
    applicationName: blockerName,
  });
  const enabler = createDatabase(verificationUrl.toString(), 1, {
    ...raceOptions,
    applicationName: enablerName,
  });
  const mutator = createDatabase(verificationUrl.toString(), 1, {
    ...raceOptions,
    applicationName: mutatorName,
  });
  raceConnections.push(
    { label: "sync fence blocker connection", connection: blocker },
    { label: "sync fence enabler connection", connection: enabler },
    { label: "sync fence mutator connection", connection: mutator },
  );
  let markBlockerReady!: () => void;
  let releaseBlocker!: () => void;
  const blockerReady = new Promise<void>((resolve) => (markBlockerReady = resolve));
  const blockerRelease = new Promise<void>((resolve) => (releaseBlocker = resolve));
  const blockerTransaction = blocker.sql.begin(async (transaction) => {
    await transaction`
      select capture_enabled from hosted_work_item_sync_capability where singleton for update
    `;
    markBlockerReady();
    await blockerRelease;
  });
  let activation: Promise<void> | undefined;
  let mutation: Promise<unknown> | undefined;
  try {
    await Promise.race([
      blockerReady,
      blockerTransaction.then(() => {
        throw new Error("Sync fence blocker exited before reaching its lock barrier.");
      }),
    ]);
    activation = enableHostedWorkItemSyncCapture(enabler);
    await waitForBlockedSession(connection, enablerName);
    mutation = Promise.resolve(mutator.sql`
      update work_items set title = 'Activated behind fence', version = version + 1,
        updated_at = clock_timestamp()
      where workspace_id = ${fenceWorkspace} and id = ${fenceItemId}
    `);
    await waitForBlockedSession(connection, mutatorName);
    releaseBlocker();
    await Promise.all([blockerTransaction, activation, mutation]);
  } finally {
    releaseBlocker();
    await Promise.allSettled(
      [blockerTransaction, activation, mutation].filter(
        (operation): operation is Promise<unknown> => operation !== undefined,
      ),
    );
  }
  assert.deepEqual(await syncState(connection, fenceWorkspace), {
    head: "1",
    minimum: "0",
    changes: 1,
  });
  const [fencedChange] = await connection.sql<{ cursor: string; title: string }[]>`
    select cursor::text, title from hosted_work_item_sync_changes
    where workspace_id = ${fenceWorkspace} and work_item_id = ${fenceItemId}
  `;
  assert.deepEqual(fencedChange, { cursor: "1", title: "Activated behind fence" });
  await enableHostedWorkItemSyncCapture(connection);
  await assert.rejects(
    connection.sql`
      update hosted_work_item_sync_capability
      set capture_enabled = false, enabled_at = null where singleton
    `,
    /immutable after enrollment/u,
  );
  const legacyBootstrap = await store.bootstrap(legacyWorkspace, { limit: 10 });
  assert.equal(legacyBootstrap.checkpoint, "0");
  assert.equal(legacyBootstrap.nextAfterId, null);
  assert.deepEqual(
    legacyBootstrap.items.map((item) => [item.id, item.title]),
    [[legacyItemId, "Legacy item before enrollment"]],
  );
  await connection.sql`
    update work_items set title = 'Legacy item updated', version = version + 1,
      updated_at = clock_timestamp()
    where workspace_id = ${legacyWorkspace} and id = ${legacyItemId}
  `;
  assert.deepEqual(await syncState(connection, legacyWorkspace), {
    head: "1",
    minimum: "0",
    changes: 1,
  });
  const [legacyMutation] = await connection.sql<
    { itemCursor: string; changeCursor: string; kind: string }[]
  >`
    select item.hosted_sync_cursor::text as "itemCursor", change.cursor::text as "changeCursor",
      change.kind::text as kind
    from work_items as item
    join hosted_work_item_sync_changes as change
      on change.workspace_id = item.workspace_id and change.work_item_id = item.id
    where item.workspace_id = ${legacyWorkspace} and item.id = ${legacyItemId}
    order by change.cursor
  `;
  assert.deepEqual(legacyMutation, { itemCursor: "1", changeCursor: "1", kind: "upsert" });
  for (const migration of migrations.filter((entry) => entry.idx > 41)) {
    await applyMigration(connection, migration.tag);
  }

  const triggerDefinitions = await connection.sql<{ definition: string }[]>`
    select pg_get_triggerdef(trigger.oid) as definition
    from pg_trigger as trigger
    join pg_class as target on target.oid = trigger.tgrelid
    where target.relname = 'work_items' and not trigger.tgisinternal
  `;
  assert.ok(
    triggerDefinitions.some((row) =>
      /AFTER INSERT OR DELETE OR UPDATE[\s\S]*hosted_work_item_sync/iu.test(row.definition),
    ),
    "migrations must install one complete AFTER-row work-item sync capture trigger",
  );

  const primary = workspaceId(randomUUID());
  const secondary = workspaceId(randomUUID());
  const activityWorkspace = workspaceId(randomUUID());
  const reconstructionWorkspace = workspaceId(randomUUID());
  const retentionWorkspace = workspaceId(randomUUID());
  const cascadeWorkspace = workspaceId(randomUUID());
  const corruptWorkspace = workspaceId(randomUUID());
  const deniedWorkspace = workspaceId(randomUUID());
  for (const [id, name] of [
    [primary, "Sync primary"],
    [secondary, "Sync secondary"],
    [activityWorkspace, "Sync activity"],
    [reconstructionWorkspace, "Sync reconstruction"],
    [retentionWorkspace, "Sync retention"],
    [cascadeWorkspace, "Sync cascade"],
    [corruptWorkspace, "Sync corrupt state"],
    [deniedWorkspace, "Sync denied"],
  ] as const) {
    await connection.sql`insert into workspaces (id, name) values (${id}, ${name})`;
  }
  assert.deepEqual(await syncState(connection, corruptWorkspace), {
    head: "0",
    minimum: "0",
    changes: 0,
  });
  assert.deepEqual(await store.bootstrap(corruptWorkspace, { limit: 1 }), {
    items: [],
    checkpoint: "0",
    nextAfterId: null,
  });
  const corruptItemId = randomUUID();
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${corruptItemId}, ${corruptWorkspace}, 'Corruption sentinel')
  `;
  assert.deepEqual(await syncState(connection, corruptWorkspace), {
    head: "1",
    minimum: "0",
    changes: 1,
  });
  await connection.sql`
    alter table hosted_work_item_sync_states
      disable trigger hosted_work_item_sync_states_delete_guard
  `;
  try {
    await connection.sql`
      delete from hosted_work_item_sync_states where workspace_id = ${corruptWorkspace}
    `;
  } finally {
    await connection.sql`
      alter table hosted_work_item_sync_states
        enable trigger hosted_work_item_sync_states_delete_guard
    `;
  }
  const [stateDeleteGuard] = await connection.sql<{ enabled: string }[]>`
    select trigger.tgenabled::text as enabled from pg_trigger as trigger
    where trigger.tgname = 'hosted_work_item_sync_states_delete_guard'
      and trigger.tgrelid = 'hosted_work_item_sync_states'::regclass
  `;
  assert.equal(stateDeleteGuard?.enabled, "O");
  await assert.rejects(store.bootstrap(corruptWorkspace, { limit: 1 }), isCorruptStoreFailure);
  await assert.rejects(
    store.listChanges(corruptWorkspace, { afterCursor: "0", limit: 1 }),
    isCorruptStoreFailure,
  );
  await assert.rejects(
    connection.sql`
      update work_items set title = 'Must roll back'
      where workspace_id = ${corruptWorkspace} and id = ${corruptItemId}
    `,
    /hosted work item sync state is missing/u,
  );
  await assert.rejects(store.bootstrap(corruptWorkspace, { limit: 1 }), isCorruptStoreFailure);
  const [corruptionSentinel] = await connection.sql<{ cursor: string; title: string }[]>`
    select hosted_sync_cursor::text as cursor, title from work_items
    where workspace_id = ${corruptWorkspace} and id = ${corruptItemId}
  `;
  assert.deepEqual(corruptionSentinel, { cursor: "1", title: "Corruption sentinel" });

  let now = new Date("2026-07-18T08:00:00.000Z");
  const clock = { now: () => now };
  const unitOfWork = new PostgresUnitOfWork(connection);
  const creator = new CreateWorkItem(unitOfWork, clock);
  const updater = new UpdateWorkItem(unitOfWork, clock);
  const generic = await creator.execute({
    workspaceId: primary,
    title: "Generic mutation",
    description: "Initial",
    priority: "high",
    dueOn: localDate("2026-07-25"),
    planningDurationMinutes: 45,
  });
  assert.equal(generic.version, 1, "repository create must return the accepted row");
  now = new Date("2026-07-18T08:01:00.000Z");
  const updatedGeneric = await updater.execute({
    workspaceId: primary,
    workItemId: generic.id,
    expectedVersion: generic.version,
    title: "Generic mutation updated",
  });
  assert.deepEqual(
    { title: updatedGeneric.title, version: updatedGeneric.version },
    { title: "Generic mutation updated", version: 2 },
    "repository update must return the accepted row",
  );
  assert.equal((await syncState(connection, primary)).head, "2");
  const beforeSuppressedConflict = await syncState(connection, primary);
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${generic.id}, ${primary}, 'Suppressed conflict')
    on conflict (id) do nothing
  `;
  assert.deepEqual(
    await syncState(connection, primary),
    beforeSuppressedConflict,
    "a conflict-suppressed insert must not publish a phantom change",
  );
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${generic.id}, ${primary}, 'Ignored conflict title')
    on conflict (id) do update set title = work_items.title
  `;
  assert.deepEqual(
    await syncState(connection, primary),
    beforeSuppressedConflict,
    "a no-op conflict update must not publish a phantom change",
  );
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${generic.id}, ${primary}, 'Meaningful conflict update')
    on conflict (id) do update set title = excluded.title,
      version = work_items.version + 1, updated_at = clock_timestamp()
  `;
  const afterMeaningfulConflict = await syncState(connection, primary);
  assert.deepEqual(afterMeaningfulConflict, { head: "3", minimum: "0", changes: 3 });
  const [meaningfulConflictChange] = await connection.sql<
    { cursor: string; title: string; version: number }[]
  >`
    select change.cursor::text as cursor, change.title, change.version
    from hosted_work_item_sync_changes as change
    where change.workspace_id = ${primary}
    order by change.cursor desc limit 1
  `;
  assert.deepEqual(meaningfulConflictChange, {
    cursor: "3",
    title: "Meaningful conflict update",
    version: 3,
  });
  const [beforeManagedCursorEdit] = await connection.sql<{ cursor: string }[]>`
    select item.hosted_sync_cursor::text as cursor from work_items as item
    where item.workspace_id = ${primary} and item.id = ${generic.id}
  `;
  await assert.rejects(
    connection.sql`
      update work_items set hosted_sync_cursor = hosted_sync_cursor + 10
      where workspace_id = ${primary} and id = ${generic.id}
    `,
    /managed internally/u,
  );
  assert.deepEqual(await syncState(connection, primary), afterMeaningfulConflict);
  const [afterManagedCursorEdit] = await connection.sql<{ cursor: string }[]>`
    select item.hosted_sync_cursor::text as cursor from work_items as item
    where item.workspace_id = ${primary} and item.id = ${generic.id}
  `;
  assert.deepEqual(afterManagedCursorEdit, beforeManagedCursorEdit);

  const beforeDeniedSyncWrites = await syncState(connection, primary);
  await assert.rejects(
    connection.sql`
      insert into hosted_work_item_sync_changes (
        workspace_id, cursor, kind, work_item_id, recorded_at
      ) values (${primary}, 999, 'delete', ${randomUUID()}, clock_timestamp())
    `,
    /immutable while retained/u,
  );
  await assert.rejects(
    connection.sql`
      update hosted_work_item_sync_changes set recorded_at = recorded_at
      where workspace_id = ${primary} and cursor = 1
    `,
    /immutable while retained/u,
  );
  await assert.rejects(
    connection.sql`
      delete from hosted_work_item_sync_changes
      where workspace_id = ${primary} and cursor = 1
    `,
    /immutable while retained/u,
  );
  await assert.rejects(
    connection.sql`
      insert into hosted_work_item_sync_states (
        workspace_id, head_cursor, minimum_cursor, updated_at
      ) values (${primary}, 0, 0, clock_timestamp())
    `,
    /state transition is not allowed/u,
  );
  await assert.rejects(
    connection.sql`
      update hosted_work_item_sync_states set head_cursor = head_cursor + 1
      where workspace_id = ${primary}
    `,
    /state transition is not allowed/u,
  );
  await assert.rejects(
    connection.sql`
      delete from hosted_work_item_sync_states where workspace_id = ${primary}
    `,
    /cannot be deleted independently/u,
  );
  assert.deepEqual(
    await syncState(connection, primary),
    beforeDeniedSyncWrites,
    "direct sync state and change writes must fail without mutation",
  );

  const activityItem = await creator.execute({
    workspaceId: activityWorkspace,
    title: "Direct activity source",
    planningDurationMinutes: 30,
  });
  const planningDate = localDate("2026-07-18");
  const plan = await new GenerateDailyPlan(unitOfWork, clock).execute({
    request: createDailyPlanningRequest({
      workspaceId: activityWorkspace,
      date: planningDate,
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: new Date("2026-07-18T09:00:00.000Z"),
          endsAt: new Date("2026-07-18T10:00:00.000Z"),
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: [],
      seed: "hosted-sync-direct-activity",
      requestRevision: 1,
    }),
  });
  assert.equal(plan.items[0]?.workItemId, activityItem.id);
  now = new Date("2026-07-18T10:01:00.000Z");
  await new RecordPlanItemActivity(unitOfWork, clock).execute({
    workspaceId: activityWorkspace,
    date: planningDate,
    expectedPlanId: plan.id,
    itemId: plan.items[0]!.id,
    expectedHeadVersion: 1,
    type: "completed",
    occurredAt: new Date("2026-07-18T10:00:00.000Z"),
    timeZone: "UTC",
    durationMinutes: 30,
    idempotencyKey: "hosted-sync-direct-activity",
  });
  const activityChanges = await connection.sql<
    { cursor: string; status: string; version: number }[]
  >`
    select change.cursor::text, change.status::text, change.version
    from hosted_work_item_sync_changes as change
    where change.workspace_id = ${activityWorkspace} order by change.cursor
  `;
  assert.deepEqual(
    [...activityChanges],
    [
      { cursor: "1", status: "backlog", version: 1 },
      { cursor: "2", status: "done", version: 2 },
    ],
  );

  const beforePrimaryConcurrency = BigInt((await syncState(connection, primary)).head);
  const concurrentPrimaryIds = Array.from({ length: 5 }, () => randomUUID());
  const concurrentSecondaryIds = Array.from({ length: 4 }, () => randomUUID());
  await Promise.all([
    ...concurrentPrimaryIds.map(
      (id, index) => connection!.sql`
        insert into work_items (id, workspace_id, title)
        values (${id}, ${primary}, ${`Concurrent primary ${String(index)}`})
      `,
    ),
    ...concurrentSecondaryIds.map(
      (id, index) => connection!.sql`
        insert into work_items (id, workspace_id, title)
        values (${id}, ${secondary}, ${`Concurrent secondary ${String(index)}`})
      `,
    ),
  ]);
  const primaryConcurrentCursors = await connection.sql<{ cursor: string }[]>`
    select change.cursor::text from hosted_work_item_sync_changes as change
    where change.workspace_id = ${primary}
      and change.cursor > ${beforePrimaryConcurrency.toString()}::bigint
    order by change.cursor
  `;
  assert.deepEqual(
    Array.from(primaryConcurrentCursors, (row) => row.cursor),
    Array.from({ length: 5 }, (_, index) =>
      (beforePrimaryConcurrency + BigInt(index + 1)).toString(),
    ),
  );
  assert.equal((await syncState(connection, secondary)).head, "4");

  const beforeNoOp = await syncState(connection, primary);
  await connection.sql`
    update work_items set title = title where workspace_id = ${primary} and id = ${generic.id}
  `;
  assert.deepEqual(
    await syncState(connection, primary),
    beforeNoOp,
    "no-op updates must be silent",
  );

  const beforeRollback = BigInt((await syncState(connection, primary)).head);
  const rolledBackId = randomUUID();
  await assert.rejects(
    connection.sql.begin(async (transaction) => {
      await transaction`
        insert into work_items (id, workspace_id, title)
        values (${rolledBackId}, ${primary}, 'Rolled back sync mutation')
      `;
      throw new Error("forced rollback");
    }),
    /forced rollback/u,
  );
  assert.equal((await syncState(connection, primary)).head, beforeRollback.toString());
  const afterRollbackId = randomUUID();
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${afterRollbackId}, ${primary}, 'After rollback')
  `;
  assert.equal(
    (await syncState(connection, primary)).head,
    (beforeRollback + 1n).toString(),
    "a rolled-back allocation must leave no cursor gap",
  );

  await connection.sql`
    delete from work_items where workspace_id = ${primary} and id = ${afterRollbackId}
  `;
  const [tombstone] = await connection.sql<Record<string, unknown>[]>`
    select change.kind::text, change.work_item_id::text as "workItemId",
      change.parent_work_item_id as "parentWorkItemId", change.title, change.description,
      change.status::text, change.priority::text,
      change.planning_duration_minutes as "planningDurationMinutes", change.due_on as "dueOn",
      change.version, change.item_created_at as "itemCreatedAt",
      change.item_updated_at as "itemUpdatedAt"
    from hosted_work_item_sync_changes as change
    where change.workspace_id = ${primary} and change.work_item_id = ${afterRollbackId}
    order by change.cursor desc limit 1
  `;
  assert.deepEqual(tombstone, {
    kind: "delete",
    workItemId: afterRollbackId,
    parentWorkItemId: null,
    title: null,
    description: null,
    status: null,
    priority: null,
    planningDurationMinutes: null,
    dueOn: null,
    version: null,
    itemCreatedAt: null,
    itemUpdatedAt: null,
  });
  const decimalBoundaryChanges = await new PostgresHostedWorkItemSyncStore(connection).listChanges(
    primary,
    { afterCursor: "0", limit: 200 },
  );
  assert.deepEqual(
    decimalBoundaryChanges.changes.map((change) => change.cursor),
    Array.from({ length: 10 }, (_, index) => String(index + 1)),
    "numeric cursor ordering must remain contiguous across the 9-to-10 boundary",
  );

  const reconstructionIds = Array.from({ length: 3 }, () => randomUUID()).sort();
  for (const [index, id] of reconstructionIds.entries()) {
    await connection.sql`
      insert into work_items (id, workspace_id, title)
      values (${id}, ${reconstructionWorkspace}, ${`Bootstrap ${String(index)}`})
    `;
  }
  const firstBootstrap = await store.bootstrap(reconstructionWorkspace, { limit: 1 });
  const reconstructed = new Map<string, ReturnType<typeof publicItem>>(
    firstBootstrap.items.map((item) => [item.id, publicItem(item)]),
  );
  const changedId = reconstructionIds[0]!;
  const deletedId = reconstructionIds[1]!;
  const concurrentId = randomUUID();
  await connection.sql`
    update work_items set title = 'Changed during bootstrap', version = version + 1,
      updated_at = clock_timestamp()
    where workspace_id = ${reconstructionWorkspace} and id = ${changedId}
  `;
  await connection.sql`
    delete from work_items where workspace_id = ${reconstructionWorkspace} and id = ${deletedId}
  `;
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${concurrentId}, ${reconstructionWorkspace}, 'Created during bootstrap')
  `;
  let bootstrapCursor = firstBootstrap.nextAfterId;
  while (bootstrapCursor !== null) {
    const page = await store.bootstrap(reconstructionWorkspace, {
      checkpoint: firstBootstrap.checkpoint,
      afterId: bootstrapCursor,
      limit: 1,
    });
    for (const item of page.items) reconstructed.set(item.id, publicItem(item));
    bootstrapCursor = page.nextAfterId;
  }

  let delta = await store.listChanges(reconstructionWorkspace, {
    afterCursor: firstBootstrap.checkpoint,
    limit: 1,
  });
  const frozenThrough = delta.throughCursor;
  const lateId = randomUUID();
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${lateId}, ${reconstructionWorkspace}, 'After frozen delta')
  `;
  const apply = (change: (typeof delta.changes)[number]): void => {
    if (change.type === "delete") reconstructed.delete(change.workItemId);
    else reconstructed.set(change.item.id, publicItem(change.item));
  };
  delta.changes.forEach(apply);
  while (delta.nextAfterCursor !== null) {
    delta = await store.listChanges(reconstructionWorkspace, {
      afterCursor: delta.nextAfterCursor,
      throughCursor: frozenThrough,
      limit: 1,
    });
    delta.changes.forEach(apply);
  }
  assert.equal(delta.throughCursor, frozenThrough);
  assert.equal(reconstructed.has(lateId), false, "a frozen delta must exclude later commits");
  const catchup = await store.listChanges(reconstructionWorkspace, {
    afterCursor: frozenThrough,
    limit: 200,
  });
  catchup.changes.forEach(apply);
  const expectedCurrent = await currentItems(connection, reconstructionWorkspace);
  assert.deepEqual(
    [...reconstructed.values()].sort((left, right) => left.id.localeCompare(right.id)),
    Array.from(expectedCurrent, (item) => ({
      ...item,
      createdAt: new Date(item.createdAt).toISOString(),
      updatedAt: new Date(item.updatedAt).toISOString(),
    })),
    "bootstrap plus ordered deltas must reconstruct exact current state",
  );

  app = await createSyncApp(
    connection,
    new Set([primary, secondary, reconstructionWorkspace, retentionWorkspace, corruptWorkspace]),
  );
  const primaryBeforeRead = await syncState(connection, primary);
  const bootstrapResponse = await app.inject({
    method: "GET",
    url: `${route(HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE, primary)}?limit=1`,
  });
  assert.equal(bootstrapResponse.statusCode, 200);
  assert.equal(bootstrapResponse.headers["cache-control"], "no-store");
  const bootstrapBody = bootstrapResponse.json<{
    protocolVersion: number;
    checkpoint: string;
    nextCursor: string | null;
    items: unknown[];
  }>();
  assert.equal(bootstrapBody.protocolVersion, 1);
  assert.equal(bootstrapResponse.body.includes(primary), false);
  assert.deepEqual(
    await syncState(connection, primary),
    primaryBeforeRead,
    "sync reads must not mutate",
  );
  const denied = await app.inject({
    method: "GET",
    url: route(HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE, deniedWorkspace),
  });
  assert.equal(denied.statusCode, 404);
  const crossTenantCursor = await app.inject({
    method: "GET",
    url: `${route(HOSTED_WORK_ITEM_SYNC_CHANGES_ROUTE, secondary)}?cursor=${encodeURIComponent(
      bootstrapBody.checkpoint,
    )}`,
  });
  assert.equal(crossTenantCursor.statusCode, 400);
  const corruptResponse = await app.inject({
    method: "GET",
    url: route(HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE, corruptWorkspace),
  });
  assert.equal(corruptResponse.statusCode, 500);
  assert.equal(corruptResponse.headers["cache-control"], "no-store");
  assert.deepEqual(corruptResponse.json<{ error: { code: string; message: string } }>().error, {
    code: "internal.unexpected_error",
    message: "An unexpected error occurred.",
  });
  assert.equal(corruptResponse.body.includes(corruptWorkspace), false);

  const emptyRetentionBootstrap = await app.inject({
    method: "GET",
    url: route(HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE, retentionWorkspace),
  });
  const expiredCheckpoint = emptyRetentionBootstrap.json<{ checkpoint: string }>().checkpoint;
  for (const title of ["Old sync one", "Old sync two"]) {
    await connection.sql`
      insert into work_items (workspace_id, title) values (${retentionWorkspace}, ${title})
    `;
  }
  await connection.sql`
    alter table hosted_work_item_sync_changes
      disable trigger hosted_work_item_sync_changes_append_only
  `;
  try {
    await connection.sql`
      update hosted_work_item_sync_changes
      set recorded_at = clock_timestamp() - interval '31 days'
    `;
  } finally {
    await connection.sql`
      alter table hosted_work_item_sync_changes
        enable trigger hosted_work_item_sync_changes_append_only
    `;
  }
  const [changeGuard] = await connection.sql<{ enabled: string; now: string | Date }[]>`
    select trigger.tgenabled::text as enabled, clock_timestamp() as now
    from pg_trigger as trigger
    where trigger.tgname = 'hosted_work_item_sync_changes_append_only'
      and trigger.tgrelid = 'hosted_work_item_sync_changes'::regclass
  `;
  assert.equal(changeGuard?.enabled, "O");
  assert.ok(changeGuard, "change guard and database clock must be readable");
  let markRetentionLocksReady!: () => void;
  let releaseRetentionLocks!: () => void;
  const retentionLocksReady = new Promise<void>((resolve) => (markRetentionLocksReady = resolve));
  const retentionLocksRelease = new Promise<void>((resolve) => (releaseRetentionLocks = resolve));
  const retentionLockTransaction = blocker.sql.begin(async (transaction) => {
    const locked = await transaction<{ workspaceId: string }[]>`
      select state.workspace_id::text as "workspaceId"
      from hosted_work_item_sync_states as state
      where exists (
        select 1 from hosted_work_item_sync_changes as change
        where change.workspace_id = state.workspace_id
          and change.cursor = state.minimum_cursor + 1
          and change.recorded_at < ${new Date(
            new Date(changeGuard.now).getTime() - 30 * 86_400_000,
          ).toISOString()}::timestamptz
      )
      for update
    `;
    assert.ok(locked.some((row) => row.workspaceId === retentionWorkspace));
    markRetentionLocksReady();
    await retentionLocksRelease;
  });
  try {
    await Promise.race([
      retentionLocksReady,
      retentionLockTransaction.then(() => {
        throw new Error("Retention lock transaction exited before reaching its barrier.");
      }),
    ]);
    const contended = await purgeHostedWorkItemSyncChanges(connection, {
      now: new Date(changeGuard.now),
      minimumRetentionMs: 30 * 86_400_000,
      batchSize: 100,
    });
    assert.deepEqual(
      {
        workspaceId: contended.workspaceId,
        deletedChanges: contended.deletedChanges,
        contended: contended.contended,
      },
      { workspaceId: null, deletedChanges: 0, contended: true },
    );
  } finally {
    releaseRetentionLocks();
    await retentionLockTransaction;
  }
  let purge: Awaited<ReturnType<typeof purgeHostedWorkItemSyncChanges>> | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await purgeHostedWorkItemSyncChanges(connection, {
      now: new Date(changeGuard.now),
      minimumRetentionMs: 30 * 86_400_000,
      batchSize: 100,
    });
    if (result.workspaceId === retentionWorkspace) {
      purge = result;
      break;
    }
    if (result.deletedChanges === 0) break;
  }
  assert.ok(purge, "retention cleanup must eventually select the target workspace");
  assert.deepEqual(
    { deletedChanges: purge.deletedChanges, minimumCursor: purge.minimumCursor },
    { deletedChanges: 2, minimumCursor: "2" },
  );
  const expired = await app.inject({
    method: "GET",
    url: `${route(HOSTED_WORK_ITEM_SYNC_CHANGES_ROUTE, retentionWorkspace)}?cursor=${encodeURIComponent(
      expiredCheckpoint,
    )}`,
  });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.headers["cache-control"], "no-store");
  assert.deepEqual(
    expired.json<{ error: { code: string } }>().error.code,
    "hosted_sync.cursor_expired",
  );
  const resync = await app.inject({
    method: "GET",
    url: route(HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE, retentionWorkspace),
  });
  assert.equal(resync.statusCode, 200);
  assert.equal(resync.json<{ items: unknown[] }>().items.length, 2);

  await connection.sql`
    insert into work_items (workspace_id, title) values (${cascadeWorkspace}, 'Cascade sync row')
  `;
  const secondaryBeforeCascade = await syncState(connection, secondary);
  await connection.sql`delete from workspaces where id = ${cascadeWorkspace}`;
  const [cascadeState] = await connection.sql<{ states: number; changes: number; items: number }[]>`
    select
      (select count(*)::integer from hosted_work_item_sync_states where workspace_id = ${cascadeWorkspace}) as states,
      (select count(*)::integer from hosted_work_item_sync_changes where workspace_id = ${cascadeWorkspace}) as changes,
      (select count(*)::integer from work_items where workspace_id = ${cascadeWorkspace}) as items
  `;
  assert.deepEqual(cascadeState, { states: 0, changes: 0, items: 0 });
  assert.deepEqual(await syncState(connection, secondary), secondaryBeforeCascade);
} catch (error) {
  verificationError = error;
}

const cleanupSteps: CleanupStep[] = [];
if (app !== undefined) {
  cleanupSteps.push({ label: "Fastify application", run: () => app!.close() });
}
for (const raceConnection of raceConnections) {
  cleanupSteps.push({
    label: raceConnection.label,
    run: () => raceConnection.connection.close(),
  });
}
if (connection !== undefined) {
  cleanupSteps.push({ label: "disposable database connection", run: () => connection!.close() });
}
if (databaseCreated) {
  cleanupSteps.push(
    {
      label: "disposable database sessions",
      run: () => admin.sql`
        select pg_terminate_backend(pid) from pg_stat_activity
        where datname = ${databaseName} and pid <> pg_backend_pid()
      `,
    },
    {
      label: "disposable database",
      run: () => admin.sql.unsafe(`drop database if exists ${quotedDatabase()} with (force)`),
    },
    {
      label: "disposable database removal check",
      run: async () => {
        const [remaining] = await admin.sql<{ exists: boolean }[]>`
          select exists(select 1 from pg_database where datname = ${databaseName}) as exists
        `;
        if (remaining?.exists !== false) throw new Error("Disposable database remains.");
      },
    },
  );
}
cleanupSteps.push({ label: "administrative database connection", run: () => admin.close() });
const cleanupFailures = await collectCleanupFailures(cleanupSteps);

if (verificationError !== undefined) {
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [verificationError, ...cleanupFailures],
      "Hosted work-item sync verification failed and cleanup was incomplete.",
    );
  }
  throw verificationError;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(
    cleanupFailures,
    "Hosted work-item sync verification cleanup was incomplete.",
  );
}
process.stdout.write(
  `Hosted work-item sync verification passed populated upgrade, AFTER-trigger conflicts and guards, generic and direct-activity mutations, concurrent cursors, rollback, tombstones, bootstrap/delta reconstruction, frozen paging, retention contention and resync, corruption fail-closed, tenant isolation, and cascade cleanup in ${databaseName}\n`,
);
