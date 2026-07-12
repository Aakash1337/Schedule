import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import type { WorkItem, Workspace } from "../types";
import { WorkView } from "./WorkView";

const apiMocks = vi.hoisted(() => ({
  createWorkItem: vi.fn(),
  listWorkItems: vi.fn(),
  updateWorkItem: vi.fn(),
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

const item: WorkItem = {
  id: "item-1",
  workspaceId: workspace.id,
  title: "Draft release notes",
  description: "Summarize the MVP.",
  status: "planned",
  priority: "high",
  version: 3,
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
  apiMocks.listWorkItems.mockResolvedValue({
    items: [item],
    page: { limit: 200, offset: 0 },
  });
});

afterEach(cleanup);

describe("work board", () => {
  it("refreshes the board instead of retrying a stale work-item version", async () => {
    const user = userEvent.setup();
    const latest = { ...item, status: "blocked" as const, version: 4 };
    apiMocks.listWorkItems
      .mockResolvedValueOnce({ items: [item], page: { limit: 200, offset: 0 } })
      .mockResolvedValueOnce({ items: [latest], page: { limit: 200, offset: 0 } });
    apiMocks.updateWorkItem.mockRejectedValue(
      new ApiError(409, "work_item.version_conflict", "Changed elsewhere.", null),
    );

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    await user.selectOptions(
      within(card).getByRole("combobox", { name: `Status for ${item.title}` }),
      "done",
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The board has been refreshed");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: `Status for ${item.title}` })).toHaveValue(
        latest.status,
      ),
    );
  });

  it("creates an item and advances its workflow status", async () => {
    const user = userEvent.setup();
    const created: WorkItem = {
      ...item,
      id: "item-created",
      title: "Ship MVP",
      description: null,
      status: "backlog",
      priority: "urgent",
      version: 1,
    };
    apiMocks.createWorkItem.mockResolvedValue(created);
    apiMocks.updateWorkItem.mockResolvedValue({ ...created, status: "done", version: 2 });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: item.title });
    await user.type(screen.getByRole("textbox", { name: "Title" }), created.title);
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority" }), "urgent");
    await user.click(screen.getByRole("button", { name: "Add item" }));

    const createdHeading = await screen.findByRole("heading", { name: created.title });
    const card = createdHeading.closest("article");
    if (card === null) throw new Error("Created work card was not rendered.");
    await user.selectOptions(
      within(card).getByRole("combobox", { name: `Status for ${created.title}` }),
      "done",
    );

    await waitFor(() =>
      expect(apiMocks.updateWorkItem).toHaveBeenCalledWith(workspace.id, created.id, {
        expectedVersion: created.version,
        status: "done",
      }),
    );
  });

  it("edits work-item title and description with the current version", async () => {
    const user = userEvent.setup();
    const updated = {
      ...item,
      title: "Publish release notes",
      description: "Summarize and publish the MVP.",
      version: 4,
    };
    apiMocks.updateWorkItem.mockResolvedValue(updated);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    await user.click(within(card).getByRole("button", { name: `Edit details for ${item.title}` }));

    const title = within(card).getByRole("textbox", { name: "Title" });
    const description = within(card).getByRole("textbox", { name: "Description (optional)" });
    await user.clear(title);
    await user.type(title, updated.title);
    await user.clear(description);
    await user.type(description, updated.description);
    await user.click(within(card).getByRole("button", { name: "Save details" }));

    await waitFor(() =>
      expect(apiMocks.updateWorkItem).toHaveBeenCalledWith(workspace.id, item.id, {
        expectedVersion: item.version,
        title: updated.title,
        description: updated.description,
      }),
    );
    expect(await screen.findByRole("heading", { name: updated.title })).toBeInTheDocument();
  });

  it("keeps the latest priority-filter response when an earlier response finishes late", async () => {
    const user = userEvent.setup();
    const all = deferred<{ items: readonly WorkItem[]; page: { limit: number; offset: number } }>();
    const urgent = deferred<{
      items: readonly WorkItem[];
      page: { limit: number; offset: number };
    }>();
    const urgentItem = {
      ...item,
      id: "item-urgent",
      title: "Respond to incident",
      priority: "urgent" as const,
    };
    apiMocks.listWorkItems.mockImplementation(
      (_workspaceId: string, filters: { priority?: string }) =>
        filters.priority === "urgent" ? urgent.promise : all.promise,
    );

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by priority" }),
      "urgent",
    );
    await waitFor(() =>
      expect(apiMocks.listWorkItems).toHaveBeenCalledWith(
        workspace.id,
        { priority: "urgent" },
        expect.any(AbortSignal),
      ),
    );

    await act(async () => {
      urgent.resolve({ items: [urgentItem], page: { limit: 200, offset: 0 } });
      await urgent.promise;
    });
    expect(await screen.findByRole("heading", { name: urgentItem.title })).toBeInTheDocument();

    await act(async () => {
      all.resolve({ items: [item], page: { limit: 200, offset: 0 } });
      await all.promise;
    });
    expect(screen.getByRole("heading", { name: urgentItem.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: item.title })).not.toBeInTheDocument();
  });

  it("removes an item that no longer matches the active priority filter", async () => {
    const user = userEvent.setup();
    const urgentItem = { ...item, priority: "urgent" as const };
    apiMocks.listWorkItems.mockImplementation(
      async (_workspaceId: string, filters: { priority?: string }) => ({
        items: filters.priority === "urgent" ? [urgentItem] : [item],
        page: { limit: 200, offset: 0 },
      }),
    );
    apiMocks.updateWorkItem.mockResolvedValue({ ...urgentItem, priority: "low", version: 4 });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by priority" }),
      "urgent",
    );
    const heading = await screen.findByRole("heading", { name: urgentItem.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    await user.selectOptions(
      within(card).getByRole("combobox", { name: `Priority for ${urgentItem.title}` }),
      "low",
    );

    await waitFor(() =>
      expect(apiMocks.updateWorkItem).toHaveBeenCalledWith(workspace.id, urgentItem.id, {
        expectedVersion: urgentItem.version,
        priority: "low",
      }),
    );
    expect(screen.queryByRole("heading", { name: urgentItem.title })).not.toBeInTheDocument();
    expect(screen.getByText("No matching work items")).toBeInTheDocument();
  });
});
