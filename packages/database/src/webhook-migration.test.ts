import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0018_fancy_human_torch.sql",
);

describe("webhook persistence migration guards", () => {
  it("makes deliveries immutable for both direct writes and deletes", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain('CREATE FUNCTION "public".prevent_webhook_delivery_mutation()');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "webhook_deliveries"');
  });

  it("guards encrypted secret material and permits only lifecycle transitions", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain(
      'CREATE FUNCTION "public".enforce_webhook_endpoint_secret_lifecycle()',
    );
    expect(migration).toContain("NEW.secret_envelope IS DISTINCT FROM OLD.secret_envelope");
    expect(migration).toContain("OLD.status = 'pending'");
    expect(migration).toContain("OLD.status = 'active'");
  });

  it("makes endpoint identity immutable and revocation terminal", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain('CREATE FUNCTION "public".enforce_webhook_endpoint_lifecycle()');
    expect(migration).toContain("NEW.url IS DISTINCT FROM OLD.url");
    expect(migration).toContain("webhook endpoint revocation is terminal");
  });
});
