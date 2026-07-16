import { expect, test } from "@playwright/test";

const csrfToken = "c".repeat(43);
const workspaces = [
  { id: "00000000-0000-4000-8000-000000000001", name: "My Schedule" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Studio" },
];

test("captures one hosted backlog item with responsive request verification", async ({ page }) => {
  let capturedBody: unknown;
  let capturedCsrf: string | undefined;
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
    if (
      request.method() === "POST" &&
      url.pathname === `/v1/hosted/workspaces/${workspaces[1]!.id}/work-items`
    ) {
      capturedBody = request.postDataJSON();
      capturedCsrf = request.headers()["x-schedule-csrf"];
      await route.fulfill({
        status: 201,
        json: { id: "00000000-0000-4000-8000-000000000010", title: "Prepare release" },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "test.unexpected" } } });
  });

  await page.goto("/hosted.html");
  await expect(page.getByRole("heading", { name: "What needs doing?" })).toBeVisible();
  await page.getByRole("combobox", { name: "Workspace" }).selectOption(workspaces[1]!.id);
  await page.getByRole("textbox", { name: "Work item" }).fill("Prepare release");
  await page.getByRole("button", { name: "Add to backlog" }).click();

  await expect(page.getByRole("status")).toContainText("Added “Prepare release” to Studio.");
  expect(capturedBody).toEqual({ title: "Prepare release" });
  expect(capturedCsrf).toBe(csrfToken);

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
