// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../web/src/App.js", () => ({
  App: () => <main aria-label="Shared Schedule application">Shared Schedule application</main>,
}));

import { DesktopApp } from "./DesktopApp.js";

describe("DesktopApp runtime gate", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("inspects once in StrictMode and keeps the shared App behind a recoverable error", async () => {
    invokeMock.mockResolvedValue({
      phase: "foundation",
      message: "Install the local runtime",
      generation: 0,
    });

    const { container } = render(
      <StrictMode>
        <DesktopApp />
      </StrictMode>,
    );

    expect(screen.queryByRole("main", { name: "Shared Schedule application" })).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("Install the local runtime");
    expect(container.querySelector(".startup-mark")?.getAttribute("data-state")).toBe("error");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry startup" }).disabled).toBe(
      false,
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("presents incompatible data as a blocking accessible error without mounting the App", async () => {
    invokeMock.mockResolvedValue({
      phase: "incompatible_data",
      message: "Update Schedule first",
      generation: 1,
    });

    render(<DesktopApp />);

    expect((await screen.findByRole("alert")).textContent).toContain("Update Schedule first");
    expect(screen.queryByRole("button", { name: "Retry startup" })).toBeNull();
    expect(screen.queryByRole("main", { name: "Shared Schedule application" })).toBeNull();
  });

  it("only offers verified automatic-backup recovery for incompatible data", async () => {
    invokeMock.mockResolvedValue({
      phase: "incompatible_data",
      message: "An update was interrupted",
      generation: 1,
      automaticBackupRecovery: true,
    });

    render(<DesktopApp />);

    expect(await screen.findByRole("button", { name: "Restore automatic backup" })).not.toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("submits native-confirmed automatic-backup recovery once, then re-inspects", async () => {
    invokeMock
      .mockResolvedValueOnce({
        phase: "incompatible_data",
        message: "An update was interrupted",
        generation: 4,
        automaticBackupRecovery: true,
      })
      .mockResolvedValueOnce({ result: "accepted", generation: 4 })
      .mockResolvedValueOnce({ phase: "ready", message: "Ready", generation: 5 });

    render(<DesktopApp />);

    const restore = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Restore automatic backup",
    });
    await act(async () => {
      restore.click();
      restore.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "runtime_restore_automatic_backup"),
    ).toHaveLength(1);
  });

  it("returns to the recovery action after native confirmation is cancelled", async () => {
    invokeMock
      .mockResolvedValueOnce({
        phase: "incompatible_data",
        message: "An update was interrupted",
        generation: 1,
        automaticBackupRecovery: true,
      })
      .mockResolvedValueOnce({ result: "cancelled" })
      .mockResolvedValueOnce({
        phase: "incompatible_data",
        message: "An update was interrupted",
        generation: 1,
        automaticBackupRecovery: true,
      });

    render(<DesktopApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore automatic backup" }));
    expect(await screen.findByRole("button", { name: "Restore automatic backup" })).not.toBeNull();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "runtime_restore_automatic_backup"),
    ).toHaveLength(1);
    expect(screen.queryByText("Automatic recovery could not start.")).toBeNull();
  });

  it("explains an unavailable recovery command and restores the safe action", async () => {
    invokeMock
      .mockResolvedValueOnce({
        phase: "incompatible_data",
        message: "An update was interrupted",
        generation: 2,
        automaticBackupRecovery: true,
      })
      .mockResolvedValueOnce({ result: "unavailable" })
      .mockResolvedValueOnce({
        phase: "incompatible_data",
        message: "An update was interrupted",
        generation: 2,
        automaticBackupRecovery: true,
      });

    render(<DesktopApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore automatic backup" }));

    expect(
      await screen.findByText(
        "Automatic recovery is no longer available. Reopen Schedule or restore a backup manually.",
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Restore automatic backup" })).not.toBeNull();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "runtime_restore_automatic_backup"),
    ).toHaveLength(1);
  });

  it("keeps polling when accepted recovery first observes its stale incompatible generation", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({
        phase: "incompatible_data",
        message: "An update was interrupted",
        generation: 3,
        automaticBackupRecovery: true,
      })
      .mockResolvedValueOnce({ result: "accepted", generation: 3 })
      .mockResolvedValueOnce({
        phase: "incompatible_data",
        message: "An update was interrupted",
        generation: 3,
        automaticBackupRecovery: true,
      })
      .mockResolvedValueOnce({
        phase: "starting_services",
        message: "Restoring the automatic backup",
        generation: 3,
      })
      .mockResolvedValueOnce({ phase: "ready", message: "Ready", generation: 4 });

    render(<DesktopApp />);
    await act(async () => Promise.resolve());
    await act(async () => {
      screen.getByRole("button", { name: "Restore automatic backup" }).click();
      await Promise.resolve();
    });

    expect(screen.getByText("Restoring the automatic backup…")).not.toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Restore automatic backup" }).disabled,
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("status").textContent).toContain("Restoring the automatic backup");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "runtime_restore_automatic_backup"),
    ).toHaveLength(1);
  });

  it("keeps recovery unavailable for other startup failures", async () => {
    invokeMock.mockResolvedValue({
      phase: "recoverable_failure",
      message: "Startup failed",
      generation: 1,
      automaticBackupRecovery: true,
    });

    render(<DesktopApp />);

    await screen.findByRole("button", { name: "Retry startup" });
    expect(screen.queryByRole("button", { name: "Restore automatic backup" })).toBeNull();
  });

  it("re-inspects after retry and mounts the shared App only when the runtime is ready", async () => {
    invokeMock
      .mockResolvedValueOnce({
        phase: "foundation",
        message: "Install the local runtime",
        generation: 1,
      })
      .mockResolvedValueOnce({ result: "accepted", generation: 1 })
      .mockResolvedValueOnce({ phase: "ready", message: "Ready", generation: 2 });

    render(<DesktopApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry startup" }));
    expect(screen.queryByRole("main", { name: "Shared Schedule application" })).toBeNull();

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "runtime_retry");
  });

  it("polls an active startup until the shared application is ready", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({
        phase: "starting_services",
        message: "Starting services",
        generation: 1,
      })
      .mockResolvedValueOnce({ phase: "ready", message: "Ready", generation: 1 });

    render(<DesktopApp />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("Starting services");
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces rapid retries while the current inspection is pending", async () => {
    let resolveRetry!: (status: { phase: "ready"; message: string; generation: number }) => void;
    const retryStatus = new Promise<{ phase: "ready"; message: string; generation: number }>(
      (resolve) => {
        resolveRetry = resolve;
      },
    );
    invokeMock
      .mockResolvedValueOnce({
        phase: "foundation",
        message: "Install the local runtime",
        generation: 1,
      })
      .mockResolvedValueOnce({ result: "accepted", generation: 1 })
      .mockReturnValueOnce(retryStatus);

    render(<DesktopApp />);

    const retry = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Retry startup",
    });
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock.mock.calls.filter(([command]) => command === "runtime_retry")).toHaveLength(
      1,
    );

    await act(async () => resolveRetry({ phase: "ready", message: "Ready", generation: 2 }));
    expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
  });

  it("keeps polling when an accepted retry first observes the stale failure generation", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({
        phase: "recoverable_failure",
        message: "Startup failed",
        generation: 4,
      })
      .mockResolvedValueOnce({ result: "accepted", generation: 4 })
      .mockResolvedValueOnce({
        phase: "recoverable_failure",
        message: "Startup failed",
        generation: 4,
      })
      .mockResolvedValueOnce({
        phase: "starting_services",
        message: "Retrying startup",
        generation: 5,
      })
      .mockResolvedValueOnce({ phase: "ready", message: "Ready", generation: 5 });

    render(<DesktopApp />);
    await act(async () => Promise.resolve());
    await act(async () => {
      screen.getByRole("button", { name: "Retry startup" }).click();
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toContain("Checking the local runtime again");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("status").textContent).toContain("Retrying startup");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
    expect(invokeMock.mock.calls.filter(([command]) => command === "runtime_retry")).toHaveLength(
      1,
    );
  });

  it("surfaces a status-command failure after an accepted retry instead of polling forever", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({
        phase: "recoverable_failure",
        message: "Startup failed",
        generation: 4,
      })
      .mockResolvedValueOnce({ result: "accepted", generation: 4 })
      .mockRejectedValueOnce(new Error("status unavailable"));

    render(<DesktopApp />);
    await act(async () => Promise.resolve());
    await act(async () => {
      screen.getByRole("button", { name: "Retry startup" }).click();
      await Promise.resolve();
    });

    expect(screen.getByText("Schedule could not inspect its local runtime")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry startup" })).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an inspection that completes after unmount without starting a poll", async () => {
    vi.useFakeTimers();
    let resolveInspection!: (status: {
      phase: "starting_services";
      message: string;
      generation: number;
    }) => void;
    invokeMock.mockReturnValueOnce(
      new Promise<{ phase: "starting_services"; message: string; generation: number }>(
        (resolve) => {
          resolveInspection = resolve;
        },
      ),
    );

    const view = render(<DesktopApp />);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () =>
      resolveInspection({
        phase: "starting_services",
        message: "Starting services",
        generation: 1,
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
