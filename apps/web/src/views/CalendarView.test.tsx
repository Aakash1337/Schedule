import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserTimeZone, todayKey } from "../date";
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

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installNarrowCalendarLayout(): () => void {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
  const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  const offsetLeftDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      if (this.classList.contains("calendar-agenda")) return 320;
      if (this.hasAttribute("data-calendar-date")) return 150;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get() {
      return this.getAttribute("data-calendar-date") === todayKey() ? 600 : 0;
    },
  });

  return () => {
    if (clientWidthDescriptor === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    } else {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
    }
    if (offsetLeftDescriptor === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetLeft");
    } else {
      Object.defineProperty(HTMLElement.prototype, "offsetLeft", offsetLeftDescriptor);
    }
  };
}

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("calendar", () => {
  it("keeps empty-state guidance in view on narrow screens", async () => {
    const restoreLayout = installNarrowCalendarLayout();

    try {
      render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

      expect(await screen.findByText("This week is open")).toBeInTheDocument();
      const agenda = document.querySelector<HTMLElement>(".calendar-agenda");
      if (agenda === null) throw new Error("Calendar agenda was not rendered.");
      await waitFor(() => expect(agenda.scrollLeft).toBe(0));
    } finally {
      restoreLayout();
    }
  });

  it("preserves the narrow agenda position after creating a block", async () => {
    const user = userEvent.setup();
    const restoreLayout = installNarrowCalendarLayout();

    try {
      render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

      expect(await screen.findByText("This week is open")).toBeInTheDocument();
      const agenda = document.querySelector<HTMLElement>(".calendar-agenda");
      if (agenda === null) throw new Error("Calendar agenda was not rendered.");
      await waitFor(() => expect(agenda.scrollLeft).toBe(0));

      const target = screen
        .getAllByRole("button", { name: /Add a block on/ })
        .find(
          (button) =>
            button.closest<HTMLElement>("[data-calendar-date]")?.dataset.calendarDate !==
            todayKey(),
        );
      if (target === undefined) throw new Error("A non-today calendar day was not rendered.");

      agenda.scrollLeft = 240;
      await user.click(target);
      await user.type(screen.getByRole("textbox", { name: /^Title/ }), "Keep my place");
      await user.click(screen.getByRole("button", { name: "Create block" }));

      expect(await screen.findByText("Keep my place")).toBeInTheDocument();
      expect(agenda.scrollLeft).toBe(240);
    } finally {
      restoreLayout();
    }
  });

  it("ignores a late create response after the visible week changes", async () => {
    const user = userEvent.setup();
    const save = deferred<ScheduleBlock>();
    apiMocks.createScheduleBlock.mockReturnValue(save.promise);

    render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "New block" }));
    await user.type(screen.getByRole("textbox", { name: /^Title/ }), "Late block");
    await user.click(screen.getByRole("button", { name: "Create block" }));
    await waitFor(() => expect(apiMocks.createScheduleBlock).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(2));

    const startsAt = new Date();
    startsAt.setHours(9, 0, 0, 0);
    await act(async () => {
      save.resolve({
        id: "block-late",
        workspaceId: workspace.id,
        workItemId: null,
        title: "Late block",
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        timeZone: browserTimeZone(),
        version: 1,
        createdAt: startsAt.toISOString(),
        updatedAt: startsAt.toISOString(),
      });
      await save.promise;
    });

    expect(screen.getByRole("heading", { name: "Reserve time" })).toBeInTheDocument();
    expect(document.querySelectorAll(".calendar-block")).toHaveLength(0);
  });

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
    await user.type(screen.getByRole("textbox", { name: /^Title/ }), "Deep work 深度 🧭");
    await user.selectOptions(screen.getByRole("combobox", { name: "Linked work item" }), "item-1");
    await user.click(screen.getByRole("button", { name: "Create block" }));

    await waitFor(() =>
      expect(apiMocks.createScheduleBlock).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({
          title: "Deep work 深度 🧭",
          timeZone: browserTimeZone(),
          workItemId: "item-1",
        }),
      ),
    );
    expect(await screen.findByText("Deep work 深度 🧭")).toBeInTheDocument();
  });

  it("performs the explicit audited delete flow with the current version", async () => {
    const user = userEvent.setup();
    const restoreLayout = installNarrowCalendarLayout();
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
    const remainingBlock: ScheduleBlock = {
      ...block,
      id: "block-remaining",
      title: "Keep me",
      startsAt: new Date(startsAt.getTime() + 2 * 60 * 60_000).toISOString(),
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60_000).toISOString(),
    };
    apiMocks.listScheduleBlocks.mockResolvedValue({
      items: [block, remainingBlock],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.deleteScheduleBlock.mockResolvedValue(undefined);

    try {
      render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

      const title = await screen.findByText(block.title ?? "");
      const agenda = document.querySelector<HTMLElement>(".calendar-agenda");
      if (agenda === null) throw new Error("Calendar agenda was not rendered.");
      agenda.scrollLeft = 240;
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
      expect(screen.getByText(remainingBlock.title ?? "")).toBeInTheDocument();
      expect(agenda.scrollLeft).toBe(240);
    } finally {
      restoreLayout();
    }
  });

  it("ignores a late delete response after the visible week changes", async () => {
    const user = userEvent.setup();
    const deletion = deferred<void>();
    const startsAt = new Date();
    startsAt.setHours(13, 0, 0, 0);
    const block: ScheduleBlock = {
      id: "block-late-delete",
      workspaceId: workspace.id,
      workItemId: null,
      title: "Do not dismiss this editor",
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
      timeZone: browserTimeZone(),
      version: 4,
      createdAt: startsAt.toISOString(),
      updatedAt: startsAt.toISOString(),
    };
    apiMocks.listScheduleBlocks
      .mockResolvedValueOnce({ items: [block], page: { limit: 200, offset: 0 } })
      .mockResolvedValue({ items: [], page: { limit: 200, offset: 0 } });
    apiMocks.deleteScheduleBlock.mockReturnValue(deletion.promise);

    render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

    const title = await screen.findByText(block.title ?? "");
    const blockButton = title.closest("button");
    if (blockButton === null) throw new Error("Calendar block button was not rendered.");
    await user.click(blockButton);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(apiMocks.deleteScheduleBlock).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(2));
    await act(async () => {
      deletion.resolve(undefined);
      await deletion.promise;
    });

    expect(screen.getByRole("heading", { name: "Adjust this block" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
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

  it("does not reconcile a late update conflict into another week", async () => {
    const user = userEvent.setup();
    const update = deferred<ScheduleBlock>();
    const startsAt = new Date();
    startsAt.setHours(10, 0, 0, 0);
    const original: ScheduleBlock = {
      id: "block-stale-conflict",
      workspaceId: workspace.id,
      workItemId: null,
      title: "Original title",
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
      timeZone: browserTimeZone(),
      version: 2,
      createdAt: startsAt.toISOString(),
      updatedAt: startsAt.toISOString(),
    };
    apiMocks.listScheduleBlocks
      .mockResolvedValueOnce({ items: [original], page: { limit: 200, offset: 0 } })
      .mockResolvedValue({ items: [], page: { limit: 200, offset: 0 } });
    apiMocks.updateScheduleBlock.mockReturnValue(update.promise);

    render(<CalendarView workspace={workspace} onNavigate={vi.fn()} />);

    const title = await screen.findByText(original.title ?? "");
    const blockButton = title.closest("button");
    if (blockButton === null) throw new Error("Calendar block button was not rendered.");
    await user.click(blockButton);
    const titleInput = screen.getByRole("textbox", { name: /^Title/ });
    await user.clear(titleInput);
    await user.type(titleInput, "Unsaved title");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(apiMocks.updateScheduleBlock).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(2));
    await act(async () => {
      update.reject(
        new ApiError(409, "schedule_block.version_conflict", "Changed elsewhere.", null),
      );
      await update.promise.catch(() => undefined);
    });

    expect(apiMocks.getScheduleBlock).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: /^Title/ })).toHaveValue("Unsaved title");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});
