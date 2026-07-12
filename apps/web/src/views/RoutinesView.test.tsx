import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import type { Routine, Workspace } from "../types";
import { RoutinesView } from "./RoutinesView";

const apiMocks = vi.hoisted(() => ({
  createRoutine: vi.fn(),
  getRoutine: vi.fn(),
  listRoutineActivity: vi.fn(),
  listRoutines: vi.fn(),
  updateRoutine: vi.fn(),
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

const routine: Routine = {
  id: "routine-1",
  workspaceId: workspace.id,
  title: "Practice Spanish",
  description: "Conversation drills",
  status: "active",
  tags: {
    priority: "medium",
    effort: "medium",
    energy: "normal",
    preference: "enjoyable",
    contexts: ["home"],
    categories: ["learning"],
    freeForm: [],
  },
  duration: {
    minimumMinutes: 15,
    expectedMinutes: 30,
    maximumMinutes: 45,
    splittable: false,
    minimumSessionMinutes: 15,
    overheadMinutes: 0,
  },
  cadence: {
    period: "week",
    rollingIntervalDays: null,
    targetCompletions: 3,
    minimumCompletions: null,
    maximumCompletions: null,
    minimumSpacingDays: 1,
    preferredWeekdays: [],
    excludedWeekdays: [],
    discourageConsecutiveDays: true,
    prohibitConsecutiveDays: false,
    weekStartsOn: 1,
    startsOn: null,
    pausedUntil: null,
    endsOn: null,
  },
  version: 2,
  createdAt: "2026-07-12T09:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
};

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.listRoutines.mockResolvedValue({
    items: [routine],
    page: { limit: 200, offset: 0 },
  });
});

afterEach(cleanup);

describe("routine pool", () => {
  it("ignores a late routine response from the previously selected status", async () => {
    const user = userEvent.setup();
    const activeRequest = deferred<{
      items: readonly Routine[];
      page: { limit: number; offset: number };
    }>();
    const pausedRequest = deferred<{
      items: readonly Routine[];
      page: { limit: number; offset: number };
    }>();
    const pausedRoutine: Routine = {
      ...routine,
      id: "routine-paused",
      title: "Evening walk",
      status: "paused",
    };
    apiMocks.listRoutines.mockImplementation((_workspaceId: string, status: Routine["status"]) =>
      status === "paused" ? pausedRequest.promise : activeRequest.promise,
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    await waitFor(() =>
      expect(apiMocks.listRoutines).toHaveBeenCalledWith(
        workspace.id,
        "active",
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole("tab", { name: "Paused" }));
    await waitFor(() =>
      expect(apiMocks.listRoutines).toHaveBeenCalledWith(
        workspace.id,
        "paused",
        expect.any(AbortSignal),
      ),
    );

    await act(async () => {
      pausedRequest.resolve({ items: [pausedRoutine], page: { limit: 200, offset: 0 } });
      await pausedRequest.promise;
    });
    expect(await screen.findByText(pausedRoutine.title)).toBeInTheDocument();

    await act(async () => {
      activeRequest.resolve({ items: [routine], page: { limit: 200, offset: 0 } });
      await activeRequest.promise;
    });
    expect(screen.getByText(pausedRoutine.title)).toBeInTheDocument();
    expect(screen.queryByText(routine.title)).not.toBeInTheDocument();
  });

  it("creates a routine from the default duration and cadence policy", async () => {
    const user = userEvent.setup();
    const created = { ...routine, id: "routine-created", title: "Strength training", version: 1 };
    apiMocks.createRoutine.mockResolvedValue(created);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "New routine" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), created.title);
    await user.click(screen.getByRole("button", { name: "Create routine" }));

    await waitFor(() =>
      expect(apiMocks.createRoutine).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({
          title: created.title,
          duration: expect.objectContaining({ expectedMinutes: 30 }),
          cadence: expect.objectContaining({ period: "week", targetCompletions: 3 }),
        }),
      ),
    );
    expect(await screen.findByRole("heading", { name: created.title })).toBeInTheDocument();
  });

  it("loads immutable activity history for the selected routine", async () => {
    const user = userEvent.setup();
    apiMocks.listRoutineActivity.mockResolvedValue({
      items: [
        {
          id: "activity-1",
          routineId: routine.id,
          type: "completed",
          occurredAt: "2026-07-12T14:00:00.000Z",
          localDate: "2026-07-12",
          durationMinutes: 30,
          reason: null,
        },
      ],
      page: { limit: 20, nextCursor: null },
    });

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const routineTitle = await screen.findByText(routine.title);
    const routineButton = routineTitle.closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(screen.getByRole("button", { name: "Show history" }));

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("30m")).toBeInTheDocument();
  });

  it("reloads authoritative values instead of advancing a stale full draft", async () => {
    const user = userEvent.setup();
    const latest = { ...routine, title: "Spanish conversation", version: 3 };
    apiMocks.updateRoutine.mockRejectedValue(
      new ApiError(409, "routine.version_conflict", "Changed elsewhere.", null),
    );
    apiMocks.getRoutine.mockResolvedValue(latest);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const routineTitle = await screen.findByText("Practice Spanish");
    const routineButton = routineTitle.closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Unsaved local title");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiMocks.getRoutine).toHaveBeenCalledWith(workspace.id, routine.id));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(latest.title);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The latest values are loaded; your unsaved edits were not applied.",
    );
  });

  it("prevents status changes while a routine save is pending", async () => {
    const user = userEvent.setup();
    const save = deferred<Routine>();
    const created = { ...routine, id: "routine-created", title: "Strength training", version: 1 };
    apiMocks.createRoutine.mockReturnValue(save.promise);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "New routine" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), created.title);
    await user.click(screen.getByRole("button", { name: "Create routine" }));

    await waitFor(() => expect(apiMocks.createRoutine).toHaveBeenCalledOnce());
    expect(screen.getByRole("tab", { name: "Paused" })).toBeDisabled();

    await act(async () => {
      save.resolve(created);
      await save.promise;
    });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Paused" })).toBeEnabled());
  });

  it("supports arrow-key navigation across status tabs", async () => {
    const user = userEvent.setup();
    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const active = await screen.findByRole("tab", { name: "Active" });
    active.focus();
    await user.keyboard("{ArrowRight}");

    const paused = screen.getByRole("tab", { name: "Paused" });
    expect(paused).toHaveFocus();
    expect(paused).toHaveAttribute("aria-selected", "true");
  });
});
