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
  let requestedTodayDate: string | null = null;
  const existing = {
    id: "00000000-0000-4000-8000-000000000009",
    title: `Review-${"outline".repeat(24)}`,
    version: 4,
  };
  const created = {
    id: "00000000-0000-4000-8000-000000000010",
    title: "Prepare release",
    version: 1,
  };
  const todayItem = {
    title: `Plan-${"focus".repeat(24)}`,
    scheduledMinutes: 45,
    activityState: "started",
  };
  let backlog = [existing];
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
        json: { date: requestedTodayDate, items: [todayItem], totalMinutes: 45 },
      });
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
  await expect(page.getByText(todayItem.title)).toBeVisible();
  await expect(page.getByText("45m · Started")).toBeVisible();
  expect(requestedTodayDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  await page.getByRole("combobox", { name: "Workspace" }).selectOption(workspaces[1]!.id);
  await page.getByRole("button", { name: `Complete ${existing.title}` }).click();
  await expect(page.getByText(`Completed “${existing.title}”.`)).toBeVisible();
  await expect(page.locator(".hosted-backlog-list li", { hasText: existing.title })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Work item" }).fill("Prepare release");
  await page.getByRole("button", { name: "Add to backlog" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "Added “Prepare release” to Studio." }),
  ).toBeVisible();
  await expect(page.locator(".hosted-backlog-list li", { hasText: created.title })).toBeVisible();
  expect(capturedBody).toEqual({ title: "Prepare release" });
  expect(capturedCsrf).toBe(csrfToken);
  expect(capturedStatusBody).toEqual({ expectedVersion: existing.version, status: "done" });
  expect(capturedStatusCsrf).toBe(csrfToken);

  await page.setViewportSize({ width: 360, height: 740 });
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
      await route.fulfill({ json: { date: "2026-07-16", items: [], totalMinutes: 0 } });
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
