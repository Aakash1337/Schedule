import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { portableDataPolicyV1 } from "./portable-data.js";

async function declaredScheduleTables(): Promise<string[]> {
  const schema = await readFile(new URL("./schema.ts", import.meta.url), "utf8");
  return [...schema.matchAll(/pgTable\(\s*"([a-z_][a-z0-9_]*)"/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

describe("portable data policy", () => {
  it("classifies every Schedule table exactly once", async () => {
    const included = [...portableDataPolicyV1.includedTables];
    const excluded = portableDataPolicyV1.excludedTables.map(({ name }) => name);

    expect(new Set(included).size).toBe(included.length);
    expect(new Set(excluded).size).toBe(excluded.length);
    expect(included.filter((name) => excluded.includes(name as (typeof excluded)[number]))).toEqual(
      [],
    );
    expect([...included, ...excluded].sort()).toEqual(await declaredScheduleTables());
  });

  it("keeps AI analysis and long-term adaptation history portable", () => {
    expect(portableDataPolicyV1.includedTables).toEqual(
      expect.arrayContaining([
        "activity_events",
        "daily_plan_fit_insight_feedback_events",
        "natural_language_proposals",
        "plan_interaction_events",
        "plan_mutations",
        "routine_duration_insight_feedback_events",
        "routine_planning_feedback_events",
        "routine_selection_preference_feedback_events",
      ]),
    );
  });

  it("never exports credentials, sessions, delivery queues, or hosted sync journals", () => {
    const exclusions = Object.fromEntries(
      portableDataPolicyV1.excludedTables.map(({ name, reason }) => [name, reason]),
    );

    expect(exclusions).toMatchObject({
      browser_sessions: "environment_identity",
      hosted_work_item_sync_changes: "environment_sync_state",
      integration_credentials: "credential",
      notification_delivery_attempts: "external_delivery_state",
      outbox_events: "external_delivery_state",
      webhook_endpoint_secrets: "credential",
    });
  });
});
