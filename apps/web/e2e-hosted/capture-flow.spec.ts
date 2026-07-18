import { expect, test } from "@playwright/test";

const csrfToken = "c".repeat(43);
const workspaces = [
  { id: "00000000-0000-4000-8000-000000000001", name: "My Schedule" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Studio" },
];
const planFitInsightKey = "a".repeat(64);

test("captures one hosted backlog item with responsive request verification", async ({ page }) => {
  let capturedBody: unknown;
  let capturedCsrf: string | undefined;
  let capturedStatusBody: unknown;
  let capturedStatusCsrf: string | undefined;
  let capturedTodayBody: unknown;
  let capturedTodayCsrf: string | undefined;
  let capturedTodayIdempotency: string | undefined;
  let capturedPlanBody: unknown;
  let capturedPlanCsrf: string | undefined;
  let capturedPlanIdempotency: string | undefined;
  const capturedPlanFitFeedback: {
    path: string;
    body: unknown;
    csrf: string | undefined;
    idempotencyKey: string | undefined;
  }[] = [];
  let requestedTodayDate: string | null = null;
  let requestedPlanFitPath: string | null = null;
  let requestedPlanFitDate: string | null = null;
  let requestedPlanFitEffectivenessPath: string | null = null;
  const existing = {
    id: "00000000-0000-4000-8000-000000000009",
    parentWorkItemId: null,
    title: `Review-${"outline".repeat(24)}`,
    description: null,
    status: "backlog",
    version: 4,
    priority: "none",
    dueOn: null,
    planningDurationMinutes: null,
    createdAt: "2026-07-15T14:00:00.000Z",
    updatedAt: "2026-07-15T14:00:00.000Z",
  };
  const created = {
    id: "00000000-0000-4000-8000-000000000010",
    parentWorkItemId: null,
    title: "Prepare release",
    description: null,
    status: "backlog",
    version: 1,
    priority: "high",
    dueOn: "2026-07-20",
    planningDurationMinutes: 75,
    createdAt: "2026-07-17T14:00:00.000Z",
    updatedAt: "2026-07-17T14:00:00.000Z",
  };
  const todayItem = {
    id: "00000000-0000-4000-8000-000000000011",
    title: `Plan-${"focus".repeat(24)}`,
    scheduledMinutes: 45,
  };
  const todayPlanId = "00000000-0000-4000-8000-000000000012";
  let todayHeadVersion = 5;
  let todayActivityState: "pending" | "completed" = "pending";
  let todayGenerated = false;
  let planFitDisposition: "available" | "dismissed" = "available";
  const firstWorkspaceItems = Array.from({ length: 21 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    parentWorkItemId: null,
    title: index === 20 ? "Archived work on page two" : `Paged work ${index + 1}`,
    description: null,
    status: index === 20 ? "done" : "backlog",
    version: 1,
    priority: "none",
    dueOn: null,
    planningDurationMinutes: null,
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    updatedAt: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
  }));
  let studioItems: Array<typeof existing | typeof created> = [existing];
  const snapshotRequests: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/v1/auth/session") {
      await route.fulfill({
        json: { authenticated: true },
        headers: {
          "set-cookie": `__Host-schedule_csrf=${csrfToken}; Path=/; Secure; SameSite=Lax`,
        },
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/v1/hosted/workspaces") {
      await route.fulfill({ json: { items: workspaces, limit: 20, offset: 0 } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/work-items/snapshot")) {
      snapshotRequests.push(`${url.pathname}${url.search}`);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const items = url.pathname.includes(workspaces[0]!.id) ? firstWorkspaceItems : studioItems;
      await route.fulfill({ json: { items: items.slice(offset, offset + limit), limit, offset } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/daily-plan-fit-insight")) {
      requestedPlanFitPath = url.pathname;
      requestedPlanFitDate = url.searchParams.get("forDate");
      await route.fulfill({
        json: {
          forDate: url.searchParams.get("forDate"),
          status: "suggested",
          disposition: planFitDisposition,
          sampleCount: 3,
          minimumSamples: 3,
          suggestedTargetMinutes: 90,
          suggestedTargetTaskCount: 2,
          insightKey: planFitInsightKey,
        },
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname.endsWith("/daily-plan-fit-insight/effectiveness")
    ) {
      requestedPlanFitEffectivenessPath = url.pathname;
      await route.fulfill({
        json: {
          usesConsidered: 4,
          eligibleResolvedUseCount: 3,
          minimumComparableUses: 3,
          pendingUseCount: 1,
          revisedUseCount: 0,
          notEvaluableUseCount: 0,
          exactSuggestionUseCount: 2,
          editedSuggestionUseCount: 2,
          scheduledMinutesRateBasisPoints: 8_000,
          scheduledTasksRateBasisPoints: 7_500,
          completionMinutesRateBasisPoints: 7_500,
          completionTasksRateBasisPoints: 8_000,
        },
      });
      return;
    }
    if (
      request.method() === "POST" &&
      (url.pathname.endsWith("/daily-plan-fit-insight/dismissals") ||
        url.pathname.endsWith("/daily-plan-fit-insight/dismissal-resets"))
    ) {
      capturedPlanFitFeedback.push({
        path: url.pathname,
        body: request.postDataJSON(),
        csrf: request.headers()["x-schedule-csrf"],
        idempotencyKey: request.headers()["idempotency-key"],
      });
      planFitDisposition = url.pathname.endsWith("/dismissals") ? "dismissed" : "available";
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/today")) {
      requestedTodayDate = url.searchParams.get("date");
      await route.fulfill({
        json: todayGenerated
          ? {
              date: requestedTodayDate,
              planId: todayPlanId,
              headVersion: todayHeadVersion,
              items: [{ ...todayItem, activityState: todayActivityState }],
              totalMinutes: 45,
            }
          : {
              date: requestedTodayDate,
              planId: null,
              headVersion: null,
              items: [],
              totalMinutes: 0,
            },
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/today")) {
      capturedPlanBody = request.postDataJSON();
      capturedPlanCsrf = request.headers()["x-schedule-csrf"];
      capturedPlanIdempotency = request.headers()["idempotency-key"];
      todayGenerated = true;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname.endsWith(`/today/${todayItem.id}/activity-events`)
    ) {
      capturedTodayBody = request.postDataJSON();
      capturedTodayCsrf = request.headers()["x-schedule-csrf"];
      capturedTodayIdempotency = request.headers()["idempotency-key"];
      todayActivityState = "completed";
      todayHeadVersion += 1;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (request.method() === "PATCH" && url.pathname.endsWith(`/work-items/${existing.id}`)) {
      capturedStatusBody = request.postDataJSON();
      capturedStatusCsrf = request.headers()["x-schedule-csrf"];
      studioItems = studioItems.map((item) =>
        item.id === existing.id
          ? {
              ...item,
              status: "done",
              version: item.version + 1,
              updatedAt: "2026-07-17T15:00:00.000Z",
            }
          : item,
      );
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/hosted/workspaces/${workspaces[1]!.id}/work-items`
    ) {
      capturedBody = request.postDataJSON();
      capturedCsrf = request.headers()["x-schedule-csrf"];
      studioItems = [...studioItems, created];
      await route.fulfill({ status: 201, json: created });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "test.unexpected" } } });
  });

  await page.goto("/hosted.html");
  await expect(page.getByRole("heading", { name: "What needs doing?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work items" })).toBeVisible();
  await expect(page.getByText("Paged work 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Archived work on page two", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Build today’s plan" })).toBeVisible();
  expect(requestedTodayDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  await page.setViewportSize({ width: 360, height: 740 });
  const nextWorkItems = page.getByRole("button", { name: "Next" });
  await expect(nextWorkItems).toBeVisible();
  expect((await nextWorkItems.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await nextWorkItems.click();
  const archivedRow = page.locator(".hosted-backlog-list li", {
    hasText: "Archived work on page two",
  });
  await expect(archivedRow).toContainText("Done");
  await expect(archivedRow.getByRole("button")).toHaveCount(0);
  const previousWorkItems = page.getByRole("button", { name: "Previous" });
  expect((await previousWorkItems.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await previousWorkItems.click();
  await expect(page.getByText("Paged work 1", { exact: true })).toBeVisible();
  expect(snapshotRequests).toContain(
    `/v1/hosted/workspaces/${workspaces[0]!.id}/work-items/snapshot?limit=21&offset=0`,
  );
  expect(snapshotRequests).toContain(
    `/v1/hosted/workspaces/${workspaces[0]!.id}/work-items/snapshot?limit=21&offset=20`,
  );

  await page.getByRole("combobox", { name: "Workspace" }).selectOption(workspaces[1]!.id);
  await expect(page.getByText(existing.title)).toBeVisible();
  expect(snapshotRequests).toContain(
    `/v1/hosted/workspaces/${workspaces[1]!.id}/work-items/snapshot?limit=21&offset=0`,
  );
  await expect(page.getByRole("heading", { name: "Plan Fit outcomes" })).toBeVisible();
  await expect(page.getByText(/target scheduled 80% time and 75% tasks/iu)).toBeVisible();
  expect(requestedPlanFitEffectivenessPath).toBe(
    `/v1/hosted/workspaces/${workspaces[1]!.id}/daily-plan-fit-insight/effectiveness`,
  );
  const usePlanFit = page.getByRole("button", { name: "Use 1h 30m and 2 tasks" });
  await expect(usePlanFit).toBeVisible();
  expect(requestedPlanFitPath).toBe(
    `/v1/hosted/workspaces/${workspaces[1]!.id}/daily-plan-fit-insight`,
  );
  expect(requestedPlanFitDate).toBe(requestedTodayDate);
  expect((await usePlanFit.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const notNow = page.getByRole("button", { name: "Not now" });
  expect((await notNow.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await notNow.click();
  const showAgain = page.getByRole("button", { name: "Show again" });
  await expect(showAgain).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent Plan Fit" })).toBeFocused();
  await showAgain.click();
  await expect(usePlanFit).toBeVisible();
  await usePlanFit.click();
  await expect(page.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveValue("90");
  await expect(page.getByRole("spinbutton", { name: "Task limit" })).toHaveValue("2");
  expect(capturedPlanBody).toBeUndefined();
  await page.getByLabel("Work window starts").fill("10:00");
  await page.getByLabel("Work window ends").fill("16:30");
  await page.getByRole("spinbutton", { name: "Time budget (minutes)" }).fill("240");
  await page.getByRole("spinbutton", { name: "Task limit" }).fill("5");
  await expect(page.getByRole("button", { name: "Use 1h 30m and 2 tasks" })).toBeEnabled();
  await expect(page.getByRole("status")).toContainText("Plan Fit suggests 1h 30m and 2 tasks.");
  for (const input of [
    page.getByLabel("Work window starts"),
    page.getByLabel("Work window ends"),
    page.getByRole("spinbutton", { name: "Time budget (minutes)" }),
    page.getByRole("spinbutton", { name: "Task limit" }),
  ]) {
    expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  const buildPlanButton = page.getByRole("button", { name: "Build plan" });
  expect((await buildPlanButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await buildPlanButton.click();
  await expect(page.getByText("Built today’s plan.")).toBeVisible();
  await expect(page.getByText(todayItem.title)).toBeVisible();
  await expect(page.getByText("45m · Pending")).toBeVisible();
  const skipButton = page.getByRole("button", { name: `Skip ${todayItem.title} in Today` });
  await expect(skipButton).toBeVisible();
  const actionLayout = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      readonly innerWidth: number;
      readonly document: { readonly documentElement: { readonly scrollWidth: number } };
    };
    return {
      viewport: browser.innerWidth,
      width: browser.document.documentElement.scrollWidth,
    };
  });
  expect(actionLayout.width).toBeLessThanOrEqual(actionLayout.viewport);
  expect((await skipButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  for (const target of [
    page.getByRole("button", { name: "Sign out" }),
    page.getByRole("button", { name: `Start ${existing.title}` }),
    page.getByText("Scheduling details (optional)"),
  ]) {
    expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("button", { name: `Complete ${todayItem.title} in Today` }).click();
  await expect(page.getByText(`Completed “${todayItem.title}”.`)).toBeVisible();
  await expect(page.getByText("45m · Completed")).toBeVisible();
  await page.getByRole("button", { name: `Complete ${existing.title}` }).click();
  await expect(page.getByText(`Completed “${existing.title}”.`)).toBeVisible();
  const transitionedRow = page.locator(".hosted-backlog-list li", { hasText: existing.title });
  await expect(transitionedRow).toContainText("Done");
  await expect(transitionedRow.getByRole("button")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Work item" }).fill("Prepare release");
  await page.getByText("Scheduling details (optional)").click();
  await page.getByRole("combobox", { name: "Priority" }).selectOption("high");
  await page.getByLabel("Due date").fill("2026-07-20");
  await page.getByRole("spinbutton", { name: /^Planning time \(minutes\)/u }).fill("75");
  await page.getByRole("button", { name: "Add to backlog" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "Added “Prepare release” to Studio." }),
  ).toBeVisible();
  await expect(page.locator(".hosted-backlog-list li", { hasText: created.title })).toBeVisible();
  await expect(page.getByText("High priority · Due 2026-07-20 · 1h 15m planned")).toBeVisible();
  expect(capturedBody).toEqual({
    title: "Prepare release",
    priority: "high",
    dueOn: "2026-07-20",
    planningDurationMinutes: 75,
  });
  expect(capturedCsrf).toBe(csrfToken);
  expect(capturedStatusBody).toEqual({ expectedVersion: existing.version, status: "done" });
  expect(capturedStatusCsrf).toBe(csrfToken);
  expect(capturedPlanBody).toEqual({
    timeZone: expect.any(String),
    window: {
      startsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      endsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    },
    targetMinutes: 240,
    targetTaskCount: 5,
    planFitInsightKey,
  });
  expect(capturedPlanFitFeedback).toEqual([
    {
      path: `/v1/hosted/workspaces/${workspaces[1]!.id}/daily-plan-fit-insight/dismissals`,
      body: { forDate: requestedTodayDate, insightKey: planFitInsightKey },
      csrf: csrfToken,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
    {
      path: `/v1/hosted/workspaces/${workspaces[1]!.id}/daily-plan-fit-insight/dismissal-resets`,
      body: { forDate: requestedTodayDate, insightKey: planFitInsightKey },
      csrf: csrfToken,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
  ]);
  const planWindow = (capturedPlanBody as { window: { startsAt: string; endsAt: string } }).window;
  expect(new Date(planWindow.endsAt).getTime() - new Date(planWindow.startsAt).getTime()).toBe(
    390 * 60_000,
  );
  expect(capturedPlanCsrf).toBe(csrfToken);
  expect(capturedPlanIdempotency).toMatch(/^[0-9a-f-]{36}$/u);
  expect(capturedTodayBody).toEqual({
    expectedPlanId: todayPlanId,
    expectedHeadVersion: 5,
    type: "completed",
    occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
  });
  expect(capturedTodayCsrf).toBe(csrfToken);
  expect(capturedTodayIdempotency).toMatch(/^[0-9a-f-]{36}$/u);

  await expect(page.getByRole("button", { name: "Add to backlog" })).toBeVisible();
  const layout = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      readonly innerWidth: number;
      readonly document: { readonly documentElement: { readonly scrollWidth: number } };
    };
    return {
      viewport: browser.innerWidth,
      width: browser.document.documentElement.scrollWidth,
    };
  });
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
  expect(
    (await page.getByRole("button", { name: "Add to backlog" }).boundingBox())?.height,
  ).toBeGreaterThanOrEqual(44);
});

test("keeps capture unavailable before sign-in", async ({ page }) => {
  await page.route("**/v1/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );

  await page.goto("/hosted.html");

  await expect(
    page.getByRole("heading", { name: "Capture work without losing your place." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/v1/auth/login",
  );
  await expect(page.getByRole("textbox", { name: "Work item" })).toHaveCount(0);
});

test("creates the first hosted workspace through exact request verification", async ({ page }) => {
  const workspace = { id: "00000000-0000-4000-8000-000000000003", name: "Projects" };
  let createBody: unknown;
  let createCsrf: string | undefined;

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/v1/auth/session") {
      await route.fulfill({
        json: { authenticated: true },
        headers: {
          "set-cookie": `__Host-schedule_csrf=${csrfToken}; Path=/; Secure; SameSite=Lax`,
        },
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/v1/hosted/workspaces") {
      await route.fulfill({ json: { items: [], limit: 20, offset: 0 } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/v1/hosted/workspaces") {
      createBody = request.postDataJSON();
      createCsrf = request.headers()["x-schedule-csrf"];
      await route.fulfill({ status: 201, json: workspace });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/work-items/snapshot")) {
      await route.fulfill({ json: { items: [], limit: 21, offset: 0 } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/today")) {
      await route.fulfill({
        json: {
          date: "2026-07-16",
          planId: null,
          headVersion: null,
          items: [],
          totalMinutes: 0,
        },
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/daily-plan-fit-insight")) {
      await route.fulfill({
        json: {
          forDate: url.searchParams.get("forDate"),
          status: "insufficient_history",
          disposition: "available",
          sampleCount: 0,
          minimumSamples: 3,
          suggestedTargetMinutes: null,
          suggestedTargetTaskCount: null,
          insightKey: null,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "test.unexpected" } } });
  });

  await page.goto("/hosted.html");
  await page.getByRole("textbox", { name: "Workspace name" }).fill("Projects");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page.getByRole("textbox", { name: "Work item" })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Created workspace “Projects”." }),
  ).toBeVisible();
  expect(createBody).toEqual({ name: "Projects" });
  expect(createCsrf).toBe(csrfToken);
});
