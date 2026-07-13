import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  integrationCredentialScopes as supportedIntegrationCredentialScopes,
  ListIntegrationCredentials,
  ProvisionIntegrationCredential,
  RevokeIntegrationCredential,
  type IntegrationCredentialScope,
} from "../packages/application/src/index.js";
import { loadApiConfig } from "../packages/config/src/index.js";
import { createDatabase, PostgresIntegrationUnitOfWork } from "../packages/database/src/index.js";
import { workspaceId } from "../packages/domain/src/index.js";

export const integrationCredentialScopes = supportedIntegrationCredentialScopes;

export type IntegrationCredentialCliCommand =
  | {
      readonly kind: "create";
      readonly workspaceId: string;
      readonly name: string;
      readonly scopes: readonly IntegrationCredentialScope[];
    }
  | { readonly kind: "revoke"; readonly credentialId: string }
  | { readonly kind: "list"; readonly workspaceId: string };

const usage = `Usage:
  pnpm integration:credentials -- create --workspace <uuid> --name <text> [--scopes schedule:read,schedule:write]
  pnpm integration:credentials -- revoke --credential <uuid>
  pnpm integration:credentials -- list --workspace <uuid>`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function commandError(message: string): Error {
  return new Error(`${message}\n${usage}`);
}

function requireUuid(value: string | undefined, flag: string): string {
  if (value === undefined || !uuidPattern.test(value)) {
    throw commandError(`${flag} must be a valid UUID.`);
  }
  return value.toLowerCase();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseFlags(
  tokens: readonly string[],
  allowed: readonly string[],
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !token.startsWith("--") || token === "--") {
      throw commandError(`Unexpected argument: ${token ?? ""}`);
    }

    const separator = token.indexOf("=");
    const flag = separator < 0 ? token : token.slice(0, separator);
    if (!allowed.includes(flag)) throw commandError(`Unknown option: ${flag}`);
    if (values.has(flag)) throw commandError(`Option may only be supplied once: ${flag}`);

    const inlineValue = separator < 0 ? undefined : token.slice(separator + 1);
    const followingValue = separator < 0 ? tokens[index + 1] : undefined;
    const value = inlineValue ?? followingValue;
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--"))) {
      throw commandError(`Option requires a value: ${flag}`);
    }
    if (separator < 0) index += 1;
    values.set(flag, value);
  }
  return values;
}

function parseScopes(value: string | undefined): readonly IntegrationCredentialScope[] {
  if (value === undefined) return integrationCredentialScopes;
  const requested = value.split(",").map((scope) => scope.trim());
  if (requested.some((scope) => scope === "")) {
    throw commandError("--scopes must be a comma-separated list without empty entries.");
  }
  if (new Set(requested).size !== requested.length) {
    throw commandError("--scopes must not contain duplicates.");
  }
  const unknown = requested.filter(
    (scope): scope is string =>
      !integrationCredentialScopes.includes(scope as IntegrationCredentialScope),
  );
  if (unknown.length > 0) {
    throw commandError(`Unsupported integration credential scope: ${unknown.join(", ")}`);
  }
  const selected = new Set(requested);
  return integrationCredentialScopes.filter((scope) => selected.has(scope));
}

export function parseIntegrationCredentialArguments(
  args: readonly string[],
): IntegrationCredentialCliCommand {
  const normalized = args.filter((argument) => argument !== "--");
  const command = normalized[0];
  const tokens = normalized.slice(1);

  if (command === "create") {
    const flags = parseFlags(tokens, ["--workspace", "--name", "--scopes"]);
    const workspaceId = requireUuid(flags.get("--workspace"), "--workspace");
    const name = flags.get("--name")?.trim();
    if (
      name === undefined ||
      name.length === 0 ||
      name.length > 120 ||
      containsControlCharacter(name)
    ) {
      throw commandError("--name must contain 1 to 120 printable characters.");
    }
    return {
      kind: "create",
      workspaceId,
      name,
      scopes: parseScopes(flags.get("--scopes")),
    };
  }

  if (command === "revoke") {
    const flags = parseFlags(tokens, ["--credential"]);
    return {
      kind: "revoke",
      credentialId: requireUuid(flags.get("--credential"), "--credential"),
    };
  }

  if (command === "list") {
    const flags = parseFlags(tokens, ["--workspace"]);
    return {
      kind: "list",
      workspaceId: requireUuid(flags.get("--workspace"), "--workspace"),
    };
  }

  throw commandError("Expected one of: create, revoke, list.");
}

type RandomBytes = (size: number) => Buffer;

export function generateIntegrationCredentialSecret(
  generateRandomBytes: RandomBytes = randomBytes,
): string {
  const entropy = generateRandomBytes(32);
  if (entropy.length < 32) {
    throw new Error("Integration credential generation requires at least 32 random bytes.");
  }
  return entropy.toString("base64url");
}

export function hashIntegrationCredentialSecret(secret: string, pepper: string): string {
  if (pepper.length < 32) {
    throw new Error("INTEGRATION_API_PEPPER must contain at least 32 characters.");
  }
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) {
    throw new Error(
      "Integration credential secret must be a base64url value with 32-byte entropy.",
    );
  }
  return createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
}

export function formatIntegrationCredentialToken(credentialId: string, secret: string): string {
  const normalizedId = requireUuid(credentialId, "credentialId");
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) {
    throw new Error(
      "Integration credential secret must be a base64url value with 32-byte entropy.",
    );
  }
  return `${normalizedId}.${secret}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runIntegrationCredentialCommand(
  command: IntegrationCredentialCliCommand,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = loadApiConfig(environment);
  const pepper = config.INTEGRATION_API_PEPPER;
  if (command.kind === "create" && (pepper === undefined || pepper.length < 32)) {
    throw new Error(
      "INTEGRATION_API_PEPPER must contain at least 32 characters before creating a credential.",
    );
  }

  const connection = createDatabase(config.DATABASE_URL, 1);
  try {
    const unitOfWork = new PostgresIntegrationUnitOfWork(connection);
    if (command.kind === "create") {
      // The guard above narrows the runtime invariant; this branch cannot run without a pepper.
      if (pepper === undefined) throw new Error("Integration credential pepper is unavailable.");
      const secret = generateIntegrationCredentialSecret();
      const credential = await new ProvisionIntegrationCredential(unitOfWork, {
        now: () => new Date(),
      }).execute({
        workspaceId: workspaceId(command.workspaceId),
        name: command.name,
        scopes: command.scopes,
        secretHash: hashIntegrationCredentialSecret(secret, pepper),
      });
      console.log("Credential created. Copy it now; it cannot be shown again:");
      console.log(formatIntegrationCredentialToken(credential.id, secret));
      return;
    }

    if (command.kind === "revoke") {
      const credential = await new RevokeIntegrationCredential(unitOfWork, {
        now: () => new Date(),
      }).execute({ credentialId: command.credentialId });
      console.log(`Credential revoked: ${credential.id}`);
      return;
    }

    const credentials = await new ListIntegrationCredentials(unitOfWork).execute({
      workspaceId: workspaceId(command.workspaceId),
    });
    console.log(JSON.stringify(credentials, null, 2));
  } finally {
    await connection.close();
  }
}

async function main(): Promise<void> {
  try {
    const command = parseIntegrationCredentialArguments(process.argv.slice(2));
    await runIntegrationCredentialCommand(command);
  } catch (error) {
    console.error(`Integration credential command failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
