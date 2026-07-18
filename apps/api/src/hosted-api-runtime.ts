import { createHmac } from "node:crypto";

import {
  AuthorizeHostedWorkspace,
  BootstrapHostedWorkItems,
  CreateHostedWorkspaceForPrincipal,
  CreateHostedWorkItem,
  DismissDailyPlanFitInsight,
  GenerateDailyPlan,
  GetDailyPlanFitEffectiveness,
  GetDailyPlanFitInsight,
  GetCurrentDailyPlan,
  ListHostedWorkspaces,
  ListHostedWorkItemChanges,
  ListDailyPlanFitUsageOutcomes,
  ListWorkItems,
  maximumDailyPlanFitUsageOutcomes,
  RecordPlanItemActivity,
  ResetDailyPlanFitInsightDismissal,
  TransactionallyAuthorizedHostedUnitOfWork,
  UpdateHostedWorkItemStatus,
} from "@schedule/application";
import type { ApiConfig } from "@schedule/config";
import { createDailyPlanningRequest } from "@schedule/domain";
import {
  enableHostedWorkItemSyncCapture,
  PostgresHostedMutationUnitOfWork,
  PostgresHostedWorkItemSyncStore,
  PostgresIdentityUnitOfWork,
  PostgresUnitOfWork,
  type DatabaseConnection,
} from "@schedule/database";

import { buildApp, type BuildAppOptions, type HostedApiOptions } from "./app.js";
import {
  prepareAppAfterDormantHostedOidcPreflight,
  type HostedOidcCompositionFactory,
} from "./dormant-hosted-oidc-runtime.js";
import type { HostedAuthLifecycleDependencies } from "./hosted-auth-lifecycle.js";
import { loadHostedWebShell, type HostedWebShellLoader } from "./hosted-web-shell.js";

type HostedRuntimeConfig = Pick<
  ApiConfig,
  "HOSTED_API_MODE" | "HOSTED_OIDC_PREFLIGHT" | "HOSTED_RATE_LIMIT_PER_MINUTE"
>;

const hostedWorkItemSyncCursorDomain = "schedule:hosted-work-item-sync:v1";

export function deriveHostedWorkItemSyncCursorSigningKey(browserSessionPepper: string): Buffer {
  return createHmac("sha256", browserSessionPepper).update(hostedWorkItemSyncCursorDomain).digest();
}

async function hostedApiOptions(
  config: HostedRuntimeConfig,
  database: DatabaseConnection,
  composition: HostedAuthLifecycleDependencies | undefined,
  webShellLoader: HostedWebShellLoader,
): Promise<HostedApiOptions> {
  if (config.HOSTED_API_MODE !== "oidc" || composition === undefined) {
    throw new Error("Hosted OIDC activation failed.");
  }
  if (config.HOSTED_OIDC_PREFLIGHT === undefined) {
    throw new Error("Hosted OIDC preflight configuration is unavailable.");
  }
  const identityUnitOfWork = new PostgresIdentityUnitOfWork(database);
  const listWorkspaces = new ListHostedWorkspaces(identityUnitOfWork);
  const createWorkspace = new CreateHostedWorkspaceForPrincipal(identityUnitOfWork);
  const productUnitOfWork = new PostgresUnitOfWork(database);
  const clock = { now: () => new Date() };
  const listWorkItems = new ListWorkItems(productUnitOfWork);
  const workItemSyncStore = new PostgresHostedWorkItemSyncStore(database);
  const bootstrapWorkItems = new BootstrapHostedWorkItems(workItemSyncStore);
  const listWorkItemChanges = new ListHostedWorkItemChanges(workItemSyncStore);
  const getCurrentDailyPlan = new GetCurrentDailyPlan(productUnitOfWork);
  const getDailyPlanFitInsight = new GetDailyPlanFitInsight(productUnitOfWork, clock);
  const getDailyPlanFitEffectiveness = new GetDailyPlanFitEffectiveness(
    new ListDailyPlanFitUsageOutcomes(productUnitOfWork),
  );
  const hostedMutationUnitOfWork = new PostgresHostedMutationUnitOfWork(database);
  const createWorkItem = new CreateHostedWorkItem(hostedMutationUnitOfWork, clock);
  const updateWorkItemStatus = new UpdateHostedWorkItemStatus(hostedMutationUnitOfWork, clock);
  let webShell: Awaited<ReturnType<HostedWebShellLoader>>;
  try {
    webShell = await webShellLoader();
  } catch {
    throw new Error("Hosted web shell could not be loaded.");
  }
  return {
    auth: composition,
    boundary: {
      authenticator: composition.authenticator,
      csrfGuard: composition.csrfGuard,
      authorizer: new AuthorizeHostedWorkspace(identityUnitOfWork),
    },
    workspaces: {
      listWorkspaces: (input) => listWorkspaces.execute(input),
      createWorkspace: (input) => createWorkspace.execute(input).then(({ workspace }) => workspace),
    },
    workItems: {
      syncCursorSigningKey: deriveHostedWorkItemSyncCursorSigningKey(
        config.HOSTED_OIDC_PREFLIGHT.browserSessionPepper,
      ),
      listWorkItems: ({ authorization }) =>
        listWorkItems.execute({
          workspaceId: authorization.workspaceId,
          status: "backlog",
          limit: 20,
          offset: 0,
        }),
      listWorkItemSnapshot: ({ authorization, limit, offset }) =>
        listWorkItems.execute({
          workspaceId: authorization.workspaceId,
          limit,
          offset,
        }),
      bootstrapWorkItemSync: ({ authorization, limit, checkpoint, afterId }) =>
        bootstrapWorkItems.execute({
          workspaceId: authorization.workspaceId,
          limit,
          ...(checkpoint === undefined ? {} : { checkpoint }),
          ...(afterId === undefined ? {} : { afterId }),
        }),
      listWorkItemSyncChanges: ({ authorization, limit, afterCursor, throughCursor }) =>
        listWorkItemChanges.execute({
          workspaceId: authorization.workspaceId,
          limit,
          afterCursor,
          ...(throughCursor === undefined ? {} : { throughCursor }),
        }),
      createWorkItem: ({ authorization, command }) =>
        createWorkItem.execute(authorization, command),
      updateWorkItemStatus: ({ authorization, command }) =>
        updateWorkItemStatus.execute(authorization, command),
    },
    today: {
      getToday: ({ authorization, date }) =>
        getCurrentDailyPlan.execute({ workspaceId: authorization.workspaceId, date }),
      getDailyPlanFitInsight: ({ authorization, forDate }) =>
        getDailyPlanFitInsight.execute({
          workspaceId: authorization.workspaceId,
          forDate,
        }),
      getDailyPlanFitEffectiveness: ({ authorization }) =>
        getDailyPlanFitEffectiveness.execute({
          workspaceId: authorization.workspaceId,
          limit: maximumDailyPlanFitUsageOutcomes,
        }),
      dismissDailyPlanFitInsight: async ({ authorization, ...command }) => {
        const service = new DismissDailyPlanFitInsight(
          new TransactionallyAuthorizedHostedUnitOfWork(hostedMutationUnitOfWork, authorization),
          clock,
        );
        await service.execute({ ...command, workspaceId: authorization.workspaceId });
      },
      resetDailyPlanFitInsightDismissal: async ({ authorization, ...command }) => {
        const service = new ResetDailyPlanFitInsightDismissal(
          new TransactionallyAuthorizedHostedUnitOfWork(hostedMutationUnitOfWork, authorization),
          clock,
        );
        await service.execute({ ...command, workspaceId: authorization.workspaceId });
      },
      generateToday: async ({
        authorization,
        date,
        timeZone,
        window,
        targetMinutes,
        targetTaskCount,
        planFitInsightKey,
        idempotencyKey,
      }) => {
        const service = new GenerateDailyPlan(
          new TransactionallyAuthorizedHostedUnitOfWork(hostedMutationUnitOfWork, authorization),
          clock,
        );
        await service.execute({
          request: createDailyPlanningRequest({
            workspaceId: authorization.workspaceId,
            date,
            timeZone,
            availableWindows: [window],
            targetMinutes,
            targetTaskCount,
            fitPreference: "balanced",
            energy: null,
            availableContexts: [],
            seed: `hosted-today:${idempotencyKey}`,
            requestRevision: 1,
            ...(planFitInsightKey === null ? {} : { planFitInsightKey }),
          }),
        });
      },
      recordActivity: async ({ authorization, ...command }) => {
        const expectedPlan = await productUnitOfWork.run(({ dailyPlans }) =>
          dailyPlans.findById(authorization.workspaceId, command.expectedPlanId),
        );
        const timeZone =
          expectedPlan?.timeZone ??
          (
            await getCurrentDailyPlan.execute({
              workspaceId: authorization.workspaceId,
              date: command.date,
            })
          ).plan.timeZone;
        const service = new RecordPlanItemActivity(
          new TransactionallyAuthorizedHostedUnitOfWork(hostedMutationUnitOfWork, authorization),
          clock,
        );
        await service.execute({
          ...command,
          workspaceId: authorization.workspaceId,
          timeZone,
        });
      },
    },
    webShell,
    requestsPerMinute: config.HOSTED_RATE_LIMIT_PER_MINUTE,
  };
}

/** Owns fail-closed hosted preflight, route assembly, and startup cleanup. */
export async function prepareHostedApiApp(
  config: HostedRuntimeConfig,
  database: DatabaseConnection,
  baseOptions: Omit<BuildAppOptions, "hostedApi"> = {},
  factory?: HostedOidcCompositionFactory,
  webShellLoader: HostedWebShellLoader = loadHostedWebShell,
  enableSyncCapture: typeof enableHostedWorkItemSyncCapture = enableHostedWorkItemSyncCapture,
) {
  try {
    return await prepareAppAfterDormantHostedOidcPreflight(
      config,
      database,
      async (composition) => {
        const app = await buildApp({
          ...baseOptions,
          ...(config.HOSTED_API_MODE === "oidc"
            ? {
                hostedApi: await hostedApiOptions(config, database, composition, webShellLoader),
              }
            : {}),
        });
        if (config.HOSTED_API_MODE === "oidc") {
          try {
            await enableSyncCapture(database);
          } catch {
            try {
              await app.close();
            } catch {
              // Preserve the stable activation failure; outer cleanup still closes the database.
            }
            throw new Error("Hosted work-item sync capture activation failed.");
          }
        }
        return app;
      },
      factory,
    );
  } catch (error) {
    try {
      await database.close();
    } catch {
      // Preserve the already-redacted startup failure.
    }
    throw error;
  }
}
