import path from "node:path";
import { pathToFileURL } from "node:url";

const timeoutMs = 10_000;
const paths = ["/health/live", "/health/ready"] as const;

type HealthPath = (typeof paths)[number];
type Environment = Readonly<Record<string, string | undefined>>;

export interface HostedHealthProbeDependencies {
  readonly fetch: typeof fetch;
  readonly timeoutSignal: (milliseconds: number) => AbortSignal;
  readonly log: (message: string) => void;
}

const defaultDependencies: HostedHealthProbeDependencies = {
  fetch,
  timeoutSignal: AbortSignal.timeout,
  log: console.log,
};

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export function parseHostedHealthOrigin(environment: Environment = process.env): URL {
  const raw = environment.SCHEDULE_HOSTED_HEALTH_ORIGIN;
  let origin: URL;
  try {
    if (raw === undefined || raw.length === 0) throw new Error();
    origin = new URL(raw);
  } catch {
    throw new Error(
      "SCHEDULE_HOSTED_HEALTH_ORIGIN must be a canonical HTTPS origin with a DNS hostname.",
    );
  }

  if (
    origin.protocol !== "https:" ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0 ||
    raw.endsWith("/") ||
    raw !== origin.origin ||
    origin.hostname === "localhost" ||
    origin.hostname.endsWith(".localhost") ||
    isIpAddress(origin.hostname)
  ) {
    throw new Error(
      "SCHEDULE_HOSTED_HEALTH_ORIGIN must be a canonical HTTPS origin with a DNS hostname.",
    );
  }
  return origin;
}

function exactStatus(body: unknown, expected: "alive" | "ready"): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    (body as { readonly status?: unknown }).status === expected
  );
}

async function probe(
  origin: URL,
  healthPath: HealthPath,
  expected: "alive" | "ready",
  dependencies: HostedHealthProbeDependencies,
): Promise<void> {
  let response: Response;
  try {
    response = await dependencies.fetch(`${origin.origin}${healthPath}`, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: dependencies.timeoutSignal(timeoutMs),
    });
  } catch {
    throw new Error(`Hosted health probe ${healthPath} request failed.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Hosted health probe ${healthPath} returned an invalid response.`);
  }
  if (response.status !== 200 || !exactStatus(body, expected)) {
    throw new Error(`Hosted health probe ${healthPath} returned an unhealthy response.`);
  }
  dependencies.log(`[hosted-health ${origin.host}] ${healthPath} ok`);
}

export async function verifyHostedHealth(
  environment: Environment = process.env,
  dependencies: HostedHealthProbeDependencies = defaultDependencies,
): Promise<void> {
  const origin = parseHostedHealthOrigin(environment);
  await probe(origin, paths[0], "alive", dependencies);
  await probe(origin, paths[1], "ready", dependencies);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  try {
    await verifyHostedHealth();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Hosted health probe failed.");
    process.exitCode = 1;
  }
}
