import { describe, expect, it } from "vitest";

import { parseHostedStagingConfig } from "./hosted-staging-config.js";

const origin = "https://schedule-staging.example.com";
const hostname = "schedule-staging.example.com";
const workspace = "staging-schedule-smoke";

function validEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SCHEDULE_STAGING_ORIGIN: origin,
    SCHEDULE_STAGING_CONFIRM_HOST: hostname,
    SCHEDULE_STAGING_WORKSPACE: workspace,
    SCHEDULE_STAGING_CONFIRM_MUTATION: `I_CONFIRM_STAGING_MUTATION ${origin} ${workspace}`,
    ...overrides,
  };
}

describe("hosted staging configuration", () => {
  it("parses a canonical target and applies stable bounded defaults", () => {
    const first = parseHostedStagingConfig(validEnvironment());
    const second = parseHostedStagingConfig(validEnvironment());

    expect(first).toMatchObject({
      origin,
      host: hostname,
      workspaceName: workspace,
      loginTimeoutMs: 300_000,
      maxWorkItemPages: 10,
    });
    expect(first).toEqual(second);
  });

  it("preserves explicit canonical boundary values", () => {
    expect(
      parseHostedStagingConfig(
        validEnvironment({
          SCHEDULE_STAGING_LOGIN_TIMEOUT_MS: "60000",
          SCHEDULE_STAGING_MAX_WORK_ITEM_PAGES: "50",
        }),
      ),
    ).toMatchObject({
      origin,
      host: hostname,
      workspaceName: workspace,
      loginTimeoutMs: 60_000,
      maxWorkItemPages: 50,
    });
  });

  it.each([
    ["CI execution", { CI: "true" }],
    ["alternate CI marker", { CI: "1" }],
    ["vendor CI marker", { GITHUB_ACTIONS: "true" }],
    ["insecure protocol", { SCHEDULE_STAGING_ORIGIN: "http://schedule-staging.example.com" }],
    ["host without staging marker", { SCHEDULE_STAGING_ORIGIN: "https://schedule.example.com" }],
    ["localhost", { SCHEDULE_STAGING_ORIGIN: "https://localhost" }],
    ["IP address", { SCHEDULE_STAGING_ORIGIN: "https://192.0.2.10" }],
    [
      "credentials",
      { SCHEDULE_STAGING_ORIGIN: "https://user:super-secret@schedule-staging.example.com" },
    ],
    ["path", { SCHEDULE_STAGING_ORIGIN: `${origin}/api` }],
    ["query", { SCHEDULE_STAGING_ORIGIN: `${origin}?debug=1` }],
    ["fragment", { SCHEDULE_STAGING_ORIGIN: `${origin}#debug` }],
    ["trailing slash", { SCHEDULE_STAGING_ORIGIN: `${origin}/` }],
    ["noncanonical origin", { SCHEDULE_STAGING_ORIGIN: "HTTPS://schedule-staging.example.com" }],
    ["missing confirmation host", { SCHEDULE_STAGING_CONFIRM_HOST: undefined }],
    [
      "mismatched confirmation host",
      { SCHEDULE_STAGING_CONFIRM_HOST: "other-staging.example.com" },
    ],
    ["blank workspace", { SCHEDULE_STAGING_WORKSPACE: "" }],
    ["workspace trim drift", { SCHEDULE_STAGING_WORKSPACE: ` ${workspace}` }],
    ["overlong workspace", { SCHEDULE_STAGING_WORKSPACE: `staging-${"x".repeat(160)}` }],
    ["workspace without marker", { SCHEDULE_STAGING_WORKSPACE: "release-check" }],
    ["workspace with a late marker", { SCHEDULE_STAGING_WORKSPACE: "production-staging" }],
    [
      "wrong mutation confirmation",
      { SCHEDULE_STAGING_CONFIRM_MUTATION: "I_CONFIRM_STAGING_MUTATION nope" },
    ],
    ["noncanonical timeout", { SCHEDULE_STAGING_LOGIN_TIMEOUT_MS: "045000" }],
    ["out-of-range timeout", { SCHEDULE_STAGING_LOGIN_TIMEOUT_MS: "59999" }],
    ["noncanonical page count", { SCHEDULE_STAGING_MAX_WORK_ITEM_PAGES: "06" }],
    ["out-of-range page count", { SCHEDULE_STAGING_MAX_WORK_ITEM_PAGES: "51" }],
  ])("fails closed for %s", (_caseName, overrides) => {
    expect(() => parseHostedStagingConfig(validEnvironment(overrides))).toThrow();
  });

  it("does not echo secret-like target input in validation errors", () => {
    const secret = "super-secret";
    let thrown: unknown;

    try {
      parseHostedStagingConfig(
        validEnvironment({
          SCHEDULE_STAGING_ORIGIN: `https://user:${secret}@schedule-staging.example.com`,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secret);
  });
});
