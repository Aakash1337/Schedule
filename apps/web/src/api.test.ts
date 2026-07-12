import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pageResponse(items: readonly { readonly id: string }[], offset: number): Response {
  return new Response(JSON.stringify({ items, page: { limit: 200, offset } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      const response =
        requestNumber % 2 === 0
          ? pageResponse(firstPage, 0)
          : pageResponse([{ id: "item-200" }], 200);
      requestNumber += 1;
      return response;
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("deduplicates entity IDs across offset pages while preserving first-seen order", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      const response =
        requestNumber % 2 === 0
          ? pageResponse(firstPage, 0)
          : pageResponse([{ id: "item-199" }, { id: "item-200" }], 200);
      requestNumber += 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.listWorkItems("workspace-1");

    expect(result.items).toHaveLength(201);
    expect(result.items.map((item) => item.id)).toEqual([
      ...firstPage.map((item) => item.id),
      "item-200",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("detects an offset shift caused by deletion between pages", async () => {
    const originalFirstPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    const currentPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index + 1}` }));
    const responses = [
      () => pageResponse(originalFirstPage, 0),
      () => pageResponse([], 200),
      () => pageResponse(currentPage, 0),
      () => pageResponse([], 200),
    ];
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => responses[requestNumber++]!());
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkItems("workspace-1")).rejects.toThrow(
      "The collection changed while it was loading. Refresh and try again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports changing offset pagination instead of returning a silent partial result", async () => {
    const repeatedPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    const response = () =>
      new Response(JSON.stringify({ items: repeatedPage, page: { limit: 200, offset: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkItems("workspace-1")).rejects.toThrow(
      "The collection changed while it was loading. Refresh and try again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
