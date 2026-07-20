import { expect, test, type Locator, type Response } from "@playwright/test";

const MOBILE_TARGET_MINIMUM_CSS_PIXELS = 44;
// Chromium can report a CSS min-height a few millionths of a pixel below its declared value.
const CSS_PIXEL_MEASUREMENT_TOLERANCE = 0.01;

function expectMobileTargetHeight(height: number, context?: string): void {
  expect(height, context).toBeGreaterThanOrEqual(
    MOBILE_TARGET_MINIMUM_CSS_PIXELS - CSS_PIXEL_MEASUREMENT_TOLERANCE,
  );
}

function isMutationResponse(
  response: Response,
  method: "POST" | "PATCH" | "DELETE",
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
    const failureText = request.failure()?.errorText ?? "unknown failure";
    // View changes and reloads deliberately abort stale reads; mutations and other network failures
    // remain actionable.
    if (request.method() === "GET" && failureText === "net::ERR_ABORTED") return;
    requestFailures.push(`${request.method()} ${new URL(request.url()).pathname} (${failureText})`);
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
    await page.getByRole("textbox", { name: "Workspace name" }).fill("Browser E2E workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    expect((await workspaceResponsePromise).status()).toBe(201);
    await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();
  }

  await workNavigation.click();
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

test("persists explicit future-plan preference without changing Today in the live 320px flow", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttpResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failureText = request.failure()?.errorText ?? "unknown failure";
    if (request.method() === "GET" && failureText === "net::ERR_ABORTED") return;
    requestFailures.push(`${request.method()} ${new URL(request.url()).pathname} (${failureText})`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    unexpectedHttpResponses.push(
      `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
    );
  });

  const workspaceResponse = await page.request.post("/v1/workspaces", {
    data: { name: "Future preference E2E workspace" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { readonly id: string };
  await page.addInitScript((workspaceId) => {
    localStorage.setItem("schedule.selectedWorkspace", workspaceId);
  }, workspace.id);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#routines");
  const expectedOrigin = new URL(page.url()).origin;
  const main = page.getByRole("main", { name: "Routines view" });
  await expect(main).toBeVisible();

  await page.getByRole("button", { name: "New routine" }).click();
  const routineTitle = "Practice the piano";
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
  const routine = (await routineResponse.json()) as { readonly id: string };

  const preferenceGroup = page.getByRole("group", {
    name: `Future plan preference for ${routineTitle}`,
  });
  const moreOften = preferenceGroup.getByRole("button", {
    name: `Choose ${routineTitle} more often in future plans`,
  });
  const lessOften = preferenceGroup.getByRole("button", {
    name: `Choose ${routineTitle} less often in future plans`,
  });
  await expect(moreOften).toBeEnabled();
  await expect(lessOften).toBeEnabled();

  for (const target of [moreOften, lessOften]) {
    await target.scrollIntoViewIfNeeded();
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    expectMobileTargetHeight(
      bounds?.height ?? 0,
      (await target.getAttribute("aria-label")) ?? undefined,
    );
  }
  const horizontalOverflow = await main.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(CSS_PIXEL_MEASUREMENT_TOLERANCE);

  const currentPlanPath = `/v1/workspaces/${workspace.id}/plans/2026-07-14/current`;
  expect((await page.request.get(currentPlanPath)).status()).toBe(404);

  const moreOftenResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        pathname === `/v1/workspaces/${workspace.id}/routines/${routine.id}/selection-preference`,
      expectedOrigin,
    ),
  );
  await moreOften.click();
  expect((await moreOftenResponsePromise).status()).toBe(200);
  await expect(page.getByLabel("More often, preference score +100")).toBeVisible();
  await expect(
    page.getByText("Saved for future plans. Today’s plan was not changed."),
  ).toBeVisible();
  await expect(
    preferenceGroup.getByRole("button", {
      name: `Clear the future plan preference for ${routineTitle}`,
    }),
  ).toBeVisible();
  expect((await page.request.get(currentPlanPath)).status()).toBe(404);

  await page.reload();
  await expect(main).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${routineTitle}`) }).click();
  await expect(page.getByLabel("More often, preference score +100")).toBeVisible();

  const lessOftenResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        pathname === `/v1/workspaces/${workspace.id}/routines/${routine.id}/selection-preference`,
      expectedOrigin,
    ),
  );
  await lessOften.click();
  expect((await lessOftenResponsePromise).status()).toBe(200);
  await expect(page.getByLabel("Neutral, preference score 0")).toBeVisible();
  const clearPreference = preferenceGroup.getByRole("button", {
    name: `Clear the future plan preference for ${routineTitle}`,
  });
  await expect(clearPreference).toBeVisible();

  const resetResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        pathname === `/v1/workspaces/${workspace.id}/routines/${routine.id}/selection-preference`,
      expectedOrigin,
    ),
  );
  await clearPreference.click();
  expect((await resetResponsePromise).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Future selection" })).toBeFocused();
  await expect(page.getByLabel("Neutral, preference score 0")).toHaveCount(0);
  await expect(clearPreference).toHaveCount(0);

  await page.reload();
  await expect(main).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${routineTitle}`) }).click();
  await expect(page.getByLabel("Neutral, preference score 0")).toHaveCount(0);
  await expect(clearPreference).toHaveCount(0);
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

test("renders planning outcomes and derives, prefills, and restores Plan Fit", async ({ page }) => {
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
      /^\/v1\/workspaces\/[^/]+\/plans\/2026-07-1[45]\/current$/.test(pathname);
    if (!expectedMissingCurrentPlan) {
      unexpectedHttpResponses.push(`${response.status()} ${request.method()} ${pathname}`);
    }
  });

  await page.clock.install({ time: new Date("2026-07-14T12:00:00.000Z") });
  const workspaceResponse = await page.request.post("/v1/workspaces", {
    data: { name: "Daily Plan Fit E2E workspace" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { readonly id: string };

  for (const title of ["Fit A", "Fit B", "Fit C", "Fit D"]) {
    const routineResponse = await page.request.post(`/v1/workspaces/${workspace.id}/routines`, {
      data: {
        title,
        tags: {
          priority: "high",
          energy: "normal",
          contexts: ["computer"],
          categories: ["plan-fit-e2e"],
        },
        duration: {
          minimumMinutes: 45,
          expectedMinutes: 45,
          maximumMinutes: 45,
        },
        cadence: {
          period: "day",
          targetCompletions: 1,
          maximumCompletions: 1,
        },
      },
    });
    expect(routineResponse.status()).toBe(201);
  }

  let latestEvidencePlanId: string | null = null;
  let latestEvidenceCompletedItemId: string | null = null;
  let latestEvidenceHeadVersion = 0;
  for (const [dateIndex, date] of ["2026-07-11", "2026-07-12", "2026-07-13"].entries()) {
    const planResponse = await page.request.post(`/v1/workspaces/${workspace.id}/plans`, {
      data: {
        date,
        timeZone: "UTC",
        availableWindows: [
          {
            startsAt: `${date}T08:00:00.000Z`,
            endsAt: `${date}T12:30:00.000Z`,
          },
        ],
        targetMinutes: 180,
        targetTaskCount: 4,
        availableContexts: ["computer"],
        seed: `daily-plan-fit-e2e-${date}`,
        requestRevision: 1,
      },
    });
    expect(planResponse.status()).toBe(200);
    const plan = (await planResponse.json()) as {
      readonly id: string;
      readonly items: readonly { readonly id: string }[];
    };
    expect(plan.items).toHaveLength(4);
    let headVersion = 1;
    for (const [itemIndex, item] of plan.items.entries()) {
      const type =
        itemIndex < 2
          ? "completed"
          : itemIndex === 2
            ? "skipped"
            : dateIndex === 1
              ? "dismissed"
              : "deferred";
      const activityResponse = await page.request.post(
        `/v1/workspaces/${workspace.id}/plans/${date}/items/${item.id}/activity-events`,
        {
          headers: { "Idempotency-Key": `daily-plan-fit-e2e-${dateIndex}-${itemIndex}` },
          data: {
            expectedPlanId: plan.id,
            expectedHeadVersion: headVersion,
            type,
            occurredAt: `${date}T${String(13 + itemIndex).padStart(2, "0")}:00:00.000Z`,
            timeZone: "UTC",
            durationMinutes: type === "completed" ? 45 : null,
            reason: null,
            metadata: {},
          },
        },
      );
      expect(activityResponse.status()).toBe(200);
      headVersion = ((await activityResponse.json()) as { readonly headVersion: number })
        .headVersion;
    }
    if (date === "2026-07-13") {
      latestEvidencePlanId = plan.id;
      latestEvidenceCompletedItemId = plan.items[0]!.id;
      latestEvidenceHeadVersion = headVersion;
    }
  }

  expect(latestEvidencePlanId).not.toBeNull();
  expect(latestEvidenceCompletedItemId).not.toBeNull();
  const initialInsightResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight?forDate=2026-07-14`,
  );
  expect(initialInsightResponse.status()).toBe(200);
  const initialInsight = (await initialInsightResponse.json()) as { readonly insightKey: string };

  const reversalResponse = await page.request.post(
    `/v1/workspaces/${workspace.id}/plans/2026-07-13/items/${latestEvidenceCompletedItemId!}/activity-events`,
    {
      headers: { "Idempotency-Key": "daily-plan-fit-e2e-reverse-evidence" },
      data: {
        expectedPlanId: latestEvidencePlanId,
        expectedHeadVersion: latestEvidenceHeadVersion,
        type: "completion_reversed",
        occurredAt: "2026-07-14T01:00:00.000Z",
        timeZone: "UTC",
        durationMinutes: null,
        reason: null,
        metadata: {},
      },
    },
  );
  expect(reversalResponse.status()).toBe(200);
  const reversedHeadVersion = ((await reversalResponse.json()) as { readonly headVersion: number })
    .headVersion;
  const skipResponse = await page.request.post(
    `/v1/workspaces/${workspace.id}/plans/2026-07-13/items/${latestEvidenceCompletedItemId!}/activity-events`,
    {
      headers: { "Idempotency-Key": "daily-plan-fit-e2e-skip-reopened-evidence" },
      data: {
        expectedPlanId: latestEvidencePlanId,
        expectedHeadVersion: reversedHeadVersion,
        type: "skipped",
        occurredAt: "2026-07-14T01:01:00.000Z",
        timeZone: "UTC",
        durationMinutes: null,
        reason: null,
        metadata: {},
      },
    },
  );
  expect(skipResponse.status()).toBe(200);

  const staleGenerationResponse = await page.request.post(`/v1/workspaces/${workspace.id}/plans`, {
    data: {
      date: "2026-07-14",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-14T08:00:00.000Z",
          endsAt: "2026-07-14T12:30:00.000Z",
        },
      ],
      targetMinutes: 90,
      targetTaskCount: 2,
      availableContexts: ["computer"],
      seed: "daily-plan-fit-e2e-stale-evidence",
      requestRevision: 1,
      planFitInsightKey: initialInsight.insightKey,
    },
  });
  expect(staleGenerationResponse.status()).toBe(409);
  expect(await staleGenerationResponse.json()).toMatchObject({
    error: { code: "daily_plan_fit_insight.evidence_conflict" },
  });
  const currentAfterStaleResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/plans/2026-07-14/current`,
  );
  expect(currentAfterStaleResponse.status()).toBe(404);
  const historyAfterStaleResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/usages?limit=5`,
  );
  expect(historyAfterStaleResponse.status()).toBe(200);
  expect(await historyAfterStaleResponse.json()).toEqual({ items: [] });
  const outcomeWorkItemResponse = await page.request.post(
    `/v1/workspaces/${workspace.id}/work-items`,
    {
      data: {
        title: "Complete the Plan Fit outcome",
        status: "planned",
        priority: "urgent",
        dueOn: "2026-07-14",
        planningDurationMinutes: 45,
      },
    },
  );
  expect(outcomeWorkItemResponse.status()).toBe(201);

  await page.addInitScript((workspaceId) => {
    localStorage.setItem("schedule.selectedWorkspace", workspaceId);
  }, workspace.id);
  await page.goto("/");
  const expectedOrigin = new URL(page.url()).origin;
  await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Try 90 minutes and 2 tasks" })).toBeVisible();
  await expect(page.getByText("3 resolved plans")).toBeVisible();
  await expect(page.getByText("3h · 4 tasks")).toBeVisible();
  await expect(page.getByText("1h 30m · 2 tasks")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Planning outcomes" })).toBeVisible();
  await expect(page.getByText(/current final revision for 3 prior plan days/i)).toBeVisible();
  await expect(page.getByText("41.67% time · 41.67% tasks", { exact: true })).toBeVisible();
  await expect(page.getByText("4 tasks · 3h")).toBeVisible();
  await expect(page.getByText("2 tasks · 1h 30m")).toBeVisible();
  await expect(page.getByText("1 task · 45m")).toBeVisible();
  await expect(page.getByText("16.67% time · 16.67% tasks", { exact: true })).toBeVisible();
  await expect(page.getByText(/manual review of duration, priority, or relevance/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "By planner version" })).toBeVisible();
  await expect(page.getByText("deterministic-planner-v8 · default-weights-v5")).toBeVisible();
  await expect(page.getByText(/Completed 41.67% scheduled time · 41.67% tasks/)).toBeVisible();
  await expect(page.getByText(/do not show that a version caused an outcome/i)).toBeVisible();
  const targetMinutes = page.getByRole("spinbutton", { name: /^Target minutes/ });
  const targetTasks = page.getByRole("spinbutton", { name: /^Target tasks/ });
  await expect(targetMinutes).toHaveValue("180");
  await expect(targetTasks).toHaveValue("4");
  await page.getByRole("button", { name: "Review today's targets" }).click();
  await expect(targetMinutes).toBeFocused();
  await expect(targetMinutes).toHaveValue("180");
  await expect(targetTasks).toHaveValue("4");
  const currentPlanAfterReview = await page.request.get(
    `/v1/workspaces/${workspace.id}/plans/2026-07-14/current`,
  );
  expect(currentPlanAfterReview.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Plan Fit outcome summary" })).toBeVisible();
  await expect(page.getByText(/No explicit Plan Fit use is available/)).toBeVisible();
  await expect(page.getByText(/Prefilling alone creates no history/)).toBeVisible();

  const dismissalResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => pathname === `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/dismissals`,
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  expect((await dismissalResponsePromise).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Plan Fit suggestion paused" })).toBeFocused();

  await page.reload();
  await expect(page.getByRole("button", { name: "Show again", exact: true })).toBeVisible();
  const resetResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        pathname === `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/dismissal-resets`,
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Show again", exact: true }).click();
  expect((await resetResponsePromise).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Try 90 minutes and 2 tasks" })).toBeFocused();

  const currentInsightResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight?forDate=2026-07-14`,
  );
  expect(currentInsightResponse.status()).toBe(200);
  const currentInsight = (await currentInsightResponse.json()) as {
    readonly insightKey: string;
    readonly suggestedTargetMinutes: number;
    readonly suggestedTargetTaskCount: number;
  };
  expect(currentInsight.insightKey).not.toBe(initialInsight.insightKey);
  await page.getByRole("button", { name: "Use 90 minutes and 2 tasks" }).click();
  await expect(page.getByRole("spinbutton", { name: /^Target minutes/ })).toHaveValue("90");
  await expect(page.getByRole("spinbutton", { name: /^Target tasks/ })).toHaveValue("2");
  await expect(page.getByRole("spinbutton", { name: /^Target minutes/ })).toBeFocused();
  const historyAfterPrefillResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/usages?limit=5`,
  );
  expect(historyAfterPrefillResponse.status()).toBe(200);
  expect(await historyAfterPrefillResponse.json()).toEqual({ items: [] });
  const effectivenessAfterPrefillResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/effectiveness?limit=28`,
  );
  expect(effectivenessAfterPrefillResponse.status()).toBe(200);
  expect(await effectivenessAfterPrefillResponse.json()).toMatchObject({
    usesConsidered: 0,
    eligibleResolvedUseCount: 0,
    scheduledMinutesRateBasisPoints: null,
    completionMinutesRateBasisPoints: null,
  });
  await page.getByRole("spinbutton", { name: /^Target minutes/ }).fill("105");
  await page.getByRole("spinbutton", { name: /^Target tasks/ }).fill("3");
  const absentPlan = await page.request.get(
    `/v1/workspaces/${workspace.id}/plans/2026-07-14/current`,
  );
  expect(absentPlan.status()).toBe(404);

  const generationResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => pathname === `/v1/workspaces/${workspace.id}/plans`,
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Generate today's plan" }).click();
  const generationResponse = await generationResponsePromise;
  expect(generationResponse.status()).toBe(200);
  const generationRequestBody = generationResponse.request().postDataJSON() as Record<
    string,
    unknown
  >;
  expect(generationRequestBody).toMatchObject({
    date: "2026-07-14",
    targetMinutes: 105,
    targetTaskCount: 3,
    planFitInsightKey: currentInsight.insightKey,
  });
  const generatedPlan = (await generationResponse.json()) as {
    readonly id: string;
    readonly items: readonly { readonly id: string; readonly scheduledMinutes: number }[];
  };
  expect(generatedPlan.items.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Plan Fit outcome summary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "After using Plan Fit" })).toBeVisible();
  await expect(page.getByText("Waiting for final outcomes")).toBeVisible();

  const replayResponse = await page.request.post(`/v1/workspaces/${workspace.id}/plans`, {
    data: generationRequestBody,
  });
  expect(replayResponse.status()).toBe(200);
  expect((await replayResponse.json()) as { readonly id: string }).toMatchObject({
    id: generatedPlan.id,
  });
  const pendingHistoryResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/usages?limit=5`,
  );
  expect(pendingHistoryResponse.status()).toBe(200);
  const pendingHistory = (await pendingHistoryResponse.json()) as {
    readonly items: readonly {
      readonly sourcePlanId: string;
      readonly insightKey: string;
      readonly status: string;
      readonly suggestedTargetMinutes: number;
      readonly suggestedTargetTaskCount: number;
      readonly appliedTargetMinutes: number;
      readonly appliedTargetTaskCount: number;
    }[];
  };
  expect(pendingHistory.items).toEqual([
    expect.objectContaining({
      sourcePlanId: generatedPlan.id,
      insightKey: currentInsight.insightKey,
      status: "pending",
      suggestedTargetMinutes: currentInsight.suggestedTargetMinutes,
      suggestedTargetTaskCount: currentInsight.suggestedTargetTaskCount,
      appliedTargetMinutes: 105,
      appliedTargetTaskCount: 3,
    }),
  ]);
  const pendingEffectivenessResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/effectiveness?limit=28`,
  );
  expect(pendingEffectivenessResponse.status()).toBe(200);
  expect(await pendingEffectivenessResponse.json()).toMatchObject({
    usesConsidered: 1,
    resolvedUseCount: 0,
    pendingUseCount: 1,
    revisedUseCount: 0,
    eligibleResolvedUseCount: 0,
    exactSuggestionUseCount: 0,
    editedSuggestionUseCount: 1,
    scheduledMinutesRateBasisPoints: null,
    scheduledTasksRateBasisPoints: null,
    completionMinutesRateBasisPoints: null,
    completionTasksRateBasisPoints: null,
  });

  let generatedHeadVersion = 1;
  for (const [itemIndex, item] of generatedPlan.items.entries()) {
    const type = itemIndex === 0 ? "completed" : "skipped";
    const activityResponse = await page.request.post(
      `/v1/workspaces/${workspace.id}/plans/2026-07-14/items/${item.id}/activity-events`,
      {
        headers: { "Idempotency-Key": `daily-plan-fit-e2e-used-${itemIndex}-${type}` },
        data: {
          expectedPlanId: generatedPlan.id,
          expectedHeadVersion: generatedHeadVersion,
          type,
          occurredAt: `2026-07-14T${String(13 + itemIndex).padStart(2, "0")}:30:00.000Z`,
          timeZone: "UTC",
          durationMinutes: type === "completed" ? item.scheduledMinutes : null,
          reason: null,
          metadata: {},
        },
      },
    );
    expect(activityResponse.status()).toBe(200);
    generatedHeadVersion = ((await activityResponse.json()) as { readonly headVersion: number })
      .headVersion;
  }

  await page.reload();
  await expect(page.getByRole("heading", { name: "After using Plan Fit" })).toBeVisible();
  await expect(page.getByText("Resolved", { exact: true })).toBeVisible();

  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "After using Plan Fit" })).toBeVisible();
  await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Suggested 1h 30m and 2 tasks; generated with 1h 45m and 3 tasks/),
  ).toBeVisible();
  await expect(page.getByText(/Completed .* and 1 task from/)).toBeVisible();
  await expect(page.getByText(/1 of 3 settled, unrevised uses is available/)).toBeVisible();
  await expect(page.getByText(/Rates appear after 2 more comparable uses/)).toBeVisible();
  await expect(page.getByText("Target scheduled")).not.toBeVisible();

  const mutationRequest = { ...generationRequestBody };
  delete mutationRequest.date;
  delete mutationRequest.requestRevision;
  delete mutationRequest.planFitInsightKey;
  const regenerationResponse = await page.request.post(
    `/v1/workspaces/${workspace.id}/plans/2026-07-14/regenerations`,
    {
      headers: { "Idempotency-Key": "daily-plan-fit-e2e-revised-after-use" },
      data: {
        expectedPlanId: generatedPlan.id,
        expectedHeadVersion: generatedHeadVersion,
        request: mutationRequest,
      },
    },
  );
  expect(regenerationResponse.status()).toBe(200);
  expect((await regenerationResponse.json()) as { readonly id: string }).not.toMatchObject({
    id: generatedPlan.id,
  });
  const finalPlanFitResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === `/v1/workspaces/${workspace.id}/daily-plan-fit-insight` &&
      url.searchParams.get("forDate") === "2026-07-15"
    );
  });
  await page.reload();
  expect((await finalPlanFitResponsePromise).status()).toBe(200);
  await expect(page.getByText("The day was revised after Plan Fit was used.")).toBeVisible();
  await expect(page.getByText(/No settled, unrevised plan is available/)).toBeVisible();
  const historyAfterRevisionResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/usages?limit=5`,
  );
  expect(historyAfterRevisionResponse.status()).toBe(200);
  expect(
    (await historyAfterRevisionResponse.json()) as {
      readonly items: readonly { readonly revisedSinceUsage: boolean }[];
    },
  ).toMatchObject({ items: [{ revisedSinceUsage: true }] });
  const effectivenessAfterRevisionResponse = await page.request.get(
    `/v1/workspaces/${workspace.id}/daily-plan-fit-insight/effectiveness?limit=28`,
  );
  expect(effectivenessAfterRevisionResponse.status()).toBe(200);
  expect(await effectivenessAfterRevisionResponse.json()).toMatchObject({
    usesConsidered: 1,
    revisedUseCount: 1,
    eligibleResolvedUseCount: 0,
    appliedTargetMinutes: 0,
    scheduledMinutes: 0,
    completedMinutes: 0,
    scheduledMinutesRateBasisPoints: null,
    completionMinutesRateBasisPoints: null,
  });

  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});

test("manages prerequisites accessibly through the live 320px work-board flow", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttpResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    const successfulNoContentDelete =
      request.method() === "DELETE" &&
      /^\/v1\/workspaces\/[^/]+\/work-items\/[^/]+\/prerequisites\/[^/]+$/.test(pathname) &&
      request.failure()?.errorText === "net::ERR_ABORTED";
    // Chromium exposes Vite-proxied 204 responses as aborted after delivering the successful
    // response headers. The test separately requires the matching response to be 204.
    if (successfulNoContentDelete) return;
    requestFailures.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    unexpectedHttpResponses.push(
      `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
    );
  });

  const workspaceResponse = await page.request.post("/v1/workspaces", {
    data: { name: "Mobile prerequisite E2E workspace" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { readonly id: string };
  await page.addInitScript((workspaceId) => {
    localStorage.setItem("schedule.selectedWorkspace", workspaceId);
  }, workspace.id);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#work");
  const expectedOrigin = new URL(page.url()).origin;
  const main = page.getByRole("main", { name: "Work view" });
  await expect(main).toBeVisible();

  const createWorkItem = async (title: string, status: "backlog" | "done") => {
    await page.getByRole("textbox", { name: "Title" }).fill(title);
    await page.getByRole("combobox", { name: "Starting status" }).selectOption(status);
    const responsePromise = page.waitForResponse((response) =>
      isMutationResponse(
        response,
        "POST",
        (pathname) => /^\/v1\/workspaces\/[^/]+\/work-items$/.test(pathname),
        expectedOrigin,
      ),
    );
    await page.getByRole("button", { name: "Add item" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const created = (await response.json()) as { readonly id: string };
    await expect(main.getByRole("heading", { name: title, exact: true })).toBeVisible();
    return created;
  };

  const prerequisiteTitle = "Approve the mobile release";
  const dependentTitle = "Publish the mobile release";
  const prerequisite = await createWorkItem(prerequisiteTitle, "done");
  await createWorkItem(dependentTitle, "backlog");

  const dependentCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: dependentTitle, exact: true }),
  });
  const prerequisites = dependentCard.getByRole("region", { name: "Prerequisites" });
  const summary = prerequisites.getByLabel(`Manage prerequisites for ${dependentTitle}`);
  const dependentStatus = dependentCard.getByRole("combobox", {
    name: `Status for ${dependentTitle}`,
  });
  await expect(prerequisites.getByText("No prerequisites linked.")).toBeVisible();
  await expect(prerequisites.getByText("None", { exact: true })).toBeVisible();
  await expect(dependentStatus).toHaveValue("backlog");

  const expectMobileTarget = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    expectMobileTargetHeight(bounds?.height ?? 0);
  };

  await expectMobileTarget(summary);
  await summary.focus();
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await summary.press("Enter");
  await expect(summary).toHaveAttribute("aria-expanded", "true");

  const prerequisiteSelect = prerequisites.getByRole("combobox", {
    name: `Add prerequisite to ${dependentTitle}`,
  });
  const addPrerequisite = prerequisites.getByRole("button", {
    name: `Add selected prerequisite to ${dependentTitle}`,
  });
  await expectMobileTarget(prerequisiteSelect);
  await expectMobileTarget(addPrerequisite);
  await prerequisiteSelect.selectOption(prerequisite.id);

  const addResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/work-items\/[^/]+\/prerequisites$/.test(pathname),
      expectedOrigin,
    ),
  );
  await addPrerequisite.focus();
  await expect(addPrerequisite).toBeFocused();
  await addPrerequisite.press("Enter");
  expect([200, 201]).toContain((await addResponsePromise).status());

  await expect(summary).toBeFocused();
  await expect(prerequisites.getByText("1/1 done", { exact: true })).toBeVisible();
  await expect(prerequisites.getByText(prerequisiteTitle, { exact: true })).toBeVisible();
  await expect(prerequisites.getByLabel(`${prerequisiteTitle} status: Done`)).toHaveText("Done");
  await expect(
    prerequisites.getByText(
      `${prerequisiteTitle} is now a prerequisite. The work item status was not changed.`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(dependentStatus).toHaveValue("backlog");

  const documentOverflow = await page.evaluate(() => {
    const browserGlobal = globalThis as unknown as {
      readonly document: {
        readonly documentElement: { readonly scrollWidth: number; readonly clientWidth: number };
        readonly body: { readonly scrollWidth: number; readonly clientWidth: number };
      };
    };
    const browserDocument = browserGlobal.document;
    return {
      document:
        browserDocument.documentElement.scrollWidth - browserDocument.documentElement.clientWidth,
      body: browserDocument.body.scrollWidth - browserDocument.body.clientWidth,
    };
  });
  expect(documentOverflow.document).toBeLessThanOrEqual(1);
  expect(documentOverflow.body).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(main).toBeVisible();
  await expect(prerequisites.getByText("1/1 done", { exact: true })).toBeVisible();
  await expect(prerequisites.getByLabel(`${prerequisiteTitle} status: Done`)).toBeVisible();
  await expect(dependentStatus).toHaveValue("backlog");

  const removePrerequisite = prerequisites.getByRole("button", {
    name: `Remove ${prerequisiteTitle} as a prerequisite for ${dependentTitle}`,
  });
  await expectMobileTarget(removePrerequisite);
  const removeResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "DELETE",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/work-items\/[^/]+\/prerequisites\/[^/]+$/.test(pathname),
      expectedOrigin,
    ),
  );
  await removePrerequisite.focus();
  await expect(removePrerequisite).toBeFocused();
  await removePrerequisite.press("Enter");
  expect((await removeResponsePromise).status()).toBe(204);

  await expect(prerequisites.getByText("No prerequisites linked.")).toBeVisible();
  await expect(removePrerequisite).toHaveCount(0);
  await expect(summary).toBeFocused();
  await expect(dependentStatus).toHaveValue("backlog");
  await expect(
    prerequisites.getByText(
      `${prerequisiteTitle} is no longer a prerequisite. The work item status was not changed.`,
      { exact: true },
    ),
  ).toBeVisible();

  await page.reload();
  await expect(main).toBeVisible();
  await expect(prerequisites.getByText("No prerequisites linked.")).toBeVisible();
  await expect(removePrerequisite).toHaveCount(0);
  await expect(dependentStatus).toHaveValue("backlog");
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});

test("persists subtasks and keeps parent containers out of Today in the live 320px flow", async ({
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

  await page.clock.install({ time: new Date("2026-07-16T12:00:00.000Z") });
  const workspaceResponse = await page.request.post("/v1/workspaces", {
    data: { name: "Mobile subtask E2E workspace" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { readonly id: string };
  await page.addInitScript((workspaceId) => {
    localStorage.setItem("schedule.selectedWorkspace", workspaceId);
  }, workspace.id);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#work");
  const expectedOrigin = new URL(page.url()).origin;
  const main = page.getByRole("main", { name: "Work view" });
  await expect(main).toBeVisible();

  const parentTitle = "Coordinate the launch";
  await page.getByRole("textbox", { name: "Title" }).fill(parentTitle);
  await page.getByRole("checkbox", { name: "Include in Today" }).click();
  await page.getByRole("spinbutton", { name: "Plan duration (minutes)" }).fill("60");
  const parentResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/work-items$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Add item" }).click();
  const parentResponse = await parentResponsePromise;
  expect(parentResponse.status()).toBe(201);
  const parent = (await parentResponse.json()) as { readonly id: string };

  const parentCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: parentTitle, exact: true }),
  });
  const addSubtask = parentCard.getByRole("button", { name: `Add subtask to ${parentTitle}` });
  await expect(addSubtask).toBeVisible();
  const addSubtaskBounds = await addSubtask.boundingBox();
  expectMobileTargetHeight(addSubtaskBounds?.height ?? 0);
  await addSubtask.click();
  await expect(page.getByRole("heading", { name: "Add a subtask" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(`Subtask of ${parentTitle}`);

  const childTitle = "Verify launch links";
  await page.getByRole("textbox", { name: "Title" }).fill(childTitle);
  await page.getByRole("checkbox", { name: "Include in Today" }).click();
  await page.getByRole("spinbutton", { name: "Plan duration (minutes)" }).fill("30");
  const childResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => pathname === `/v1/workspaces/${workspace.id}/work-items/${parent.id}/subtasks`,
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Add subtask", exact: true }).click();
  const childResponse = await childResponsePromise;
  expect(childResponse.status()).toBe(201);
  const child = (await childResponse.json()) as { readonly id: string };

  const childCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: childTitle, exact: true }),
  });
  await expect(parentCard.getByLabel(/Parent container/)).toHaveText("Parent · not in Today");
  await expect(parentCard.getByText("0/1 subtasks done", { exact: true })).toBeVisible();
  await expect(childCard.getByText(/Subtask of/)).toContainText(parentTitle);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();
  const generatePlan = page.getByRole("button", { name: "Generate today's plan" });
  const planResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/plans$/.test(pathname),
      expectedOrigin,
    ),
  );
  await generatePlan.click();
  expect((await planResponsePromise).status()).toBe(200);
  const plannedItems = page.getByRole("list", { name: "Today's planned items" });
  await expect(plannedItems.getByRole("article", { name: childTitle })).toBeVisible();
  await expect(plannedItems.getByRole("article", { name: parentTitle })).toHaveCount(0);

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(main).toBeVisible();
  const childStatus = childCard.getByRole("combobox", { name: `Status for ${childTitle}` });
  const completionResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "PATCH",
      (pathname) => pathname.endsWith(`/work-items/${child.id}`),
      expectedOrigin,
    ),
  );
  await childStatus.selectOption("done");
  expect((await completionResponsePromise).status()).toBe(200);
  await expect(parentCard.getByText("1/1 subtasks done", { exact: true })).toBeVisible();

  await page.reload();
  await expect(main).toBeVisible();
  await expect(childCard.getByText(/Subtask of/)).toContainText(parentTitle);
  await expect(childStatus).toHaveValue("done");
  await expect(parentCard.getByText("1/1 subtasks done", { exact: true })).toBeVisible();

  await childCard.getByRole("button", { name: `Edit details for ${childTitle}` }).click();
  const parentSelect = childCard.getByRole("combobox", { name: /Parent item/ });
  await expect(parentSelect).toHaveValue(parent.id);
  await parentSelect.selectOption("");
  const detachResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "PATCH",
      (pathname) => pathname.endsWith(`/work-items/${child.id}`),
      expectedOrigin,
    ),
  );
  await childCard.getByRole("button", { name: "Save details" }).click();
  expect((await detachResponsePromise).status()).toBe(200);
  await expect(childCard.getByText("Top-level item", { exact: true })).toBeVisible();
  await expect(parentCard.getByText(/subtasks done/)).toHaveCount(0);

  await childCard.getByRole("button", { name: `Edit details for ${childTitle}` }).click();
  await childCard.getByRole("combobox", { name: /Parent item/ }).selectOption(parent.id);
  const reparentResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "PATCH",
      (pathname) => pathname.endsWith(`/work-items/${child.id}`),
      expectedOrigin,
    ),
  );
  await childCard.getByRole("button", { name: "Save details" }).click();
  expect((await reparentResponsePromise).status()).toBe(200);
  await expect(childCard.getByText(/Subtask of/)).toContainText(parentTitle);
  await expect(parentCard.getByText("1/1 subtasks done", { exact: true })).toBeVisible();

  for (const suffix of ["A", "B", "C"]) {
    const overflowChildResponse = await page.request.post(
      `/v1/workspaces/${workspace.id}/work-items/${parent.id}/subtasks`,
      {
        data: {
          title: `Additional launch child ${suffix}`,
          status: "backlog",
          priority: "none",
          planningDurationMinutes: null,
        },
      },
    );
    expect(overflowChildResponse.status()).toBe(201);
  }
  await page.reload();
  await expect(main).toBeVisible();
  await expect(parentCard.getByText("1/4 subtasks done", { exact: true })).toBeVisible();
  const overflowSummary = parentCard.getByText("Show 1 more subtask", { exact: true });
  await expect(overflowSummary).toBeVisible();
  const overflowSummaryBounds = await overflowSummary.boundingBox();
  expectMobileTargetHeight(overflowSummaryBounds?.height ?? 0);
  await overflowSummary.click();
  const overflowChild = parentCard.getByRole("button", { name: /^Verify launch links/ });
  await expect(overflowChild).toBeVisible();
  const overflowChildBounds = await overflowChild.boundingBox();
  expectMobileTargetHeight(overflowChildBounds?.height ?? 0);

  await page.evaluate(async () => {
    const browserGlobal = globalThis as unknown as {
      readonly document: { readonly fonts: { readonly ready: Promise<unknown> } };
    };
    await browserGlobal.document.fonts.ready;
  });
  const relationshipTargets = await page
    .locator(".work-hierarchy button:visible")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(relationshipTargets.length).toBeGreaterThan(0);
  expect(
    relationshipTargets.filter(
      (height) => height < MOBILE_TARGET_MINIMUM_CSS_PIXELS - CSS_PIXEL_MEASUREMENT_TOLERANCE,
    ),
    `all relationship target heights: ${relationshipTargets.join(", ")}`,
  ).toEqual([]);
  const overflow = await page.evaluate(() => {
    const browserGlobal = globalThis as unknown as {
      readonly document: {
        readonly documentElement: { readonly scrollWidth: number; readonly clientWidth: number };
        readonly body: { readonly scrollWidth: number; readonly clientWidth: number };
      };
    };
    return {
      document:
        browserGlobal.document.documentElement.scrollWidth -
        browserGlobal.document.documentElement.clientWidth,
      body: browserGlobal.document.body.scrollWidth - browserGlobal.document.body.clientWidth,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);

  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});

test("compares, selects, persists, and rejects stale daily-plan alternatives", async ({ page }) => {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttpResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    requestFailures.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    const expectedStaleSelection =
      response.status() === 409 && pathname.endsWith("/alternative-selections");
    if (!expectedStaleSelection) {
      unexpectedHttpResponses.push(
        `${response.status()} ${response.request().method()} ${pathname}`,
      );
    }
  });

  await page.clock.install({ time: new Date("2026-07-15T12:00:00.000Z") });
  const workspaceResponse = await page.request.post("/v1/workspaces", {
    data: { name: "Alternative comparison E2E" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { id: string };
  const routines: Array<{ id: string; version: number; title: string }> = [];
  for (const [index, title] of [
    "Anchor the morning",
    "Review the roadmap",
    "Draft the update",
    "Practice vocabulary",
    "Clear small follow-ups",
  ].entries()) {
    const response = await page.request.post(`/v1/workspaces/${workspace.id}/routines`, {
      data: {
        title,
        tags: { priority: ["critical", "high", "high", "medium", "low"][index] },
        duration: { expectedMinutes: 30 },
        cadence: { period: "week", targetCompletions: 3 },
      },
    });
    expect(response.status()).toBe(201);
    routines.push((await response.json()) as { id: string; version: number; title: string });
  }
  const planResponse = await page.request.post(`/v1/workspaces/${workspace.id}/plans`, {
    data: {
      date: "2026-07-15",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-15T08:00:00.000Z",
          endsAt: "2026-07-15T09:00:00.000Z",
        },
      ],
      targetMinutes: 60,
      maximumMinutes: 60,
      targetTaskCount: 2,
      maximumTaskCount: 2,
      seed: "alternatives-browser-source",
    },
  });
  expect(planResponse.status()).toBe(200);

  await page.addInitScript((workspaceId) => {
    globalThis.localStorage.setItem("schedule.selectedWorkspace", workspaceId);
  }, workspace.id);
  await page.goto("/#today");
  await expect(page.getByRole("main", { name: "Today view" })).toBeVisible();
  const plannedItems = page.getByRole("list", { name: "Today's planned items" });
  const firstItem = plannedItems.getByRole("article").first();
  const lockedTitle = await firstItem.getByRole("heading", { level: 3 }).innerText();
  const lockResponsePromise = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      /\/plans\/[^/]+\/items\/[^/]+\/lock$/.test(new URL(response.url()).pathname),
  );
  await firstItem.getByRole("button", { name: "Lock" }).click();
  await lockResponsePromise;
  await expect(firstItem.getByRole("button", { name: "Unlock" })).toBeVisible();

  const previewResponsePromise = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      new URL(response.url()).pathname.endsWith("/alternative-previews"),
  );
  await page.getByRole("button", { name: "Compare alternatives" }).click();
  const previewResponse = await previewResponsePromise;
  const preview = (await previewResponse.json()) as {
    alternatives: Array<{ items: Array<{ title: string }> }>;
  };
  expect(preview.alternatives.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Compare before changing Today" })).toBeVisible();
  const chosenTitles = preview.alternatives[0]!.items.map((item) => item.title);
  const selectionResponsePromise = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      new URL(response.url()).pathname.endsWith("/alternative-selections"),
  );
  await page.getByRole("button", { name: "Use alternative 1 as today's plan" }).click();
  await selectionResponsePromise;
  await expect(page.getByText("Alternative 1 is now today's plan.")).toBeVisible();
  for (const title of chosenTitles) {
    await expect(plannedItems.getByRole("article", { name: title })).toBeVisible();
  }
  await expect(
    plannedItems
      .getByRole("article", { name: lockedTitle })
      .getByRole("button", { name: "Unlock" }),
  ).toBeVisible();

  await page.reload();
  for (const title of chosenTitles) {
    await expect(plannedItems.getByRole("article", { name: title })).toBeVisible();
  }
  await expect(
    plannedItems
      .getByRole("article", { name: lockedTitle })
      .getByRole("button", { name: "Unlock" }),
  ).toBeVisible();

  const stalePreviewResponsePromise = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      new URL(response.url()).pathname.endsWith("/alternative-previews"),
  );
  await page.getByRole("button", { name: "Compare alternatives" }).click();
  const stalePreviewResponse = await stalePreviewResponsePromise;
  const stalePreview = (await stalePreviewResponse.json()) as {
    alternatives: Array<{
      items: Array<{ routineId: string | null; title: string }>;
    }>;
  };
  const staleRoutineId = stalePreview.alternatives[0]?.items.find(
    (item) => item.routineId !== null && item.title !== lockedTitle,
  )?.routineId;
  expect(staleRoutineId).toBeTruthy();
  const editedRoutine = routines.find((routine) => routine.id === staleRoutineId);
  expect(editedRoutine).toBeTruthy();
  const editResponse = await page.request.patch(
    `/v1/workspaces/${workspace.id}/routines/${editedRoutine!.id}`,
    {
      data: {
        expectedVersion: editedRoutine!.version,
        status: "paused",
      },
    },
  );
  expect(editResponse.status()).toBe(200);
  const staleSelectionResponsePromise = page.waitForResponse(
    (response) =>
      response.status() === 409 &&
      new URL(response.url()).pathname.endsWith("/alternative-selections"),
  );
  await page.getByRole("button", { name: "Use alternative 1 as today's plan" }).click();
  await staleSelectionResponsePromise;
  await expect(page.getByRole("alert")).toContainText(
    "This plan changed. The latest plan is shown; compare again.",
  );
  await expect(page.getByRole("heading", { name: "Compare before changing Today" })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});
