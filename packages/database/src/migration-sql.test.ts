import { describe, expect, it } from "vitest";

import { controlsMigrationTransaction, migrationSqlStatements } from "./migration-sql.js";

describe("migration SQL safety", () => {
  it("splits only top-level statements and raw Drizzle breakpoints", () => {
    const statements = migrationSqlStatements(`
      SELECT '; still text';
      DO $body$ BEGIN RAISE NOTICE ';'; END $body$;
      --> statement-breakpoint
      SELECT 3;
    `);
    expect(statements).toHaveLength(3);
    expect(statements.map(({ source }) => source.trim())).toEqual([
      "SELECT '; still text'",
      "DO $body$ BEGIN RAISE NOTICE ';'; END $body$",
      "SELECT 3",
    ]);
  });

  it("isolates computed set_config calls before later statements", () => {
    const statements = migrationSqlStatements(`
      SELECT set_config('standard_' || 'conforming_strings', 'off', false);
      SELECT 'middle';
      SELECT set_config('standard_' || 'conforming_strings', 'on', false);
    `);
    expect(statements).toHaveLength(3);
  });

  it("preserves valid compound statements without hiding trailing commands", () => {
    const atomic = migrationSqlStatements(`
      CREATE FUNCTION f() RETURNS integer LANGUAGE SQL
      BEGIN ATOMIC
        SELECT CASE WHEN true THEN 1 ELSE 0 END;
      END;
    `);
    expect(atomic).toHaveLength(1);
    expect(controlsMigrationTransaction(atomic[0]!)).toBe(false);

    const rule = migrationSqlStatements(
      "CREATE RULE notify_insert AS ON INSERT TO things DO ALSO (NOTIFY first; NOTIFY second);",
    );
    expect(rule).toHaveLength(1);

    const escaped = migrationSqlStatements(`
      CREATE FUNCTION f() RETURNS integer LANGUAGE SQL
      BEGIN ATOMIC SELECT 1; END;
      COMMIT;
    `);
    expect(escaped.length).toBeGreaterThan(1);
    expect(escaped.some(controlsMigrationTransaction)).toBe(true);

    for (const suffix of ["COMMIT;", "COMMIT; END;"]) {
      const hidden = migrationSqlStatements(`
        CREATE FUNCTION f() RETURNS integer LANGUAGE SQL
        BEGIN ATOMIC SELECT 1; END;
        ${suffix}
      `);
      expect(hidden.some(controlsMigrationTransaction), suffix).toBe(true);
    }

    const invalidBody = migrationSqlStatements(`
      CREATE FUNCTION f() RETURNS integer LANGUAGE SQL
      BEGIN ATOMIC COMMIT; END;
    `);
    expect(invalidBody.some(controlsMigrationTransaction)).toBe(true);

    const prefixedEscape = migrationSqlStatements(`
      CREATE FUNCTION first_f() RETURNS integer LANGUAGE SQL AS 'SELECT 1';
      COMMIT;
      CREATE FUNCTION second_f() RETURNS integer LANGUAGE SQL
      BEGIN ATOMIC SELECT 2; END;
    `);
    expect(prefixedEscape.some(controlsMigrationTransaction)).toBe(true);

    for (const header of ["begin(atomic integer)", "f(begin atomic)"]) {
      const identifierEscape = migrationSqlStatements(`
        CREATE FUNCTION ${header} RETURNS integer LANGUAGE SQL AS 'SELECT 1';
        END;
      `);
      expect(identifierEscape.some(controlsMigrationTransaction), header).toBe(true);
    }

    const identifierBody = migrationSqlStatements(`
      CREATE FUNCTION f(begin integer) RETURNS integer LANGUAGE SQL
      BEGIN ATOMIC SELECT begin atomic; END;
    `);
    expect(identifierBody).toHaveLength(1);
    expect(controlsMigrationTransaction(identifierBody[0]!)).toBe(false);

    const nestedIdentifierEscape = migrationSqlStatements(`
      CREATE FUNCTION f(begin integer) RETURNS integer LANGUAGE SQL
      BEGIN ATOMIC SELECT begin atomic; END; END;
    `);
    expect(nestedIdentifierEscape.some(controlsMigrationTransaction)).toBe(true);
  });

  it("detects every top-level transaction escape used by the runtime", () => {
    for (const source of [
      "COMMIT AND CHAIN",
      "END",
      "ROLLBACK TO SAVEPOINT before_change",
      "ABORT",
      "BEGIN",
      "START TRANSACTION",
      "SAVEPOINT before_change",
      "RELEASE SAVEPOINT before_change",
      "PREPARE TRANSACTION 'migration'",
    ]) {
      const [statement] = migrationSqlStatements(source);
      expect(statement, source).toBeDefined();
      expect(controlsMigrationTransaction(statement!), source).toBe(true);
    }

    for (const source of [
      "SELECT CASE WHEN true THEN 1 ELSE 0 END",
      "DO $body$ BEGIN NULL; END $body$",
      "SELECT 'COMMIT'",
    ]) {
      const [statement] = migrationSqlStatements(source);
      expect(statement, source).toBeDefined();
      expect(controlsMigrationTransaction(statement!), source).toBe(false);
    }
  });
});
