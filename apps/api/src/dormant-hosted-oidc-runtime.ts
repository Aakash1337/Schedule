import type { ApiConfig } from "@schedule/config";
import type { DatabaseConnection } from "@schedule/database";

import {
  createDormantHostedOidcComposition,
  type DormantHostedOidcCompositionOptions,
} from "./dormant-hosted-oidc-composition.js";
import type { HostedAuthLifecycleDependencies } from "./hosted-auth-lifecycle.js";

export type HostedOidcCompositionFactory = (
  options: DormantHostedOidcCompositionOptions,
) => Promise<HostedAuthLifecycleDependencies>;

/** Constructs and retains no public route; callers decide whether the frozen graph is reachable. */
export async function constructDormantHostedOidcPreflight(
  config: Pick<ApiConfig, "HOSTED_OIDC_PREFLIGHT">,
  database: DatabaseConnection,
  factory: HostedOidcCompositionFactory = createDormantHostedOidcComposition,
): Promise<HostedAuthLifecycleDependencies | undefined> {
  const preflight = config.HOSTED_OIDC_PREFLIGHT;
  if (preflight === undefined) return undefined;
  try {
    return await factory({ database, ...preflight });
  } catch {
    throw new Error("Hosted OIDC preflight failed.");
  }
}

export async function prepareAppAfterDormantHostedOidcPreflight<App>(
  config: Pick<ApiConfig, "HOSTED_OIDC_PREFLIGHT">,
  database: DatabaseConnection,
  buildApp: (composition: HostedAuthLifecycleDependencies | undefined) => Promise<App>,
  factory: HostedOidcCompositionFactory = createDormantHostedOidcComposition,
): Promise<
  Readonly<{
    app: App;
    composition: HostedAuthLifecycleDependencies | undefined;
  }>
> {
  const composition = await constructDormantHostedOidcPreflight(config, database, factory);
  const app = await buildApp(composition);
  return Object.freeze({ app, composition });
}
