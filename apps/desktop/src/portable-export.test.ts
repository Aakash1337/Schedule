import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { requestPortableExport } from "./DesktopApp.js";

const invokeMock = vi.mocked(invoke);

describe("requestPortableExport", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the portable export command without arguments", async () => {
    invokeMock.mockResolvedValue({ result: "cancelled" });

    await expect(requestPortableExport()).resolves.toEqual({ result: "cancelled" });

    expect(invokeMock).toHaveBeenCalledWith("portable_export");
    expect(invokeMock.mock.calls[0]).toHaveLength(1);
  });
});
