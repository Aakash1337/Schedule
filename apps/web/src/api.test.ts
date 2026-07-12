import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API client", () => {
  it("uses the same-origin workspace endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], page: { limit: 20, offset: 0 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkspaces()).resolves.toMatchObject({ items: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces?limit=20&offset=0",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("carries optimistic versions in work-item updates", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "item-1",
            workspaceId: "workspace-1",
            title: "Plan",
            description: null,
            status: "planned",
            priority: "high",
            version: 4,
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:01:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.updateWorkItem("workspace-1", "item-1", {
      expectedVersion: 3,
      status: "planned",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/work-items/item-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 3, status: "planned" }),
      }),
    );
  });

  it("reads offset-paginated collections through the final page", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: firstPage, page: { limit: 200, offset: 0 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: [{ id: "item-200" }], page: { limit: 200, offset: 200 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkItems("workspace-1")).resolves.toMatchObject({
      items: expect.arrayContaining([{ id: "item-200" }]),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace-1/work-items?limit=200&offset=0",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace-1/work-items?limit=200&offset=200",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("retrieves one calendar block directly for conflict recovery", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "block-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getScheduleBlock("workspace-1", "block-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/schedule-blocks/block-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("handles audited 204 deletion responses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteScheduleBlock("workspace-1", "block-1", 7)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/schedule-blocks/block-1",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: 7 }),
      }),
    );
  });

  it("maps the shared API error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "work_item.version_conflict", message: "Changed elsewhere." },
              requestId: "req-9",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const error = await api
      .updateWorkItem("workspace-1", "item-1", { expectedVersion: 1, status: "done" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "work_item.version_conflict",
      requestId: "req-9",
    });
  });
});
