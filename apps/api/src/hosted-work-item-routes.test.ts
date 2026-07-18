import {
  DomainError,
  browserSessionId,
  createWorkItem,
  localDate,
  updateWorkItem,
  userId,
  workspaceId,
} from "@schedule/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSTED_WORK_ITEM_COLLECTION_ROUTE,
  HOSTED_WORK_ITEM_RESOURCE_ROUTE,
  HOSTED_WORK_ITEM_SNAPSHOT_ROUTE,
  registerHostedWorkItemBoundary,
  type HostedWorkItemServices,
} from "./hosted-work-item-routes.js";
import { installErrorHandler } from "./http-errors.js";

const USER_ID = userId("00000000-0000-4000-8000-000000000101");
const OTHER_USER_ID = userId("00000000-0000-4000-8000-000000000102");
const SESSION_ID = browserSessionId("00000000-0000-4000-8000-000000000201");
const WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000301");
const OTHER_WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000302");
const principal = {
  userId: USER_ID,
  sessionId: SESSION_ID,
  idleExpiresAt: new Date("2026-07-15T10:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-07-16T00:00:00.000Z"),
};
const authorization = Object.freeze({
  userId: USER_ID,
  sessionId: SESSION_ID,
  workspaceId: WORKSPACE_ID,
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function servicesWith(overrides: Partial<HostedWorkItemServices> = {}): HostedWorkItemServices {
  return {
    createWorkItem: vi.fn(async () => {
      throw new Error("Unexpected hosted work-item create.");
    }),
    listWorkItems: vi.fn(async () => ({ items: [], limit: 20, offset: 0 })),
    listWorkItemSnapshot: vi.fn(async () => ({ items: [], limit: 100, offset: 0 })),
    updateWorkItemStatus: vi.fn(async () => {
      throw new Error("Unexpected hosted work-item update.");
    }),
    ...overrides,
  };
}

async function createHostedApp(
  services: Partial<HostedWorkItemServices>,
): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installErrorHandler(app);
  await registerHostedWorkItemBoundary(
    app,
    {
      csrfGuard: { verify: () => true },
      authenticator: { authenticate: async () => principal },
      authorizer: {
        execute: async (candidate, requestedWorkspace) =>
          candidate.userId === USER_ID && requestedWorkspace === WORKSPACE_ID
            ? Object.freeze({ ...candidate, workspaceId: requestedWorkspace })
            : null,
      },
    },
    servicesWith(services),
  );
  await app.ready();
  return app;
}

describe("hosted work-item routes", () => {
  it("derives canonical authority and applies narrow scheduling defaults", async () => {
    const created = createWorkItem({
      workspaceId: WORKSPACE_ID,
      title: "Hosted task",
      priority: "high",
      dueOn: localDate("2026-07-20"),
      planningDurationMinutes: 45,
      now: new Date("2026-07-15T09:00:00.000Z"),
    });
    const defaulted = createWorkItem({
      workspaceId: WORKSPACE_ID,
      title: "Default task",
      now: new Date("2026-07-15T09:01:00.000Z"),
    });
    const createWorkItemService = vi
      .fn()
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(defaulted);
    const app = await createHostedApp({ createWorkItem: createWorkItemService });

    const response = await app.inject({
      method: "POST",
      url: HOSTED_WORK_ITEM_COLLECTION_ROUTE.replace(":workspaceId", WORKSPACE_ID.toUpperCase()),
      headers: { "x-user-id": OTHER_USER_ID, "x-workspace-id": OTHER_WORKSPACE_ID },
      payload: {
        title: "  Hosted task  ",
        priority: "high",
        dueOn: "2026-07-20",
        planningDurationMinutes: 45,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      id: created.id,
      title: created.title,
      version: created.version,
      priority: "high",
      dueOn: "2026-07-20",
      planningDurationMinutes: 45,
    });
    expect(response.body).not.toContain(WORKSPACE_ID);
    expect(createWorkItemService).toHaveBeenNthCalledWith(1, {
      authorization,
      command: {
        parentWorkItemId: null,
        title: "Hosted task",
        description: null,
        status: "backlog",
        priority: "high",
        dueOn: localDate("2026-07-20"),
        planningDurationMinutes: 45,
      },
    });
    expect(Object.isFrozen(createWorkItemService.mock.calls[0]?.[0].authorization)).toBe(true);

    const defaultResponse = await app.inject({
      method: "POST",
      url: HOSTED_WORK_ITEM_COLLECTION_ROUTE.replace(":workspaceId", WORKSPACE_ID),
      payload: { title: "Default task" },
    });
    expect(defaultResponse.statusCode).toBe(201);
    expect(defaultResponse.json()).toEqual({
      id: defaulted.id,
      title: defaulted.title,
      version: defaulted.version,
      priority: "none",
      dueOn: null,
      planningDurationMinutes: null,
    });
    expect(createWorkItemService).toHaveBeenNthCalledWith(2, {
      authorization,
      command: {
        parentWorkItemId: null,
        title: "Default task",
        description: null,
        status: "backlog",
        priority: "none",
        dueOn: null,
        planningDurationMinutes: null,
      },
    });
  });

  it("returns one redacted fixed backlog page from canonical authority", async () => {
    const first = createWorkItem({
      workspaceId: WORKSPACE_ID,
      title: "Visible backlog title",
      description: "private description",
      priority: "medium",
      dueOn: localDate("2026-07-21"),
      planningDurationMinutes: 30,
      now: new Date("2026-07-15T09:00:00.000Z"),
    });
    const listWorkItems = vi
      .fn()
      .mockResolvedValueOnce({ items: [first], limit: 20, offset: 0 })
      .mockRejectedValueOnce(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp({ listWorkItems });
    const path = HOSTED_WORK_ITEM_COLLECTION_ROUTE.replace(
      ":workspaceId",
      WORKSPACE_ID.toUpperCase(),
    );

    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { "x-user-id": OTHER_USER_ID, "x-workspace-id": OTHER_WORKSPACE_ID },
    });
    const malformed = await app.inject({ method: "GET", url: `${path}?limit=100` });
    const revoked = await app.inject({ method: "GET", url: path });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      items: [
        {
          id: first.id,
          title: first.title,
          version: first.version,
          priority: "medium",
          dueOn: "2026-07-21",
          planningDurationMinutes: 30,
        },
      ],
      limit: 20,
      offset: 0,
    });
    expect(response.body).not.toContain("private description");
    expect(listWorkItems).toHaveBeenNthCalledWith(1, { authorization });
    expect(malformed.statusCode).toBe(400);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain("private membership detail");
    expect(listWorkItems).toHaveBeenCalledTimes(2);
  });

  it("returns a stable full-field current-state work-item page with default and forwarded pages", async () => {
    const parent = createWorkItem({
      workspaceId: WORKSPACE_ID,
      title: "Parent",
      now: new Date("2026-07-15T08:00:00.000Z"),
    });
    const original = createWorkItem({
      workspaceId: WORKSPACE_ID,
      parentWorkItemId: parent.id,
      title: "Snapshot task",
      description: "Full current state",
      status: "planned",
      priority: "urgent",
      dueOn: localDate("2026-07-22"),
      planningDurationMinutes: 75,
      now: new Date("2026-07-15T09:00:00.000Z"),
    });
    const item = updateWorkItem(original, {
      status: "in_progress",
      now: new Date("2026-07-16T10:30:00.000Z"),
    });
    const listWorkItemSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ items: [item], limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [], limit: 200, offset: 1_000_000 });
    const app = await createHostedApp({ listWorkItemSnapshot });
    const path = HOSTED_WORK_ITEM_SNAPSHOT_ROUTE.replace(
      ":workspaceId",
      WORKSPACE_ID.toUpperCase(),
    );

    const defaults = await app.inject({ method: "GET", url: path });
    const paged = await app.inject({
      method: "GET",
      url: `${path}?limit=200&offset=1000000`,
    });

    expect(defaults.statusCode).toBe(200);
    expect(defaults.headers["cache-control"]).toBe("no-store");
    expect(defaults.json()).toEqual({
      items: [
        {
          id: item.id,
          parentWorkItemId: parent.id,
          title: "Snapshot task",
          description: "Full current state",
          status: "in_progress",
          priority: "urgent",
          dueOn: "2026-07-22",
          planningDurationMinutes: 75,
          version: 2,
          createdAt: "2026-07-15T09:00:00.000Z",
          updatedAt: "2026-07-16T10:30:00.000Z",
        },
      ],
      limit: 100,
      offset: 0,
    });
    expect(defaults.body).not.toContain(WORKSPACE_ID);
    expect(paged.statusCode).toBe(200);
    expect(paged.json()).toEqual({ items: [], limit: 200, offset: 1_000_000 });
    expect(listWorkItemSnapshot).toHaveBeenNthCalledWith(1, {
      authorization,
      limit: 100,
      offset: 0,
    });
    expect(listWorkItemSnapshot).toHaveBeenNthCalledWith(2, {
      authorization,
      limit: 200,
      offset: 1_000_000,
    });
  });

  it("rejects non-canonical snapshot pages before calling the service", async () => {
    const listWorkItemSnapshot = vi.fn();
    const app = await createHostedApp({ listWorkItemSnapshot });
    const path = HOSTED_WORK_ITEM_SNAPSHOT_ROUTE.replace(":workspaceId", WORKSPACE_ID);

    for (const query of [
      "limit=0",
      "limit=201",
      "limit=01",
      "limit=%2B1",
      "limit=%201",
      "limit=1.0",
      "limit=1e2",
      "limit=1&limit=2",
      "offset=-1",
      "offset=1000001",
      "offset=01",
      "offset=%2B1",
      "offset=%201",
      "offset=1.0",
      "offset=1e2",
      "offset=1&offset=2",
      "status=backlog",
      "limit=1&workspaceId=00000000-0000-4000-8000-000000000302",
    ]) {
      const response = await app.inject({ method: "GET", url: `${path}?${query}` });
      expect(response.statusCode, query).toBe(400);
      expect(response.headers["cache-control"], query).toBe("no-store");
    }
    expect(listWorkItemSnapshot).not.toHaveBeenCalled();
  });

  it("redacts unavailable snapshot membership and never crosses the workspace boundary", async () => {
    const listWorkItemSnapshot = vi
      .fn()
      .mockRejectedValue(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp({ listWorkItemSnapshot });
    const permittedPath = HOSTED_WORK_ITEM_SNAPSHOT_ROUTE.replace(":workspaceId", WORKSPACE_ID);
    const deniedPath = HOSTED_WORK_ITEM_SNAPSHOT_ROUTE.replace(":workspaceId", OTHER_WORKSPACE_ID);

    const revoked = await app.inject({ method: "GET", url: permittedPath });
    const otherTenant = await app.inject({ method: "GET", url: deniedPath });

    expect(revoked.statusCode).toBe(404);
    expect(revoked.headers["cache-control"]).toBe("no-store");
    expect(revoked.json()).toMatchObject({
      error: {
        code: "workspace.not_found",
        message: "The requested workspace does not exist.",
      },
    });
    expect(revoked.body).not.toContain("private membership detail");
    expect(otherTenant.statusCode).toBe(404);
    expect(otherTenant.body).not.toContain(WORKSPACE_ID);
    expect(listWorkItemSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects identity-bearing and malformed bodies before calling the service", async () => {
    const createWorkItemService = vi.fn();
    const app = await createHostedApp({ createWorkItem: createWorkItemService });

    for (const payload of [
      { title: "Spoof", userId: OTHER_USER_ID },
      { title: "" },
      { title: "Valid", planningDurationMinutes: 0 },
      { title: "Invalid date", dueOn: "2026-02-30" },
      { title: "Invalid priority", priority: "critical" },
      { title: "Too long", planningDurationMinutes: 43_201 },
      { title: "Too broad", description: "private" },
      { title: "Too broad", status: "done" },
      { title: "Too broad", parentWorkItemId: "00000000-0000-4000-8000-000000000401" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: HOSTED_WORK_ITEM_COLLECTION_ROUTE.replace(":workspaceId", WORKSPACE_ID),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(createWorkItemService).not.toHaveBeenCalled();
  });

  it("updates only status from canonical authority with an optimistic version", async () => {
    const current = createWorkItem({
      workspaceId: WORKSPACE_ID,
      title: "Hosted task",
      now: new Date("2026-07-16T09:00:00.000Z"),
    });
    const updated = updateWorkItem(current, {
      status: "done",
      now: new Date("2026-07-16T09:01:00.000Z"),
    });
    const updateWorkItemStatus = vi.fn(async () => updated);
    const app = await createHostedApp({ updateWorkItemStatus });
    const path = HOSTED_WORK_ITEM_RESOURCE_ROUTE.replace(
      ":workspaceId",
      WORKSPACE_ID.toUpperCase(),
    ).replace(":workItemId", current.id.toUpperCase());

    const response = await app.inject({
      method: "PATCH",
      url: path,
      headers: { "x-user-id": OTHER_USER_ID, "x-workspace-id": OTHER_WORKSPACE_ID },
      payload: { expectedVersion: current.version, status: "done" },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe("");
    expect(updateWorkItemStatus).toHaveBeenCalledWith({
      authorization,
      command: { workItemId: current.id, expectedVersion: current.version, status: "done" },
    });
  });

  it("rejects general editing and invalid status updates before calling the service", async () => {
    const updateWorkItemStatus = vi.fn();
    const app = await createHostedApp({ updateWorkItemStatus });
    const path = HOSTED_WORK_ITEM_RESOURCE_ROUTE.replace(":workspaceId", WORKSPACE_ID).replace(
      ":workItemId",
      "00000000-0000-4000-8000-000000000401",
    );

    for (const payload of [
      { expectedVersion: 1, status: "backlog" },
      { expectedVersion: 0, status: "done" },
      { expectedVersion: 1, status: "done", title: "General edit" },
      { expectedVersion: 1, status: "done", workspaceId: OTHER_WORKSPACE_ID },
    ]) {
      const response = await app.inject({ method: "PATCH", url: path, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it("reports a stale hosted status update without exposing repository detail", async () => {
    const app = await createHostedApp({
      updateWorkItemStatus: vi
        .fn()
        .mockRejectedValue(new DomainError("work_item.version_conflict", "private row detail")),
    });
    const path = HOSTED_WORK_ITEM_RESOURCE_ROUTE.replace(":workspaceId", WORKSPACE_ID).replace(
      ":workItemId",
      "00000000-0000-4000-8000-000000000401",
    );

    const response = await app.inject({
      method: "PATCH",
      url: path,
      payload: { expectedVersion: 1, status: "in_progress" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "work_item.version_conflict" } });
    expect(response.body).not.toContain("private row detail");
  });

  it("reports a non-backlog source conflict without exposing repository detail", async () => {
    const app = await createHostedApp({
      updateWorkItemStatus: vi
        .fn()
        .mockRejectedValue(new DomainError("work_item.status_conflict", "private status detail")),
    });
    const path = HOSTED_WORK_ITEM_RESOURCE_ROUTE.replace(":workspaceId", WORKSPACE_ID).replace(
      ":workItemId",
      "00000000-0000-4000-8000-000000000401",
    );

    const response = await app.inject({
      method: "PATCH",
      url: path,
      payload: { expectedVersion: 2, status: "in_progress" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "work_item.status_conflict",
        message: "The work item status changed before this update could be applied.",
      },
    });
    expect(response.body).not.toContain("private status detail");
  });

  it.each([
    [
      new DomainError("hosted.authentication_failed", "private session detail"),
      401,
      "hosted.authentication_failed",
      "Authentication failed.",
    ],
    [
      new DomainError("workspace.not_found", "private membership detail"),
      404,
      "workspace.not_found",
      "The requested workspace does not exist.",
    ],
  ] as const)(
    "maps transaction authorization denial without exposing auth detail",
    async (failure, status, code, message) => {
      const app = await createHostedApp({
        createWorkItem: vi.fn().mockRejectedValue(failure),
      });

      const response = await app.inject({
        method: "POST",
        url: HOSTED_WORK_ITEM_COLLECTION_ROUTE.replace(":workspaceId", WORKSPACE_ID),
        payload: { title: "Denied" },
      });

      expect(response.statusCode).toBe(status);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ error: { code, message } });
      if (code === "hosted.authentication_failed") {
        expect(response.headers["www-authenticate"]).toBeUndefined();
        expect(response.body).not.toContain("private session detail");
      } else {
        expect(response.body).not.toContain("private membership detail");
      }
    },
  );

  it("redacts internal transaction failures", async () => {
    const app = await createHostedApp({
      createWorkItem: vi.fn().mockRejectedValue(new Error("database-password")),
    });

    const response = await app.inject({
      method: "POST",
      url: HOSTED_WORK_ITEM_COLLECTION_ROUTE.replace(":workspaceId", WORKSPACE_ID),
      payload: { title: "Unavailable" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      error: { code: "internal.unexpected_error", message: "An unexpected error occurred." },
    });
    expect(response.body).not.toContain("database-password");
  });

  it("fails closed before route services when the composed boundary returns inconsistent access", async () => {
    const app = Fastify();
    apps.push(app);
    installErrorHandler(app);
    const createWorkItemService = vi.fn();
    await registerHostedWorkItemBoundary(
      app,
      {
        csrfGuard: { verify: () => true },
        authenticator: { authenticate: async () => principal },
        authorizer: {
          execute: async () => Object.freeze({ ...authorization, workspaceId: OTHER_WORKSPACE_ID }),
        },
      },
      servicesWith({ createWorkItem: createWorkItemService }),
    );
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: HOSTED_WORK_ITEM_COLLECTION_ROUTE.replace(":workspaceId", WORKSPACE_ID),
      payload: { title: "Mismatched" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "hosted.authorization_unavailable" } });
    expect(createWorkItemService).not.toHaveBeenCalled();
  });
});
