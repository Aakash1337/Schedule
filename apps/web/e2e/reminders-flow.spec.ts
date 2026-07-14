import { expect, test, type Response } from "@playwright/test";

import { createDatabase } from "../../../packages/database/src/index.js";

function isMutationResponse(
  response: Response,
  method: "POST" | "PUT" | "PATCH",
  expression: RegExp,
): boolean {
  return (
    response.request().method() === method && expression.test(new URL(response.url()).pathname)
  );
}

test("configures, materializes, audits, and responsively renders reminders through the live product", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttpResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    requestFailures.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    const pathname = new URL(response.url()).pathname;
    const expectedMissingProfile =
      response.status() === 404 &&
      request.method() === "GET" &&
      /^\/v1\/workspaces\/[^/]+\/notification-profile$/.test(pathname);
    if (!expectedMissingProfile) {
      unexpectedHttpResponses.push(`${response.status()} ${request.method()} ${pathname}`);
    }
  });

  await page.clock.install({ time: new Date("2026-07-15T12:00:00.000Z") });
  const workspaceResponse = await page.request.post("/v1/workspaces", {
    data: { name: "Reminder browser verification" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { readonly id: string };
  await page.addInitScript((workspaceId) => {
    localStorage.setItem("schedule.selectedWorkspace", workspaceId);
  }, workspace.id);

  await page.goto("/#reminders");
  await expect(page.getByRole("main", { name: "Reminders view" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Configure reminders" })).toBeVisible();
  await expect(page.getByText("Rules stay locked until policy setup is saved")).toBeVisible();

  await page.getByRole("textbox", { name: "Policy time zone" }).fill("UTC");
  const profileResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(response, "PUT", /^\/v1\/workspaces\/[^/]+\/notification-profile$/),
  );
  await page.getByRole("button", { name: "Save reminder policy" }).click();
  expect((await profileResponsePromise).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Policy and quiet hours" })).toBeVisible();

  const addRule = page.locator("details").filter({ hasText: "Add a reusable rule" });
  await addRule.locator("summary").click();
  await addRule.getByRole("combobox", { name: "Rule type" }).selectOption("daily_digest");
  await addRule.locator('input[type="time"]').fill("09:00");
  const ruleResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(response, "POST", /^\/v1\/workspaces\/[^/]+\/notification-rules$/),
  );
  await addRule.getByRole("button", { name: "Create rule" }).click();
  expect((await ruleResponsePromise).status()).toBe(201);
  const ruleCard = page.locator(".reminder-rule-card").filter({ hasText: "Daily digest" });
  await expect(ruleCard).toBeVisible();
  await ruleCard.getByRole("spinbutton", { name: "Priority" }).fill("82");
  const ruleUpdatePromise = page.waitForResponse((response) =>
    isMutationResponse(response, "PATCH", /^\/v1\/workspaces\/[^/]+\/notification-rules\/[^/]+$/),
  );
  await ruleCard.getByRole("button", { name: "Save rule" }).click();
  expect((await ruleUpdatePromise).status()).toBe(200);

  const reminderTitle = "Bring the passport";
  await page.getByRole("textbox", { name: "Reminder title" }).fill(reminderTitle);
  await page.getByLabel("Date and time on this device").fill("2026-07-15T13:00");
  const reminderResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(response, "POST", /^\/v1\/workspaces\/[^/]+\/one-off-reminders$/),
  );
  await page.getByRole("button", { name: "Add reminder" }).click();
  expect((await reminderResponsePromise).status()).toBe(201);
  await expect(page.getByRole("heading", { name: reminderTitle })).toBeVisible();

  const materializeResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      /^\/v1\/workspaces\/[^/]+\/notification-intents\/materializations$/,
    ),
  );
  await page.getByRole("button", { name: "Refresh planned reminders" }).click();
  expect((await materializeResponsePromise).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Planned reminders" })).toBeVisible();
  await expect(page.getByRole("heading", { name: reminderTitle })).toBeVisible();

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("Browser E2E requires DATABASE_URL.");
  const database = createDatabase(databaseUrl, 1);
  try {
    const inserted = await database.sql<{ id: string }[]>`
      insert into notification_delivery_commands (
        id, workspace_id, intent_id, occurrence_key, kind, target_type, title_snapshot,
        scheduled_for, local_date, priority, status, attempts, available_at, completed_at,
        created_at, updated_at
      )
      select
        id, workspace_id, id, occurrence_key, kind, target_type, title_snapshot,
        scheduled_for, local_date, priority, 'delivered', 1, clock_timestamp(),
        clock_timestamp(), clock_timestamp(), clock_timestamp()
      from notification_intents
      where workspace_id = ${workspace.id}
        and title_snapshot = ${reminderTitle}
      returning id::text
    `;
    expect(inserted).toHaveLength(1);
  } finally {
    await database.close();
  }

  await page.getByRole("button", { name: "Refresh data" }).click();
  await page.getByRole("tab", { name: /Execution/ }).click();
  await expect(page.getByRole("heading", { name: "Execution history" })).toBeVisible();
  await expect(page.getByRole("heading", { name: reminderTitle })).toBeVisible();
  await expect(page.getByText("Acknowledged")).toBeVisible();
  await expect(
    page.getByText(/no credentials, recipients, provider payloads, or claim tokens/i),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 800 });
  const mobileNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(mobileNavigation).toBeVisible();
  const mobileTargets = await mobileNavigation
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(mobileTargets.every((height) => height >= 44)).toBe(true);
  const tabTargets = await page
    .getByRole("tab")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().height));
  expect(tabTargets.every((height) => height >= 44)).toBe(true);
  const layout = await page.evaluate(() => {
    const browserGlobal = globalThis as unknown as {
      readonly document: { readonly documentElement: { readonly scrollWidth: number } };
      readonly innerWidth: number;
    };
    return {
      scrollWidth: browserGlobal.document.documentElement.scrollWidth,
      viewportWidth: browserGlobal.innerWidth,
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);

  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});
