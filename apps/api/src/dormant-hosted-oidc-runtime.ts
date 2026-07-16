import type { ApiConfig } from "@schedule/config";
import type { DatabaseConnection } from "@schedule/database";

import {
  createDormantHostedOidcComposition,
  type DormantHostedOidcCompositionOptions,
} from "./dormant-hosted-oidc-composition.js";
import type { HostedAuthLifecycleDependencies } from "./hosted-auth-lifecycle.js";

type CompositionFactory = (
  options: DormantHostedOidcCompositionOptions,
) => Promise<HostedAuthLifecycleDependencies>;

/** Constructs and retains no public route; callers decide whether the frozen graph is reachable. */
export async function constructDormantHostedOidcPreflight(
  config: Pick<ApiConfig, "HOSTED_OIDC_PREFLIGHT">,
  database: DatabaseConnection,
  factory: CompositionFactory = createDormantHostedOidcComposition,
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
  buildApp: () => Promise<App>,
  factory: CompositionFactory = createDormantHostedOidcComposition,
): Promise<
  Readonly<{
    app: App;
    composition: HostedAuthLifecycleDependencies | undefined;
  }>
> {
  const composition = await constructDormantHostedOidcPreflight(config, database, factory);
  const app = await buildApp();
  return Object.freeze({ app, composition });
}
