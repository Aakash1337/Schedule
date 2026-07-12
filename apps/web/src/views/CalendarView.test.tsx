import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserTimeZone } from "../date";
import { ApiError } from "../api";
import type { ScheduleBlock, Workspace } from "../types";
import { CalendarView } from "./CalendarView";

const apiMocks = vi.hoisted(() => ({
  createScheduleBlock: vi.fn(),
  deleteScheduleBlock: vi.fn(),
  getScheduleBlock: vi.fn(),
  listScheduleBlocks: vi.fn(),
  listWorkItems: vi.fn(),
  updateScheduleBlock: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, api: { ...original.api, ...apiMocks } };
});

const workspace: Workspace = {
  id: "workspace-1",
  name: "Personal",
  createdAt: "2026-07-12T09:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.listScheduleBlocks.mockResolvedValue({
    items: [],
    page: { limit: 200, offset: 0 },
  });
  apiMocks.listWorkItems.mockResolvedValue({ items: [], page: { limit: 200, offset: 0 } });
  apiMocks.createScheduleBlock.mockImplementation(
    async (
      workspaceId: string,
      input: Pick<ScheduleBlock, "workItemId" | "title" | "startsAt" | "endsAt" | "timeZone">,
    ): Promise<ScheduleBlock> => ({
      id: "block-1",
      workspaceId,
      ...input,
      version: 1,
      createdAt: "2026-07-12T09:00:00.000Z",
      updatedAt: "2026-07-12T09:00:00.000Z",
    }),
  );
});

afterEach(cleanup);

describe("calendar", () => {
  it("announces a week refresh while retaining the previous agenda", async () => {
    const user = userEvent.setup();
    const startsAt = new Date();
    startsAt.setHours(8, 0, 0, 0);
    const block: ScheduleBlock = {
      id: "block-refresh",
      workspaceId: workspace.id,
      workItemId: null,
      title: "Visible while refreshing",
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
      timeZone: browserTimeZone(),
      version: 1,
      createdAt: startsAt.toISOString(),
      updatedAt: startsAt.toISOString(),
    };
    let finishRefresh!: (page: {
      items: ScheduleBlock[];
      page: { limit: number; offset: number };
    }) => void;
    apiMocks.listScheduleBlocks
      .mockReset()
      .mockResolvedValueOnce({ items: [block], page: { limit: 200, offset: 0 } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );

    render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

    expect(await screen.findByText(block.title ?? "")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Updating calendar week");
    expect(screen.getByText(block.title ?? "")).toBeInTheDocument();

    finishRefresh({ items: [], page: { limit: 200, offset: 0 } });
    await waitFor(() =>
      expect(screen.queryByText("Updating calendar week...")).not.toBeInTheDocument(),
    );
  });

  it("creates a block using the browser time zone shown by the editor", async () => {
    const user = userEvent.setup();
    apiMocks.listWorkItems.mockResolvedValue({
      items: [
        {
          id: "item-1",
          workspaceId: workspace.id,
          title: "Ship MVP",
          description: null,
          status: "in_progress",
          priority: "urgent",
          version: 1,
          createdAt: "2026-07-12T09:00:00.000Z",
          updatedAt: "2026-07-12T09:00:00.000Z",
        },
      ],
      page: { limit: 200, offset: 0 },
    });
    render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "New block" }));
    const timeZone = screen.getByRole("textbox", { name: /^Time zone/ });
    expect(timeZone).toHaveValue(browserTimeZone());
    expect(timeZone).toHaveAttribute("readonly");
    await user.type(screen.getByRole("textbox", { name: /^Title/ }), "Deep work");
    await user.selectOptions(screen.getByRole("combobox", { name: "Linked work item" }), "item-1");
    await user.click(screen.getByRole("button", { name: "Create block" }));

    await waitFor(() =>
      expect(apiMocks.createScheduleBlock).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({
          title: "Deep work",
          timeZone: browserTimeZone(),
          workItemId: "item-1",
        }),
      ),
    );
    expect(await screen.findByText("Deep work")).toBeInTheDocument();
  });

  it("performs the explicit audited delete flow with the current version", async () => {
    const user = userEvent.setup();
    const startsAt = new Date();
    startsAt.setHours(13, 0, 0, 0);
    const endsAt = new Date(startsAt);
    endsAt.setHours(14);
    const block: ScheduleBlock = {
      id: "block-delete",
      workspaceId: workspace.id,
      workItemId: null,
      title: "Remove me",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timeZone: browserTimeZone(),
      version: 5,
      createdAt: startsAt.toISOString(),
      updatedAt: startsAt.toISOString(),
    };
    apiMocks.listScheduleBlocks.mockResolvedValue({
      items: [block],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.deleteScheduleBlock.mockResolvedValue(undefined);

    render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

    const title = await screen.findByText(block.title ?? "");
    const blockButton = title.closest("button");
    if (blockButton === null) throw new Error("Calendar block button was not rendered.");
    await user.click(blockButton);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() =>
      expect(apiMocks.deleteScheduleBlock).toHaveBeenCalledWith(
        workspace.id,
        block.id,
        block.version,
      ),
    );
    expect(screen.queryByText(block.title ?? "")).not.toBeInTheDocument();
  });

  it("loads the authoritative block after an optimistic conflict", async () => {
    const user = userEvent.setup();
    const startsAt = new Date();
    startsAt.setHours(10, 0, 0, 0);
    const endsAt = new Date(startsAt);
    endsAt.setHours(11);
    const original: ScheduleBlock = {
      id: "block-conflict",
      workspaceId: workspace.id,
      workItemId: null,
      title: "Original title",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timeZone: browserTimeZone(),
      version: 2,
      createdAt: startsAt.toISOString(),
      updatedAt: startsAt.toISOString(),
    };
    const latest = { ...original, title: "Authoritative title", version: 3 };
    apiMocks.listScheduleBlocks.mockResolvedValue({
      items: [original],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.updateScheduleBlock.mockRejectedValue(
      new ApiError(409, "schedule_block.version_conflict", "Changed elsewhere.", null),
    );
    apiMocks.getScheduleBlock.mockResolvedValue(latest);

    render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

    const title = await screen.findByText("Original title");
    const blockButton = title.closest("button");
    if (blockButton === null) throw new Error("Calendar block button was not rendered.");
    await user.click(blockButton);
    const titleInput = screen.getByRole("textbox", { name: /^Title/ });
    await user.clear(titleInput);
    await user.type(titleInput, "Unsaved title");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(apiMocks.getScheduleBlock).toHaveBeenCalledWith(workspace.id, original.id),
    );
    expect(screen.getByRole("textbox", { name: /^Title/ })).toHaveValue(latest.title);
    expect(screen.getByRole("alert")).toHaveTextContent("The latest values from");
  });
});
