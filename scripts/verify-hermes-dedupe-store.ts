import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
  grantPostgresDeliveryDedupeRuntimeRole,
  migratePostgresDeliveryDedupeStore,
  PostgresDeliveryDedupeStore,
  PostgresDeliveryDedupeStoreError,
} from "../apps/hermes-reminders/src/index.js";
import { createDatabase, type DatabaseConnection } from "../packages/database/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const nonce = randomUUID().replaceAll("-", "");
const verificationDatabase = `schedule_hermes_dedupe_verify_${nonce}`;
const runtimeRole = `hermes_verify_${nonce}`;
const runtimePassword = randomUUID();
const verificationDatabasePattern = /^schedule_hermes_dedupe_verify_[a-f0-9]{32}$/u;
const runtimeRolePattern = /^hermes_verify_[a-f0-9]{32}$/u;
const runtimePasswordPattern = /^[0-9a-f-]{36}$/u;
const commandHash = createHash("sha256").update("command-one", "utf8").digest("hex");
const conflictingCommandHash = createHash("sha256")
  .update("different-command", "utf8")
  .digest("hex");

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function runtimeDatabaseUrl(): string {
  const url = new URL(databaseUrlFor(verificationDatabase));
  url.username = runtimeRole;
  url.password = runtimePassword;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe Hermes dedupe verification database identifier.");
  }
  return `"${verificationDatabase}"`;
}

function quotedRuntimeRole(): string {
  if (!runtimeRolePattern.test(runtimeRole)) {
    throw new Error("Unsafe Hermes dedupe verification role identifier.");
  }
  return `"${runtimeRole}"`;
}

function expiry(milliseconds = 5 * 60 * 1_000): Date {
  return new Date(Date.now() + milliseconds);
}

function store(
  connection: DatabaseConnection,
  reservationToken: string,
  options: {
    readonly statementTimeoutMilliseconds?: number;
  } = {},
) {
  return new PostgresDeliveryDedupeStore(connection.sql, {
    reservationToken: () => reservationToken,
    ...options,
  });
}

function errorCode(code: PostgresDeliveryDedupeStoreError["code"]) {
  return (error: unknown): boolean =>
    error instanceof PostgresDeliveryDedupeStoreError && error.code === code;
}

function postgresErrorCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let databaseCreated = false;
let roleCreated = false;
let connection: DatabaseConnection | null = null;
let runtimeConnection: DatabaseConnection | null = null;
let verificationFailed = false;
let verificationError: unknown;
const cleanupErrors: unknown[] = [];
let successMessage = "";

try {
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  if (!runtimePasswordPattern.test(runtimePassword)) {
    throw new Error("Unsafe Hermes dedupe verification role password.");
  }
  await adminConnection.sql.unsafe(
    `create role ${quotedRuntimeRole()} login password '${runtimePassword}' noinherit`,
  );
  roleCreated = true;

  connection = createDatabase(disposableDatabaseUrl, 16, {
    applicationName: "schedule-hermes-dedupe-verifier-owner",
    statementTimeoutMs: 10_000,
  });
  await migratePostgresDeliveryDedupeStore(connection.sql);
  await migratePostgresDeliveryDedupeStore(connection.sql);

  const [migration] = await connection.sql<{ checksum: string; version: number }[]>`
    select version, checksum
    from hermes_adapter.schema_migrations
  `;
  assert.equal(migration?.version, 1);
  assert.match(migration?.checksum ?? "", /^[0-9a-f]{64}$/u);

  await connection.sql`
    update hermes_adapter.schema_migrations
    set checksum = ${"0".repeat(64)}
    where version = 1
  `;
  await assert.rejects(
    migratePostgresDeliveryDedupeStore(connection.sql),
    errorCode("unsupported_schema"),
  );
  await connection.sql`
    update hermes_adapter.schema_migrations
    set checksum = ${migration!.checksum}
    where version = 1
  `;

  await connection.sql`drop index hermes_adapter.hermes_delivery_dedupe_expiry_idx`;
  await connection.sql`
    create index hermes_delivery_dedupe_expiry_idx
    on hermes_adapter.delivery_dedupe (dedupe_key)
  `;
  await assert.rejects(
    migratePostgresDeliveryDedupeStore(connection.sql),
    errorCode("unsupported_schema"),
  );
  await connection.sql`drop index hermes_adapter.hermes_delivery_dedupe_expiry_idx`;
  await connection.sql`
    create index hermes_delivery_dedupe_expiry_idx
    on hermes_adapter.delivery_dedupe (reservation_expires_at, dedupe_key)
    where status = 'reserved'
  `;

  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    drop constraint hermes_delivery_dedupe_state_valid
  `;
  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    add constraint hermes_delivery_dedupe_state_valid check (true)
  `;
  await assert.rejects(
    migratePostgresDeliveryDedupeStore(connection.sql),
    errorCode("unsupported_schema"),
  );
  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    drop constraint hermes_delivery_dedupe_state_valid
  `;
  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    add constraint hermes_delivery_dedupe_state_valid check (
      (
        status = 'available'
        and reservation_expires_at is null
        and delivered_at is null
      )
      or (
        status = 'reserved'
        and reservation_expires_at is not null
        and delivered_at is null
      )
      or (
        status = 'delivered'
        and reservation_expires_at is null
        and delivered_at is not null
      )
    )
  `;

  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    disable trigger hermes_delivery_dedupe_transition_guard
  `;
  await assert.rejects(
    migratePostgresDeliveryDedupeStore(connection.sql),
    errorCode("unsupported_schema"),
  );
  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    enable trigger hermes_delivery_dedupe_transition_guard
  `;
  await connection.sql`alter table hermes_adapter.delivery_dedupe set unlogged`;
  await assert.rejects(
    migratePostgresDeliveryDedupeStore(connection.sql),
    errorCode("unsupported_schema"),
  );
  await connection.sql`alter table hermes_adapter.delivery_dedupe set logged`;
  await migratePostgresDeliveryDedupeStore(connection.sql);

  await connection.sql.unsafe(`alter schema hermes_adapter owner to ${quotedRuntimeRole()}`);
  await assert.rejects(
    grantPostgresDeliveryDedupeRuntimeRole(connection.sql, runtimeRole),
    errorCode("invalid_input"),
  );
  await connection.sql`alter schema hermes_adapter owner to current_user`;
  await grantPostgresDeliveryDedupeRuntimeRole(connection.sql, runtimeRole);
  runtimeConnection = createDatabase(runtimeDatabaseUrl(), 16, {
    applicationName: "schedule-hermes-dedupe-verifier-runtime",
    statementTimeoutMs: 10_000,
  });

  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    disable trigger hermes_delivery_dedupe_transition_guard
  `;
  await assert.rejects(
    store(runtimeConnection, randomUUID()).reserve({
      dedupeKey: randomUUID(),
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    errorCode("unsupported_schema"),
  );
  await connection.sql`
    alter table hermes_adapter.delivery_dedupe
    enable trigger hermes_delivery_dedupe_transition_guard
  `;

  const [transitionFunction] = await connection.sql<{ definition: string }[]>`
    select pg_get_functiondef(procedure_record.oid) as definition
    from pg_proc as procedure_record
    join pg_namespace as namespace_record on namespace_record.oid = procedure_record.pronamespace
    where
      namespace_record.nspname = 'hermes_adapter'
      and procedure_record.proname = 'enforce_delivery_dedupe_transition'
  `;
  const transitionFunctionDefinition = transitionFunction?.definition;
  if (
    transitionFunctionDefinition === undefined ||
    !transitionFunctionDefinition.includes("Invalid delivery dedupe insert transition.")
  ) {
    throw new Error("The transition function definition could not be captured for restoration.");
  }
  await connection.sql.unsafe(`
    create or replace function hermes_adapter.enforce_delivery_dedupe_transition()
    returns trigger
    language plpgsql
    set search_path = pg_catalog
    as $function$
    begin
      return NEW;
    end
    $function$
  `);
  await assert.rejects(
    store(runtimeConnection, randomUUID()).reserve({
      dedupeKey: randomUUID(),
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    errorCode("unsupported_schema"),
  );
  await connection.sql.unsafe(transitionFunctionDefinition);
  await connection.sql.unsafe(
    `grant select on hermes_adapter.delivery_dedupe to ${quotedRuntimeRole()}`,
  );
  await assert.rejects(
    store(runtimeConnection, randomUUID()).reserve({
      dedupeKey: randomUUID(),
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    errorCode("unsupported_schema"),
  );
  await connection.sql.unsafe(
    `revoke select on hermes_adapter.delivery_dedupe from ${quotedRuntimeRole()}`,
  );
  await connection.sql.unsafe(`
    create function hermes_adapter.unexpected_security_definer_helper()
    returns text
    language sql
    security definer
    set search_path = pg_catalog
    as $function$
      select 'unexpected'::text
    $function$
  `);
  const [unexpectedFunctionPrivilege] = await connection.sql<{ executable: boolean }[]>`
    select has_function_privilege(
      ${runtimeRole},
      'hermes_adapter.unexpected_security_definer_helper()',
      'EXECUTE'
    ) as executable
  `;
  assert.equal(unexpectedFunctionPrivilege?.executable, false);
  await assert.rejects(
    store(runtimeConnection, randomUUID()).reserve({
      dedupeKey: randomUUID(),
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    errorCode("unsupported_schema"),
  );
  await connection.sql`drop function hermes_adapter.unexpected_security_definer_helper()`;

  const dedupeKey = randomUUID();
  const claimToken = randomUUID();
  const replicaTokens = Array.from({ length: 12 }, () => randomUUID());
  const replicas = replicaTokens.map((token) => store(runtimeConnection!, token));
  const reservations = await Promise.all(
    replicas.map((replica) =>
      replica.reserve({
        dedupeKey,
        commandHash,
        claimToken,
        reservationExpiresAt: expiry(),
        minimumRemainingMilliseconds: 1_000,
      }),
    ),
  );
  const acquired = reservations.filter((reservation) => reservation.state === "acquired");
  assert.equal(acquired.length, 1);
  assert.equal(reservations.filter((reservation) => reservation.state === "busy").length, 11);
  const winningReservation = acquired[0];
  assert.ok(winningReservation?.state === "acquired");

  assert.deepEqual(
    await replicas[0]!.reserve({
      dedupeKey,
      commandHash: conflictingCommandHash,
      claimToken,
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "payload_conflict" },
  );
  await assert.rejects(
    replicas[0]!.markDelivered({ dedupeKey, reservationToken: randomUUID() }),
    errorCode("reservation_fenced"),
  );
  await replicas[0]!.markDelivered({
    dedupeKey,
    reservationToken: winningReservation.reservationToken,
  });
  await replicas[1]!.markDelivered({
    dedupeKey,
    reservationToken: winningReservation.reservationToken,
  });
  assert.deepEqual(
    await replicas[2]!.reserve({
      dedupeKey,
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "delivered" },
  );
  assert.deepEqual(
    await replicas[2]!.reserve({
      dedupeKey,
      commandHash: conflictingCommandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "payload_conflict" },
  );

  await assert.rejects(
    runtimeConnection.sql`
      select status from hermes_adapter.delivery_dedupe
      where dedupe_key = ${dedupeKey}::uuid
    `,
    postgresErrorCode("42501"),
  );
  const [persisted] = await connection.sql<
    {
      reservationTokenHash: string;
      rowText: string;
      status: string;
    }[]
  >`
    select
      reservation_token_hash as "reservationTokenHash",
      row_to_json(record)::text as "rowText",
      status
    from hermes_adapter.delivery_dedupe as record
    where dedupe_key = ${dedupeKey}::uuid
  `;
  assert.equal(persisted?.status, "delivered");
  assert.equal(persisted?.reservationTokenHash.length, 64);
  assert.doesNotMatch(persisted?.rowText ?? "", new RegExp(claimToken, "u"));
  assert.doesNotMatch(
    persisted?.rowText ?? "",
    new RegExp(winningReservation.reservationToken, "u"),
  );
  await assert.rejects(
    runtimeConnection.sql`
      delete from hermes_adapter.delivery_dedupe
      where dedupe_key = ${dedupeKey}::uuid
    `,
    postgresErrorCode("42501"),
  );
  await assert.rejects(
    runtimeConnection.sql`create table hermes_adapter.forbidden_runtime_ddl (id integer)`,
    postgresErrorCode("42501"),
  );
  await assert.rejects(
    runtimeConnection.sql`
      update hermes_adapter.delivery_dedupe
      set
        status = 'available',
        reservation_expires_at = null,
        delivered_at = null,
        updated_at = clock_timestamp()
      where dedupe_key = ${dedupeKey}::uuid
    `,
    postgresErrorCode("42501"),
  );
  await assert.rejects(
    connection.sql`
      update hermes_adapter.delivery_dedupe
      set
        status = 'available',
        reservation_expires_at = null,
        delivered_at = null,
        updated_at = clock_timestamp()
      where dedupe_key = ${dedupeKey}::uuid
    `,
    postgresErrorCode("23514"),
  );
  await assert.rejects(
    runtimeConnection.sql`
      update hermes_adapter.delivery_dedupe
      set command_hash = ${conflictingCommandHash}
      where dedupe_key = ${dedupeKey}::uuid
    `,
    postgresErrorCode("42501"),
  );

  const releasedKey = randomUUID();
  const releasedClaim = randomUUID();
  const firstToken = randomUUID();
  const secondToken = randomUUID();
  const firstOwner = store(runtimeConnection, firstToken);
  const secondOwner = store(runtimeConnection, secondToken);
  assert.deepEqual(
    await firstOwner.reserve({
      dedupeKey: releasedKey,
      commandHash,
      claimToken: releasedClaim,
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "acquired", reservationToken: firstToken },
  );
  await firstOwner.release({ dedupeKey: releasedKey, reservationToken: firstToken });
  await firstOwner.release({ dedupeKey: releasedKey, reservationToken: firstToken });
  await assert.rejects(
    connection.sql`
      update hermes_adapter.delivery_dedupe
      set
        status = 'reserved',
        reservation_expires_at = clock_timestamp() + interval '5 minutes',
        updated_at = clock_timestamp()
      where dedupe_key = ${releasedKey}::uuid
    `,
    postgresErrorCode("23514"),
  );
  await assert.rejects(
    firstOwner.markDelivered({ dedupeKey: releasedKey, reservationToken: firstToken }),
    errorCode("reservation_fenced"),
  );
  assert.deepEqual(
    await secondOwner.reserve({
      dedupeKey: releasedKey,
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "acquired", reservationToken: secondToken },
  );
  await assert.rejects(
    firstOwner.release({ dedupeKey: releasedKey, reservationToken: firstToken }),
    errorCode("reservation_fenced"),
  );
  assert.deepEqual(
    await firstOwner.reserve({
      dedupeKey: releasedKey,
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "busy" },
  );

  const expiredKey = randomUUID();
  const expiredToken = randomUUID();
  const replacementToken = randomUUID();
  const expiredOwner = store(runtimeConnection, expiredToken);
  const replacementOwner = store(runtimeConnection, replacementToken);
  await expiredOwner.reserve({
    dedupeKey: expiredKey,
    commandHash,
    claimToken: randomUUID(),
    reservationExpiresAt: expiry(300),
    minimumRemainingMilliseconds: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(
    connection.sql`
      update hermes_adapter.delivery_dedupe
      set
        reservation_expires_at = clock_timestamp() + interval '5 minutes',
        updated_at = clock_timestamp()
      where dedupe_key = ${expiredKey}::uuid
    `,
    postgresErrorCode("23514"),
  );
  assert.deepEqual(
    await replacementOwner.reserve({
      dedupeKey: expiredKey,
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "acquired", reservationToken: replacementToken },
  );
  await assert.rejects(
    expiredOwner.markDelivered({ dedupeKey: expiredKey, reservationToken: expiredToken }),
    errorCode("reservation_fenced"),
  );

  await assert.rejects(
    firstOwner.reserve({
      dedupeKey: randomUUID(),
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(-1_000),
      minimumRemainingMilliseconds: 0,
    }),
    errorCode("invalid_input"),
  );
  await assert.rejects(
    firstOwner.reserve({
      dedupeKey: randomUUID(),
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(16 * 60 * 1_000),
      minimumRemainingMilliseconds: 0,
    }),
    errorCode("invalid_input"),
  );
  await assert.rejects(
    firstOwner.reserve({
      dedupeKey: randomUUID(),
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(2_000),
      minimumRemainingMilliseconds: 3_000,
    }),
    errorCode("invalid_input"),
  );

  const lockWaitKey = randomUUID();
  const lockWaitToken = randomUUID();
  const lockWaitStore = store(runtimeConnection, lockWaitToken);
  await lockWaitStore.reserve({
    dedupeKey: lockWaitKey,
    commandHash,
    claimToken: randomUUID(),
    reservationExpiresAt: expiry(),
    minimumRemainingMilliseconds: 1_000,
  });
  await lockWaitStore.release({ dedupeKey: lockWaitKey, reservationToken: lockWaitToken });
  let reportLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    reportLocked = resolve;
  });
  const holdLock = connection.sql.begin(async (transaction) => {
    await transaction`
      select dedupe_key
      from hermes_adapter.delivery_dedupe
      where dedupe_key = ${lockWaitKey}::uuid
      for update
    `;
    reportLocked();
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  await locked;
  await assert.rejects(
    lockWaitStore.reserve({
      dedupeKey: lockWaitKey,
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(250),
      minimumRemainingMilliseconds: 0,
    }),
    errorCode("invalid_input"),
  );
  await holdLock;
  const [postWaitState] = await connection.sql<{ status: string }[]>`
    select status
    from hermes_adapter.delivery_dedupe
    where dedupe_key = ${lockWaitKey}::uuid
  `;
  assert.equal(postWaitState?.status, "available");

  let reportDeadlineLock!: () => void;
  const deadlineLocked = new Promise<void>((resolve) => {
    reportDeadlineLock = resolve;
  });
  const holdDeadlineLock = connection.sql.begin(async (transaction) => {
    await transaction`
      select dedupe_key
      from hermes_adapter.delivery_dedupe
      where dedupe_key = ${lockWaitKey}::uuid
      for update
    `;
    reportDeadlineLock();
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
  await deadlineLocked;
  const deadlineStartedAt = Date.now();
  assert.deepEqual(
    await store(runtimeConnection, randomUUID(), {
      statementTimeoutMilliseconds: 100,
    }).reserve({
      dedupeKey: lockWaitKey,
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "busy" },
  );
  assert.ok(Date.now() - deadlineStartedAt < 1_000);
  await holdDeadlineLock;

  const migrationVersions = await runtimeConnection.sql<{ version: number }[]>`
    select version
    from hermes_adapter.schema_migrations
    order by version
  `;
  assert.deepEqual([...migrationVersions], [{ version: 1 }]);

  await runtimeConnection.close();
  runtimeConnection = null;
  await connection.close();
  connection = null;
  runtimeConnection = createDatabase(runtimeDatabaseUrl(), 2, {
    applicationName: "schedule-hermes-dedupe-reopen-verifier-runtime",
    statementTimeoutMs: 10_000,
  });
  assert.deepEqual(
    await store(runtimeConnection, randomUUID()).reserve({
      dedupeKey,
      commandHash,
      claimToken: randomUUID(),
      reservationExpiresAt: expiry(),
      minimumRemainingMilliseconds: 1_000,
    }),
    { state: "delivered" },
  );

  successMessage = `Hermes delivery dedupe verification passed atomic concurrency, payload binding, digest-only fencing, delivered replay, release and expiry takeover, database-clock budget rechecks, bounded lock waits, migration attestation, least-privilege runtime access, and restart durability in ${verificationDatabase}`;
} catch (error) {
  verificationFailed = true;
  verificationError = error;
} finally {
  try {
    await runtimeConnection?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await connection?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (databaseCreated) {
    try {
      await adminConnection.sql`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where datname = ${verificationDatabase} and pid <> pg_backend_pid()
      `;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await adminConnection.sql.unsafe(`drop database if exists ${quotedVerificationDatabase()}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (roleCreated) {
    try {
      await adminConnection.sql.unsafe(`drop role if exists ${quotedRuntimeRole()}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await adminConnection.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
}

const failures = [...(verificationFailed ? [verificationError] : []), ...cleanupErrors];
if (failures.length === 1) throw failures[0];
if (failures.length > 1) {
  throw new AggregateError(failures, "Hermes dedupe verification and cleanup had multiple errors.");
}
console.log(successMessage);
