import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  PostgresDeliveryDedupeStore,
  PostgresDeliveryDedupeStoreError,
} from "./postgres-dedupe-store.js";

const dedupeKey = "00000000-0000-4000-8000-000000000001";
const claimToken = "00000000-0000-4000-8000-000000000002";
const reservationToken = "00000000-0000-4000-8000-000000000003";
const commandHash = "a".repeat(64);
const unusedSql = {} as Sql;

function store(overrides: ConstructorParameters<typeof PostgresDeliveryDedupeStore>[1] = {}) {
  return new PostgresDeliveryDedupeStore(unusedSql, {
    reservationToken: () => reservationToken,
    ...overrides,
  });
}

function validReservation() {
  return {
    dedupeKey,
    commandHash,
    claimToken,
    reservationExpiresAt: new Date(Date.now() + 60_000),
    minimumRemainingMilliseconds: 1_000,
  };
}

describe("PostgresDeliveryDedupeStore guards", () => {
  it("rejects unsafe reservation horizon configuration", () => {
    expect(
      () =>
        new PostgresDeliveryDedupeStore(unusedSql, { maximumReservationHorizonMilliseconds: 999 }),
    ).toThrow("1000 to 3600000");
    expect(
      () =>
        new PostgresDeliveryDedupeStore(unusedSql, {
          maximumReservationHorizonMilliseconds: 3_600_001,
        }),
    ).toThrow("1000 to 3600000");
  });

  it("rejects unsafe database statement timeout configuration", () => {
    expect(() => store({ statementTimeoutMilliseconds: 99 })).toThrow("100 to 30000");
    expect(() => store({ statementTimeoutMilliseconds: 30_001 })).toThrow("100 to 30000");
  });

  it.each([
    ["dedupe key", { dedupeKey: "not-a-uuid" }],
    ["command hash", { commandHash: "a" }],
    ["claim token", { claimToken: "not-a-uuid" }],
    ["expiry", { reservationExpiresAt: new Date(Number.NaN) }],
    ["negative required budget", { minimumRemainingMilliseconds: -1 }],
    ["oversized required budget", { minimumRemainingMilliseconds: 15 * 60 * 1_000 + 1 }],
  ])("rejects an invalid %s before opening a transaction", async (_label, change) => {
    await expect(store().reserve({ ...validReservation(), ...change })).rejects.toMatchObject({
      name: "PostgresDeliveryDedupeStoreError",
      code: "invalid_input",
    });
  });

  it("rejects an invalid generated fencing token without leaking it", async () => {
    const unsafeToken = "private-reservation-token";
    const error = await store({ reservationToken: () => unsafeToken })
      .reserve(validReservation())
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PostgresDeliveryDedupeStoreError);
    expect(String(error)).not.toContain(unsafeToken);
  });
});
