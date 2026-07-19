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
    invokeMock.mockResolvedValue({ phase: "foundation", message: "Install the local runtime" });

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
    invokeMock.mockResolvedValue({ phase: "incompatible_data", message: "Update Schedule first" });

    render(<DesktopApp />);

    expect((await screen.findByRole("alert")).textContent).toContain("Update Schedule first");
    expect(screen.queryByRole("button", { name: "Retry startup" })).toBeNull();
    expect(screen.queryByRole("main", { name: "Shared Schedule application" })).toBeNull();
  });

  it("re-inspects after retry and mounts the shared App only when the runtime is ready", async () => {
    invokeMock
      .mockResolvedValueOnce({ phase: "foundation", message: "Install the local runtime" })
      .mockResolvedValueOnce({ phase: "ready", message: "Ready" });

    render(<DesktopApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry startup" }));
    expect(screen.queryByRole("main", { name: "Shared Schedule application" })).toBeNull();

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("polls an active startup until the shared application is ready", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({ phase: "starting_services", message: "Starting services" })
      .mockResolvedValueOnce({ phase: "ready", message: "Ready" });

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
    let resolveRetry!: (status: { phase: "ready"; message: string }) => void;
    const retryStatus = new Promise<{ phase: "ready"; message: string }>((resolve) => {
      resolveRetry = resolve;
    });
    invokeMock
      .mockResolvedValueOnce({ phase: "foundation", message: "Install the local runtime" })
      .mockReturnValueOnce(retryStatus);

    render(<DesktopApp />);

    const retry = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Retry startup",
    });
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);

    await act(async () => resolveRetry({ phase: "ready", message: "Ready" }));
    expect(screen.getByRole("main", { name: "Shared Schedule application" })).not.toBeNull();
  });

  it("ignores an inspection that completes after unmount without starting a poll", async () => {
    vi.useFakeTimers();
    let resolveInspection!: (status: { phase: "starting_services"; message: string }) => void;
    invokeMock.mockReturnValueOnce(
      new Promise<{ phase: "starting_services"; message: string }>((resolve) => {
        resolveInspection = resolve;
      }),
    );

    const view = render(<DesktopApp />);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () =>
      resolveInspection({ phase: "starting_services", message: "Starting services" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
