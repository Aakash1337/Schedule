import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { desktopApiTransport } from "./api-transport.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("desktop API transport", () => {
  it("sends only the narrow request DTO and reconstructs the response", async () => {
    invokeMock.mockResolvedValue({
      status: 409,
      jsonBody: '{"error":{"code":"version.conflict"}}',
      requestId: "request-7",
    });

    const response = await desktopApiTransport("/v1/workspaces/workspace-1/work-items", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "must-not-cross-the-bridge",
        "Content-Type": "application/json",
        "Idempotency-Key": "operation-7",
      },
      body: '{"title":"Review"}',
    });

    expect(invokeMock).toHaveBeenCalledWith("api_request", {
      request: {
        method: "POST",
        path: "/v1/workspaces/workspace-1/work-items",
        jsonBody: '{"title":"Review"}',
        idempotencyKey: "operation-7",
      },
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("x-request-id")).toBe("request-7");
    await expect(response.json()).resolves.toEqual({ error: { code: "version.conflict" } });
  });

  it("preserves null-body statuses and rejects an aborted request before invoking Rust", async () => {
    for (const status of [204, 205, 304]) {
      invokeMock.mockResolvedValueOnce({ status, jsonBody: '{"ignored":true}' });
      const response = await desktopApiTransport("/v1/workspaces/workspace-1/block", {});
      expect(response.status).toBe(status);
      await expect(response.text()).resolves.toBe("");
    }

    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      desktopApiTransport("/v1/workspaces", { signal: cancellation.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("rejects unsupported methods and non-string bodies locally", async () => {
    await expect(desktopApiTransport("/v1/workspaces", { method: "OPTIONS" })).rejects.toThrow(
      "method is not supported",
    );
    await expect(
      desktopApiTransport("/v1/workspaces", { body: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow("serialized JSON");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
