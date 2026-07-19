import { DisabledNaturalLanguageProposer } from "@schedule/application";
import { loadApiConfig } from "@schedule/config";
import {
  createDatabase,
  healthCheckDatabase,
  PostgresIntegrationUnitOfWork,
  PostgresNaturalLanguageProposalUnitOfWork,
  PostgresUnitOfWork,
} from "@schedule/database";

import { prepareHostedApiApp } from "./hosted-api-runtime.js";
import {
  clearDesktopApiTokenEnvironment,
  desktopApiReadyLine,
  installDesktopShutdownControl,
  type DesktopShutdownControl,
} from "./desktop-api-runtime.js";
import { createDesktopProductAuthenticator } from "./desktop-product-auth.js";
import { createIntegrationServices } from "./integration-services.js";
import { DisabledSchedulingAdvisor, OllamaSchedulingAdvisor } from "./local-model-advisor.js";
import { createNaturalLanguagePromptHasher } from "./natural-language-runtime.js";
import { createProductServices } from "./product-services.js";

const config = loadApiConfig();
clearDesktopApiTokenEnvironment(process.env);
const database = createDatabase(config.DATABASE_URL);
const unitOfWork = new PostgresUnitOfWork(database);
const integrationUnitOfWork = new PostgresIntegrationUnitOfWork(database);
const naturalLanguageProposalUnitOfWork = new PostgresNaturalLanguageProposalUnitOfWork(database);
const clock = { now: () => new Date() };
const localModel =
  config.LOCAL_MODEL_ADVISOR_MODE === "ollama" || config.LOCAL_MODEL_PROPOSAL_MODE === "ollama"
    ? new OllamaSchedulingAdvisor({
        baseUrl: config.LOCAL_MODEL_ADVISOR_URL,
        model: config.LOCAL_MODEL_ADVISOR_MODEL,
        connectTimeoutMs: config.LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS,
        requestTimeoutMs: config.LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS,
        maxResponseBytes: config.LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES,
        maxConcurrent: config.LOCAL_MODEL_ADVISOR_MAX_CONCURRENT,
      })
    : null;
const schedulingAdvisor =
  config.LOCAL_MODEL_ADVISOR_MODE === "ollama" ? localModel! : new DisabledSchedulingAdvisor();
const naturalLanguageProposer =
  config.LOCAL_MODEL_PROPOSAL_MODE === "ollama"
    ? localModel!
    : new DisabledNaturalLanguageProposer();
const productServices = createProductServices(unitOfWork, clock, schedulingAdvisor, {
  unitOfWork: naturalLanguageProposalUnitOfWork,
  proposer: naturalLanguageProposer,
  promptHasher: createNaturalLanguagePromptHasher(
    config.LOCAL_MODEL_PROPOSAL_MODE,
    config.LOCAL_MODEL_PROPOSAL_HMAC_KEY,
  ),
  proposalTtlMilliseconds: config.LOCAL_MODEL_PROPOSAL_TTL_SECONDS * 1_000,
});
const integrationPepper = config.INTEGRATION_API_PEPPER;
let integrationServices: ReturnType<typeof createIntegrationServices> | undefined;
if (config.INTEGRATION_API_MODE === "enabled") {
  if (integrationPepper === undefined) {
    throw new Error("The enabled integration API requires a configured pepper.");
  }
  integrationServices = createIntegrationServices(
    integrationUnitOfWork,
    clock,
    integrationPepper,
    config.INTEGRATION_CONFIRMATION_TTL_SECONDS,
  );
}
const { app, composition: hostedOidcComposition } = await prepareHostedApiApp(config, database, {
  trustProxy: config.API_TRUSTED_PROXIES.length === 0 ? false : [...config.API_TRUSTED_PROXIES],
  logger:
    config.NODE_ENV === "development"
      ? {
          level: config.LOG_LEVEL,
          transport: { target: "pino-pretty", options: { colorize: true } },
        }
      : { level: config.LOG_LEVEL },
  readinessCheck: () => healthCheckDatabase(database),
  ...(config.PRODUCT_API_MODE !== "disabled"
    ? {
        productServices,
        productApiAccess:
          config.PRODUCT_API_MODE === "desktop_authenticated"
            ? {
                mode: "desktop_authenticated" as const,
                authenticator: createDesktopProductAuthenticator(config.DESKTOP_API_TOKEN_DIGEST!),
              }
            : { mode: "local_unauthenticated" as const },
        productApiLimits: {
          requestsPerMinute: config.PRODUCT_RATE_LIMIT_PER_MINUTE,
          maxConcurrentPlans: 2,
        },
      }
    : {}),
  ...(integrationServices === undefined
    ? {}
    : {
        integrationServices,
        integrationApiLimits: {
          requestsPerMinute: config.INTEGRATION_RATE_LIMIT_PER_MINUTE,
        },
      }),
});
if (config.HOSTED_API_MODE === "oidc") {
  app.log.info("hosted OIDC routes enabled");
} else if (hostedOidcComposition !== undefined) {
  app.log.info("dormant hosted OIDC preflight complete");
}

let shuttingDown = false;
let desktopShutdownControl: DesktopShutdownControl | undefined;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  desktopShutdownControl?.dispose();
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  if (config.PRODUCT_API_MODE === "desktop_authenticated") {
    process.stdout.write(desktopApiReadyLine(app.server.address()));
    desktopShutdownControl = installDesktopShutdownControl({
      mode: config.PRODUCT_API_MODE,
      input: process.stdin,
      onShutdown: () => {
        void shutdown("desktop supervisor").then(() => process.exit(0));
      },
    });
  }
} catch (error) {
  app.log.error(error, "failed to start API");
  await database.close();
  process.exit(1);
}
