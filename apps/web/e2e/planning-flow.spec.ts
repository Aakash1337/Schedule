import { expect, test, type Response } from "@playwright/test";

function isMutationResponse(
  response: Response,
  method: "POST" | "PATCH",
  pathMatches: (pathname: string) => boolean,
  expectedOrigin: string,
): boolean {
  const url = new URL(response.url());
  return (
    url.origin === expectedOrigin &&
    response.request().method() === method &&
    pathMatches(url.pathname)
  );
}

test("persists temporary routine feedback and activity through the live Today planning flow", async ({
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
    const expectedMissingCurrentPlan =
      response.status() === 404 &&
      request.method() === "GET" &&
      /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/current$/.test(pathname);
    if (!expectedMissingCurrentPlan) {
      unexpectedHttpResponses.push(`${response.status()} ${request.method()} ${pathname}`);
    }
  });

  await page.clock.install({ time: new Date("2026-07-15T12:00:00.000Z") });
  await page.goto("/");
  const expectedOrigin = new URL(page.url()).origin;
  await expect(page.getByRole("heading", { name: "Give your days a shape." })).toBeVisible();

  const workspaceResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => pathname === "/v1/workspaces",
      expectedOrigin,
    ),
  );
  await page.getByRole("textbox", { name: "Workspace name" }).fill("Browser E2E workspace");
  await page.getByRole("button", { name: "Create workspace" }).click();
  expect((await workspaceResponsePromise).status()).toBe(201);
  await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("main", { name: "Work view" })).toBeVisible();

  const workItemTitle = "Prepare the release notes";
  await page.getByRole("textbox", { name: "Title" }).fill(workItemTitle);
  await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("urgent");
  await page.getByRole("checkbox", { name: "Include in Today" }).click();
  await page.getByRole("spinbutton", { name: "Plan duration (minutes)" }).fill("45");
  const workItemResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/work-items$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Add item" }).click();
  expect((await workItemResponsePromise).status()).toBe(201);
  await expect(page.getByRole("heading", { name: workItemTitle, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(page.getByRole("main", { name: "Routines view" })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();

  const routineTitle = "Review the daily plan";
  await page.getByRole("textbox", { name: "Title" }).fill(routineTitle);
  const routineResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/routines$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Create routine" }).click();
  expect((await routineResponsePromise).status()).toBe(201);
  await expect(page.getByRole("heading", { name: routineTitle, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();
  const generatePlan = page.getByRole("button", { name: "Generate today's plan" });
  const regeneratePlan = page.getByRole("button", { name: "Regenerate unlocked" });
  await expect(generatePlan.or(regeneratePlan)).toBeVisible();
  const planResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans$/.test(pathname) ||
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/regenerations$/.test(pathname),
      expectedOrigin,
    ),
  );
  if (await generatePlan.isVisible()) await generatePlan.click();
  else await regeneratePlan.click();
  expect((await planResponsePromise).status()).toBe(200);

  const plannedRoutines = page.getByRole("list", { name: "Today's planned items" });
  const routine = plannedRoutines.getByRole("article", { name: routineTitle });
  const workItem = plannedRoutines.getByRole("article", { name: workItemTitle });
  await expect(routine).toBeVisible();
  await expect(workItem).toBeVisible();
  await expect(workItem.getByText("Work item", { exact: true })).toBeVisible();
  await expect(routine.getByLabel("Status: Pending")).toBeVisible();
  await expect(workItem.getByLabel("Status: Pending")).toBeVisible();

  const routineFeedbackResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/items\/[^/]+\/routine-feedback$/.test(pathname),
      expectedOrigin,
    ),
  );
  await routine
    .getByRole("group", { name: `Planning feedback for ${routineTitle}` })
    .getByRole("button", { name: "Not today", exact: true })
    .click();
  expect((await routineFeedbackResponsePromise).status()).toBe(200);

  const temporarilyHidden = page.getByRole("region", { name: "Temporarily hidden" });
  await expect(routine).toBeHidden();
  await expect(temporarilyHidden).toBeVisible();
  await expect(temporarilyHidden.getByText(routineTitle, { exact: true })).toBeVisible();
  await expect(temporarilyHidden.getByText("Hidden today", { exact: true })).toBeVisible();

  await page.reload();
  const persistedTemporaryFeedback = page.getByRole("region", { name: "Temporarily hidden" });
  await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();
  await expect(routine).toBeHidden();
  await expect(persistedTemporaryFeedback).toBeVisible();
  await expect(persistedTemporaryFeedback.getByText(routineTitle, { exact: true })).toBeVisible();
  await expect(persistedTemporaryFeedback.getByText("Hidden today", { exact: true })).toBeVisible();

  const routineFeedbackResetResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/routines\/[^/]+\/routine-feedback-resets$/.test(
          pathname,
        ),
      expectedOrigin,
    ),
  );
  await persistedTemporaryFeedback
    .getByRole("button", { name: `Undo temporary feedback for ${routineTitle}` })
    .click();
  expect((await routineFeedbackResetResponsePromise).status()).toBe(200);
  await expect(persistedTemporaryFeedback).toBeHidden();
  await expect(routine).toBeVisible();
  await expect(routine.getByLabel("Status: Pending")).toBeVisible();

  const workCompletionResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/items\/[^/]+\/activity-events$/.test(pathname),
      expectedOrigin,
    ),
  );
  await workItem.getByRole("button", { name: "Complete" }).click();
  expect((await workCompletionResponsePromise).status()).toBe(200);
  await expect(workItem.getByLabel("Status: Completed")).toBeVisible();

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("main", { name: "Work view" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: `Status for ${workItemTitle}` })).toHaveValue(
    "done",
  );

  await page.getByRole("button", { name: "Today", exact: true }).click();
  const plannedWorkItem = page
    .getByRole("list", { name: "Today's planned items" })
    .getByRole("article", { name: workItemTitle });
  const workReversalResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/items\/[^/]+\/activity-events$/.test(pathname),
      expectedOrigin,
    ),
  );
  await plannedWorkItem.getByRole("button", { name: "Undo completion" }).click();
  expect((await workReversalResponsePromise).status()).toBe(200);
  await expect(plannedWorkItem.getByLabel("Status: Pending")).toBeVisible();

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("combobox", { name: `Status for ${workItemTitle}` })).toHaveValue(
    "backlog",
  );
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const plannedRoutine = page
    .getByRole("list", { name: "Today's planned items" })
    .getByRole("article", { name: routineTitle });

  const activityResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/items\/[^/]+\/activity-events$/.test(pathname),
      expectedOrigin,
    ),
  );
  await plannedRoutine.getByRole("button", { name: "Complete" }).click();
  expect((await activityResponsePromise).status()).toBe(200);
  await expect(plannedRoutine.getByLabel("Status: Completed")).toBeVisible();

  await page.reload();
  const persistedRoutine = page
    .getByRole("list", { name: "Today's planned items" })
    .getByRole("article", { name: routineTitle });
  await expect(persistedRoutine.getByLabel("Status: Completed")).toBeVisible();
  await expect(persistedRoutine.getByRole("button", { name: "Undo completion" })).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});

test("persists work-item due dates and exposes deadline pressure through the live planning flow", async ({
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
    const expectedMissingCurrentPlan =
      response.status() === 404 &&
      request.method() === "GET" &&
      /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/current$/.test(pathname);
    if (!expectedMissingCurrentPlan) {
      unexpectedHttpResponses.push(`${response.status()} ${request.method()} ${pathname}`);
    }
  });

  const planningDate = "2026-07-15";
  const revisedDueDate = "2026-07-16";
  const workItemTitle = "Submit the deadline report";

  await page.clock.install({ time: new Date(`${planningDate}T12:00:00.000Z`) });
  await page.goto("/");
  const expectedOrigin = new URL(page.url()).origin;
  const onboardingHeading = page.getByRole("heading", { name: "Give your days a shape." });
  const workNavigation = page.getByRole("button", { name: "Work", exact: true });
  await expect(onboardingHeading.or(workNavigation)).toBeVisible();
  if (await onboardingHeading.isVisible()) {
    const workspaceResponsePromise = page.waitForResponse((response) =>
      isMutationResponse(
        response,
        "POST",
        (pathname) => pathname === "/v1/workspaces",
        expectedOrigin,
      ),
    );
    await page.getByRole("textbox", { name: "Workspace name" }).fill("Deadline E2E workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    expect((await workspaceResponsePromise).status()).toBe(201);
  }

  await workNavigation.click();
  await expect(page.getByRole("main", { name: "Work view" })).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill(workItemTitle);
  await page.getByLabel("Due date (optional)").fill(planningDate);
  await page.getByRole("checkbox", { name: "Include in Today" }).click();
  await page.getByRole("spinbutton", { name: "Plan duration (minutes)" }).fill("30");
  const createResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/work-items$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Add item" }).click();
  expect((await createResponsePromise).status()).toBe(201);

  const workCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: workItemTitle, exact: true }),
  });
  await expect(workCard).toBeVisible();
  await expect(workCard.getByLabel(`Due ${planningDate}`)).toBeVisible();

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();
  const generatePlan = page.getByRole("button", { name: "Generate today's plan" });
  const regeneratePlan = page.getByRole("button", { name: "Regenerate unlocked" });
  await expect(generatePlan.or(regeneratePlan)).toBeVisible();
  const planResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans$/.test(pathname) ||
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/regenerations$/.test(pathname),
      expectedOrigin,
    ),
  );
  if (await generatePlan.isVisible()) await generatePlan.click();
  else await regeneratePlan.click();
  expect((await planResponsePromise).status()).toBe(200);

  const plannedWorkItem = page
    .getByRole("list", { name: "Today's planned items" })
    .getByRole("article", { name: workItemTitle });
  await expect(plannedWorkItem).toBeVisible();
  await expect(
    plannedWorkItem.getByText(/^Due today \(\+\d+ deadline pressure\)\.$/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await workCard.getByRole("button", { name: `Edit details for ${workItemTitle}` }).click();
  await expect(workCard.getByLabel("Due date (optional)")).toHaveValue(planningDate);
  await workCard.getByLabel("Due date (optional)").fill(revisedDueDate);
  const reviseResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "PATCH",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/work-items\/[^/]+$/.test(pathname),
      expectedOrigin,
    ),
  );
  await workCard.getByRole("button", { name: "Save details" }).click();
  expect((await reviseResponsePromise).status()).toBe(200);
  await expect(workCard.getByLabel(`Due ${revisedDueDate}`)).toBeVisible();

  await workCard.getByRole("button", { name: `Edit details for ${workItemTitle}` }).click();
  await workCard.getByLabel("Due date (optional)").fill("");
  const clearResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "PATCH",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/work-items\/[^/]+$/.test(pathname),
      expectedOrigin,
    ),
  );
  await workCard.getByRole("button", { name: "Save details" }).click();
  expect((await clearResponsePromise).status()).toBe(200);
  await expect(workCard.getByLabel(`Due ${revisedDueDate}`)).toHaveCount(0);

  await page.reload();
  await expect(workCard.getByLabel(`Due ${planningDate}`)).toHaveCount(0);
  await expect(workCard.getByLabel(`Due ${revisedDueDate}`)).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});

test("persists exact-evidence duration insight feedback and resurfaces changed evidence", async ({
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
    unexpectedHttpResponses.push(
      `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
    );
  });

  await page.goto("/#routines");
  const expectedOrigin = new URL(page.url()).origin;
  const onboardingHeading = page.getByRole("heading", { name: "Give your days a shape." });
  const routinesNavigation = page.getByRole("button", { name: "Routines", exact: true });
  await expect(onboardingHeading.or(routinesNavigation)).toBeVisible();
  if (await onboardingHeading.isVisible()) {
    const workspaceResponsePromise = page.waitForResponse((response) =>
      isMutationResponse(
        response,
        "POST",
        (pathname) => pathname === "/v1/workspaces",
        expectedOrigin,
      ),
    );
    await page.getByRole("textbox", { name: "Workspace name" }).fill("Insight E2E workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    expect((await workspaceResponsePromise).status()).toBe(201);
  }

  await routinesNavigation.click();
  await expect(page.getByRole("main", { name: "Routines view" })).toBeVisible();
  await page.getByRole("button", { name: "New routine" }).click();

  const routineTitle = "Calibrate the weekly review";
  await page.getByRole("textbox", { name: "Title" }).fill(routineTitle);
  const routineResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/routines$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Create routine" }).click();
  const routineResponse = await routineResponsePromise;
  expect(routineResponse.status()).toBe(201);
  const routine = (await routineResponse.json()) as {
    readonly id: string;
    readonly workspaceId: string;
  };
  await expect(page.getByRole("heading", { name: routineTitle, exact: true })).toBeVisible();

  async function recordCompletion(sequence: number): Promise<void> {
    const occurredAt = new Date(Date.now() - (8 - sequence) * 24 * 60 * 60 * 1_000);
    const response = await page.request.post(
      `${expectedOrigin}/v1/workspaces/${routine.workspaceId}/routines/${routine.id}/activity-events`,
      {
        headers: { "Idempotency-Key": `duration-insight-e2e-completion-${sequence}` },
        data: {
          type: "completed",
          occurredAt: occurredAt.toISOString(),
          timeZone: "UTC",
          planId: null,
          durationMinutes: 50,
          reason: null,
          referenceEventId: null,
          metadata: {},
        },
      },
    );
    expect(response.status()).toBe(200);
  }

  await recordCompletion(1);
  await recordCompletion(2);
  await recordCompletion(3);
  await page.reload();
  await expect(page.getByRole("main", { name: "Routines view" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${routineTitle}`) }).click();
  await expect(
    page.getByText("Recent sessions suggest 50m is a more typical estimate."),
  ).toBeVisible();

  const firstDismissalPromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/routines\/[^/]+\/duration-insight\/dismissals$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  expect((await firstDismissalPromise).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Show again", exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: new RegExp(`^${routineTitle}`) }).click();
  await expect(page.getByRole("button", { name: "Show again", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Apply 50m estimate/ })).toHaveCount(0);

  const resetPromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/routines\/[^/]+\/duration-insight\/dismissal-resets$/.test(
          pathname,
        ),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Show again", exact: true }).click();
  expect((await resetPromise).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Not now", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Apply 50m estimate/ })).toBeVisible();

  const secondDismissalPromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/routines\/[^/]+\/duration-insight\/dismissals$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  expect((await secondDismissalPromise).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Show again", exact: true })).toBeVisible();

  await recordCompletion(4);
  await page.reload();
  await page.getByRole("button", { name: new RegExp(`^${routineTitle}`) }).click();
  await expect(page.getByRole("button", { name: "Not now", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Apply 50m estimate/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show again", exact: true })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});
