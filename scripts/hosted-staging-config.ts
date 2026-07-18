const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const MIN_LOGIN_TIMEOUT_MS = 60_000;
const MAX_LOGIN_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_WORK_ITEM_PAGES = 10;
const MAX_WORK_ITEM_PAGES = 50;
const CI_MARKERS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "CODEBUILD_BUILD_ID",
] as const;

export interface HostedStagingConfig {
  readonly origin: string;
  readonly host: string;
  readonly workspaceName: string;
  readonly loginTimeoutMs: number;
  readonly maxWorkItemPages: number;
}

export type HostedStagingEnvironment = Readonly<Record<string, string | undefined>>;

function required(environment: HostedStagingEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the hosted staging smoke check.`);
  }
  return value;
}

function boundedInteger(
  environment: HostedStagingEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

/** Parse the small, explicit operator contract for a real hosted staging run. */
export function parseHostedStagingConfig(
  environment: HostedStagingEnvironment = process.env,
): HostedStagingConfig {
  if (CI_MARKERS.some((name) => (environment[name]?.length ?? 0) > 0)) {
    throw new Error("Hosted staging smoke checks are operator-only and cannot run in CI.");
  }

  const rawOrigin = required(environment, "SCHEDULE_STAGING_ORIGIN");
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch {
    throw new Error("SCHEDULE_STAGING_ORIGIN must be a canonical HTTPS origin.");
  }
  if (
    parsedOrigin.protocol !== "https:" ||
    parsedOrigin.username.length > 0 ||
    parsedOrigin.password.length > 0 ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search.length > 0 ||
    parsedOrigin.hash.length > 0 ||
    rawOrigin.endsWith("/") ||
    rawOrigin !== parsedOrigin.origin ||
    parsedOrigin.hostname === "localhost" ||
    parsedOrigin.hostname.endsWith(".localhost") ||
    isIpAddress(parsedOrigin.hostname) ||
    !/(staging|smoke)/i.test(parsedOrigin.hostname)
  ) {
    throw new Error(
      "SCHEDULE_STAGING_ORIGIN must be a canonical HTTPS staging or smoke origin without credentials, path, query, fragment, localhost, or an IP address.",
    );
  }

  const host = parsedOrigin.host;
  if (required(environment, "SCHEDULE_STAGING_CONFIRM_HOST") !== host) {
    throw new Error("SCHEDULE_STAGING_CONFIRM_HOST must exactly match the staging origin host.");
  }

  const workspaceName = required(environment, "SCHEDULE_STAGING_WORKSPACE");
  if (
    workspaceName !== workspaceName.trim() ||
    workspaceName.length > 160 ||
    !/^(staging|smoke)(?:[ _-]|$)/i.test(workspaceName)
  ) {
    throw new Error(
      "SCHEDULE_STAGING_WORKSPACE must be an exact dedicated workspace name prefixed with staging or smoke.",
    );
  }

  const expectedMutationConfirmation = `I_CONFIRM_STAGING_MUTATION ${parsedOrigin.origin} ${workspaceName}`;
  if (required(environment, "SCHEDULE_STAGING_CONFIRM_MUTATION") !== expectedMutationConfirmation) {
    throw new Error(
      "SCHEDULE_STAGING_CONFIRM_MUTATION must exactly bind the origin and dedicated workspace.",
    );
  }

  return {
    origin: parsedOrigin.origin,
    host,
    workspaceName,
    loginTimeoutMs: boundedInteger(
      environment,
      "SCHEDULE_STAGING_LOGIN_TIMEOUT_MS",
      DEFAULT_LOGIN_TIMEOUT_MS,
      MIN_LOGIN_TIMEOUT_MS,
      MAX_LOGIN_TIMEOUT_MS,
    ),
    maxWorkItemPages: boundedInteger(
      environment,
      "SCHEDULE_STAGING_MAX_WORK_ITEM_PAGES",
      DEFAULT_MAX_WORK_ITEM_PAGES,
      1,
      MAX_WORK_ITEM_PAGES,
    ),
  };
}
