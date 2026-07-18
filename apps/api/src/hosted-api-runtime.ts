import {
  AuthorizeHostedWorkspace,
  CreateHostedWorkspaceForPrincipal,
  CreateHostedWorkItem,
  GenerateDailyPlan,
  GetDailyPlanFitInsight,
  GetCurrentDailyPlan,
  ListHostedWorkspaces,
  ListWorkItems,
  RecordPlanItemActivity,
  TransactionallyAuthorizedHostedUnitOfWork,
  UpdateHostedWorkItemStatus,
} from "@schedule/application";
import type { ApiConfig } from "@schedule/config";
import { createDailyPlanningRequest } from "@schedule/domain";
import {
  PostgresHostedMutationUnitOfWork,
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

async function hostedApiOptions(
  config: HostedRuntimeConfig,
  database: DatabaseConnection,
  composition: HostedAuthLifecycleDependencies | undefined,
  webShellLoader: HostedWebShellLoader,
): Promise<HostedApiOptions> {
  if (config.HOSTED_API_MODE !== "oidc" || composition === undefined) {
    throw new Error("Hosted OIDC activation failed.");
  }
  const identityUnitOfWork = new PostgresIdentityUnitOfWork(database);
  const listWorkspaces = new ListHostedWorkspaces(identityUnitOfWork);
  const createWorkspace = new CreateHostedWorkspaceForPrincipal(identityUnitOfWork);
  const productUnitOfWork = new PostgresUnitOfWork(database);
  const clock = { now: () => new Date() };
  const listWorkItems = new ListWorkItems(productUnitOfWork);
  const getCurrentDailyPlan = new GetCurrentDailyPlan(productUnitOfWork);
  const getDailyPlanFitInsight = new GetDailyPlanFitInsight(productUnitOfWork, clock);
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
      listWorkItems: ({ authorization }) =>
        listWorkItems.execute({
          workspaceId: authorization.workspaceId,
          status: "backlog",
          limit: 20,
          offset: 0,
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
) {
  try {
    return await prepareAppAfterDormantHostedOidcPreflight(
      config,
      database,
      async (composition) =>
        buildApp({
          ...baseOptions,
          ...(config.HOSTED_API_MODE === "oidc"
            ? {
                hostedApi: await hostedApiOptions(config, database, composition, webShellLoader),
              }
            : {}),
        }),
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
