import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AesGcmHostedLoginPkceProtector,
  ConsumeHostedLoginTransaction,
  HmacHostedLoginTransactionCodec,
  PruneHostedLoginTransactions,
  StartHostedLoginTransaction,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  PostgresHostedLoginTransactionUnitOfWork,
  type DatabaseConnection,
} from "../packages/database/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_login_tx_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_login_tx_verify_[a-f0-9]{32}$/u;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe hosted login transaction verification database identifier.");
  }
  return `"${verificationDatabase}"`;
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
  await new Promise<void>((resolve, reject) => {
    const output: Buffer[] = [];
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve();
      const diagnostic = Buffer.concat(output)
        .toString("utf8")
        .replaceAll(databaseUrl, "[DISPOSABLE_DATABASE_URL]")
        .trim();
      reject(
        new Error(
          `Hosted login transaction migration failed with exit code ${String(code)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let databaseCreated = false;
let connection: DatabaseConnection | null = null;

try {
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  await applyCurrentMigrations(disposableDatabaseUrl);
  connection = createDatabase(disposableDatabaseUrl, 16, {
    applicationName: "schedule-hosted-login-transaction-verifier",
  });

  const unitOfWork = new PostgresHostedLoginTransactionUnitOfWork(connection);
  const codec = new HmacHostedLoginTransactionCodec(
    "hosted-login-transaction-verifier-pepper-32-bytes",
  );
  const protector = new AesGcmHostedLoginPkceProtector({
    primaryKeyId: "verification",
    keys: { verification: Buffer.alloc(32, 7).toString("base64url") },
  });
  const start = new StartHostedLoginTransaction(unitOfWork, codec, protector);
  const consume = new ConsumeHostedLoginTransaction(unitOfWork, codec, protector);
  const startInput = {
    issuer: "https://identity.example/tenant",
    clientId: "schedule-web",
    redirectUri: "https://schedule.example/v1/auth/callback",
    returnToPath: "/today?source=hosted-login",
    ttlSeconds: 300,
  } as const;

  const issued = await start.execute(startInput);
  const issuedStateDigest = codec.stateDigestForLookup(issued.state).digest;
  const [persistedBeforeConsume] = await connection.sql<
    {
      stateDigest: string;
      browserBindingDigest: string;
      protectedPkceVerifier: string;
      rowText: string;
    }[]
  >`
    select
      state_digest as "stateDigest",
      browser_binding_digest as "browserBindingDigest",
      protected_pkce_verifier as "protectedPkceVerifier",
      row_to_json(login_transaction)::text as "rowText"
    from hosted_login_transactions as login_transaction
    where state_digest = ${issuedStateDigest}
  `;
  assert.ok(persistedBeforeConsume);
  assert.match(persistedBeforeConsume.stateDigest, /^[0-9a-f]{64}$/u);
  assert.match(persistedBeforeConsume.browserBindingDigest, /^[0-9a-f]{64}$/u);
  assert.equal(persistedBeforeConsume.rowText.includes(issued.state), false);
  assert.equal(persistedBeforeConsume.rowText.includes(issued.browserBinding), false);

  assert.equal(
    await consume.execute({ state: issued.state, browserBinding: "A".repeat(43) }),
    null,
  );
  const [afterWrongBinding] = await connection.sql<{ consumedAt: Date | null }[]>`
    select consumed_at as "consumedAt"
    from hosted_login_transactions
    where state_digest = ${issuedStateDigest}
  `;
  assert.equal(afterWrongBinding?.consumedAt, null);

  const concurrentResults = await Promise.all(
    Array.from({ length: 12 }, async () =>
      consume.execute({ state: issued.state, browserBinding: issued.browserBinding }),
    ),
  );
  const successful = concurrentResults.filter((result) => result !== null);
  assert.equal(successful.length, 1);
  const consumed = successful[0];
  assert.ok(consumed);
  assert.equal(consumed.issuer, startInput.issuer);
  assert.equal(consumed.clientId, startInput.clientId);
  assert.equal(consumed.redirectUri, startInput.redirectUri);
  assert.equal(consumed.returnToPath, startInput.returnToPath);
  assert.equal(consumed.expectedNonce, issued.nonce);
  assert.equal(codec.pkceChallenge(consumed.pkceVerifier), issued.pkceChallenge);
  assert.equal(persistedBeforeConsume.rowText.includes(consumed.pkceVerifier), false);
  assert.equal(
    await consume.execute({ state: issued.state, browserBinding: issued.browserBinding }),
    null,
  );

  const corrupted = await start.execute(startInput);
  const corruptedDigest = codec.stateDigestForLookup(corrupted.state).digest;
  await connection.sql`
    update hosted_login_transactions
    set protected_pkce_verifier = 'v1.verification.invalid.invalid.invalid'
    where state_digest = ${corruptedDigest}
  `;
  await assert.rejects(
    consume.execute({ state: corrupted.state, browserBinding: corrupted.browserBinding }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "hosted_login_transaction.pkce_protection_failed" &&
      "message" in error &&
      typeof error.message === "string" &&
      !error.message.includes(corrupted.state) &&
      !error.message.includes(corrupted.browserBinding),
  );
  const [corruptedState] = await connection.sql<{ consumedAt: Date | null }[]>`
    select consumed_at as "consumedAt"
    from hosted_login_transactions
    where state_digest = ${corruptedDigest}
  `;
  assert.equal(corruptedState?.consumedAt, null);

  const expired = await start.execute({ ...startInput, ttlSeconds: 60 });
  const expiredDigest = codec.stateDigestForLookup(expired.state).digest;
  await connection.sql`
    with boundary as (select clock_timestamp() as value)
    update hosted_login_transactions
    set
      created_at = boundary.value - interval '60 seconds',
      expires_at = boundary.value
    from boundary
    where state_digest = ${expiredDigest}
  `;
  assert.equal(
    await consume.execute({ state: expired.state, browserBinding: expired.browserBinding }),
    null,
  );

  const cleanupCandidate = await start.execute({ ...startInput, ttlSeconds: 60 });
  const cleanupDigest = codec.stateDigestForLookup(cleanupCandidate.state).digest;
  await connection.sql`
    with boundary as (select clock_timestamp() as value)
    update hosted_login_transactions
    set
      created_at = boundary.value - interval '60 seconds',
      expires_at = boundary.value
    from boundary
    where state_digest = ${cleanupDigest}
  `;
  const prune = new PruneHostedLoginTransactions(unitOfWork);
  assert.equal(await prune.execute(1), 1);
  const [remainingExpired] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count
    from hosted_login_transactions
    where expires_at <= clock_timestamp()
  `;
  assert.equal(remainingExpired?.count, 1);
  assert.equal(await prune.execute(1), 1);

  console.log(
    `Hosted login transaction verification passed digest-only state and browser binding, protected PKCE recovery, exact provider and redirect binding, concurrent single-use consumption, database-clock expiry, corruption rollback, redaction, and bounded cleanup in ${verificationDatabase}`,
  );
} finally {
  try {
    await connection?.close().catch(() => undefined);
    if (databaseCreated) {
      await adminConnection.sql`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where datname = ${verificationDatabase} and pid <> pg_backend_pid()
      `.catch(() => undefined);
      await adminConnection.sql.unsafe(`drop database if exists ${quotedVerificationDatabase()}`);
    }
  } finally {
    await adminConnection.close();
  }
}
