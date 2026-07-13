import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  encryptWebhookSigningSecret,
  generateWebhookSigningSecret,
  type WebhookSecretEnvelope,
} from "../packages/application/src/index.js";
import { loadWorkerConfig, type WorkerConfig } from "../packages/config/src/index.js";
import {
  activatePendingWebhookSecret,
  createDatabase,
  createWebhookEndpoint,
  enqueueWebhookTestDelivery,
  listWebhookDeadLetters,
  listWebhookEndpoints,
  prepareWebhookSecretRotation,
  redriveWebhookDelivery,
  revokeWebhookEndpoint,
  type DatabaseConnection,
  type WebhookDeadLetter,
  type WebhookEndpoint,
} from "../packages/database/src/index.js";
import {
  assertPublicDnsAnswers,
  resolvePublicDns,
  validateWebhookUrl,
  type ResolvedAddress,
} from "../apps/worker/src/webhook-delivery.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TEST_EVENT_TYPE = "schedule.webhook.test.v1";

const usage = `Usage:
  pnpm webhooks -- generate-master-key --id <key-id>
  pnpm webhooks -- create --workspace <uuid> --name <text> --url <https-url>
  pnpm webhooks -- list --workspace <uuid>
  pnpm webhooks -- prepare-rotation --workspace <uuid> --endpoint <uuid>
  pnpm webhooks -- activate-rotation --workspace <uuid> --endpoint <uuid> --secret <uuid>
  pnpm webhooks -- revoke --workspace <uuid> --endpoint <uuid>
  pnpm webhooks -- send-test --workspace <uuid> --endpoint <uuid>
  pnpm webhooks -- dead-letters --workspace <uuid> [--limit <1-100>]
  pnpm webhooks -- redrive --workspace <uuid> --delivery <uuid>`;

export type WebhookEndpointCliCommand =
  | { readonly kind: "generate-master-key"; readonly keyId: string }
  | {
      readonly kind: "create";
      readonly workspaceId: string;
      readonly name: string;
      readonly url: string;
    }
  | { readonly kind: "list"; readonly workspaceId: string }
  | { readonly kind: "prepare-rotation"; readonly workspaceId: string; readonly endpointId: string }
  | {
      readonly kind: "activate-rotation";
      readonly workspaceId: string;
      readonly endpointId: string;
      readonly secretId: string;
    }
  | { readonly kind: "revoke"; readonly workspaceId: string; readonly endpointId: string }
  | { readonly kind: "send-test"; readonly workspaceId: string; readonly endpointId: string }
  | { readonly kind: "dead-letters"; readonly workspaceId: string; readonly limit: number }
  | { readonly kind: "redrive"; readonly workspaceId: string; readonly deliveryId: string };

export interface WebhookEndpointCliDependencies {
  readonly loadConfig: (environment: NodeJS.ProcessEnv) => WorkerConfig;
  readonly createConnection: (databaseUrl: string) => DatabaseConnection;
  readonly createEndpoint: typeof createWebhookEndpoint;
  readonly listEndpoints: typeof listWebhookEndpoints;
  readonly prepareRotation: typeof prepareWebhookSecretRotation;
  readonly activateRotation: typeof activatePendingWebhookSecret;
  readonly revokeEndpoint: typeof revokeWebhookEndpoint;
  readonly enqueueTestDelivery: typeof enqueueWebhookTestDelivery;
  readonly listDeadLetters: typeof listWebhookDeadLetters;
  readonly redriveDelivery: typeof redriveWebhookDelivery;
  readonly validateUrl: typeof validateWebhookUrl;
  readonly resolveDns: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly assertPublicDns: typeof assertPublicDnsAnswers;
  readonly randomUuid: () => string;
  readonly random: (size: number) => Buffer;
  readonly now: () => Date;
  readonly write: (line: string) => void;
}

const productionDependencies: WebhookEndpointCliDependencies = {
  loadConfig: loadWorkerConfig,
  createConnection: (databaseUrl) => createDatabase(databaseUrl, 1),
  createEndpoint: createWebhookEndpoint,
  listEndpoints: listWebhookEndpoints,
  prepareRotation: prepareWebhookSecretRotation,
  activateRotation: activatePendingWebhookSecret,
  revokeEndpoint: revokeWebhookEndpoint,
  enqueueTestDelivery: enqueueWebhookTestDelivery,
  listDeadLetters: listWebhookDeadLetters,
  redriveDelivery: redriveWebhookDelivery,
  validateUrl: validateWebhookUrl,
  resolveDns: resolvePublicDns,
  assertPublicDns: assertPublicDnsAnswers,
  randomUuid: randomUUID,
  random: randomBytes,
  now: () => new Date(),
  write: (line) => console.log(line),
};

function argumentError(message: string): Error {
  return new Error(`${message}\n${usage}`);
}

function requireUuid(value: string | undefined, flag: string): string {
  if (value === undefined || !UUID.test(value))
    throw argumentError(`${flag} must be a valid UUID.`);
  return value.toLowerCase();
}

function parseFlags(
  tokens: readonly string[],
  allowed: readonly string[],
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !token.startsWith("--") || token === "--") {
      throw argumentError(`Unexpected argument: ${token ?? ""}`);
    }
    const separator = token.indexOf("=");
    const flag = separator < 0 ? token : token.slice(0, separator);
    if (!allowed.includes(flag)) throw argumentError(`Unknown option: ${flag}`);
    if (values.has(flag)) throw argumentError(`Option may only be supplied once: ${flag}`);
    const value = separator < 0 ? tokens[index + 1] : token.slice(separator + 1);
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--"))) {
      throw argumentError(`Option requires a value: ${flag}`);
    }
    if (separator < 0) index += 1;
    values.set(flag, value);
  }
  return values;
}

function requirePrintableName(value: string | undefined): string {
  const name = value?.trim();
  if (
    name === undefined ||
    name.length === 0 ||
    name.length > 160 ||
    /[\p{Cc}\p{Cf}]/u.test(name)
  ) {
    throw argumentError("--name must contain 1 to 160 printable characters.");
  }
  return name;
}

function requireHttpsUrl(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 2_048 || /\s/u.test(value)) {
    throw argumentError("--url must be an HTTPS URL no longer than 2048 characters.");
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "")
      throw new Error();
  } catch {
    throw argumentError("--url must be an HTTPS URL no longer than 2048 characters.");
  }
  return value;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    throw argumentError("--limit must be a whole number between 1 and 100.");
  }
  return Number(value);
}

export function parseWebhookEndpointArguments(args: readonly string[]): WebhookEndpointCliCommand {
  const normalized = args.filter((value) => value !== "--");
  const command = normalized[0];
  const tokens = normalized.slice(1);
  const flagsFor = (allowed: readonly string[]) => parseFlags(tokens, allowed);
  const workspaceEndpoint = (allowed: readonly string[]) => {
    const flags = flagsFor(allowed);
    return {
      flags,
      workspaceId: requireUuid(flags.get("--workspace"), "--workspace"),
      endpointId: requireUuid(flags.get("--endpoint"), "--endpoint"),
    };
  };

  if (command === "generate-master-key") {
    const flags = flagsFor(["--id"]);
    const keyId = flags.get("--id");
    if (keyId === undefined || !KEY_ID.test(keyId)) {
      throw argumentError("--id must be a lowercase webhook master-key identifier.");
    }
    return { kind: command, keyId };
  }
  if (command === "create") {
    const flags = flagsFor(["--workspace", "--name", "--url"]);
    return {
      kind: command,
      workspaceId: requireUuid(flags.get("--workspace"), "--workspace"),
      name: requirePrintableName(flags.get("--name")),
      url: requireHttpsUrl(flags.get("--url")),
    };
  }
  if (command === "list") {
    const flags = flagsFor(["--workspace"]);
    return { kind: command, workspaceId: requireUuid(flags.get("--workspace"), "--workspace") };
  }
  if (command === "prepare-rotation") {
    const value = workspaceEndpoint(["--workspace", "--endpoint"]);
    return { kind: command, workspaceId: value.workspaceId, endpointId: value.endpointId };
  }
  if (command === "activate-rotation") {
    const value = workspaceEndpoint(["--workspace", "--endpoint", "--secret"]);
    return {
      kind: command,
      workspaceId: value.workspaceId,
      endpointId: value.endpointId,
      secretId: requireUuid(value.flags.get("--secret"), "--secret"),
    };
  }
  if (command === "revoke" || command === "send-test") {
    const value = workspaceEndpoint(["--workspace", "--endpoint"]);
    return { kind: command, workspaceId: value.workspaceId, endpointId: value.endpointId };
  }
  if (command === "dead-letters") {
    const flags = flagsFor(["--workspace", "--limit"]);
    return {
      kind: command,
      workspaceId: requireUuid(flags.get("--workspace"), "--workspace"),
      limit: parseLimit(flags.get("--limit")),
    };
  }
  if (command === "redrive") {
    const flags = flagsFor(["--workspace", "--delivery"]);
    return {
      kind: command,
      workspaceId: requireUuid(flags.get("--workspace"), "--workspace"),
      deliveryId: requireUuid(flags.get("--delivery"), "--delivery"),
    };
  }
  throw argumentError("Expected a webhook endpoint command.");
}

export function createWebhookTestBody(eventId: string, occurredAt: Date): string {
  const canonicalId = requireUuid(eventId, "eventId");
  if (!Number.isFinite(occurredAt.getTime()))
    throw new Error("A valid event timestamp is required.");
  return JSON.stringify({
    specversion: "1.0",
    id: canonicalId,
    type: TEST_EVENT_TYPE,
    time: occurredAt.toISOString(),
  });
}

function activeKey(config: WorkerConfig): { readonly id: string; readonly material: string } {
  const key = config.WEBHOOK_MASTER_KEYS_BY_ID.get(config.WEBHOOK_ACTIVE_MASTER_KEY_ID);
  if (config.WEBHOOK_ACTIVE_MASTER_KEY_ID === "" || key === undefined) {
    throw new Error(
      "An active webhook master key must be configured before creating or rotating a signing secret.",
    );
  }
  return key;
}

function secretEnvelope(
  command: { readonly workspaceId: string; readonly endpointId: string },
  secretId: string,
  key: { readonly id: string; readonly material: string },
  random: (size: number) => Buffer,
): { readonly secret: string; readonly envelope: WebhookSecretEnvelope } {
  const secret = generateWebhookSigningSecret(random);
  return {
    secret,
    envelope: encryptWebhookSigningSecret({
      workspaceId: command.workspaceId,
      endpointId: command.endpointId,
      secretId,
      masterKeyId: key.id,
      masterKey: key.material,
      signingSecret: secret,
      randomBytes: random,
    }),
  };
}

function endpointMetadata(endpoint: WebhookEndpoint): object {
  return {
    id: endpoint.id,
    workspaceId: endpoint.workspaceId,
    name: endpoint.name,
    status: endpoint.status,
  };
}

function deadLetterMetadata(letter: WebhookDeadLetter): object {
  return {
    deliveryId: letter.deliveryId,
    outboxEventId: letter.outboxEventId,
    endpointId: letter.endpointId,
    eventId: letter.eventId,
    eventType: letter.eventType,
    eventOccurredAt: letter.eventOccurredAt.toISOString(),
    createdAt: letter.createdAt.toISOString(),
    attempts: letter.attempts,
  };
}

async function withConnection(
  config: WorkerConfig,
  dependencies: WebhookEndpointCliDependencies,
  operation: (connection: DatabaseConnection) => Promise<void>,
): Promise<void> {
  const connection = dependencies.createConnection(config.DATABASE_URL);
  let failure: unknown;
  try {
    await operation(connection);
  } catch (error) {
    failure = error;
  }
  try {
    await connection.close();
  } catch (closeError) {
    failure = failure === undefined ? closeError : new AggregateError([failure, closeError]);
  }
  if (failure !== undefined) throw failure;
}

/**
 * Operator input receives the same parse-and-resolve protection as delivery,
 * before an endpoint record can make an unsafe target durable.  The command
 * intentionally collapses all underlying diagnostics because they can contain
 * a private hostname or resolver detail.
 */
async function preflightWebhookUrl(
  url: string,
  dependencies: Pick<
    WebhookEndpointCliDependencies,
    "validateUrl" | "resolveDns" | "assertPublicDns"
  >,
): Promise<void> {
  try {
    const parsed = dependencies.validateUrl(url);
    dependencies.assertPublicDns(await dependencies.resolveDns(parsed.hostname));
  } catch {
    throw new Error("Webhook endpoint URL did not pass network preflight.");
  }
}

export async function runWebhookEndpointCommand(
  command: WebhookEndpointCliCommand,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: WebhookEndpointCliDependencies = productionDependencies,
): Promise<void> {
  if (command.kind === "generate-master-key") {
    const material = dependencies.random(32);
    if (!Buffer.isBuffer(material) || material.byteLength !== 32) {
      throw new Error("Webhook master-key generation requires exactly 32 random bytes.");
    }
    const key = material.toString("base64url");
    dependencies.write(`WEBHOOK_MASTER_KEYS=${command.keyId}:${key}`);
    dependencies.write(`WEBHOOK_ACTIVE_MASTER_KEY_ID=${command.keyId}`);
    return;
  }

  const config = dependencies.loadConfig(environment);
  if (command.kind === "create") await preflightWebhookUrl(command.url, dependencies);
  await withConnection(config, dependencies, async (connection) => {
    if (command.kind === "create" || command.kind === "prepare-rotation") {
      const key = activeKey(config);
      const endpointId =
        command.kind === "create" ? dependencies.randomUuid().toLowerCase() : command.endpointId;
      const secretId = dependencies.randomUuid().toLowerCase();
      const generated = secretEnvelope(
        { workspaceId: command.workspaceId, endpointId },
        secretId,
        key,
        dependencies.random,
      );
      if (command.kind === "create") {
        const endpoint = await dependencies.createEndpoint(connection, {
          workspaceId: command.workspaceId,
          endpointId,
          secretId,
          name: command.name,
          url: command.url,
          secretEnvelope: generated.envelope,
        });
        dependencies.write(
          JSON.stringify({ ...endpointMetadata(endpoint), signingSecret: generated.secret }),
        );
        return;
      }
      const result = await dependencies.prepareRotation(connection, {
        workspaceId: command.workspaceId,
        endpointId,
        secretId,
        secretEnvelope: generated.envelope,
      });
      if (result === null)
        throw new Error("Webhook endpoint was not active or already has a pending rotation.");
      dependencies.write(
        JSON.stringify({
          endpointId: result.endpointId,
          secretId: result.id,
          version: result.version,
          signingSecret: generated.secret,
        }),
      );
      return;
    }

    if (command.kind === "list") {
      const endpoints = await dependencies.listEndpoints(connection, command.workspaceId);
      dependencies.write(JSON.stringify(endpoints.map(endpointMetadata)));
      return;
    }
    if (command.kind === "activate-rotation") {
      const result = await dependencies.activateRotation(connection, command);
      if (result === null) throw new Error("Webhook secret rotation could not be activated.");
      dependencies.write(
        JSON.stringify({
          endpointId: result.endpointId,
          secretId: result.id,
          version: result.version,
          status: result.status,
        }),
      );
      return;
    }
    if (command.kind === "revoke") {
      if (!(await dependencies.revokeEndpoint(connection, command)))
        throw new Error("Webhook endpoint could not be revoked.");
      dependencies.write(JSON.stringify({ endpointId: command.endpointId, status: "revoked" }));
      return;
    }
    if (command.kind === "send-test") {
      const eventId = dependencies.randomUuid().toLowerCase();
      const occurredAt = dependencies.now();
      const delivery = await dependencies.enqueueTestDelivery(connection, {
        workspaceId: command.workspaceId,
        endpointId: command.endpointId,
        eventId,
        eventType: TEST_EVENT_TYPE,
        eventOccurredAt: occurredAt,
        rawBody: createWebhookTestBody(eventId, occurredAt),
      });
      if (delivery === null) throw new Error("Webhook test delivery could not be queued.");
      dependencies.write(
        JSON.stringify({
          deliveryId: delivery.id,
          outboxEventId: delivery.outboxEventId,
          eventId: delivery.eventId,
        }),
      );
      return;
    }
    if (command.kind === "dead-letters") {
      const letters = await dependencies.listDeadLetters(connection, command);
      dependencies.write(JSON.stringify(letters.map(deadLetterMetadata)));
      return;
    }
    if (!(await dependencies.redriveDelivery(connection, command))) {
      throw new Error("Webhook delivery could not be redriven.");
    }
    dependencies.write(JSON.stringify({ deliveryId: command.deliveryId, status: "pending" }));
  });
}

async function main(): Promise<void> {
  try {
    await runWebhookEndpointCommand(parseWebhookEndpointArguments(process.argv.slice(2)));
  } catch {
    // Deliberately do not expose database, configuration, endpoint, or secret details.
    console.error("Webhook endpoint command failed.");
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
