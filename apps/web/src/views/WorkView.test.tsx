import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import type {
  NaturalLanguageProposal,
  NaturalLanguageProposalResult,
  WorkItem,
  WorkItemDependency,
  Workspace,
} from "../types";
import { WorkView } from "./WorkView";

const apiMocks = vi.hoisted(() => ({
  addWorkItemPrerequisite: vi.fn(),
  cancelNaturalLanguageProposal: vi.fn(),
  confirmNaturalLanguageProposal: vi.fn(),
  createSubtask: vi.fn(),
  createWorkItem: vi.fn(),
  generateNaturalLanguageProposal: vi.fn(),
  listWorkItemDependencies: vi.fn(),
  listWorkItems: vi.fn(),
  removeWorkItemPrerequisite: vi.fn(),
  updateWorkItem: vi.fn(),
  updateNaturalLanguageProposal: vi.fn(),
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
  parentWorkItemId: null,
  title: "Draft release notes",
  description: "Summarize the MVP.",
  status: "planned",
  priority: "high",
  dueOn: null,
  planningDurationMinutes: null,
  version: 3,
  createdAt: "2026-07-12T09:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
};

function naturalLanguageProposal(title = "Prepare quarterly report"): NaturalLanguageProposal {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    requestId: "99999999-9999-4999-8999-999999999999",
    commandHash: "a".repeat(64),
    commandDisplay: JSON.stringify({ title, type: "work_item.create" }),
    command: { type: "work_item.create", title },
    provider: "ollama",
    model: "gemma4:e4b",
    status: "pending",
    expiresAt: "2026-07-14T10:10:00.000Z",
    version: 1,
  };
}

function naturalLanguageResult(
  proposal = naturalLanguageProposal(),
): NaturalLanguageProposalResult {
  return {
    version: "schedule.natural-language/v1",
    requestId: proposal.requestId,
    status: "proposal",
    reason: null,
    summary: "Review one concrete backlog title.",
    warnings: ["Nothing is created until you confirm."],
    proposal,
    provenance: {
      provider: "ollama",
      model: "gemma4:e4b",
      requestedAt: "2026-07-14T10:00:00.000Z",
      completedAt: "2026-07-14T10:00:01.000Z",
      latencyMs: 1_000,
    },
  };
}

function dependency(
  prerequisiteWorkItemId: string,
  dependentWorkItemId = item.id,
  workspaceId = workspace.id,
): WorkItemDependency {
  return {
    workspaceId,
    prerequisiteWorkItemId,
    dependentWorkItemId,
    createdAt: "2026-07-14T09:00:00.000Z",
  };
}

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
  apiMocks.listWorkItemDependencies.mockResolvedValue({
    items: [],
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

  it("prepares and cancels a local proposal without creating a work item", async () => {
    const user = userEvent.setup();
    const proposal = naturalLanguageProposal();
    apiMocks.generateNaturalLanguageProposal.mockResolvedValue(naturalLanguageResult(proposal));
    apiMocks.cancelNaturalLanguageProposal.mockResolvedValue({
      ...proposal,
      status: "cancelled",
      version: 2,
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: item.title });
    await user.click(screen.getByRole("button", { name: "Describe work" }));
    await user.type(
      screen.getByRole("textbox", { name: /^Describe one work item/ }),
      "Add prepare the quarterly report to my work list",
    );
    await user.click(screen.getByRole("button", { name: "Review proposal" }));

    expect(
      await screen.findByRole("heading", { name: "Create one backlog work item" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Confirming will atomically create this exact title in Backlog/),
    ).toBeInTheDocument();
    expect(apiMocks.generateNaturalLanguageProposal).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        version: "schedule.natural-language/v1",
        prompt: "Add prepare the quarterly report to my work list",
        requestId: expect.any(String),
      }),
      expect.any(AbortSignal),
    );
    expect(apiMocks.createWorkItem).not.toHaveBeenCalled();
    expect(apiMocks.confirmNaturalLanguageProposal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel proposal" }));
    expect(apiMocks.cancelNaturalLanguageProposal).toHaveBeenCalledWith(
      workspace.id,
      proposal.id,
      proposal.version,
      expect.any(AbortSignal),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Proposal cancelled. No work item was created.",
    );
    expect(apiMocks.createWorkItem).not.toHaveBeenCalled();
  });

  it("persists an edited proposal, confirms explicitly, and focuses the created backlog card", async () => {
    const user = userEvent.setup();
    const proposal = naturalLanguageProposal();
    const edited = {
      ...proposal,
      command: { ...proposal.command, title: "Prepare final quarterly report" },
      version: 2,
    };
    const created: WorkItem = {
      ...item,
      id: proposal.id,
      title: edited.command.title,
      description: null,
      status: "backlog",
      priority: "none",
      planningDurationMinutes: null,
      version: 1,
    };
    apiMocks.generateNaturalLanguageProposal.mockResolvedValue(naturalLanguageResult(proposal));
    apiMocks.updateNaturalLanguageProposal.mockResolvedValue(edited);
    apiMocks.confirmNaturalLanguageProposal.mockResolvedValue({
      proposalId: proposal.id,
      commandHash: edited.commandHash,
      replayed: false,
      workItem: created,
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: item.title });
    await user.click(screen.getByRole("button", { name: "Describe work" }));
    await user.type(
      screen.getByRole("textbox", { name: /^Describe one work item/ }),
      "Prepare a quarterly report",
    );
    await user.click(screen.getByRole("button", { name: "Review proposal" }));
    const title = await screen.findByRole("textbox", { name: /^Work item title/ });
    await user.clear(title);
    await user.type(title, edited.command.title);
    await user.click(screen.getByRole("button", { name: "Create this work item" }));

    expect(apiMocks.updateNaturalLanguageProposal).toHaveBeenCalledWith(
      workspace.id,
      proposal.id,
      { expectedVersion: 1, title: edited.command.title },
      expect.any(AbortSignal),
    );
    expect(apiMocks.confirmNaturalLanguageProposal).toHaveBeenCalledWith(
      workspace.id,
      proposal.id,
      edited.version,
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(apiMocks.createWorkItem).not.toHaveBeenCalled();
    const createdHeading = await screen.findByRole("heading", { name: created.title });
    const card = createdHeading.closest("article");
    if (card === null) throw new Error("Confirmed work card was not rendered.");
    await waitFor(() => expect(card).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("was created in Backlog");
  });

  it("does not insert a confirmed proposal into a priority filter selected in flight", async () => {
    const user = userEvent.setup();
    const proposal = naturalLanguageProposal();
    const confirmation = deferred<{
      proposalId: string;
      commandHash: string;
      replayed: boolean;
      workItem: WorkItem;
    }>();
    const created: WorkItem = {
      ...item,
      id: proposal.id,
      title: proposal.command.title,
      status: "backlog",
      priority: "none",
      version: 1,
    };
    const filteredItem: WorkItem = {
      ...item,
      id: "item-filtered-high",
      title: "Review incident report",
    };
    apiMocks.generateNaturalLanguageProposal.mockResolvedValue(naturalLanguageResult(proposal));
    apiMocks.confirmNaturalLanguageProposal.mockReturnValue(confirmation.promise);
    apiMocks.listWorkItems.mockImplementation(
      async (_workspaceId: string, filters: { priority?: string }) => ({
        items: filters.priority === "high" ? [filteredItem] : [item],
        page: { limit: 200, offset: 0 },
      }),
    );

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: item.title });
    await user.click(screen.getByRole("button", { name: "Describe work" }));
    await user.type(screen.getByRole("textbox", { name: /^Describe one work item/ }), "Report");
    await user.click(screen.getByRole("button", { name: "Review proposal" }));
    await user.click(await screen.findByRole("button", { name: "Create this work item" }));
    await waitFor(() => expect(apiMocks.confirmNaturalLanguageProposal).toHaveBeenCalledOnce());

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by priority" }), "high");
    await waitFor(() =>
      expect(apiMocks.listWorkItems).toHaveBeenCalledWith(
        workspace.id,
        { priority: "high" },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByRole("heading", { name: filteredItem.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: item.title })).not.toBeInTheDocument();

    await act(async () => {
      confirmation.resolve({
        proposalId: proposal.id,
        commandHash: proposal.commandHash,
        replayed: false,
        workItem: created,
      });
      await confirmation.promise;
    });

    expect(screen.getByRole("combobox", { name: "Filter by priority" })).toHaveValue("high");
    expect(screen.getByRole("heading", { name: filteredItem.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: created.title })).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("was created in Backlog");
  });

  it("reuses the same confirmation key after an ambiguous failure", async () => {
    const user = userEvent.setup();
    const proposal = naturalLanguageProposal();
    const created: WorkItem = {
      ...item,
      id: proposal.id,
      title: proposal.command.title,
      status: "backlog",
      priority: "none",
      version: 1,
    };
    apiMocks.generateNaturalLanguageProposal.mockResolvedValue(naturalLanguageResult(proposal));
    apiMocks.confirmNaturalLanguageProposal
      .mockRejectedValueOnce(new Error("The connection closed before the result arrived."))
      .mockResolvedValueOnce({
        proposalId: proposal.id,
        commandHash: proposal.commandHash,
        replayed: true,
        workItem: created,
      });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: item.title });
    await user.click(screen.getByRole("button", { name: "Describe work" }));
    await user.type(screen.getByRole("textbox", { name: /^Describe one work item/ }), "Report");
    await user.click(screen.getByRole("button", { name: "Review proposal" }));
    await user.click(await screen.findByRole("button", { name: "Create this work item" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("same confirmation key");
    await user.click(screen.getByRole("button", { name: "Create this work item" }));

    await screen.findByRole("heading", { name: created.title });
    const firstKey = apiMocks.confirmNaturalLanguageProposal.mock.calls[0]?.[3];
    const secondKey = apiMocks.confirmNaturalLanguageProposal.mock.calls[1]?.[3];
    expect(firstKey).toEqual(expect.any(String));
    expect(secondKey).toBe(firstKey);
    expect(apiMocks.confirmNaturalLanguageProposal).toHaveBeenCalledTimes(2);
  });

  it("aborts and discards proposal work when the workspace changes", async () => {
    const user = userEvent.setup();
    const pending = deferred<NaturalLanguageProposalResult>();
    let requestSignal: AbortSignal | undefined;
    apiMocks.generateNaturalLanguageProposal.mockImplementation(
      (_workspaceId: string, _input: unknown, signal: AbortSignal) => {
        requestSignal = signal;
        return pending.promise;
      },
    );
    const nextWorkspace: Workspace = { ...workspace, id: "workspace-2", name: "Other" };

    const { rerender } = render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: item.title });
    await user.click(screen.getByRole("button", { name: "Describe work" }));
    await user.type(screen.getByRole("textbox", { name: /^Describe one work item/ }), "Old work");
    await user.click(screen.getByRole("button", { name: "Review proposal" }));
    await waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));

    rerender(<WorkView workspace={nextWorkspace} onNavigate={vi.fn()} />);
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await act(async () => {
      pending.resolve(naturalLanguageResult(naturalLanguageProposal("Stale old-workspace task")));
      await pending.promise;
    });
    expect(screen.queryByRole("heading", { name: "Describe work in your own words" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Stale old-workspace task" })).toBeNull();
  });

  it("opts a one-time item into Today with an explicit duration", async () => {
    const user = userEvent.setup();
    const created: WorkItem = {
      ...item,
      id: "item-plannable",
      title: "Prepare the demo",
      planningDurationMinutes: 75,
      version: 1,
    };
    apiMocks.createWorkItem.mockResolvedValue(created);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: item.title });
    await user.type(screen.getByRole("textbox", { name: "Title" }), created.title);
    await user.click(screen.getByRole("checkbox", { name: "Include in Today" }));
    const duration = screen.getByRole("spinbutton", { name: "Plan duration (minutes)" });
    expect(duration).toHaveAttribute("aria-describedby", "work-planning-duration-hint");
    expect(document.getElementById("work-planning-duration-hint")).toHaveTextContent(
      "The planner reserves this many minutes",
    );
    await user.clear(duration);
    await user.type(duration, "75");
    await user.click(screen.getByRole("button", { name: "Add item" }));

    await waitFor(() =>
      expect(apiMocks.createWorkItem).toHaveBeenCalledWith(workspace.id, {
        title: created.title,
        description: null,
        status: "backlog",
        priority: "none",
        dueOn: null,
        planningDurationMinutes: 75,
      }),
    );
    expect(await screen.findByLabelText("Included in daily plan")).toHaveTextContent(
      "Today · 75 min",
    );
  });

  it("creates a work item with an optional local due date", async () => {
    const user = userEvent.setup();
    const created = { ...item, id: "item-due", title: "File the report", dueOn: "2026-07-20" };
    apiMocks.createWorkItem.mockResolvedValue(created);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: item.title });
    await user.type(screen.getByRole("textbox", { name: "Title" }), created.title);
    const dueDate = screen.getByLabelText(/Due date/);
    expect(screen.getByText("Leave blank when this work has no deadline.")).toBeInTheDocument();
    fireEvent.change(dueDate, { target: { value: "2026-07-20" } });
    await user.click(screen.getByRole("button", { name: "Add item" }));

    await waitFor(() =>
      expect(apiMocks.createWorkItem).toHaveBeenCalledWith(workspace.id, {
        title: created.title,
        description: null,
        status: "backlog",
        priority: "none",
        dueOn: "2026-07-20",
        planningDurationMinutes: null,
      }),
    );
    expect(await screen.findByLabelText("Due 2026-07-20")).toHaveTextContent("Due Jul 20, 2026");
  });

  it("shows hierarchy context and creates a subtask under the selected parent", async () => {
    const user = userEvent.setup();
    const parent: WorkItem = {
      ...item,
      id: "parent-1",
      title: "Ship the release",
      planningDurationMinutes: 90,
    };
    const completedChild: WorkItem = {
      ...item,
      id: "child-1",
      parentWorkItemId: parent.id,
      title: "Draft screenshots",
      status: "done",
      version: 1,
    };
    const createdChild: WorkItem = {
      ...item,
      id: "child-2",
      parentWorkItemId: parent.id,
      title: "Check release links",
      description: null,
      status: "backlog",
      priority: "none",
      planningDurationMinutes: null,
      version: 1,
    };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [parent, completedChild],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.createSubtask.mockResolvedValue(createdChild);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const parentHeading = await screen.findByRole("heading", { name: parent.title });
    const parentCard = parentHeading.closest("article");
    if (parentCard === null) throw new Error("Parent work card was not rendered.");
    expect(within(parentCard).getByLabelText(/Parent container/)).toHaveTextContent(
      "Parent · not in Today",
    );
    expect(within(parentCard).getByText("1/1 subtasks done")).toBeInTheDocument();
    expect(
      within(parentCard).getByRole("button", { name: /^Draft screenshots/ }),
    ).toHaveTextContent("Done");
    await user.click(
      within(parentCard).getByRole("button", { name: `Edit details for ${parent.title}` }),
    );
    expect(
      within(parentCard).getByRole("checkbox", { name: "Eligible for Today when leaf" }),
    ).toBeDisabled();
    expect(
      within(parentCard).getByRole("spinbutton", { name: "Plan duration (minutes)" }),
    ).toBeDisabled();
    expect(within(parentCard).getByText(/Saved at 90 minutes, but dormant/)).toBeInTheDocument();
    await user.click(within(parentCard).getByRole("button", { name: "Cancel" }));

    const childHeading = screen.getByRole("heading", { name: completedChild.title });
    const childCard = childHeading.closest("article");
    if (childCard === null) throw new Error("Child work card was not rendered.");
    expect(within(childCard).getByText(/Subtask of/)).toHaveTextContent(parent.title);

    await user.click(
      within(parentCard).getByRole("button", { name: `Add subtask to ${parent.title}` }),
    );
    expect(screen.getByRole("heading", { name: "Add a subtask" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(`Subtask of ${parent.title}`);
    await user.type(screen.getByRole("textbox", { name: "Title" }), createdChild.title);
    await user.click(screen.getByRole("button", { name: "Add subtask" }));

    await waitFor(() =>
      expect(apiMocks.createSubtask).toHaveBeenCalledWith(workspace.id, parent.id, {
        title: createdChild.title,
        description: null,
        status: "backlog",
        priority: "none",
        dueOn: null,
        planningDurationMinutes: null,
      }),
    );
    expect(apiMocks.createWorkItem).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: createdChild.title })).toBeInTheDocument();
    expect(within(parentCard).getByText("1/2 subtasks done")).toBeInTheDocument();
  });

  it("detaches and reparents a subtask without changing either parent's version", async () => {
    const user = userEvent.setup();
    const firstParent: WorkItem = { ...item, id: "parent-1", title: "First parent", version: 5 };
    const secondParent: WorkItem = { ...item, id: "parent-2", title: "Second parent", version: 8 };
    const child: WorkItem = {
      ...item,
      id: "child-1",
      parentWorkItemId: firstParent.id,
      title: "Movable child",
      version: 2,
    };
    const detached: WorkItem = { ...child, parentWorkItemId: null, version: 3 };
    const reparented: WorkItem = { ...detached, parentWorkItemId: secondParent.id, version: 4 };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [firstParent, secondParent, child],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.updateWorkItem.mockResolvedValueOnce(detached).mockResolvedValueOnce(reparented);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const childHeading = await screen.findByRole("heading", { name: child.title });
    const childCard = childHeading.closest("article");
    if (childCard === null) throw new Error("Child work card was not rendered.");
    await user.click(
      within(childCard).getByRole("button", { name: `Edit details for ${child.title}` }),
    );
    await user.selectOptions(within(childCard).getByRole("combobox", { name: /Parent item/ }), "");
    await user.click(within(childCard).getByRole("button", { name: "Save details" }));

    await waitFor(() =>
      expect(apiMocks.updateWorkItem).toHaveBeenNthCalledWith(1, workspace.id, child.id, {
        expectedVersion: child.version,
        parentWorkItemId: null,
        title: child.title,
        description: child.description,
        dueOn: null,
        planningDurationMinutes: null,
      }),
    );
    expect(within(childCard).getByText("Top-level item")).toBeInTheDocument();

    await user.click(
      within(childCard).getByRole("button", { name: `Edit details for ${child.title}` }),
    );
    await user.selectOptions(
      within(childCard).getByRole("combobox", { name: /Parent item/ }),
      secondParent.id,
    );
    await user.click(within(childCard).getByRole("button", { name: "Save details" }));

    await waitFor(() =>
      expect(apiMocks.updateWorkItem).toHaveBeenNthCalledWith(2, workspace.id, child.id, {
        expectedVersion: detached.version,
        parentWorkItemId: secondParent.id,
        title: child.title,
        description: child.description,
        dueOn: null,
        planningDurationMinutes: null,
      }),
    );
    expect(within(childCard).getByText(/Subtask of/)).toHaveTextContent(secondParent.title);
    expect(firstParent.version).toBe(5);
    expect(secondParent.version).toBe(8);
  });

  it("keeps the hierarchy draft open when the server rejects a cycle", async () => {
    const user = userEvent.setup();
    const parent: WorkItem = { ...item, id: "parent-1", title: "Parent" };
    const child: WorkItem = {
      ...item,
      id: "child-1",
      parentWorkItemId: parent.id,
      title: "Child",
      version: 1,
    };
    const staleCandidate: WorkItem = {
      ...item,
      id: "candidate-1",
      title: "Candidate with a stale relationship",
      version: 1,
    };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [parent, child, staleCandidate],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.updateWorkItem.mockRejectedValue(
      new ApiError(
        409,
        "work_item_hierarchy.cycle_conflict",
        "The proposed parent would create a cycle.",
        null,
      ),
    );

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const parentHeading = await screen.findByRole("heading", { name: parent.title });
    const parentCard = parentHeading.closest("article");
    if (parentCard === null) throw new Error("Parent work card was not rendered.");
    const loadCount = apiMocks.listWorkItems.mock.calls.length;
    await user.click(
      within(parentCard).getByRole("button", { name: `Edit details for ${parent.title}` }),
    );
    await user.selectOptions(
      within(parentCard).getByRole("combobox", { name: /Parent item/ }),
      staleCandidate.id,
    );
    await user.click(within(parentCard).getByRole("button", { name: "Save details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That parent would create a cycle. Choose an item outside this subtask branch.",
    );
    expect(within(parentCard).getByRole("combobox", { name: /Parent item/ })).toHaveValue(
      staleCandidate.id,
    );
    expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(loadCount);
  });

  it("removes every descendant from the parent selector at arbitrary depth", async () => {
    const user = userEvent.setup();
    const parent: WorkItem = { ...item, id: "parent-1", title: "Parent" };
    const child: WorkItem = {
      ...item,
      id: "child-1",
      parentWorkItemId: parent.id,
      title: "Child",
    };
    const grandchild: WorkItem = {
      ...item,
      id: "grandchild-1",
      parentWorkItemId: child.id,
      title: "Grandchild",
    };
    const validParent: WorkItem = { ...item, id: "valid-1", title: "Separate branch" };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [parent, child, grandchild, validParent],
      page: { limit: 200, offset: 0 },
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const parentHeading = await screen.findByRole("heading", { name: parent.title });
    const parentCard = parentHeading.closest("article");
    if (parentCard === null) throw new Error("Parent work card was not rendered.");
    await user.click(
      within(parentCard).getByRole("button", { name: `Edit details for ${parent.title}` }),
    );
    const select = within(parentCard).getByRole("combobox", { name: /Parent item/ });
    const options = Array.from((select as HTMLSelectElement).options).map((option) => option.value);
    expect(options).toContain(validParent.id);
    expect(options).not.toContain(child.id);
    expect(options).not.toContain(grandchild.id);
  });

  it("reveals every overflow subtask after clearing an active priority filter", async () => {
    const user = userEvent.setup();
    const parent: WorkItem = {
      ...item,
      id: "parent-1",
      title: "Urgent parent",
      priority: "urgent",
    };
    const children = Array.from({ length: 4 }, (_, index): WorkItem => ({
      ...item,
      id: `child-${index + 1}`,
      parentWorkItemId: parent.id,
      title: `Low priority child ${index + 1}`,
      priority: "low",
      version: 1,
    }));
    const overflowChild = children[3];
    if (overflowChild === undefined) throw new Error("Overflow child fixture is missing.");
    const allItems = [parent, ...children];
    apiMocks.listWorkItems.mockImplementation(
      async (_workspaceId: string, filters: { priority?: string }) => ({
        items: filters.priority === "urgent" ? [parent] : allItems,
        page: { limit: 200, offset: 0 },
      }),
    );

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: parent.title });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by priority" }),
      "urgent",
    );
    const parentCard = screen.getByRole("heading", { name: parent.title }).closest("article");
    if (parentCard === null) throw new Error("Parent work card was not rendered.");
    expect(screen.queryByRole("heading", { name: overflowChild.title })).not.toBeInTheDocument();
    await user.click(within(parentCard).getByText("Show 1 more subtask"));
    await user.click(within(parentCard).getByRole("button", { name: /^Low priority child 4/ }));

    const revealedHeading = await screen.findByRole("heading", { name: overflowChild.title });
    const revealedCard = revealedHeading.closest("article");
    if (revealedCard === null) throw new Error("Revealed child work card was not rendered.");
    await waitFor(() => expect(revealedCard).toHaveFocus());
    expect(screen.getByRole("combobox", { name: "Filter by priority" })).toHaveValue("");
  });

  it("can remove an item from Today's candidate pool while editing details", async () => {
    const user = userEvent.setup();
    const plannable = { ...item, planningDurationMinutes: 45 };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [plannable],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.updateWorkItem.mockResolvedValue({
      ...plannable,
      planningDurationMinutes: null,
      version: 4,
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", { name: plannable.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    await user.click(
      within(card).getByRole("button", { name: `Edit details for ${plannable.title}` }),
    );
    const duration = within(card).getByRole("spinbutton", { name: "Plan duration (minutes)" });
    expect(duration).toHaveAttribute(
      "aria-describedby",
      `work-card-planning-duration-${plannable.id}-hint`,
    );
    expect(
      document.getElementById(`work-card-planning-duration-${plannable.id}-hint`),
    ).toHaveTextContent("The planner reserves this many minutes");
    await user.click(within(card).getByRole("checkbox", { name: "Include in Today" }));
    await user.click(within(card).getByRole("button", { name: "Save details" }));

    await waitFor(() =>
      expect(apiMocks.updateWorkItem).toHaveBeenCalledWith(workspace.id, plannable.id, {
        expectedVersion: plannable.version,
        parentWorkItemId: null,
        title: plannable.title,
        description: plannable.description,
        dueOn: null,
        planningDurationMinutes: null,
      }),
    );
    expect(screen.queryByLabelText("Included in daily plan")).not.toBeInTheDocument();
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
        parentWorkItemId: null,
        title: updated.title,
        description: updated.description,
        dueOn: null,
        planningDurationMinutes: null,
      }),
    );
    expect(await screen.findByRole("heading", { name: updated.title })).toBeInTheDocument();
  });

  it("edits and clears an optional due date without discarding the details draft", async () => {
    const user = userEvent.setup();
    const dated = { ...item, dueOn: "2026-07-20" };
    const cleared = { ...dated, dueOn: null, version: 4 };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [dated],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.updateWorkItem.mockResolvedValue(cleared);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", { name: dated.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    expect(within(card).getByLabelText("Due 2026-07-20")).toHaveTextContent("Due Jul 20, 2026");
    await user.click(within(card).getByRole("button", { name: `Edit details for ${dated.title}` }));
    const dueDate = within(card).getByLabelText(/Due date/);
    expect(dueDate).toHaveValue("2026-07-20");
    await user.clear(dueDate);
    await user.click(within(card).getByRole("button", { name: "Save details" }));

    await waitFor(() =>
      expect(apiMocks.updateWorkItem).toHaveBeenCalledWith(workspace.id, dated.id, {
        expectedVersion: dated.version,
        parentWorkItemId: null,
        title: dated.title,
        description: dated.description,
        dueOn: null,
        planningDurationMinutes: null,
      }),
    );
    expect(screen.queryByLabelText("Due 2026-07-20")).not.toBeInTheDocument();
  });

  it("preserves a due-date draft when a details save fails", async () => {
    const user = userEvent.setup();
    apiMocks.updateWorkItem.mockRejectedValue(new Error("Network unavailable."));

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    await user.click(within(card).getByRole("button", { name: `Edit details for ${item.title}` }));
    const dueDate = within(card).getByLabelText(/Due date/);
    fireEvent.change(dueDate, { target: { value: "2026-07-20" } });
    await user.click(within(card).getByRole("button", { name: "Save details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable.");
    expect(within(card).getByLabelText(/Due date/)).toHaveValue("2026-07-20");
  });

  it("keeps the latest priority-filter response when an earlier response finishes late", async () => {
    const user = userEvent.setup();
    const initialAll = deferred<{
      items: readonly WorkItem[];
      page: { limit: number; offset: number };
    }>();
    const filteredCatalog = deferred<{
      items: readonly WorkItem[];
      page: { limit: number; offset: number };
    }>();
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
    let unfilteredRequestCount = 0;
    apiMocks.listWorkItems.mockImplementation(
      (_workspaceId: string, filters: { priority?: string }) =>
        filters.priority === "urgent"
          ? urgent.promise
          : unfilteredRequestCount++ === 0
            ? initialAll.promise
            : filteredCatalog.promise,
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
      filteredCatalog.resolve({
        items: [item, urgentItem],
        page: { limit: 200, offset: 0 },
      });
      await Promise.all([urgent.promise, filteredCatalog.promise]);
    });
    expect(await screen.findByRole("heading", { name: urgentItem.title })).toBeInTheDocument();

    await act(async () => {
      initialAll.resolve({ items: [item], page: { limit: 200, offset: 0 } });
      await initialAll.promise;
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

  it("loads prerequisite titles and statuses with a correctly bounded candidate list", async () => {
    const user = userEvent.setup();
    const completedPrerequisite: WorkItem = {
      ...item,
      id: "item-complete",
      title: "Approve final copy",
      status: "done",
      version: 2,
    };
    const candidate: WorkItem = {
      ...item,
      id: "item-candidate",
      title: "Review screenshots",
      status: "backlog",
      version: 1,
    };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [item, completedPrerequisite, candidate],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.listWorkItemDependencies.mockResolvedValue({
      items: [dependency(completedPrerequisite.id)],
      page: { limit: 200, offset: 0 },
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    const prerequisites = within(card).getByRole("region", { name: "Prerequisites" });

    expect(within(prerequisites).getByText("1/1 done")).toBeVisible();
    expect(within(prerequisites).getByText(completedPrerequisite.title)).toBeVisible();
    expect(
      within(prerequisites).getByLabelText(`${completedPrerequisite.title} status: Done`),
    ).toHaveTextContent("Done");
    expect(
      within(prerequisites).getByText(/Today waits until every prerequisite is Done/),
    ).toBeVisible();

    await user.click(within(card).getByLabelText(`Manage prerequisites for ${item.title}`));
    const select = within(card).getByRole("combobox", {
      name: `Add prerequisite to ${item.title}`,
    });
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual(
      ["", candidate.id],
    );
    expect(
      within(card).getByRole("button", { name: `Add selected prerequisite to ${item.title}` }),
    ).toBeDisabled();
  });

  it("keeps only one progressive prerequisite editor open", async () => {
    const user = userEvent.setup();
    const secondItem: WorkItem = {
      ...item,
      id: "item-second",
      title: "Publish the summary",
    };
    const candidate: WorkItem = {
      ...item,
      id: "item-candidate",
      title: "Review screenshots",
    };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [item, secondItem, candidate],
      page: { limit: 200, offset: 0 },
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const firstHeading = await screen.findByRole("heading", { name: item.title });
    const secondHeading = screen.getByRole("heading", { name: secondItem.title });
    const firstCard = firstHeading.closest("article");
    const secondCard = secondHeading.closest("article");
    if (firstCard === null || secondCard === null) {
      throw new Error("Expected both work cards to be rendered.");
    }

    const firstSummary = within(firstCard).getByLabelText(`Manage prerequisites for ${item.title}`);
    const secondSummary = within(secondCard).getByLabelText(
      `Manage prerequisites for ${secondItem.title}`,
    );
    expect(firstSummary).toHaveAttribute("aria-expanded", "false");
    expect(firstSummary.querySelector(".work-dependency-chevron")).toHaveAttribute(
      "data-state",
      "closed",
    );

    await user.click(firstSummary);
    expect(firstSummary).toHaveAttribute("aria-expanded", "true");
    expect(firstSummary.querySelector(".work-dependency-chevron")).toHaveAttribute(
      "data-state",
      "open",
    );
    expect(
      within(firstCard).getByRole("combobox", { name: `Add prerequisite to ${item.title}` }),
    ).toBeVisible();

    await user.click(secondSummary);

    await waitFor(() =>
      expect(
        within(firstCard).queryByRole("combobox", {
          name: `Add prerequisite to ${item.title}`,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(secondCard).getByRole("combobox", {
        name: `Add prerequisite to ${secondItem.title}`,
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("combobox", { name: /Add prerequisite to/ })).toHaveLength(1);
    expect(firstSummary).toHaveAttribute("aria-expanded", "false");
    expect(secondSummary).toHaveAttribute("aria-expanded", "true");
  });

  it("adds a prerequisite inline, exposes an unsuppressed live pending state, and never changes status", async () => {
    const user = userEvent.setup();
    const prerequisite: WorkItem = {
      ...item,
      id: "item-prerequisite",
      title: "Collect approvals",
      status: "in_progress",
      version: 1,
    };
    const otherCandidate: WorkItem = {
      ...item,
      id: "item-other",
      title: "Prepare appendix",
      status: "backlog",
      version: 1,
    };
    const addRequest = deferred<WorkItemDependency>();
    apiMocks.listWorkItems.mockResolvedValue({
      items: [item, prerequisite, otherCandidate],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.addWorkItemPrerequisite.mockReturnValue(addRequest.promise);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    await user.click(within(card).getByLabelText(`Manage prerequisites for ${item.title}`));
    const select = within(card).getByRole("combobox", {
      name: `Add prerequisite to ${item.title}`,
    });
    await user.selectOptions(select, prerequisite.id);
    await user.click(
      within(card).getByRole("button", { name: `Add selected prerequisite to ${item.title}` }),
    );

    expect(card).not.toHaveAttribute("aria-busy", "true");
    const pendingStatus = within(card).getByRole("status");
    expect(pendingStatus).toHaveTextContent("Saving prerequisite change");
    expect(pendingStatus).toHaveAttribute("aria-live", "polite");
    expect(pendingStatus.closest('[aria-busy="true"]')).toBeNull();
    expect(select).toBeDisabled();
    expect(apiMocks.addWorkItemPrerequisite).toHaveBeenCalledWith(
      workspace.id,
      item.id,
      prerequisite.id,
    );
    expect(apiMocks.updateWorkItem).not.toHaveBeenCalled();

    await act(async () => {
      addRequest.resolve(dependency(prerequisite.id));
      await addRequest.promise;
    });

    expect(within(card).getByText(prerequisite.title)).toBeVisible();
    expect(within(card).getByText("0/1 done")).toBeVisible();
    expect(within(card).getByText(/status was not changed/)).toHaveAttribute("role", "status");
    await waitFor(() => expect(select).toHaveFocus());
    expect(within(card).getByRole("combobox", { name: `Status for ${item.title}` })).toHaveValue(
      item.status,
    );
  });

  it("removes a prerequisite inline and restores focus to the progressive editor", async () => {
    const user = userEvent.setup();
    const prerequisite: WorkItem = {
      ...item,
      id: "item-prerequisite",
      title: "Collect approvals",
      status: "done",
      version: 1,
    };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [item, prerequisite],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.listWorkItemDependencies.mockResolvedValue({
      items: [dependency(prerequisite.id)],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.removeWorkItemPrerequisite.mockResolvedValue(undefined);

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    const summary = within(card).getByLabelText(`Manage prerequisites for ${item.title}`);
    await user.click(
      within(card).getByRole("button", {
        name: `Remove ${prerequisite.title} as a prerequisite for ${item.title}`,
      }),
    );

    expect(apiMocks.removeWorkItemPrerequisite).toHaveBeenCalledWith(
      workspace.id,
      item.id,
      prerequisite.id,
    );
    expect(within(card).getByText("No prerequisites linked.")).toBeVisible();
    expect(
      within(card).queryByRole("button", {
        name: `Remove ${prerequisite.title} as a prerequisite for ${item.title}`,
      }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(summary).toHaveFocus());
    expect(apiMocks.updateWorkItem).not.toHaveBeenCalled();
  });

  it("keeps a selected candidate and current status when the server rejects a cycle", async () => {
    const user = userEvent.setup();
    const prerequisite: WorkItem = {
      ...item,
      id: "item-prerequisite",
      title: "Collect approvals",
      status: "backlog",
      version: 1,
    };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [item, prerequisite],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.addWorkItemPrerequisite.mockRejectedValue(
      new ApiError(
        409,
        "work_item_dependency.cycle_conflict",
        "The dependency would create a cycle.",
        null,
      ),
    );

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");
    await user.click(within(card).getByLabelText(`Manage prerequisites for ${item.title}`));
    const select = within(card).getByRole("combobox", {
      name: `Add prerequisite to ${item.title}`,
    });
    await user.selectOptions(select, prerequisite.id);
    await user.click(
      within(card).getByRole("button", { name: `Add selected prerequisite to ${item.title}` }),
    );

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "That prerequisite would create a cycle",
    );
    expect(select).toHaveValue(prerequisite.id);
    expect(within(card).getByRole("combobox", { name: `Status for ${item.title}` })).toHaveValue(
      item.status,
    );
    expect(within(card).getByText("No prerequisites linked.")).toBeVisible();
    expect(apiMocks.updateWorkItem).not.toHaveBeenCalled();
  });

  it("resolves prerequisite titles outside the active priority filter", async () => {
    const user = userEvent.setup();
    const dependent: WorkItem = {
      ...item,
      id: "item-urgent",
      title: "Publish release",
      priority: "urgent",
    };
    const hiddenPrerequisite: WorkItem = {
      ...item,
      id: "item-low",
      title: "Verify changelog",
      priority: "low",
      status: "done",
    };
    apiMocks.listWorkItems.mockImplementation(
      async (_workspaceId: string, filters: { priority?: WorkItem["priority"] }) => ({
        items: filters.priority === "urgent" ? [dependent] : [dependent, hiddenPrerequisite],
        page: { limit: 200, offset: 0 },
      }),
    );
    apiMocks.listWorkItemDependencies.mockResolvedValue({
      items: [dependency(hiddenPrerequisite.id, dependent.id)],
      page: { limit: 200, offset: 0 },
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: dependent.title });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by priority" }),
      "urgent",
    );

    const heading = await screen.findByRole("heading", { name: dependent.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Filtered work card was not rendered.");
    expect(within(card).getByText(hiddenPrerequisite.title)).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: hiddenPrerequisite.title }),
    ).not.toBeInTheDocument();
    expect(apiMocks.listWorkItems).toHaveBeenCalledWith(workspace.id, {}, expect.any(AbortSignal));
    expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(2);
    expect(apiMocks.listWorkItemDependencies).toHaveBeenCalledTimes(1);
  });

  it("merges fresh filtered records into cached prerequisite status data", async () => {
    const user = userEvent.setup();
    const dependent: WorkItem = {
      ...item,
      id: "item-dependent",
      title: "Publish the release",
      priority: "urgent",
    };
    const stalePrerequisite: WorkItem = {
      ...item,
      id: "item-prerequisite",
      title: "Approve final copy",
      priority: "urgent",
      status: "in_progress",
      version: 1,
    };
    const freshPrerequisite: WorkItem = {
      ...stalePrerequisite,
      status: "done",
      version: 2,
      updatedAt: "2026-07-14T10:00:00.000Z",
    };
    apiMocks.listWorkItems.mockImplementation(
      async (_workspaceId: string, filters: { priority?: WorkItem["priority"] }) => ({
        items:
          filters.priority === "urgent"
            ? [dependent, freshPrerequisite]
            : [dependent, stalePrerequisite],
        page: { limit: 200, offset: 0 },
      }),
    );
    apiMocks.listWorkItemDependencies.mockResolvedValue({
      items: [dependency(stalePrerequisite.id, dependent.id)],
      page: { limit: 200, offset: 0 },
    });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: dependent.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Dependent work card was not rendered.");
    expect(within(card).getByText("0/1 done")).toBeVisible();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by priority" }),
      "urgent",
    );

    const refreshedHeading = await screen.findByRole("heading", { name: dependent.title });
    const refreshedCard = refreshedHeading.closest("article");
    if (refreshedCard === null) throw new Error("Refreshed dependent work card was not rendered.");
    await waitFor(() => expect(within(refreshedCard).getByText("1/1 done")).toBeVisible());
    expect(
      within(refreshedCard).getByLabelText(`${freshPrerequisite.title} status: Done`),
    ).toHaveTextContent("Done");
    expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(2);
    expect(apiMocks.listWorkItemDependencies).toHaveBeenCalledTimes(1);
  });

  it("revalidates the workspace catalog and dependency graph on explicit refresh", async () => {
    const user = userEvent.setup();
    const dependent: WorkItem = {
      ...item,
      id: "item-dependent",
      title: "Publish the release",
      priority: "urgent",
    };
    const prerequisite: WorkItem = {
      ...item,
      id: "item-prerequisite",
      title: "Approve final copy",
      status: "in_progress",
      version: 1,
    };
    const refreshedPrerequisite: WorkItem = {
      ...prerequisite,
      status: "done",
      version: 2,
      updatedAt: "2026-07-14T10:00:00.000Z",
    };
    apiMocks.listWorkItems
      .mockResolvedValueOnce({
        items: [dependent, prerequisite],
        page: { limit: 200, offset: 0 },
      })
      .mockResolvedValueOnce({
        items: [dependent],
        page: { limit: 200, offset: 0 },
      })
      .mockResolvedValueOnce({
        items: [dependent],
        page: { limit: 200, offset: 0 },
      })
      .mockResolvedValueOnce({
        items: [dependent, refreshedPrerequisite],
        page: { limit: 200, offset: 0 },
      });
    apiMocks.listWorkItemDependencies
      .mockResolvedValueOnce({ items: [], page: { limit: 200, offset: 0 } })
      .mockResolvedValueOnce({
        items: [dependency(prerequisite.id, dependent.id)],
        page: { limit: 200, offset: 0 },
      });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: dependent.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Dependent work card was not rendered.");
    expect(within(card).getByText("No prerequisites linked.")).toBeVisible();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by priority" }),
      "urgent",
    );
    const filteredHeading = await screen.findByRole("heading", { name: dependent.title });
    const filteredCard = filteredHeading.closest("article");
    if (filteredCard === null) throw new Error("Filtered dependent work card was not rendered.");

    await user.click(screen.getByRole("button", { name: "Refresh board" }));

    await waitFor(() => expect(within(filteredCard).getByText("1/1 done")).toBeVisible());
    expect(within(filteredCard).getByText(refreshedPrerequisite.title)).toBeVisible();
    expect(
      within(filteredCard).getByLabelText(`${refreshedPrerequisite.title} status: Done`),
    ).toHaveTextContent("Done");
    expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(4);
    expect(apiMocks.listWorkItemDependencies).toHaveBeenCalledTimes(2);
  });

  it("retries a failed explicit refresh with workspace revalidation", async () => {
    const user = userEvent.setup();
    const prerequisite: WorkItem = {
      ...item,
      id: "item-prerequisite",
      title: "Approve final copy",
      status: "done",
      version: 2,
    };
    apiMocks.listWorkItems.mockResolvedValue({
      items: [item, prerequisite],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.listWorkItemDependencies
      .mockResolvedValueOnce({ items: [], page: { limit: 200, offset: 0 } })
      .mockRejectedValueOnce(new Error("Dependency refresh failed."))
      .mockResolvedValueOnce({
        items: [dependency(prerequisite.id)],
        page: { limit: 200, offset: 0 },
      });

    render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: item.title });
    const card = heading.closest("article");
    if (card === null) throw new Error("Work card was not rendered.");

    await user.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dependency refresh failed.");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(within(card).getByText("1/1 done")).toBeVisible());
    expect(within(card).getByText(prerequisite.title)).toBeVisible();
    expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(3);
    expect(apiMocks.listWorkItemDependencies).toHaveBeenCalledTimes(3);
  });

  it("ignores late dependency data from a previous workspace", async () => {
    const previousItems = deferred<{
      items: readonly WorkItem[];
      page: { limit: number; offset: number };
    }>();
    const previousDependencies = deferred<{
      items: readonly WorkItemDependency[];
      page: { limit: number; offset: number };
    }>();
    const nextWorkspace: Workspace = { ...workspace, id: "workspace-2", name: "Work" };
    const nextItem: WorkItem = {
      ...item,
      id: "item-next",
      workspaceId: nextWorkspace.id,
      title: "Plan next sprint",
    };
    apiMocks.listWorkItems.mockImplementation((workspaceId: string) =>
      workspaceId === workspace.id
        ? previousItems.promise
        : Promise.resolve({ items: [nextItem], page: { limit: 200, offset: 0 } }),
    );
    apiMocks.listWorkItemDependencies.mockImplementation((workspaceId: string) =>
      workspaceId === workspace.id
        ? previousDependencies.promise
        : Promise.resolve({ items: [], page: { limit: 200, offset: 0 } }),
    );

    const { rerender } = render(<WorkView workspace={workspace} onNavigate={vi.fn()} />);
    rerender(<WorkView workspace={nextWorkspace} onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: nextItem.title })).toBeInTheDocument();

    await act(async () => {
      previousItems.resolve({ items: [item], page: { limit: 200, offset: 0 } });
      previousDependencies.resolve({
        items: [dependency("old-prerequisite")],
        page: { limit: 200, offset: 0 },
      });
      await Promise.all([previousItems.promise, previousDependencies.promise]);
    });

    expect(screen.getByRole("heading", { name: nextItem.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: item.title })).not.toBeInTheDocument();
    expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(2);
    expect(apiMocks.listWorkItemDependencies).toHaveBeenCalledTimes(2);
    expect(apiMocks.listWorkItemDependencies).toHaveBeenCalledWith(
      nextWorkspace.id,
      expect.any(AbortSignal),
    );
  });
});
