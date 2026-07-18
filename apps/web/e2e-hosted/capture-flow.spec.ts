import { expect, test } from "@playwright/test";

const csrfToken = "c".repeat(43);
const workspaces = [
  { id: "00000000-0000-4000-8000-000000000001", name: "My Schedule" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Studio" },
];

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
  let requestedTodayDate: string | null = null;
  const existing = {
    id: "00000000-0000-4000-8000-000000000009",
    title: `Review-${"outline".repeat(24)}`,
    version: 4,
    priority: "none",
    dueOn: null,
    planningDurationMinutes: null,
  };
  const created = {
    id: "00000000-0000-4000-8000-000000000010",
    title: "Prepare release",
    version: 1,
    priority: "high",
    dueOn: "2026-07-20",
    planningDurationMinutes: 75,
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
  let backlog: (typeof existing | typeof created)[] = [existing];
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
    if (request.method() === "GET" && url.pathname.endsWith("/work-items")) {
      await route.fulfill({ json: { items: backlog, limit: 20, offset: 0 } });
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
      backlog = backlog.filter((item) => item.id !== existing.id);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/hosted/workspaces/${workspaces[1]!.id}/work-items`
    ) {
      capturedBody = request.postDataJSON();
      capturedCsrf = request.headers()["x-schedule-csrf"];
      backlog = [...backlog, created];
      await route.fulfill({ status: 201, json: created });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "test.unexpected" } } });
  });

  await page.goto("/hosted.html");
  await expect(page.getByRole("heading", { name: "What needs doing?" })).toBeVisible();
  await expect(page.getByText(existing.title)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build today’s plan" })).toBeVisible();
  expect(requestedTodayDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  await page.getByRole("combobox", { name: "Workspace" }).selectOption(workspaces[1]!.id);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByLabel("Work window starts").fill("10:00");
  await page.getByLabel("Work window ends").fill("16:30");
  await page.getByRole("spinbutton", { name: "Time budget (minutes)" }).fill("240");
  await page.getByRole("spinbutton", { name: "Task limit" }).fill("5");
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
  await expect(page.locator(".hosted-backlog-list li", { hasText: existing.title })).toHaveCount(0);
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
  });
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
    if (request.method() === "GET" && url.pathname.endsWith("/work-items")) {
      await route.fulfill({ json: { items: [], limit: 20, offset: 0 } });
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
