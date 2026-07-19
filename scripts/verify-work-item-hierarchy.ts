import assert from "node:assert/strict";

import { buildApp } from "../apps/api/src/app.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import { createDatabase, PostgresUnitOfWork } from "../packages/database/src/index.js";
import { workspaceId } from "../packages/domain/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 6);
const unitOfWork = new PostgresUnitOfWork(connection);
const app = await buildApp({
  readinessCheck: async () => {
    await connection.sql`select 1`;
  },
  productServices: createProductServices(unitOfWork, {
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  }),
  productApiAccess: { mode: "local_unauthenticated" },
});

interface WorkItemResponse {
  readonly id: string;
  readonly parentWorkItemId: string | null;
  readonly version: number;
}

let primaryWorkspaceId: string | null = null;
let isolatedWorkspaceId: string | null = null;

async function createWorkspace(name: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/workspaces", payload: { name } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ id: string }>().id;
}

async function createWorkItem(
  workspaceId: string,
  title: string,
  parentWorkItemId: string | null = null,
): Promise<WorkItemResponse> {
  const response = await app.inject({
    method: "POST",
    url:
      parentWorkItemId === null
        ? `/v1/workspaces/${workspaceId}/work-items`
        : `/v1/workspaces/${workspaceId}/work-items/${parentWorkItemId}/subtasks`,
    payload: { title, planningDurationMinutes: 30 },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<WorkItemResponse>();
}

async function setParent(
  workspaceId: string,
  item: WorkItemResponse,
  parentWorkItemId: string | null,
) {
  return app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${workspaceId}/work-items/${item.id}`,
    payload: { expectedVersion: item.version, parentWorkItemId },
  });
}

function errorCode(response: { json<T>(): T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

function hasConstraint(error: unknown, code: string, constraintName: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code &&
    "constraint_name" in error &&
    error.constraint_name === constraintName
  );
}

async function cleanup(): Promise<void> {
  const workspaceIds = [primaryWorkspaceId, isolatedWorkspaceId].filter(
    (workspaceId): workspaceId is string => workspaceId !== null,
  );
  if (workspaceIds.length === 0) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_daily_plan_fit_insight_feedback_event_change', 'on', true)`;
    await sql`delete from workspaces where id = any(${workspaceIds})`;
  });
}

try {
  primaryWorkspaceId = await createWorkspace("Hierarchy verification");
  isolatedWorkspaceId = await createWorkspace("Hierarchy isolation verification");

  const root = await createWorkItem(primaryWorkspaceId, "Release");
  const alternateRoot = await createWorkItem(primaryWorkspaceId, "Operations");
  const child = await createWorkItem(primaryWorkspaceId, "Write release notes", root.id);
  const grandchild = await createWorkItem(primaryWorkspaceId, "Proofread notes", child.id);

  assert.equal(child.parentWorkItemId, root.id);
  assert.equal(grandchild.parentWorkItemId, child.id);
  const childrenResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${primaryWorkspaceId}/work-items/${root.id}/subtasks?limit=20&offset=0`,
  });
  assert.equal(childrenResponse.statusCode, 200, childrenResponse.body);
  assert.deepEqual(
    childrenResponse.json<{ items: WorkItemResponse[]; page: { limit: number; offset: number } }>(),
    {
      items: [child],
      page: { limit: 20, offset: 0 },
    },
  );

  const reparentedResponse = await setParent(primaryWorkspaceId, child, alternateRoot.id);
  assert.equal(reparentedResponse.statusCode, 200, reparentedResponse.body);
  const reparented = reparentedResponse.json<WorkItemResponse>();
  assert.deepEqual(
    { parentWorkItemId: reparented.parentWorkItemId, version: reparented.version },
    { parentWorkItemId: alternateRoot.id, version: 2 },
  );
  const detachedResponse = await setParent(primaryWorkspaceId, reparented, null);
  assert.equal(detachedResponse.statusCode, 200, detachedResponse.body);
  const detached = detachedResponse.json<WorkItemResponse>();
  assert.deepEqual(
    { parentWorkItemId: detached.parentWorkItemId, version: detached.version },
    { parentWorkItemId: null, version: 3 },
  );
  const reattachedResponse = await setParent(primaryWorkspaceId, detached, root.id);
  assert.equal(reattachedResponse.statusCode, 200, reattachedResponse.body);
  const reattached = reattachedResponse.json<WorkItemResponse>();
  assert.deepEqual(
    { parentWorkItemId: reattached.parentWorkItemId, version: reattached.version },
    { parentWorkItemId: root.id, version: 4 },
  );

  const cycleResponse = await setParent(primaryWorkspaceId, root, grandchild.id);
  assert.equal(cycleResponse.statusCode, 409, cycleResponse.body);
  assert.equal(errorCode(cycleResponse), "work_item_hierarchy.cycle_conflict");
  const selfResponse = await setParent(primaryWorkspaceId, reattached, reattached.id);
  assert.equal(selfResponse.statusCode, 422, selfResponse.body);
  assert.equal(errorCode(selfResponse), "work_item_hierarchy.self_reference_invalid");

  const crossTenantResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${root.id}/subtasks`,
    payload: { title: "Cross-tenant child" },
  });
  assert.equal(crossTenantResponse.statusCode, 404, crossTenantResponse.body);
  assert.equal(errorCode(crossTenantResponse), "work_item.not_found");

  const graph = await unitOfWork.run(({ workItemDependencies }) =>
    workItemDependencies.loadPlanningGraph(workspaceId(primaryWorkspaceId!), 501, 2_001),
  );
  const planningIds = new Set<string>(graph.workItems.map((item) => item.id));
  assert.equal(planningIds.has(root.id), false, "a parent must not be planned with its children");
  assert.equal(
    planningIds.has(reattached.id),
    false,
    "a nested parent must not be planned with its child",
  );
  assert.equal(planningIds.has(alternateRoot.id), true);
  assert.equal(planningIds.has(grandchild.id), true);

  await assert.rejects(
    connection.sql`delete from work_items where workspace_id = ${primaryWorkspaceId} and id = ${root.id}`,
    (error) => hasConstraint(error, "23503", "work_items_parent_tenant_fk"),
  );

  const left = await createWorkItem(primaryWorkspaceId, "Concurrent left");
  const right = await createWorkItem(primaryWorkspaceId, "Concurrent right");
  const reciprocalResponses = await Promise.all([
    setParent(primaryWorkspaceId, left, right.id),
    setParent(primaryWorkspaceId, right, left.id),
  ]);
  assert.deepEqual(
    reciprocalResponses.map((response) => response.statusCode).sort((a, b) => a - b),
    [200, 409],
    "opposite concurrent reparents must serialize so only one wins",
  );
  assert.equal(
    errorCode(reciprocalResponses.find((response) => response.statusCode === 409)!),
    "work_item_hierarchy.cycle_conflict",
  );

  const [auditCounts] = await connection.sql<
    { assigned: number; changed: number; removed: number }[]
  >`
    select
      count(*) filter (where action = 'work_item_hierarchy.parent_assigned')::int as assigned,
      count(*) filter (where action = 'work_item_hierarchy.parent_changed')::int as changed,
      count(*) filter (where action = 'work_item_hierarchy.parent_removed')::int as removed
    from audit_events
    where workspace_id = ${primaryWorkspaceId}
  `;
  assert.ok((auditCounts?.assigned ?? 0) >= 2);
  assert.ok((auditCounts?.changed ?? 0) >= 2);
  assert.equal(auditCounts?.removed, 1);

  process.stdout.write(
    "work-item hierarchy verification passed tenant isolation, reparenting, cycles, concurrent exclusion, delete restriction, audits, and leaf-only planning\n",
  );
} finally {
  await app.close();
  await cleanup();
  await connection.close();
}
