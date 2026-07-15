import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import type {
  NotificationDeliveryHistoryItem,
  NotificationIntent,
  NotificationProfile,
  NotificationRule,
  OneOffReminder,
  Workspace,
} from "../types";
import { RemindersView } from "./RemindersView";

const apiMocks = vi.hoisted(() => ({
  cancelOneOffReminder: vi.fn(),
  configureNotificationProfile: vi.fn(),
  createNotificationRule: vi.fn(),
  createOneOffReminder: vi.fn(),
  getNotificationProfile: vi.fn(),
  listNotificationDeliveries: vi.fn(),
  listNotificationIntents: vi.fn(),
  listNotificationRules: vi.fn(),
  listOneOffReminders: vi.fn(),
  materializeNotificationIntents: vi.fn(),
  updateNotificationRule: vi.fn(),
  updateOneOffReminder: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, api: { ...original.api, ...apiMocks } };
});

const workspace: Workspace = {
  id: "workspace-reminders",
  name: "Personal",
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:00:00.000Z",
};

const profile: NotificationProfile = {
  workspaceId: workspace.id,
  enabled: true,
  timeZone: "America/La_Paz",
  quietHoursStartMinute: 1_320,
  quietHoursEndMinute: 420,
  quietHoursPolicy: "next_allowed",
  catchUpWindowMinutes: 90,
  dailyIntentLimit: 20,
  version: 2,
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:30:00.000Z",
};

const rule: NotificationRule = {
  id: "rule-digest",
  workspaceId: workspace.id,
  kind: "daily_digest",
  enabled: true,
  localMinute: 540,
  leadMinutes: null,
  cooldownMinutes: 60,
  priority: 70,
  version: 3,
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:30:00.000Z",
};

const oneOff: OneOffReminder = {
  id: "one-off-call",
  workspaceId: workspace.id,
  title: "Call home",
  scheduledFor: "2026-07-15T15:00:00.000Z",
  cancelledAt: null,
  version: 1,
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:00:00.000Z",
};

const intent: NotificationIntent = {
  id: "intent-digest",
  workspaceId: workspace.id,
  ruleId: rule.id,
  oneOffReminderId: null,
  kind: "daily_digest",
  occurrenceKey: "digest:2026-07-15",
  targetType: "workspace",
  targetId: null,
  titleSnapshot: null,
  scheduledFor: "2026-07-15T13:00:00.000Z",
  localDate: "2026-07-15",
  priority: 70,
  policySnapshot: { profileVersion: 2, ruleVersion: 3 },
  localTimeResolution: "exact",
  adjustedForQuietHours: false,
  caughtUp: false,
  createdAt: "2026-07-14T09:00:00.000Z",
};

const delivery: NotificationDeliveryHistoryItem = {
  deliveryId: "delivery-digest",
  intentId: intent.id,
  kind: "daily_digest",
  targetType: "workspace",
  title: null,
  scheduledFor: intent.scheduledFor,
  localDate: intent.localDate,
  priority: 70,
  status: "processing",
  attempts: 1,
  availableAt: "2026-07-15T13:00:00.000Z",
  completedAt: null,
  lastFailureCode: null,
  createdAt: "2026-07-15T13:00:00.000Z",
  updatedAt: "2026-07-15T13:00:01.000Z",
};

function page<Item>(items: readonly Item[]) {
  return { items, page: { limit: 200, offset: 0 } };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.getNotificationProfile.mockResolvedValue(profile);
  apiMocks.listNotificationRules.mockResolvedValue({ items: [rule] });
  apiMocks.listOneOffReminders.mockResolvedValue({ items: [oneOff] });
  apiMocks.listNotificationIntents.mockResolvedValue(page([intent]));
  apiMocks.listNotificationDeliveries.mockResolvedValue(page([delivery]));
  apiMocks.configureNotificationProfile.mockResolvedValue(profile);
  apiMocks.updateNotificationRule.mockResolvedValue({ ...rule, version: 4 });
  apiMocks.createNotificationRule.mockResolvedValue(rule);
  apiMocks.createOneOffReminder.mockResolvedValue(oneOff);
  apiMocks.updateOneOffReminder.mockResolvedValue({ ...oneOff, version: 2 });
  apiMocks.cancelOneOffReminder.mockResolvedValue({
    ...oneOff,
    version: 2,
    cancelledAt: "2026-07-14T10:00:00.000Z",
  });
  apiMocks.materializeNotificationIntents.mockResolvedValue({
    created: [intent],
    existing: [],
    suppressed: [],
  });
});

afterEach(() => cleanup());

describe("RemindersView", () => {
  it("requires an explicit policy save and never silently creates a default profile", async () => {
    const user = userEvent.setup();
    apiMocks.getNotificationProfile
      .mockRejectedValueOnce(
        new ApiError(
          404,
          "notification_profile.not_found",
          "The workspace has no notification profile.",
          null,
        ),
      )
      .mockResolvedValue(profile);
    apiMocks.listNotificationRules.mockResolvedValue({ items: [] });
    apiMocks.listOneOffReminders.mockResolvedValue({ items: [] });
    apiMocks.listNotificationIntents.mockResolvedValue(page([]));
    apiMocks.listNotificationDeliveries.mockResolvedValue(page([]));

    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Configure reminders" })).toBeInTheDocument();
    expect(apiMocks.configureNotificationProfile).not.toHaveBeenCalled();
    expect(screen.getByText("Rules stay locked until policy setup is saved")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save reminder policy" }));

    await waitFor(() => expect(apiMocks.configureNotificationProfile).toHaveBeenCalledTimes(1));
    expect(apiMocks.configureNotificationProfile).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ expectedVersion: null, enabled: true }),
    );
    expect(await screen.findByText(/Reminder policy configured/)).toBeInTheDocument();
  });

  it("edits a versioned rule and reloads after the mutation", async () => {
    const user = userEvent.setup();
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", { name: "Daily digest" });
    const card = heading.closest("form");
    if (card === null) throw new Error("Rule card was not rendered as a form.");
    await user.click(within(card).getByRole("checkbox", { name: "Pause Daily digest" }));
    await user.clear(within(card).getByRole("spinbutton", { name: "Priority" }));
    await user.type(within(card).getByRole("spinbutton", { name: "Priority" }), "82");
    await user.click(within(card).getByRole("button", { name: "Save rule" }));

    await waitFor(() => expect(apiMocks.updateNotificationRule).toHaveBeenCalledTimes(1));
    expect(apiMocks.updateNotificationRule).toHaveBeenCalledWith(workspace.id, rule.id, {
      expectedVersion: 3,
      enabled: false,
      localMinute: 540,
      leadMinutes: null,
      cooldownMinutes: 60,
      priority: 82,
    });
    expect(apiMocks.getNotificationProfile).toHaveBeenCalledTimes(2);
  });

  it("creates and cancels one-off reminders through explicit versioned commands", async () => {
    const user = userEvent.setup();
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: "One-off reminders" });
    await user.type(screen.getByRole("textbox", { name: "Reminder title" }), "Bring passport");
    await user.click(screen.getByRole("button", { name: "Add reminder" }));

    await waitFor(() => expect(apiMocks.createOneOffReminder).toHaveBeenCalledTimes(1));
    expect(apiMocks.createOneOffReminder).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ title: "Bring passport", scheduledFor: expect.any(String) }),
    );

    await user.click(screen.getByRole("button", { name: "Cancel reminder" }));
    await waitFor(() =>
      expect(apiMocks.cancelOneOffReminder).toHaveBeenCalledWith(workspace.id, oneOff.id, 1),
    );
  });

  it("materializes explicitly, reports the result, and opens planned intent history", async () => {
    const user = userEvent.setup();
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: "Policy and quiet hours" });
    await user.click(screen.getByRole("button", { name: "Refresh planned reminders" }));

    await waitFor(() => expect(apiMocks.materializeNotificationIntents).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Planned reminders" })).toBeInTheDocument();
    expect(screen.getByText(/Planning refreshed: 1 created/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Daily digest" })).toBeInTheDocument();
  });

  it("separates claimed execution from proof of an external send", async () => {
    const user = userEvent.setup();
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: "Policy and quiet hours" });
    screen.getByRole("tab", { name: "Policy" }).focus();
    await user.keyboard("{End}");

    expect(await screen.findByRole("heading", { name: "Execution history" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Execution/ })).toHaveFocus();
    expect(screen.getByText("Claimed")).toBeInTheDocument();
    expect(screen.getByText(/does not prove an external message was sent/)).toBeInTheDocument();
    expect(
      screen.getByText(/no credentials, recipients, provider payloads, or claim tokens/i),
    ).toBeInTheDocument();
  });

  it("reloads a concurrent version conflict before asking the user to retry", async () => {
    const user = userEvent.setup();
    apiMocks.updateNotificationRule.mockRejectedValue(
      new ApiError(
        409,
        "notification_rule.version_conflict",
        "The notification rule changed.",
        null,
      ),
    );
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", { name: "Daily digest" });
    const card = heading.closest("form");
    if (card === null) throw new Error("Rule card was not rendered as a form.");
    await user.click(within(card).getByRole("button", { name: "Save rule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(apiMocks.getNotificationProfile).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed one-off edit open with its unsaved values", async () => {
    const user = userEvent.setup();
    apiMocks.updateOneOffReminder.mockRejectedValue(new Error("The update could not be saved."));
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: "One-off reminders" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("button", { name: "Save reminder" }).closest("form");
    if (editor === null) throw new Error("One-off editor was not rendered.");
    const title = within(editor).getByRole("textbox", { name: "Reminder title" });
    await user.clear(title);
    await user.type(title, "Call family tonight");
    await user.click(screen.getByRole("button", { name: "Save reminder" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByRole("button", { name: "Save reminder" })).toBeInTheDocument();
    expect(within(editor).getByRole("textbox", { name: "Reminder title" })).toHaveValue(
      "Call family tonight",
    );
  });

  it("serializes reminder mutations and disables competing commands", async () => {
    const user = userEvent.setup();
    let releaseProfile: ((value: NotificationProfile) => void) | undefined;
    apiMocks.configureNotificationProfile.mockReturnValue(
      new Promise<NotificationProfile>((resolve) => {
        releaseProfile = resolve;
      }),
    );
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: "Policy and quiet hours" });
    await user.click(screen.getByText("Add a reusable rule"));
    const createRule = screen.getByRole("button", { name: "Create rule" });
    await user.click(screen.getByRole("button", { name: "Save policy changes" }));

    await waitFor(() => expect(createRule).toBeDisabled());
    await user.click(createRule);
    expect(apiMocks.createNotificationRule).not.toHaveBeenCalled();

    releaseProfile?.(profile);
    expect(await screen.findByText(/Reminder policy saved/)).toBeInTheDocument();
  });

  it("rejects blank numeric policy fields before an API request", async () => {
    const user = userEvent.setup();
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: "Policy and quiet hours" });
    const catchUp = screen.getByRole("spinbutton", {
      name: /^Catch-up window \(minutes\)/,
    });
    await user.clear(catchUp);
    const form = catchUp.closest("form");
    if (form === null) throw new Error("Profile form was not rendered.");
    fireEvent.submit(form);

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter whole numbers");
    expect(catchUp).toHaveAttribute("aria-invalid", "true");
    expect(apiMocks.configureNotificationProfile).not.toHaveBeenCalled();
  });

  it("rejects blank enabled quiet-hour times before an API request", async () => {
    render(<RemindersView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByRole("heading", { name: "Policy and quiet hours" });
    const quietStart = screen.getByLabelText("Quiet hours start");
    fireEvent.change(quietStart, { target: { value: "" } });
    await waitFor(() => expect(quietStart).toHaveAttribute("aria-invalid", "true"));
    const form = quietStart.closest("form");
    if (form === null) throw new Error("Profile form was not rendered.");
    fireEvent.submit(form);

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose both a valid quiet-hours");
    expect(quietStart).toHaveAttribute("aria-invalid", "true");
    expect(apiMocks.configureNotificationProfile).not.toHaveBeenCalled();
  });
});
