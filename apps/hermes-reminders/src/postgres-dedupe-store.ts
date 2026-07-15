import { createHash, randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

import type { DedupeReservation, DeliveryDedupeStore } from "./contracts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;
const DATABASE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/u;
const DEFAULT_MAXIMUM_RESERVATION_HORIZON_MILLISECONDS = 15 * 60 * 1_000;
const DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS = 2_000;
const MIGRATION_LOCK = "schedule.hermes-reminder.delivery-dedupe/v1";
const MIGRATION_CHECKSUM_V1 = createHash("sha256")
  .update(
    [
      "schedule.hermes-reminder.delivery-dedupe/v1",
      "dedupe_key:uuid",
      "command_hash:sha256",
      "reservation_token_hash:sha256",
      "status:available|reserved|delivered",
      "database-clock-expiry",
      "guarded-state-transitions",
      "immutable-delivered",
      "security-definer-operation-functions",
      "logged-relations",
    ].join("|"),
    "utf8",
  )
  .digest("hex");
const EXPECTED_COLUMNS = [
  "dedupe_key|uuid|NO|<none>||",
  "command_hash|text|NO|<none>||",
  "reservation_token_hash|text|NO|<none>||",
  "status|text|NO|<none>||",
  "reservation_expires_at|timestamptz|YES|<none>||",
  "delivered_at|timestamptz|YES|<none>||",
  "created_at|timestamptz|NO|clock_timestamp()||",
  "updated_at|timestamptz|NO|clock_timestamp()||",
] as const;
const EXPECTED_MIGRATION_COLUMNS = [
  "version|int4|NO|<none>||",
  "checksum|text|NO|<none>||",
  "applied_at|timestamptz|NO|clock_timestamp()||",
] as const;
const EXPECTED_CONSTRAINTS = [
  "p|delivery_dedupe_pkey|PRIMARY KEY (dedupe_key)",
  "c|hermes_delivery_dedupe_command_hash_valid|CHECK (command_hash ~ '^[0-9a-f]{64}$'::text)",
  "c|hermes_delivery_dedupe_reservation_token_hash_valid|CHECK (reservation_token_hash ~ '^[0-9a-f]{64}$'::text)",
  "c|hermes_delivery_dedupe_state_valid|CHECK (status = 'available'::text AND reservation_expires_at IS NULL AND delivered_at IS NULL OR status = 'reserved'::text AND reservation_expires_at IS NOT NULL AND delivered_at IS NULL OR status = 'delivered'::text AND reservation_expires_at IS NULL AND delivered_at IS NOT NULL)",
  "c|hermes_delivery_dedupe_timestamps_valid|CHECK (updated_at >= created_at AND (delivered_at IS NULL OR delivered_at >= created_at))",
] as const;
const EXPECTED_MIGRATION_CONSTRAINTS = [
  "c|hermes_schema_migration_checksum_valid|CHECK (checksum ~ '^[0-9a-f]{64}$'::text)",
  "p|schema_migrations_pkey|PRIMARY KEY (version)",
] as const;
const EXPECTED_INDEXES = [
  "hermes_adapter.delivery_dedupe_pkey|CREATE UNIQUE INDEX delivery_dedupe_pkey ON hermes_adapter.delivery_dedupe USING btree (dedupe_key)|<none>|t|t|t",
  "hermes_adapter.hermes_delivery_dedupe_expiry_idx|CREATE INDEX hermes_delivery_dedupe_expiry_idx ON hermes_adapter.delivery_dedupe USING btree (reservation_expires_at, dedupe_key) WHERE status = 'reserved'::text|status = 'reserved'::text|f|t|t",
] as const;
const EXPECTED_TRIGGERS = [
  "hermes_delivery_dedupe_transition_guard|O|CREATE TRIGGER hermes_delivery_dedupe_transition_guard BEFORE INSERT OR UPDATE ON hermes_adapter.delivery_dedupe FOR EACH ROW EXECUTE FUNCTION hermes_adapter.enforce_delivery_dedupe_transition()",
] as const;
const EXPECTED_RELATIONS = [
  "delivery_dedupe|r|p",
  "delivery_dedupe_pkey|i|p",
  "hermes_delivery_dedupe_expiry_idx|i|p",
  "schema_migrations|r|p",
  "schema_migrations_pkey|i|p",
] as const;
const EXPECTED_FUNCTIONS = [
  "enforce_delivery_dedupe_transition||plpgsql|f|f|v|u|search_path=pg_catalog",
  "mark_delivery_dedupe|uuid, text|plpgsql|t|t|v|u|search_path=pg_catalog",
  "release_delivery_dedupe|uuid, text|plpgsql|t|t|v|u|search_path=pg_catalog",
  "reserve_delivery_dedupe|uuid, text, text, timestamp with time zone, bigint, bigint|plpgsql|t|t|v|u|search_path=pg_catalog",
] as const;
const EXPECTED_FUNCTION_SOURCE_HASHES = [
  "c586b73b066318992b2fd453cfb5ac1dabb3e4dd271dc2fdf95d216c68b8a3b9",
  "fe97d941e679cdbcbd153acac200c283ae33553068998b90e8ec7c3ab3c38234",
  "4562935e13faf7d8f72f09c60f6a3573f0b99d241b820e547eff51a25065db6c",
  "4881d2ae7cb2efe086498ced0f67d6fa771d5eb806444ad158909ff354dc1119",
] as const;

interface ReserveFunctionRow {
  readonly outcome: string;
  readonly budgetValid: boolean | null;
  readonly storedCommandHash: string | null;
}

interface MigrationRow {
  readonly version: number;
  readonly checksum: string;
}

interface RuntimeRoleRow {
  readonly canLogin: boolean;
  readonly createsDatabase: boolean;
  readonly createsRole: boolean;
  readonly bypassesRowSecurity: boolean;
  readonly inherits: boolean;
  readonly isolated: boolean;
  readonly ownsAdapterObjects: boolean;
  readonly ownsDatabase: boolean;
  readonly replicates: boolean;
  readonly superuser: boolean;
}

interface RuntimeBoundaryRow extends RuntimeRoleRow {
  readonly directSession: boolean;
  readonly migrationReadPrivilege: boolean;
  readonly migrationWritePrivilege: boolean;
  readonly operationFunctionsExecute: boolean;
  readonly schemaCreate: boolean;
  readonly schemaUsage: boolean;
  readonly tablePrivilege: boolean;
  readonly transitionFunctionExecute: boolean;
}

interface SchemaShapeRow {
  readonly columns: string[];
  readonly migrationColumns: string[];
  readonly constraints: string[];
  readonly migrationConstraints: string[];
  readonly indexes: string[];
  readonly relations: string[];
  readonly triggers: string[];
  readonly functions: string[];
  readonly functionSources: string[];
  readonly publicSchemaUsage: boolean;
  readonly publicTablePrivilege: boolean;
  readonly publicFunctionExecute: boolean;
}

export type PostgresDeliveryDedupeStoreErrorCode =
  | "invalid_input"
  | "operation_timeout"
  | "reservation_fenced"
  | "store_inconsistent"
  | "unsupported_schema";

export class PostgresDeliveryDedupeStoreError extends Error {
  override readonly name = "PostgresDeliveryDedupeStoreError";

  constructor(
    readonly code: PostgresDeliveryDedupeStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PostgresDeliveryDedupeStoreOptions {
  /** Prevents a malformed upstream lease from monopolizing a dedupe key indefinitely. */
  readonly maximumReservationHorizonMilliseconds?: number;
  /** Bounds each database statement, including time waiting for a conflicting reservation row. */
  readonly statementTimeoutMilliseconds?: number;
  /** Injectable only for deterministic tests. Production callers should keep the UUID default. */
  readonly reservationToken?: () => string;
}

function invalid(message: string): never {
  throw new PostgresDeliveryDedupeStoreError("invalid_input", message);
}

function normalizeUuid(value: string, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a UUID.`);
  const normalized = value.toLowerCase();
  if (!UUID.test(normalized)) invalid(`${label} must be a UUID.`);
  return normalized;
}

function normalizeHash(value: string, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a SHA-256 digest.`);
  const normalized = value.toLowerCase();
  if (!SHA_256.test(normalized)) invalid(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireMaximumReservationHorizon(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60 * 1_000) {
    throw new TypeError(
      "maximumReservationHorizonMilliseconds must be an integer from 1000 to 3600000.",
    );
  }
  return value;
}

function requireStatementTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new TypeError("statementTimeoutMilliseconds must be an integer from 100 to 30000.");
  }
  return value;
}

function requireMinimumRemaining(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid(`minimumRemainingMilliseconds must be an integer from 0 to ${String(maximum)}.`);
  }
  return value;
}

function quotedDatabaseRole(value: string): string {
  if (typeof value !== "string" || !DATABASE_ROLE.test(value)) {
    invalid("runtimeRole must be a lowercase PostgreSQL identifier.");
  }
  return `"${value}"`;
}

function isOperationTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "55P03" || error.code === "57014")
  );
}

function isTransitionViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23514" &&
    "constraint_name" in error &&
    error.constraint_name === "hermes_delivery_dedupe_transition_valid"
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertSchemaShape(transaction: TransactionSql): Promise<void> {
  const rows = await transaction<SchemaShapeRow[]>`
    select
      array(
        select concat_ws(
          '|',
          column_record.attname,
          type_record.typname,
          case when column_record.attnotnull then 'NO' else 'YES' end,
          coalesce(pg_get_expr(default_record.adbin, default_record.adrelid, true), '<none>'),
          column_record.attidentity,
          column_record.attgenerated
        )
        from pg_attribute as column_record
        join pg_class as relation_record on relation_record.oid = column_record.attrelid
        join pg_namespace as namespace_record on namespace_record.oid = relation_record.relnamespace
        join pg_type as type_record on type_record.oid = column_record.atttypid
        left join pg_attrdef as default_record on
          default_record.adrelid = column_record.attrelid
          and default_record.adnum = column_record.attnum
        where
          namespace_record.nspname = 'hermes_adapter'
          and relation_record.relname = 'delivery_dedupe'
          and column_record.attnum > 0
          and not column_record.attisdropped
        order by column_record.attnum
      ) as columns,
      array(
        select concat_ws('|', constraint_record.contype, constraint_record.conname, pg_get_constraintdef(constraint_record.oid, true))
        from pg_constraint as constraint_record
        where constraint_record.conrelid = to_regclass('hermes_adapter.delivery_dedupe')
        order by constraint_record.conname
      ) as constraints,
      array(
        select concat_ws(
          '|',
          column_record.attname,
          type_record.typname,
          case when column_record.attnotnull then 'NO' else 'YES' end,
          coalesce(pg_get_expr(default_record.adbin, default_record.adrelid, true), '<none>'),
          column_record.attidentity,
          column_record.attgenerated
        )
        from pg_attribute as column_record
        join pg_class as relation_record on relation_record.oid = column_record.attrelid
        join pg_namespace as namespace_record on namespace_record.oid = relation_record.relnamespace
        join pg_type as type_record on type_record.oid = column_record.atttypid
        left join pg_attrdef as default_record on
          default_record.adrelid = column_record.attrelid
          and default_record.adnum = column_record.attnum
        where
          namespace_record.nspname = 'hermes_adapter'
          and relation_record.relname = 'schema_migrations'
          and column_record.attnum > 0
          and not column_record.attisdropped
        order by column_record.attnum
      ) as "migrationColumns",
      array(
        select concat_ws('|', constraint_record.contype, constraint_record.conname, pg_get_constraintdef(constraint_record.oid, true))
        from pg_constraint as constraint_record
        where constraint_record.conrelid = to_regclass('hermes_adapter.schema_migrations')
        order by constraint_record.conname
      ) as "migrationConstraints",
      array(
        select concat_ws(
          '|',
          index_record.indexrelid::regclass::text,
          pg_get_indexdef(index_record.indexrelid, 0, true),
          coalesce(pg_get_expr(index_record.indpred, index_record.indrelid, true), '<none>'),
          index_record.indisunique,
          index_record.indisvalid,
          index_record.indisready
        )
        from pg_index as index_record
        where index_record.indrelid = to_regclass('hermes_adapter.delivery_dedupe')
        order by index_record.indexrelid::regclass::text
      ) as indexes,
      array(
        select concat_ws('|', relation_record.relname, relation_record.relkind, relation_record.relpersistence)
        from pg_class as relation_record
        join pg_namespace as namespace_record on namespace_record.oid = relation_record.relnamespace
        where
          namespace_record.nspname = 'hermes_adapter'
        order by relation_record.relname
      ) as relations,
      array(
        select concat_ws('|', trigger_record.tgname, trigger_record.tgenabled, pg_get_triggerdef(trigger_record.oid, true))
        from pg_trigger as trigger_record
        where
          trigger_record.tgrelid = to_regclass('hermes_adapter.delivery_dedupe')
          and not trigger_record.tgisinternal
        order by trigger_record.tgname
      ) as triggers,
      array(
        select concat_ws(
          '|',
          procedure_record.proname,
          oidvectortypes(procedure_record.proargtypes),
          language_record.lanname,
          procedure_record.prosecdef,
          procedure_record.proisstrict,
          procedure_record.provolatile,
          procedure_record.proparallel,
          coalesce(array_to_string(procedure_record.proconfig, ','), '<none>')
        )
        from pg_proc as procedure_record
        join pg_namespace as namespace_record on namespace_record.oid = procedure_record.pronamespace
        join pg_language as language_record on language_record.oid = procedure_record.prolang
        where namespace_record.nspname = 'hermes_adapter'
        order by procedure_record.proname, procedure_record.oid
      ) as functions,
      array(
        select procedure_record.prosrc
        from pg_proc as procedure_record
        join pg_namespace as namespace_record on namespace_record.oid = procedure_record.pronamespace
        where namespace_record.nspname = 'hermes_adapter'
        order by procedure_record.proname, procedure_record.oid
      ) as "functionSources",
      has_schema_privilege('public', 'hermes_adapter', 'USAGE') as "publicSchemaUsage",
      (
        has_table_privilege('public', 'hermes_adapter.delivery_dedupe', 'SELECT')
        or has_table_privilege('public', 'hermes_adapter.delivery_dedupe', 'INSERT')
        or has_table_privilege('public', 'hermes_adapter.delivery_dedupe', 'UPDATE')
        or has_table_privilege('public', 'hermes_adapter.delivery_dedupe', 'DELETE')
        or has_table_privilege('public', 'hermes_adapter.delivery_dedupe', 'TRUNCATE')
        or has_table_privilege('public', 'hermes_adapter.delivery_dedupe', 'REFERENCES')
        or has_table_privilege('public', 'hermes_adapter.delivery_dedupe', 'TRIGGER')
        or has_any_column_privilege('public', 'hermes_adapter.delivery_dedupe', 'SELECT')
        or has_any_column_privilege('public', 'hermes_adapter.delivery_dedupe', 'INSERT')
        or has_any_column_privilege('public', 'hermes_adapter.delivery_dedupe', 'UPDATE')
        or has_any_column_privilege('public', 'hermes_adapter.delivery_dedupe', 'REFERENCES')
        or has_table_privilege('public', 'hermes_adapter.schema_migrations', 'SELECT')
        or has_table_privilege('public', 'hermes_adapter.schema_migrations', 'INSERT')
        or has_table_privilege('public', 'hermes_adapter.schema_migrations', 'UPDATE')
        or has_table_privilege('public', 'hermes_adapter.schema_migrations', 'DELETE')
        or has_table_privilege('public', 'hermes_adapter.schema_migrations', 'TRUNCATE')
        or has_table_privilege('public', 'hermes_adapter.schema_migrations', 'REFERENCES')
        or has_table_privilege('public', 'hermes_adapter.schema_migrations', 'TRIGGER')
        or has_any_column_privilege('public', 'hermes_adapter.schema_migrations', 'SELECT')
        or has_any_column_privilege('public', 'hermes_adapter.schema_migrations', 'INSERT')
        or has_any_column_privilege('public', 'hermes_adapter.schema_migrations', 'UPDATE')
        or has_any_column_privilege('public', 'hermes_adapter.schema_migrations', 'REFERENCES')
      ) as "publicTablePrivilege",
      coalesce((
        select bool_or(has_function_privilege('public', procedure_record.oid, 'EXECUTE'))
        from pg_proc as procedure_record
        join pg_namespace as namespace_record on namespace_record.oid = procedure_record.pronamespace
        where namespace_record.nspname = 'hermes_adapter'
      ), false) as "publicFunctionExecute"
  `;
  const shape = rows[0];
  const functionSourceHashes =
    shape?.functionSources.map((source) =>
      createHash("sha256").update(source, "utf8").digest("hex"),
    ) ?? [];
  if (
    shape === undefined ||
    !arraysEqual(shape.columns, EXPECTED_COLUMNS) ||
    !arraysEqual(shape.migrationColumns, EXPECTED_MIGRATION_COLUMNS) ||
    !arraysEqual(shape.constraints, EXPECTED_CONSTRAINTS) ||
    !arraysEqual(shape.migrationConstraints, EXPECTED_MIGRATION_CONSTRAINTS) ||
    !arraysEqual(shape.indexes, EXPECTED_INDEXES) ||
    !arraysEqual(shape.relations, EXPECTED_RELATIONS) ||
    !arraysEqual(shape.triggers, EXPECTED_TRIGGERS) ||
    !arraysEqual(shape.functions, EXPECTED_FUNCTIONS) ||
    !arraysEqual(functionSourceHashes, EXPECTED_FUNCTION_SOURCE_HASHES) ||
    shape.publicSchemaUsage ||
    shape.publicTablePrivilege ||
    shape.publicFunctionExecute
  ) {
    throw new PostgresDeliveryDedupeStoreError(
      "unsupported_schema",
      "The delivery dedupe database schema does not match migration v1.",
    );
  }
}

async function assertMigrationIdentity(transaction: TransactionSql): Promise<void> {
  const migrations = await transaction<MigrationRow[]>`
    select version, checksum
    from hermes_adapter.schema_migrations
    order by version
  `;
  if (
    migrations.length !== 1 ||
    migrations[0]?.version !== 1 ||
    migrations[0]?.checksum !== MIGRATION_CHECKSUM_V1
  ) {
    throw new PostgresDeliveryDedupeStoreError(
      "unsupported_schema",
      "The delivery dedupe migration identity is unsupported.",
    );
  }
}

async function assertRuntimeBoundary(transaction: TransactionSql): Promise<void> {
  const roles = await transaction<RuntimeBoundaryRow[]>`
    select
      role_record.rolcanlogin as "canLogin",
      role_record.rolcreatedb as "createsDatabase",
      role_record.rolcreaterole as "createsRole",
      role_record.rolbypassrls as "bypassesRowSecurity",
      role_record.rolinherit as inherits,
      not exists (
        select 1 from pg_auth_members as membership_record
        where membership_record.member = role_record.oid
      ) as isolated,
      exists (
        select 1
        from pg_namespace as owned_namespace
        where
          owned_namespace.nspname = 'hermes_adapter'
          and owned_namespace.nspowner = role_record.oid
        union all
        select 1
        from pg_class as owned_relation
        join pg_namespace as relation_namespace on
          relation_namespace.oid = owned_relation.relnamespace
        where
          relation_namespace.nspname = 'hermes_adapter'
          and owned_relation.relowner = role_record.oid
        union all
        select 1
        from pg_proc as owned_procedure
        join pg_namespace as procedure_namespace on
          procedure_namespace.oid = owned_procedure.pronamespace
        where
          procedure_namespace.nspname = 'hermes_adapter'
          and owned_procedure.proowner = role_record.oid
      ) as "ownsAdapterObjects",
      exists (
        select 1 from pg_database as database_record
        where
          database_record.datname = current_database()
          and database_record.datdba = role_record.oid
      ) as "ownsDatabase",
      role_record.rolreplication as replicates,
      role_record.rolsuper as superuser,
      session_user = current_user as "directSession",
      has_table_privilege(
        current_user,
        'hermes_adapter.schema_migrations',
        'SELECT'
      ) as "migrationReadPrivilege",
      (
        has_table_privilege(current_user, 'hermes_adapter.schema_migrations', 'INSERT')
        or has_table_privilege(current_user, 'hermes_adapter.schema_migrations', 'UPDATE')
        or has_table_privilege(current_user, 'hermes_adapter.schema_migrations', 'DELETE')
        or has_table_privilege(current_user, 'hermes_adapter.schema_migrations', 'TRUNCATE')
        or has_table_privilege(current_user, 'hermes_adapter.schema_migrations', 'REFERENCES')
        or has_table_privilege(current_user, 'hermes_adapter.schema_migrations', 'TRIGGER')
        or has_any_column_privilege(current_user, 'hermes_adapter.schema_migrations', 'INSERT')
        or has_any_column_privilege(current_user, 'hermes_adapter.schema_migrations', 'UPDATE')
        or has_any_column_privilege(current_user, 'hermes_adapter.schema_migrations', 'REFERENCES')
      ) as "migrationWritePrivilege",
      (
        has_function_privilege(
          current_user,
          'hermes_adapter.reserve_delivery_dedupe(uuid,text,text,timestamp with time zone,bigint,bigint)',
          'EXECUTE'
        )
        and has_function_privilege(
          current_user,
          'hermes_adapter.mark_delivery_dedupe(uuid,text)',
          'EXECUTE'
        )
        and has_function_privilege(
          current_user,
          'hermes_adapter.release_delivery_dedupe(uuid,text)',
          'EXECUTE'
        )
      ) as "operationFunctionsExecute",
      has_schema_privilege(current_user, 'hermes_adapter', 'CREATE') as "schemaCreate",
      has_schema_privilege(current_user, 'hermes_adapter', 'USAGE') as "schemaUsage",
      (
        has_table_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'SELECT')
        or has_table_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'INSERT')
        or has_table_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'UPDATE')
        or has_table_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'DELETE')
        or has_table_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'TRUNCATE')
        or has_table_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'REFERENCES')
        or has_table_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'TRIGGER')
        or has_any_column_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'SELECT')
        or has_any_column_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'INSERT')
        or has_any_column_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'UPDATE')
        or has_any_column_privilege(current_user, 'hermes_adapter.delivery_dedupe', 'REFERENCES')
      ) as "tablePrivilege",
      has_function_privilege(
        current_user,
        'hermes_adapter.enforce_delivery_dedupe_transition()',
        'EXECUTE'
      ) as "transitionFunctionExecute"
    from pg_roles as role_record
    where role_record.rolname = current_user
  `;
  const role = roles[0];
  if (
    roles.length !== 1 ||
    role === undefined ||
    !role.canLogin ||
    role.createsDatabase ||
    role.createsRole ||
    role.bypassesRowSecurity ||
    role.inherits ||
    !role.isolated ||
    role.ownsAdapterObjects ||
    role.ownsDatabase ||
    role.replicates ||
    role.superuser ||
    !role.directSession ||
    !role.migrationReadPrivilege ||
    role.migrationWritePrivilege ||
    !role.operationFunctionsExecute ||
    role.schemaCreate ||
    !role.schemaUsage ||
    role.tablePrivilege ||
    role.transitionFunctionExecute
  ) {
    throw new PostgresDeliveryDedupeStoreError(
      "unsupported_schema",
      "The delivery dedupe runtime role no longer matches the execute-only boundary.",
    );
  }
}

/** Applies and attests the adapter-owned schema with a migration role. */
export async function migratePostgresDeliveryDedupeStore(sql: Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK}, 0))`;
    await transaction`create schema if not exists hermes_adapter`;
    await transaction`
      alter default privileges revoke execute on functions from public
    `;
    await transaction`
      create table if not exists hermes_adapter.schema_migrations (
        version integer primary key,
        checksum text not null,
        applied_at timestamptz not null default clock_timestamp(),
        constraint hermes_schema_migration_checksum_valid
          check (checksum ~ '^[0-9a-f]{64}$')
      )
    `;
    const migrations = await transaction<MigrationRow[]>`
      select version, checksum
      from hermes_adapter.schema_migrations
      order by version
    `;
    if (migrations.length === 0) {
      await transaction`
        create table hermes_adapter.delivery_dedupe (
          dedupe_key uuid primary key,
          command_hash text not null,
          reservation_token_hash text not null,
          status text not null,
          reservation_expires_at timestamptz,
          delivered_at timestamptz,
          created_at timestamptz not null default clock_timestamp(),
          updated_at timestamptz not null default clock_timestamp(),
          constraint hermes_delivery_dedupe_command_hash_valid
            check (command_hash ~ '^[0-9a-f]{64}$'),
          constraint hermes_delivery_dedupe_reservation_token_hash_valid
            check (reservation_token_hash ~ '^[0-9a-f]{64}$'),
          constraint hermes_delivery_dedupe_state_valid check (
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
          ),
          constraint hermes_delivery_dedupe_timestamps_valid check (
            updated_at >= created_at
            and (delivered_at is null or delivered_at >= created_at)
          )
        )
      `;
      await transaction`
        create index hermes_delivery_dedupe_expiry_idx
        on hermes_adapter.delivery_dedupe (reservation_expires_at, dedupe_key)
        where status = 'reserved'
      `;
      await transaction`
        create function hermes_adapter.enforce_delivery_dedupe_transition()
        returns trigger
        language plpgsql
        set search_path = pg_catalog
        as $function$
        declare
          observed_at timestamptz := clock_timestamp();
        begin
          if TG_OP = 'INSERT' then
            if
              NEW.status <> 'reserved'
              or NEW.reservation_expires_at <= observed_at
              or NEW.reservation_expires_at > observed_at + interval '1 hour'
            then
              raise exception using
                errcode = '23514',
                message = 'Invalid delivery dedupe insert transition.',
                constraint = 'hermes_delivery_dedupe_transition_valid';
            end if;
            return NEW;
          end if;

          if
            NEW.dedupe_key is distinct from OLD.dedupe_key
            or NEW.command_hash is distinct from OLD.command_hash
            or NEW.created_at is distinct from OLD.created_at
            or NEW.updated_at < OLD.updated_at
          then
            raise exception using
              errcode = '23514',
              message = 'Immutable delivery dedupe identity was changed.',
              constraint = 'hermes_delivery_dedupe_transition_valid';
          end if;

          if OLD.status = 'delivered' then
            raise exception using
              errcode = '23514',
              message = 'Delivered dedupe records are immutable.',
              constraint = 'hermes_delivery_dedupe_transition_valid';
          elsif OLD.status = 'available' then
            if
              NEW.status <> 'reserved'
              or NEW.reservation_token_hash is not distinct from OLD.reservation_token_hash
              or NEW.reservation_expires_at <= observed_at
              or NEW.reservation_expires_at > observed_at + interval '1 hour'
            then
              raise exception using
                errcode = '23514',
                message = 'Invalid available delivery dedupe transition.',
                constraint = 'hermes_delivery_dedupe_transition_valid';
            end if;
          elsif OLD.status = 'reserved' then
            if NEW.status = 'reserved' then
              if
                OLD.reservation_expires_at > observed_at
                or NEW.reservation_token_hash is not distinct from OLD.reservation_token_hash
                or NEW.reservation_expires_at <= observed_at
                or NEW.reservation_expires_at > observed_at + interval '1 hour'
              then
                raise exception using
                  errcode = '23514',
                  message = 'Invalid reserved delivery dedupe takeover.',
                  constraint = 'hermes_delivery_dedupe_transition_valid';
              end if;
            elsif NEW.status = 'available' then
              if NEW.reservation_token_hash is distinct from OLD.reservation_token_hash then
                raise exception using
                  errcode = '23514',
                  message = 'Invalid delivery dedupe release transition.',
                  constraint = 'hermes_delivery_dedupe_transition_valid';
              end if;
            elsif NEW.status = 'delivered' then
              if
                NEW.reservation_token_hash is distinct from OLD.reservation_token_hash
                or OLD.reservation_expires_at <= observed_at
              then
                raise exception using
                  errcode = '23514',
                  message = 'Invalid delivered dedupe transition.',
                  constraint = 'hermes_delivery_dedupe_transition_valid';
              end if;
            else
              raise exception using
                errcode = '23514',
                message = 'Invalid reserved delivery dedupe transition.',
                constraint = 'hermes_delivery_dedupe_transition_valid';
            end if;
          else
            raise exception using
              errcode = '23514',
              message = 'Unknown delivery dedupe state.',
              constraint = 'hermes_delivery_dedupe_transition_valid';
          end if;

          return NEW;
        end
        $function$
      `;
      await transaction`
        create trigger hermes_delivery_dedupe_transition_guard
        before insert or update on hermes_adapter.delivery_dedupe
        for each row execute function hermes_adapter.enforce_delivery_dedupe_transition()
      `;
      await transaction`
        create function hermes_adapter.reserve_delivery_dedupe(
          input_dedupe_key uuid,
          input_command_hash text,
          input_reservation_token_hash text,
          input_reservation_expires_at timestamptz,
          input_minimum_remaining_milliseconds bigint,
          input_maximum_horizon_milliseconds bigint
        )
        returns table (
          outcome text,
          stored_command_hash text,
          budget_valid boolean
        )
        language plpgsql
        security definer
        strict
        set search_path = pg_catalog
        as $function$
        declare
          observed_at timestamptz := clock_timestamp();
        begin
          if
            input_command_hash !~ '^[0-9a-f]{64}$'
            or input_reservation_token_hash !~ '^[0-9a-f]{64}$'
            or input_minimum_remaining_milliseconds < 0
            or input_maximum_horizon_milliseconds < 1000
            or input_maximum_horizon_milliseconds > 3600000
            or input_minimum_remaining_milliseconds > input_maximum_horizon_milliseconds
            or input_reservation_expires_at < observed_at
              + (input_minimum_remaining_milliseconds * interval '1 millisecond')
            or input_reservation_expires_at > observed_at
              + (input_maximum_horizon_milliseconds * interval '1 millisecond')
          then
            return query select 'invalid'::text, null::text, false;
            return;
          end if;

          return query
            insert into hermes_adapter.delivery_dedupe as existing_record (
              dedupe_key,
              command_hash,
              reservation_token_hash,
              status,
              reservation_expires_at
            )
            values (
              input_dedupe_key,
              input_command_hash,
              input_reservation_token_hash,
              'reserved',
              input_reservation_expires_at
            )
            on conflict (dedupe_key) do update
            set
              reservation_token_hash = excluded.reservation_token_hash,
              status = 'reserved',
              reservation_expires_at = excluded.reservation_expires_at,
              delivered_at = null,
              updated_at = clock_timestamp()
            where
              existing_record.command_hash = excluded.command_hash
              and (
                existing_record.status = 'available'
                or (
                  existing_record.status = 'reserved'
                  and existing_record.reservation_expires_at <= clock_timestamp()
                )
              )
            returning
              'acquired'::text,
              existing_record.command_hash,
              existing_record.reservation_expires_at >= clock_timestamp()
                + (input_minimum_remaining_milliseconds * interval '1 millisecond');
          if found then return; end if;

          return query
            select
              case
                when existing_record.command_hash <> input_command_hash then 'payload_conflict'
                when existing_record.status = 'delivered' then 'delivered'
                when existing_record.status in ('available', 'reserved') then 'busy'
                else 'inconsistent'
              end,
              existing_record.command_hash,
              null::boolean
            from hermes_adapter.delivery_dedupe as existing_record
            where existing_record.dedupe_key = input_dedupe_key;
          if not found then
            return query select 'missing'::text, null::text, null::boolean;
          end if;
        end
        $function$
      `;
      await transaction`
        create function hermes_adapter.mark_delivery_dedupe(
          input_dedupe_key uuid,
          input_reservation_token_hash text
        )
        returns text
        language plpgsql
        security definer
        strict
        set search_path = pg_catalog
        as $function$
        declare
          stored_status text;
          stored_token_hash text;
        begin
          update hermes_adapter.delivery_dedupe
          set
            status = 'delivered',
            reservation_expires_at = null,
            delivered_at = clock_timestamp(),
            updated_at = clock_timestamp()
          where
            dedupe_key = input_dedupe_key
            and status = 'reserved'
            and reservation_token_hash = input_reservation_token_hash
            and reservation_expires_at > clock_timestamp();
          if found then return 'delivered'; end if;

          select status, reservation_token_hash
          into stored_status, stored_token_hash
          from hermes_adapter.delivery_dedupe
          where dedupe_key = input_dedupe_key;
          if not found then return 'missing'; end if;
          if stored_status = 'delivered' and stored_token_hash = input_reservation_token_hash then
            return 'delivered';
          end if;
          return 'fenced';
        end
        $function$
      `;
      await transaction`
        create function hermes_adapter.release_delivery_dedupe(
          input_dedupe_key uuid,
          input_reservation_token_hash text
        )
        returns text
        language plpgsql
        security definer
        strict
        set search_path = pg_catalog
        as $function$
        declare
          stored_status text;
          stored_token_hash text;
        begin
          update hermes_adapter.delivery_dedupe
          set
            status = 'available',
            reservation_expires_at = null,
            updated_at = clock_timestamp()
          where
            dedupe_key = input_dedupe_key
            and status = 'reserved'
            and reservation_token_hash = input_reservation_token_hash;
          if found then return 'released'; end if;

          select status, reservation_token_hash
          into stored_status, stored_token_hash
          from hermes_adapter.delivery_dedupe
          where dedupe_key = input_dedupe_key;
          if not found then return 'missing'; end if;
          if stored_status = 'available' and stored_token_hash = input_reservation_token_hash then
            return 'released';
          end if;
          return 'fenced';
        end
        $function$
      `;
      await transaction`
        insert into hermes_adapter.schema_migrations (version, checksum)
        values (1, ${MIGRATION_CHECKSUM_V1})
      `;
    }
    await transaction`revoke all on schema hermes_adapter from public`;
    await transaction`revoke all on all tables in schema hermes_adapter from public`;
    await transaction`revoke all on all functions in schema hermes_adapter from public`;
    await assertMigrationIdentity(transaction);
    await assertSchemaShape(transaction);
  });
}

/** Grants only the privileges required by normal adapter operations to an existing role. */
export async function grantPostgresDeliveryDedupeRuntimeRole(
  sql: Sql,
  runtimeRole: string,
): Promise<void> {
  const quotedRole = quotedDatabaseRole(runtimeRole);
  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK}, 0))`;
    await assertMigrationIdentity(transaction);
    await assertSchemaShape(transaction);
    const roles = await transaction<RuntimeRoleRow[]>`
      select
        role_record.rolcanlogin as "canLogin",
        role_record.rolcreatedb as "createsDatabase",
        role_record.rolcreaterole as "createsRole",
        role_record.rolbypassrls as "bypassesRowSecurity",
        role_record.rolinherit as inherits,
        not exists (
          select 1 from pg_auth_members as membership_record
          where membership_record.member = role_record.oid
        ) as isolated,
        exists (
          select 1
          from pg_namespace as owned_namespace
          where
            owned_namespace.nspname = 'hermes_adapter'
            and owned_namespace.nspowner = role_record.oid
          union all
          select 1
          from pg_class as owned_relation
          join pg_namespace as relation_namespace on
            relation_namespace.oid = owned_relation.relnamespace
          where
            relation_namespace.nspname = 'hermes_adapter'
            and owned_relation.relowner = role_record.oid
          union all
          select 1
          from pg_proc as owned_procedure
          join pg_namespace as procedure_namespace on
            procedure_namespace.oid = owned_procedure.pronamespace
          where
            procedure_namespace.nspname = 'hermes_adapter'
            and owned_procedure.proowner = role_record.oid
        ) as "ownsAdapterObjects",
        exists (
          select 1 from pg_database as database_record
          where
            database_record.datname = current_database()
            and database_record.datdba = role_record.oid
        ) as "ownsDatabase",
        role_record.rolreplication as replicates,
        role_record.rolsuper as superuser
      from pg_roles as role_record
      where role_record.rolname = ${runtimeRole}
    `;
    const role = roles[0];
    if (
      roles.length !== 1 ||
      role === undefined ||
      !role.canLogin ||
      role.createsDatabase ||
      role.createsRole ||
      role.bypassesRowSecurity ||
      role.inherits ||
      !role.isolated ||
      role.ownsAdapterObjects ||
      role.ownsDatabase ||
      role.replicates ||
      role.superuser
    ) {
      invalid(
        "runtimeRole must be a dedicated NOINHERIT LOGIN role without elevated attributes, role memberships, or database/adapter object ownership.",
      );
    }
    await transaction.unsafe(`revoke all on schema hermes_adapter from ${quotedRole}`);
    await transaction.unsafe(
      `revoke all on all tables in schema hermes_adapter from ${quotedRole}`,
    );
    await transaction.unsafe(
      `revoke all on all functions in schema hermes_adapter from ${quotedRole}`,
    );
    await transaction.unsafe(`grant usage on schema hermes_adapter to ${quotedRole}`);
    await transaction.unsafe(`grant select on hermes_adapter.schema_migrations to ${quotedRole}`);
    await transaction.unsafe(
      `grant execute on function hermes_adapter.reserve_delivery_dedupe(uuid, text, text, timestamptz, bigint, bigint) to ${quotedRole}`,
    );
    await transaction.unsafe(
      `grant execute on function hermes_adapter.mark_delivery_dedupe(uuid, text) to ${quotedRole}`,
    );
    await transaction.unsafe(
      `grant execute on function hermes_adapter.release_delivery_dedupe(uuid, text) to ${quotedRole}`,
    );
  });
}

/** PostgreSQL-backed cross-process fencing for reminder provider side effects. */
export class PostgresDeliveryDedupeStore implements DeliveryDedupeStore {
  private readonly maximumReservationHorizonMilliseconds: number;
  private readonly statementTimeoutMilliseconds: number;
  private readonly reservationToken: () => string;

  constructor(
    private readonly sql: Sql,
    options: PostgresDeliveryDedupeStoreOptions = {},
  ) {
    this.maximumReservationHorizonMilliseconds = requireMaximumReservationHorizon(
      options.maximumReservationHorizonMilliseconds ??
        DEFAULT_MAXIMUM_RESERVATION_HORIZON_MILLISECONDS,
    );
    this.statementTimeoutMilliseconds = requireStatementTimeout(
      options.statementTimeoutMilliseconds ?? DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS,
    );
    this.reservationToken = options.reservationToken ?? randomUUID;
  }

  private async transaction<Result>(
    operation: (transaction: TransactionSql) => Promise<Result>,
  ): Promise<Result> {
    try {
      const result = await this.sql.begin(async (transaction) => {
        const timeout = `${String(this.statementTimeoutMilliseconds)}ms`;
        await transaction`
          select
            set_config('lock_timeout', ${timeout}, true),
            set_config('statement_timeout', ${timeout}, true)
        `;
        await assertRuntimeBoundary(transaction);
        await assertMigrationIdentity(transaction);
        await assertSchemaShape(transaction);
        return operation(transaction);
      });
      // postgres-js recursively unwraps arrays returned from transaction callbacks. Store
      // operations return discriminated objects or void, so the generic value is unchanged.
      return result as Result;
    } catch (error) {
      if (isOperationTimeout(error)) {
        throw new PostgresDeliveryDedupeStoreError(
          "operation_timeout",
          "A delivery dedupe database statement exceeded its bounded deadline.",
        );
      }
      throw error;
    }
  }

  async reserve(input: {
    readonly dedupeKey: string;
    readonly commandHash: string;
    readonly claimToken: string;
    readonly reservationExpiresAt: Date;
    readonly minimumRemainingMilliseconds: number;
  }): Promise<DedupeReservation> {
    const dedupeKey = normalizeUuid(input.dedupeKey, "dedupeKey");
    const commandHash = normalizeHash(input.commandHash, "commandHash");
    normalizeUuid(input.claimToken, "claimToken");
    if (
      !(input.reservationExpiresAt instanceof Date) ||
      !Number.isFinite(input.reservationExpiresAt.getTime())
    ) {
      invalid("reservationExpiresAt must be a valid Date.");
    }
    const reservationExpiresAt = new Date(input.reservationExpiresAt.getTime());
    const reservationExpiresAtIso = reservationExpiresAt.toISOString();
    const minimumRemainingMilliseconds = requireMinimumRemaining(
      input.minimumRemainingMilliseconds,
      this.maximumReservationHorizonMilliseconds,
    );
    const reservationToken = normalizeUuid(this.reservationToken(), "reservationToken");
    const reservationTokenHash = digest(reservationToken);

    try {
      return await this.transaction(async (transaction): Promise<DedupeReservation> => {
        const rows = await transaction<ReserveFunctionRow[]>`
          select
            outcome,
            stored_command_hash as "storedCommandHash",
            budget_valid as "budgetValid"
          from hermes_adapter.reserve_delivery_dedupe(
            ${dedupeKey}::uuid,
            ${commandHash},
            ${reservationTokenHash},
            ${reservationExpiresAtIso}::timestamptz,
            ${minimumRemainingMilliseconds}::bigint,
            ${this.maximumReservationHorizonMilliseconds}::bigint
          )
        `;
        const row = rows[0];
        if (rows.length !== 1 || row === undefined) {
          throw new PostgresDeliveryDedupeStoreError(
            "store_inconsistent",
            "The durable delivery dedupe reservation returned an invalid result.",
          );
        }
        if (
          row.outcome === "acquired" &&
          row.storedCommandHash === commandHash &&
          row.budgetValid === true
        ) {
          return { state: "acquired", reservationToken };
        }
        if (
          row.outcome === "payload_conflict" &&
          typeof row.storedCommandHash === "string" &&
          SHA_256.test(row.storedCommandHash) &&
          row.storedCommandHash !== commandHash
        ) {
          return { state: "payload_conflict" };
        }
        if (
          (row.outcome === "delivered" || row.outcome === "busy") &&
          row.storedCommandHash === commandHash
        ) {
          return { state: row.outcome };
        }
        if (row.outcome === "invalid" && row.storedCommandHash === null) {
          invalid(
            "reservationExpiresAt must preserve the required budget inside the database-clock horizon.",
          );
        }
        throw new PostgresDeliveryDedupeStoreError(
          "store_inconsistent",
          "The durable delivery dedupe reservation returned an inconsistent state.",
        );
      });
    } catch (error) {
      if (isTransitionViolation(error)) {
        invalid(
          "reservationExpiresAt lost its required budget while the durable reservation was being acquired.",
        );
      }
      if (error instanceof PostgresDeliveryDedupeStoreError && error.code === "operation_timeout") {
        return { state: "busy" };
      }
      throw error;
    }
  }

  async markDelivered(input: {
    readonly dedupeKey: string;
    readonly reservationToken: string;
  }): Promise<void> {
    const dedupeKey = normalizeUuid(input.dedupeKey, "dedupeKey");
    const reservationTokenHash = digest(normalizeUuid(input.reservationToken, "reservationToken"));

    await this.transaction(async (transaction) => {
      const rows = await transaction<{ outcome: string }[]>`
        select hermes_adapter.mark_delivery_dedupe(
          ${dedupeKey}::uuid,
          ${reservationTokenHash}
        ) as outcome
      `;
      if (rows.length === 1 && rows[0]?.outcome === "delivered") return;
      if (rows.length !== 1 || rows[0]?.outcome !== "fenced") {
        throw new PostgresDeliveryDedupeStoreError(
          "store_inconsistent",
          "The durable delivery dedupe record is missing or invalid.",
        );
      }
      throw new PostgresDeliveryDedupeStoreError(
        "reservation_fenced",
        "The delivery dedupe reservation is no longer owned by this token.",
      );
    });
  }

  async release(input: {
    readonly dedupeKey: string;
    readonly reservationToken: string;
  }): Promise<void> {
    const dedupeKey = normalizeUuid(input.dedupeKey, "dedupeKey");
    const reservationTokenHash = digest(normalizeUuid(input.reservationToken, "reservationToken"));

    await this.transaction(async (transaction) => {
      const rows = await transaction<{ outcome: string }[]>`
        select hermes_adapter.release_delivery_dedupe(
          ${dedupeKey}::uuid,
          ${reservationTokenHash}
        ) as outcome
      `;
      if (rows.length === 1 && rows[0]?.outcome === "released") return;
      if (rows.length !== 1 || rows[0]?.outcome !== "fenced") {
        throw new PostgresDeliveryDedupeStoreError(
          "store_inconsistent",
          "The durable delivery dedupe record is missing or invalid.",
        );
      }
      throw new PostgresDeliveryDedupeStoreError(
        "reservation_fenced",
        "The delivery dedupe reservation is no longer owned by this token.",
      );
    });
  }
}
