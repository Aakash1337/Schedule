import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  confirmPortableImport,
  requestPortableExport,
  requestPortableImportSelection,
} from "./DesktopApp.js";

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

describe("portable import native bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("selects an import archive without supplying a path", async () => {
    invokeMock.mockResolvedValue({ result: "cancelled" });

    await expect(requestPortableImportSelection()).resolves.toEqual({ result: "cancelled" });

    expect(invokeMock).toHaveBeenCalledWith("portable_import_select");
    expect(invokeMock.mock.calls[0]).toHaveLength(1);
  });

  it("confirms an import with the opaque selection token only", async () => {
    invokeMock.mockResolvedValue({ result: "imported" });

    await expect(confirmPortableImport("opaque-import-token")).resolves.toEqual({
      result: "imported",
    });

    expect(invokeMock).toHaveBeenCalledWith("portable_import_confirm", {
      token: "opaque-import-token",
    });
  });
});
