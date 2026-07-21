import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { parseHostedStagingConfig } from "../../../scripts/hosted-staging-config";

const staging = parseHostedStagingConfig();

function highLevel(message: string): void {
  console.log(`[hosted-staging ${staging.host}] ${message}`);
}

async function expectExactJson(
  request: APIRequestContext,
  path: "/health/live" | "/health/ready" | "/v1/auth/session",
  body: unknown,
): Promise<void> {
  const response = await request.get(path);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual(body);
}

async function selectDedicatedWorkspace(page: Page): Promise<void> {
  const workspace = page.getByRole("combobox", { name: "Workspace", exact: true });
  if (await workspace.isVisible()) {
    const matchingOptions = (await workspace.locator("option").allTextContents()).filter(
      (name) => name === staging.workspaceName,
    );
    expect(matchingOptions).toEqual([staging.workspaceName]);
    await workspace.selectOption({ label: staging.workspaceName });
    return;
  }
  await expect(page.locator(".hosted-workspace-name")).toHaveText(
    `Backlog · ${staging.workspaceName}`,
  );
}

test("operator-assisted hosted staging smoke", async ({ browser, request }) => {
  await expectExactJson(request, "/health/live", { status: "alive" });
  await expectExactJson(request, "/health/ready", { status: "ready" });

  const context = await browser.newContext({ baseURL: staging.origin });
  const page = await context.newPage();
  try {
    await expectExactJson(page.request, "/v1/auth/session", { authenticated: false });
    await page.goto("/hosted.html");
    const signIn = page.getByRole("button", { name: "Sign in", exact: true });
    await expect(signIn).toBeVisible();

    highLevel("Complete the normal OIDC sign-in in the opened Chromium window.");
    await signIn.click();
    await expect(page.getByRole("heading", { name: "What needs doing?", exact: true })).toBeVisible(
      {
        timeout: staging.loginTimeoutMs,
      },
    );

    await selectDedicatedWorkspace(page);
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Work items", exact: true })).toBeVisible();

    const title = `Hosted staging smoke ${Date.now()}`;
    await page.getByRole("textbox", { name: "Work item", exact: true }).fill(title);
    await page.getByText("Scheduling details (optional)", { exact: true }).click();
    await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("urgent");
    await page.getByRole("spinbutton", { name: "Planning time (minutes)", exact: true }).fill("15");
    const addButton = page.getByRole("button", { name: "Add to backlog", exact: true });
    await addButton.click();
    await expect(addButton).toBeEnabled();

    const backlog = page.getByRole("heading", { name: "Work items", exact: true }).locator("..");
    const pagination = page.getByRole("navigation", { name: "Work item pages", exact: true });
    let item = backlog.getByText(title, { exact: true });
    for (let pageNumber = 1; pageNumber <= staging.maxWorkItemPages; pageNumber += 1) {
      if (await item.isVisible()) break;
      if (pageNumber === staging.maxWorkItemPages) break;
      const next = page.getByRole("button", { name: "Next", exact: true });
      if (!(await next.isVisible()) || (await next.isDisabled())) break;
      await next.click();
      await expect(pagination.getByText(`Page ${pageNumber + 1}`, { exact: true })).toBeVisible();
      item = backlog.getByText(title, { exact: true });
    }
    await expect(item).toBeVisible();
    const row = item.locator("xpath=ancestor::li[1]");
    const done = row.getByRole("button", { name: `Complete ${title}`, exact: true });
    await expect(done).toHaveCount(1);
    await done.click();
    await expect(row).toContainText("Done");

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expectExactJson(page.request, "/v1/auth/session", { authenticated: false });
  } finally {
    await context.close();
  }

  await expectExactJson(request, "/health/live", { status: "alive" });
  await expectExactJson(request, "/health/ready", { status: "ready" });
});
