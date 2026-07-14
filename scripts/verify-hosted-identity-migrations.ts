import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type DatabaseConnection } from "../packages/database/src/index.js";
import { expectConstraint } from "./lib/postgres-assertions.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const adminUrl = new URL(sourceDatabaseUrl);
adminUrl.pathname = "/postgres";
const verificationDatabase = `schedule_identity_migration_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_identity_migration_[a-f0-9]{32}$/u;
const verificationUrl = new URL(sourceDatabaseUrl);
verificationUrl.pathname = `/${verificationDatabase}`;
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/database/drizzle",
);
const admin = createDatabase(adminUrl.toString(), 1);
let verification: DatabaseConnection | undefined;

async function applyMigration(connection: DatabaseConnection, tag: string): Promise<void> {
  const migration = await readFile(path.join(migrationsFolder, `${tag}.sql`), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await connection.sql.unsafe(statement);
  }
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe hosted-identity migration database identifier.");
  }
  return `"${verificationDatabase}"`;
}

try {
  await admin.sql.unsafe(`create database ${quotedVerificationDatabase()} owner schedule`);
  verification = createDatabase(verificationUrl.toString(), 1);
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
  const identityMigration = entries.find((entry) => entry.idx === 31);
  if (identityMigration === undefined) {
    throw new Error("Hosted identity migration 0031 is missing from the journal.");
  }
  for (const migration of entries.filter((entry) => entry.idx < 31)) {
    await applyMigration(verification, migration.tag);
  }

  const workspace = randomUUID();
  const workItem = randomUUID();
  await verification.sql`
    insert into workspaces (id, name) values (${workspace}, 'Pre-identity workspace')
  `;
  await verification.sql`
    insert into work_items (id, workspace_id, title)
    values (${workItem}, ${workspace}, 'Pre-identity work item')
  `;
  const [before] = await verification.sql<{ users: string | null }[]>`
    select to_regclass('public.users')::text as users
  `;
  assert.equal(before?.users, null);

  await applyMigration(verification, identityMigration.tag);
  const [preserved] = await verification.sql<{ workspaces: number; workItems: number }[]>`
    select
      (select count(*)::integer from workspaces where id = ${workspace}) as workspaces,
      (select count(*)::integer from work_items where id = ${workItem}) as "workItems"
  `;
  assert.deepEqual(preserved, { workspaces: 1, workItems: 1 });
  const tables = await verification.sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name = any(${[
        "users",
        "external_identities",
        "browser_sessions",
        "workspace_memberships",
      ]})
    order by table_name
  `;
  assert.deepEqual(
    tables.map((row) => row.table_name),
    ["browser_sessions", "external_identities", "users", "workspace_memberships"],
  );

  const user = randomUUID();
  const identity = randomUUID();
  await verification.sql`insert into users (id) values (${user})`;
  await verification.sql`
    insert into external_identities (id, user_id, issuer, subject)
    values (${identity}, ${user}, 'https://Identity.Example ', ' Subject ')
  `;
  await verification.sql`
    insert into external_identities (id, user_id, issuer, subject)
    values (${randomUUID()}, ${user}, 'https://identity.example ', ' Subject ')
  `;
  await expectConstraint(
    () =>
      verification!.sql`
        insert into external_identities (id, user_id, issuer, subject)
        values (${randomUUID()}, ${user}, 'https://Identity.Example ', ' Subject ')
      `,
    "23505",
    "external_identities_exact_binding_uq",
  );
  await verification.sql`
    insert into workspace_memberships (user_id, workspace_id) values (${user}, ${workspace})
  `;
  await verification.sql`delete from users where id = ${user}`;
  const [afterDeletion] = await verification.sql<
    { identities: number; memberships: number; workspaces: number; workItems: number }[]
  >`
    select
      (select count(*)::integer from external_identities where user_id = ${user}) as identities,
      (select count(*)::integer from workspace_memberships where user_id = ${user}) as memberships,
      (select count(*)::integer from workspaces where id = ${workspace}) as workspaces,
      (select count(*)::integer from work_items where id = ${workItem}) as "workItems"
  `;
  assert.deepEqual(afterDeletion, { identities: 0, memberships: 0, workspaces: 1, workItems: 1 });

  console.log(
    `Hosted identity migration verification passed upgrade preservation, exact binding uniqueness, cascade isolation, and workspace data retention in ${verificationDatabase}`,
  );
} finally {
  await verification?.close().catch(() => undefined);
  await admin.sql`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = ${verificationDatabase} and pid <> pg_backend_pid()
  `.catch(() => undefined);
  await admin.sql.unsafe(`drop database if exists ${quotedVerificationDatabase()}`);
  await admin.close();
}
