import { expect, test } from "@playwright/test";

test("discovers active and terminal work through accessible mobile filters while keeping tablet controls reachable", async ({
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

  const workspaceResponse = await page.request.post("/v1/workspaces", {
    data: { name: "Work discovery browser verification" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { readonly id: string };

  const workItems = [
    {
      title: "Review finance report",
      description: "Quarterly close notes",
      status: "backlog",
      priority: "high",
      dueOn: null,
    },
    {
      title: "Book future conference travel",
      description: null,
      status: "planned",
      priority: "low",
      dueOn: "9999-12-31",
    },
    {
      title: "Resolve overdue filing",
      description: null,
      status: "blocked",
      priority: "urgent",
      dueOn: "2000-01-01",
    },
    {
      title: "Archive completed release",
      description: null,
      status: "done",
      priority: "none",
      dueOn: null,
    },
    {
      title: "Retire cancelled booking",
      description: null,
      status: "cancelled",
      priority: "none",
      dueOn: null,
    },
  ] as const;

  for (const workItem of workItems) {
    const response = await page.request.post(`/v1/workspaces/${workspace.id}/work-items`, {
      data: { ...workItem, planningDurationMinutes: null },
    });
    expect(response.status()).toBe(201);
  }

  await page.addInitScript((workspaceId) => {
    localStorage.setItem("schedule.selectedWorkspace", workspaceId);
  }, workspace.id);
  await page.setViewportSize({ width: 920, height: 800 });
  await page.goto("/#work");

  const main = page.getByRole("main", { name: "Work view" });
  const search = main.getByRole("searchbox", { name: "Search work" });
  const status = main.getByRole("combobox", { name: "Filter by status" });
  const dueDate = main.getByRole("combobox", { name: "Filter by due date" });
  const priority = main.getByRole("combobox", { name: "Filter by priority" });
  const reset = main.getByRole("button", { name: "Reset filters" });
  const results = main.getByRole("status", { name: "Work filter results" });
  const heading = (title: string) => main.getByRole("heading", { name: title, exact: true });

  await expect(main).toBeVisible();
  for (const width of [920, 761]) {
    await page.setViewportSize({ width, height: 800 });
    for (const control of [search, status, dueDate, priority]) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    }
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(status).toHaveValue("active");
  await expect(heading(workItems[0].title)).toBeVisible();
  await expect(heading(workItems[1].title)).toBeVisible();
  await expect(heading(workItems[2].title)).toBeVisible();
  await expect(heading(workItems[3].title)).toHaveCount(0);
  await expect(heading(workItems[4].title)).toHaveCount(0);
  await expect(results).toContainText("3 of 5 work items shown");

  await search.fill("QUARTERLY finance");
  await expect(heading(workItems[0].title)).toBeVisible();
  await expect(heading(workItems[1].title)).toHaveCount(0);
  await expect(results).toContainText("1 of 5 work items shown");

  await reset.click();
  await expect(search).toHaveValue("");
  await expect(status).toHaveValue("active");

  await status.selectOption("done");
  await expect(heading(workItems[3].title)).toBeVisible();
  await expect(heading(workItems[4].title)).toHaveCount(0);
  await status.selectOption("cancelled");
  await expect(heading(workItems[4].title)).toBeVisible();
  await expect(heading(workItems[3].title)).toHaveCount(0);
  await status.selectOption("all");
  await expect(heading(workItems[3].title)).toBeVisible();
  await expect(heading(workItems[4].title)).toBeVisible();

  await reset.click();
  await dueDate.selectOption("later");
  await expect(heading(workItems[1].title)).toBeVisible();
  await expect(heading(workItems[0].title)).toHaveCount(0);
  await dueDate.selectOption("overdue");
  await expect(heading(workItems[2].title)).toBeVisible();
  await expect(heading(workItems[1].title)).toHaveCount(0);
  await dueDate.selectOption("all");
  await priority.selectOption("high");
  await expect(heading(workItems[0].title)).toBeVisible();
  await expect(heading(workItems[2].title)).toHaveCount(0);

  for (const control of [search, status, dueDate, priority, reset]) {
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

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

  await reset.click();
  await expect(status).toHaveValue("active");
  await expect(dueDate).toHaveValue("all");
  await expect(priority).toHaveValue("");
  await expect(heading(workItems[3].title)).toHaveCount(0);
  await expect(heading(workItems[4].title)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});
