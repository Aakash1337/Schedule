import { expect, test, type Response } from "@playwright/test";

function fakeModelControlUrl(pathname: "/test/held-proposal" | "/test/release-proposal"): string {
  const port = Number(process.env.E2E_OLLAMA_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_OLLAMA_PORT must identify the fake loopback model.");
  }
  return `http://127.0.0.1:${String(port)}${pathname}`;
}

async function heldProposalState(): Promise<{
  readonly held: boolean;
  readonly clientAborted: boolean;
}> {
  const response = await fetch(fakeModelControlUrl("/test/held-proposal"));
  if (!response.ok) throw new Error("Could not read fake-model proposal state.");
  return (await response.json()) as { readonly held: boolean; readonly clientAborted: boolean };
}

async function releaseHeldProposal(): Promise<void> {
  const response = await fetch(fakeModelControlUrl("/test/release-proposal"), { method: "POST" });
  if (!response.ok) throw new Error("Could not release the held fake-model proposal.");
}

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

function isCurrentPlanResponse(
  response: Response,
  workspaceId: string,
  expectedOrigin: string,
): boolean {
  const url = new URL(response.url());
  return (
    url.origin === expectedOrigin &&
    response.request().method() === "GET" &&
    url.pathname.startsWith(`/v1/workspaces/${workspaceId}/plans/`) &&
    url.pathname.endsWith("/current")
  );
}

function isDailyPlanFitInsightResponse(response: Response, expectedOrigin: string): boolean {
  const url = new URL(response.url());
  return (
    url.origin === expectedOrigin &&
    response.request().method() === "GET" &&
    /^\/v1\/workspaces\/[^/]+\/daily-plan-fit-insight$/.test(url.pathname)
  );
}

test("reviews and explicitly confirms local work and calendar proposals through the live stack", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttpResponses: string[] = [];
  let expectedProposalAbort = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      expectedProposalAbort &&
      request.method() === "POST" &&
      /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals$/.test(pathname)
    ) {
      expectedProposalAbort = false;
      return;
    }
    requestFailures.push(`${request.method()} ${pathname}`);
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

  await page.goto("/");
  const expectedOrigin = new URL(page.url()).origin;
  const onboardingHeading = page.getByRole("heading", { name: "Give your days a shape." });
  const workNavigation = page.getByRole("button", { name: "Work", exact: true });
  await expect(onboardingHeading.or(workNavigation)).toBeVisible();
  if (await onboardingHeading.isVisible()) {
    const initialPlanFitResponsePromise = page.waitForResponse((response) =>
      isDailyPlanFitInsightResponse(response, expectedOrigin),
    );
    const workspaceResponsePromise = page.waitForResponse((response) =>
      isMutationResponse(
        response,
        "POST",
        (pathname) => pathname === "/v1/workspaces",
        expectedOrigin,
      ),
    );
    await page.getByRole("textbox", { name: "Workspace name" }).fill("Proposal E2E workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    expect((await workspaceResponsePromise).status()).toBe(201);
    expect((await initialPlanFitResponsePromise).status()).toBe(200);
  }

  await workNavigation.click();
  await expect(page.getByRole("main", { name: "Work view" })).toBeVisible();
  await page.getByRole("button", { name: "Describe work" }).click();
  await expect(
    page.getByRole("heading", { name: "Describe work in your own words" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: /^Describe one/ })
    .fill("Turn the launch notes into one checklist task");

  const proposalResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Review proposal" }).click();
  expect((await proposalResponsePromise).status()).toBe(200);

  await expect(page.getByRole("heading", { name: "Create one backlog work item" })).toBeVisible();
  await expect(page.getByText(/Nothing has been created yet/).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Prepare the launch checklist", exact: true }),
  ).toHaveCount(0);

  const suggestions = page.getByRole("region", { name: "Optional model suggestions" });
  await expect(suggestions).toBeVisible();
  await suggestions.getByRole("button", { name: "Use priority" }).click();
  await suggestions.getByRole("button", { name: "Use due date" }).click();
  await suggestions.getByRole("button", { name: "Use duration" }).click();

  const reviewedTitle = "Prepare the reviewed launch checklist";
  await page.getByRole("textbox", { name: /^Work item title/ }).fill(reviewedTitle);
  const userFields = page.getByRole("region", {
    name: "Your reviewed choices",
  });
  await userFields.getByRole("combobox", { name: "Priority" }).selectOption("urgent");
  await userFields.locator('input[type="date"]').fill("2026-07-20");
  await userFields.getByRole("checkbox", { name: "Include in Today" }).check();
  await userFields.getByRole("spinbutton", { name: "Plan duration (minutes)" }).fill("75");
  const updateResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "PATCH",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals\/[^/]+$/.test(pathname),
      expectedOrigin,
    ),
  );
  const confirmationResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals\/[^/]+\/confirmations$/.test(
          pathname,
        ),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Create this work item" }).click();
  const updateResponse = await updateResponsePromise;
  const confirmationResponse = await confirmationResponsePromise;
  expect(updateResponse.status()).toBe(200);
  expect(confirmationResponse.status()).toBe(201);
  expect(updateResponse.request().postDataJSON()).toEqual({
    expectedVersion: 1,
    command: { type: "work_item.create", title: reviewedTitle },
    userSelection: {
      priority: "urgent",
      dueOn: "2026-07-20",
      planningDurationMinutes: 75,
    },
  });
  expect(confirmationResponse.request().postDataJSON()).toEqual({ expectedVersion: 2 });
  const updatedProposal = (await updateResponse.json()) as {
    readonly version: number;
    readonly userSelection: {
      readonly priority: string;
      readonly dueOn: string | null;
      readonly planningDurationMinutes: number | null;
    };
  };
  expect(updatedProposal.userSelection).toEqual({
    priority: "urgent",
    dueOn: "2026-07-20",
    planningDurationMinutes: 75,
  });
  const firstConfirmation = (await confirmationResponse.json()) as {
    readonly replayed: boolean;
    readonly workItem: { readonly id: string };
  };
  const confirmationKey = confirmationResponse.request().headers()["idempotency-key"];
  if (confirmationKey === undefined) throw new Error("Confirmation request omitted its key.");

  const createdCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: reviewedTitle, exact: true }),
  });
  await expect(createdCard).toBeVisible();
  await expect(createdCard).toBeFocused();
  await expect(
    createdCard.getByRole("combobox", { name: `Status for ${reviewedTitle}` }),
  ).toHaveValue("backlog");
  await expect(createdCard.locator(".work-priority-badge")).toHaveText("Urgent");
  await expect(createdCard.getByText("Today · 75 min", { exact: true })).toBeVisible();
  await expect(createdCard.getByText(/Due Jul 20, 2026/)).toBeVisible();

  const replay = await page.evaluate(
    async ({ path, key, expectedVersion }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ expectedVersion }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          replayed?: boolean;
          workItem?: { id?: string };
        },
      };
    },
    {
      path: new URL(confirmationResponse.url()).pathname,
      key: confirmationKey,
      expectedVersion: updatedProposal.version,
    },
  );
  expect(replay).toMatchObject({
    status: 200,
    body: { replayed: true, workItem: { id: firstConfirmation.workItem.id } },
  });

  await page.reload();
  await expect(createdCard).toBeVisible();
  await expect(createdCard).toHaveCount(1);

  await page.getByRole("button", { name: "Describe work" }).click();
  await page
    .getByRole("textbox", { name: /^Describe one/ })
    .fill("Draft a task that I will cancel after reviewing it");
  const cancellableProposalResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Review proposal" }).click();
  expect((await cancellableProposalResponsePromise).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Cancel proposal" })).toBeVisible();
  const cancellationResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals\/[^/]+\/cancellations$/.test(
          pathname,
        ),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Cancel proposal" }).click();
  expect((await cancellationResponsePromise).status()).toBe(200);
  await expect(page.getByText("Proposal cancelled. Nothing was created.")).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Prepare the launch checklist", exact: true }),
  ).toHaveCount(0);
  await expect(createdCard).toHaveCount(1);

  await page.getByRole("button", { name: "Describe work" }).click();
  await page
    .getByRole("textbox", { name: /^Describe one/ })
    .fill("Create one calendar block E2E for the quarterly report");
  const blockProposalResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Review proposal" }).click();
  expect((await blockProposalResponsePromise).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Create one unlinked calendar block" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Your reviewed time" })).toBeVisible();

  const blockConfirmationResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals\/[^/]+\/confirmations$/.test(
          pathname,
        ),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Create this calendar block" }).click();
  const blockConfirmationResponse = await blockConfirmationResponsePromise;
  expect(blockConfirmationResponse.status()).toBe(201);
  expect(await blockConfirmationResponse.json()).toMatchObject({
    resultType: "schedule_block",
    workItem: null,
    scheduleBlock: {
      title: "Review the quarterly report",
      workItemId: null,
      startsAt: "2026-07-17T14:00:00.000Z",
      endsAt: "2026-07-17T15:00:00.000Z",
      timeZone: "UTC",
    },
  });
  await expect(
    page.getByText("Review the quarterly report was created in Calendar."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page.getByRole("main", { name: "Calendar view" })).toBeVisible();
  await expect(page.getByText("Review the quarterly report", { exact: true })).toBeVisible();
  await workNavigation.click();

  await page.getByRole("button", { name: "Describe work" }).click();
  await page
    .getByRole("textbox", { name: /^Describe one/ })
    .fill("Create a routine E2E for Spanish practice");
  const routineProposalResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals$/.test(pathname),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Review proposal" }).click();
  expect((await routineProposalResponsePromise).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Create one reusable routine" })).toBeVisible();
  const routineFields = page.getByRole("region", { name: "Reviewed routine fields" });
  await expect(routineFields).toContainText("The model suggested only the title");
  await routineFields.getByRole("textbox", { name: "Title" }).fill("Practice reviewed Spanish");
  await routineFields.getByRole("spinbutton", { name: "Expected minutes" }).fill("50");
  await routineFields.getByRole("combobox", { name: "Period" }).selectOption("day");
  await routineFields.getByRole("textbox", { name: /^Categories/ }).fill("learning");
  const routineUpdateResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "PATCH",
      (pathname) => /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals\/[^/]+$/.test(pathname),
      expectedOrigin,
    ),
  );
  const routineConfirmationResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) =>
        /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals\/[^/]+\/confirmations$/.test(
          pathname,
        ),
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Create this routine" }).click();
  expect((await routineUpdateResponsePromise).status()).toBe(200);
  const routineConfirmation = await routineConfirmationResponsePromise;
  expect(routineConfirmation.status()).toBe(201);
  expect(await routineConfirmation.json()).toMatchObject({
    resultType: "routine",
    workItem: null,
    scheduleBlock: null,
    routine: {
      title: "Practice reviewed Spanish",
      tags: { categories: ["learning"] },
      duration: { expectedMinutes: 50 },
      cadence: { period: "day" },
    },
  });
  await expect(page.getByText("Practice reviewed Spanish was created in Routines.")).toBeVisible();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Practice reviewed Spanish\b/ })).toBeVisible();
  await workNavigation.click();

  const workspaceSelect = page.getByRole("combobox", { name: "Workspace" }).first();
  const originalWorkspaceId = await workspaceSelect.inputValue();
  await page.getByRole("button", { name: "New workspace" }).click();
  await page.getByRole("textbox", { name: "New workspace name" }).fill("Proposal switch target");
  const createdWorkspacePlanResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.origin === expectedOrigin &&
      response.request().method() === "GET" &&
      /^\/v1\/workspaces\/[^/]+\/plans\/[^/]+\/current$/.test(url.pathname)
    );
  });
  const secondWorkspaceResponsePromise = page.waitForResponse((response) =>
    isMutationResponse(
      response,
      "POST",
      (pathname) => pathname === "/v1/workspaces",
      expectedOrigin,
    ),
  );
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const secondWorkspaceResponse = await secondWorkspaceResponsePromise;
  expect(secondWorkspaceResponse.status()).toBe(201);
  const secondWorkspace = (await secondWorkspaceResponse.json()) as { readonly id: string };
  const createdWorkspacePlanResponse = await createdWorkspacePlanResponsePromise;
  expect(
    isCurrentPlanResponse(createdWorkspacePlanResponse, secondWorkspace.id, expectedOrigin),
  ).toBe(true);

  const originalWorkspacePlanResponsePromise = page.waitForResponse((response) =>
    isCurrentPlanResponse(response, originalWorkspaceId, expectedOrigin),
  );
  await workspaceSelect.selectOption(originalWorkspaceId);
  await originalWorkspacePlanResponsePromise;
  await workNavigation.click();
  await page.getByRole("button", { name: "Describe work" }).click();
  await page
    .getByRole("textbox", { name: /^Describe one/ })
    .fill("delay this proposal while I switch workspaces");
  const delayedProposalRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.origin === expectedOrigin &&
      request.method() === "POST" &&
      /^\/v1\/workspaces\/[^/]+\/natural-language\/proposals$/.test(url.pathname)
    );
  });
  await page.getByRole("button", { name: "Review proposal" }).click();
  await delayedProposalRequestPromise;
  await expect.poll(async () => (await heldProposalState()).held).toBe(true);
  expectedProposalAbort = true;
  await workspaceSelect.selectOption(secondWorkspace.id);
  await expect.poll(async () => (await heldProposalState()).clientAborted).toBe(true);
  await expect.poll(() => expectedProposalAbort).toBe(false);
  await releaseHeldProposal();
  await workNavigation.click();
  await expect(page.getByRole("main", { name: "Work view" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create one backlog work item" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Prepare the launch checklist", exact: true }),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(requestFailures).toEqual([]);
  expect(unexpectedHttpResponses).toEqual([]);
});
