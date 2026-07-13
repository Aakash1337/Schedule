import { expect, test, type Response } from "@playwright/test";

function isMutationResponse(
  response: Response,
  method: "POST",
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

test("persists completion through the live routine-to-Today planning flow", async ({ page }) => {
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
  const planResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/plans$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Generate today's plan" }).click();
  expect((await planResponsePromise).status()).toBe(200);

  const plannedRoutines = page.getByRole("list", { name: "Today's planned routines" });
  const routine = plannedRoutines.getByRole("article", { name: routineTitle });
  await expect(routine).toBeVisible();
  await expect(routine.getByLabel("Status: Pending")).toBeVisible();

  const activityResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/items\/[^/]+\/activity-events$/.test(pathname),
      expectedOrigin,
    ),
  );
  await routine.getByRole("button", { name: "Complete" }).click();
  expect((await activityResponsePromise).status()).toBe(200);
  await expect(routine.getByLabel("Status: Completed")).toBeVisible();

  await page.reload();
  const persistedRoutine = page
    .getByRole("list", { name: "Today's planned routines" })
    .getByRole("article", { name: routineTitle });
  await expect(persistedRoutine.getByLabel("Status: Completed")).toBeVisible();
  await expect(persistedRoutine.getByRole("button", { name: "Undo completion" })).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});
