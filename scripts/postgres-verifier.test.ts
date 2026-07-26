import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseNativePostgresVerifier,
  redactVerifierCredentials,
  runNativeVerifierCommand,
  verifierCommandDatabaseUrl,
  verifierDatabaseUrl,
} from "./postgres-verifier.js";

function withNativeEnvironment<Result>(databaseUrl: string, operation: () => Result): Result {
  const previousBin = process.env.SCHEDULE_VERIFIER_POSTGRES_BIN;
  const previousUrl = process.env.SCHEDULE_VERIFIER_DATABASE_URL;
  process.env.SCHEDULE_VERIFIER_POSTGRES_BIN = "/opt/pg/bin";
  process.env.SCHEDULE_VERIFIER_DATABASE_URL = databaseUrl;
  try {
    return operation();
  } finally {
    if (previousBin === undefined) delete process.env.SCHEDULE_VERIFIER_POSTGRES_BIN;
    else process.env.SCHEDULE_VERIFIER_POSTGRES_BIN = previousBin;
    if (previousUrl === undefined) delete process.env.SCHEDULE_VERIFIER_DATABASE_URL;
    else process.env.SCHEDULE_VERIFIER_DATABASE_URL = previousUrl;
  }
}

function nativeConfiguration() {
  const configuration = parseNativePostgresVerifier({
    SCHEDULE_VERIFIER_POSTGRES_BIN: path.dirname(process.execPath),
    SCHEDULE_VERIFIER_DATABASE_URL:
      "postgres://verifier:secret@localhost:5432/template1?sslmode=disable",
  });
  if (configuration === null) throw new Error("native verifier configuration was not selected");
  return configuration;
}

describe("native PostgreSQL verifier configuration", () => {
  it("keeps Compose as the default", () => {
    expect(parseNativePostgresVerifier({})).toBeNull();
  });

  it("requires both opt-in variables", () => {
    expect(() =>
      parseNativePostgresVerifier({ SCHEDULE_VERIFIER_POSTGRES_BIN: "C:\\pg\\bin" }),
    ).toThrow(/set together/);
    expect(() =>
      parseNativePostgresVerifier({
        SCHEDULE_VERIFIER_DATABASE_URL: "postgres://verifier@localhost:5432/template1",
      }),
    ).toThrow(/set together/);
  });

  it("derives platform-specific native command paths from a safe URL", () => {
    const result = parseNativePostgresVerifier(
      {
        SCHEDULE_VERIFIER_POSTGRES_BIN: "C:\\PostgreSQL\\bin",
        SCHEDULE_VERIFIER_DATABASE_URL: "postgresql://verifier:secret@127.0.0.1:5432/template1",
      },
      "win32",
    );
    expect(result).toMatchObject({
      databaseUser: "verifier",
      psql: path.win32.join("C:\\PostgreSQL\\bin", "psql.exe"),
    });
  });

  it("rejects unsafe native database identities", () => {
    expect(() =>
      parseNativePostgresVerifier({
        SCHEDULE_VERIFIER_POSTGRES_BIN: "/opt/pg/bin",
        SCHEDULE_VERIFIER_DATABASE_URL: "postgres://bad-user@localhost:5432/template1",
      }),
    ).toThrow(/simple PostgreSQL/);
  });

  it.each(["dbname", "host", "user", "service", "options"])(
    "rejects the libpq %s option",
    (option) => {
      expect(() =>
        parseNativePostgresVerifier({
          SCHEDULE_VERIFIER_POSTGRES_BIN: "/opt/pg/bin",
          SCHEDULE_VERIFIER_DATABASE_URL: `postgres://verifier:secret@localhost:5432/template1?${option}=schedule`,
        }),
      ).toThrow(/only one recognized sslmode/);
    },
  );

  it("rejects remote hosts, fragments, and unknown sslmode values", () => {
    expect(() =>
      parseNativePostgresVerifier({
        SCHEDULE_VERIFIER_POSTGRES_BIN: "/opt/pg/bin",
        SCHEDULE_VERIFIER_DATABASE_URL: "postgres://verifier:secret@example.test:5432/template1",
      }),
    ).toThrow(/loopback/);
    for (const suffix of ["#fragment", "?sslmode=unknown"]) {
      expect(() =>
        parseNativePostgresVerifier({
          SCHEDULE_VERIFIER_POSTGRES_BIN: "/opt/pg/bin",
          SCHEDULE_VERIFIER_DATABASE_URL: `postgres://verifier:secret@localhost:5432/template1${suffix}`,
        }),
      ).toThrow(/only one recognized sslmode/);
    }
  });

  it("rebinds native URLs to generated verifier databases", () => {
    withNativeEnvironment(
      "postgres://verifier:secret@localhost:5432/template1?sslmode=disable",
      () => {
        const databaseName = "schedule_recovery_active_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const commandUrl = verifierCommandDatabaseUrl(databaseName);
        expect(verifierDatabaseUrl(databaseName)).toContain(`/${databaseName}?sslmode=disable`);
        expect(new URL(commandUrl).password).toBe("");
        expect(commandUrl).toContain(`/${databaseName}?sslmode=disable`);
      },
    );
  });

  it("redacts encoded and decoded native credentials", () => {
    withNativeEnvironment(
      "postgres://verifier:s%40cret@localhost:5432/template1?sslmode=require",
      () => {
        const configured = process.env.SCHEDULE_VERIFIER_DATABASE_URL!;
        const output = redactVerifierCredentials(`${configured} s%40cret s@cret`);
        expect(output).not.toContain("s%40cret");
        expect(output).not.toContain("s@cret");
        expect(output).toContain("[SCHEDULE_VERIFIER_DATABASE_URL]");
      },
    );
  });

  it("bounds native commands that do not exit after the soft deadline", async () => {
    await expect(
      runNativeVerifierCommand(
        process.execPath,
        ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        nativeConfiguration(),
        { timeoutMs: 100, terminationGraceMs: 100 },
      ),
    ).rejects.toThrow(/timed out/);
  });
});
