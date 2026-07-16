import { AuthorizeHostedWorkspace, CreateHostedWorkItem } from "@schedule/application";
import type { ApiConfig } from "@schedule/config";
import {
  PostgresHostedMutationUnitOfWork,
  PostgresIdentityUnitOfWork,
  type DatabaseConnection,
} from "@schedule/database";

import { buildApp, type BuildAppOptions, type HostedApiOptions } from "./app.js";
import {
  prepareAppAfterDormantHostedOidcPreflight,
  type HostedOidcCompositionFactory,
} from "./dormant-hosted-oidc-runtime.js";
import type { HostedAuthLifecycleDependencies } from "./hosted-auth-lifecycle.js";

type HostedRuntimeConfig = Pick<
  ApiConfig,
  "HOSTED_API_MODE" | "HOSTED_OIDC_PREFLIGHT" | "HOSTED_RATE_LIMIT_PER_MINUTE"
>;

function hostedApiOptions(
  config: HostedRuntimeConfig,
  database: DatabaseConnection,
  composition: HostedAuthLifecycleDependencies | undefined,
): HostedApiOptions {
  if (config.HOSTED_API_MODE !== "oidc" || composition === undefined) {
    throw new Error("Hosted OIDC activation failed.");
  }
  const identityUnitOfWork = new PostgresIdentityUnitOfWork(database);
  const createWorkItem = new CreateHostedWorkItem(new PostgresHostedMutationUnitOfWork(database), {
    now: () => new Date(),
  });
  return {
    auth: composition,
    boundary: {
      authenticator: composition.authenticator,
      csrfGuard: composition.csrfGuard,
      authorizer: new AuthorizeHostedWorkspace(identityUnitOfWork),
    },
    workItems: {
      createWorkItem: ({ authorization, command }) =>
        createWorkItem.execute(authorization, command),
    },
    requestsPerMinute: config.HOSTED_RATE_LIMIT_PER_MINUTE,
  };
}

/** Owns fail-closed hosted preflight, route assembly, and startup cleanup. */
export async function prepareHostedApiApp(
  config: HostedRuntimeConfig,
  database: DatabaseConnection,
  baseOptions: Omit<BuildAppOptions, "hostedApi"> = {},
  factory?: HostedOidcCompositionFactory,
) {
  try {
    return await prepareAppAfterDormantHostedOidcPreflight(
      config,
      database,
      (composition) =>
        buildApp({
          ...baseOptions,
          ...(config.HOSTED_API_MODE === "oidc"
            ? { hostedApi: hostedApiOptions(config, database, composition) }
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
