import { createHash, randomUUID } from "node:crypto";

import {
  DomainError,
  activityEventTypes,
  createScheduleBlock,
  createWorkItem,
  dailyPlanId,
  isIanaTimeZone,
  isValidLocalDate,
  isPlanItemActivityActionType,
  localDate,
  planItemId,
  planItemActivityStates,
  scheduleBlockId,
  updateScheduleBlock,
  updateWorkItem,
  workItemId,
  workItemPriorities,
  workItemStatuses,
  type ActivityEvent,
  type JsonValue,
  type ScheduleBlock,
  type WorkItem,
  type WorkspaceId,
} from "@schedule/domain";

import type {
  Clock,
  ConfirmedIntegrationCommandResult,
  IntegrationActivityEventDto,
  IntegrationCommand,
  IntegrationCommandOutcome,
  IntegrationCredential,
  IntegrationCredentialRepository,
  IntegrationCredentialScope,
  IntegrationPlanItemActivityDto,
  IntegrationPrincipal,
  IntegrationRequestRecord,
  IntegrationScheduleBlockDto,
  IntegrationTransactionContext,
  IntegrationUnitOfWork,
  IntegrationWorkItemDto,
  PlanItemActivityResult,
  PreparedIntegrationCommand,
  SecretVerifier,
} from "./ports.js";

const GENERIC_AUTHENTICATION_MESSAGE = "The integration credential could not be authenticated.";
const DUMMY_SECRET_HASH = "0".repeat(64);
const DEFAULT_CONFIRMATION_TTL_MILLISECONDS = 10 * 60 * 1_000;

export interface IntegrationCredentialDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly scopes: readonly IntegrationCredentialScope[];
  readonly active: boolean;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProvisionIntegrationCredentialCommand {
  readonly id?: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly scopes: readonly IntegrationCredentialScope[];
  readonly secretHash: string;
  readonly expiresAt?: Date | null;
}

export interface RevokeIntegrationCredentialCommand {
  readonly credentialId: string;
}

export interface ListIntegrationCredentialsQuery {
  readonly workspaceId: WorkspaceId;
}

export interface AuthenticateIntegrationCredentialCommand {
  readonly credentialId: string;
  readonly secret: string;
  readonly requiredScope: IntegrationCredentialScope;
}

export interface IntegrationTodayResult {
  readonly workspaceId: string;
  readonly date: string;
  readonly headVersion: number;
  readonly plan: JsonValue;
}

export interface GetIntegrationTodayQuery {
  readonly principal: IntegrationPrincipal;
  readonly date: string;
}

export interface ListIntegrationWorkItemsQuery {
  readonly principal: IntegrationPrincipal;
  readonly status?: unknown;
  readonly priority?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface IntegrationWorkItemPageResult {
  readonly items: readonly IntegrationWorkItemDto[];
  readonly page: {
    readonly limit: number;
    readonly offset: number;
  };
}

export interface PrepareIntegrationCommandInput {
  readonly principal: IntegrationPrincipal;
  readonly requestId: string;
  readonly command: IntegrationCommand;
}

export interface ConfirmIntegrationCommandInput {
  readonly principal: IntegrationPrincipal;
  readonly confirmationId: string;
  readonly idempotencyKey: string;
}

function validNow(clock: Clock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DomainError(
      "integration.timestamp_invalid",
      "A valid integration timestamp is required.",
    );
  }
  return new Date(now);
}

function normalizeBounded(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new DomainError(`integration.${field}_invalid`, `${field} must be text.`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new DomainError(
      `integration.${field}_invalid`,
      `${field} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

function normalizeUuid(value: unknown, field: string): string {
  const normalized = normalizeBounded(value, field, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
  ) {
    throw new DomainError(`integration.${field}_invalid`, `${field} must be a UUID.`);
  }
  return normalized.toLowerCase();
}

function isScope(value: unknown): value is IntegrationCredentialScope {
  return value === "schedule:read" || value === "schedule:write";
}

function credentialIsUsable(credential: IntegrationCredential, now: Date): boolean {
  return (
    credential.active &&
    credential.revokedAt === null &&
    (credential.expiresAt === null || credential.expiresAt.getTime() > now.getTime())
  );
}

function requireScope(
  credential: IntegrationCredential,
  requiredScope: IntegrationCredentialScope,
): void {
  if (!credential.scopes.includes(requiredScope)) {
    throw new DomainError(
      "integration.scope_denied",
      "The integration credential does not grant the required scope.",
    );
  }
}

async function revalidateCredential(
  credentials: IntegrationCredentialRepository,
  principal: IntegrationPrincipal,
  requiredScope: IntegrationCredentialScope,
  now: Date,
): Promise<IntegrationCredential> {
  const credential =
    typeof principal.credentialId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      principal.credentialId,
    )
      ? await credentials.findById(principal.credentialId)
      : null;
  if (credential === null || !credentialIsUsable(credential, now)) {
    throw new DomainError("integration.authentication_failed", GENERIC_AUTHENTICATION_MESSAGE);
  }
  requireScope(credential, requiredScope);
  return credential;
}

function toCredentialDto(credential: IntegrationCredential): IntegrationCredentialDto {
  return {
    id: credential.id,
    workspaceId: credential.workspaceId,
    name: credential.name,
    scopes: [...credential.scopes],
    active: credential.active,
    expiresAt: credential.expiresAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    version: credential.version,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
  };
}

export class AuthenticateIntegrationCredential {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly clock: Clock,
    private readonly secretVerifier: SecretVerifier,
  ) {}

  async execute(command: AuthenticateIntegrationCredentialCommand): Promise<IntegrationPrincipal> {
    const now = validNow(this.clock);
    const credentialId =
      typeof command.credentialId === "string" ? command.credentialId.trim() : "";
    const credential =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        credentialId,
      )
        ? await this.unitOfWork.run(({ credentials }) => credentials.findById(credentialId))
        : null;
    let secretMatches: boolean;
    try {
      secretMatches = await this.secretVerifier.verify(
        typeof command.secret === "string" ? command.secret : "",
        credential?.secretHash ?? DUMMY_SECRET_HASH,
      );
    } catch {
      secretMatches = false;
    }
    if (credential === null || !secretMatches || !credentialIsUsable(credential, now)) {
      throw new DomainError("integration.authentication_failed", GENERIC_AUTHENTICATION_MESSAGE);
    }
    if (!isScope(command.requiredScope)) {
      throw new DomainError(
        "integration.scope_denied",
        "A supported integration scope is required.",
      );
    }
    requireScope(credential, command.requiredScope);
    return {
      credentialId: credential.id,
      workspaceId: credential.workspaceId,
      scopes: [...credential.scopes],
    };
  }
}

export class ProvisionIntegrationCredential {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: ProvisionIntegrationCredentialCommand): Promise<IntegrationCredentialDto> {
    const now = validNow(this.clock);
    const id = command.id === undefined ? randomUUID() : normalizeUuid(command.id, "credential_id");
    const name = normalizeBounded(command.name, "credential_name", 120);
    const secretHash = normalizeBounded(command.secretHash, "secret_hash", 64);
    if (!/^[0-9a-f]{64}$/.test(secretHash)) {
      throw new DomainError(
        "integration.secret_hash_invalid",
        "secret_hash must be a 64-character lowercase hexadecimal digest.",
      );
    }
    if (
      !Array.isArray(command.scopes) ||
      command.scopes.length < 1 ||
      !command.scopes.every(isScope)
    ) {
      throw new DomainError(
        "integration.scopes_invalid",
        "At least one supported integration scope is required.",
      );
    }
    const scopes = [...new Set(command.scopes)].sort() as IntegrationCredentialScope[];
    const expiresAt = command.expiresAt ?? null;
    if (
      expiresAt !== null &&
      (!(expiresAt instanceof Date) ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= now.getTime())
    ) {
      throw new DomainError(
        "integration.expiry_invalid",
        "Credential expiry must be a valid future timestamp or null.",
      );
    }
    const credential: IntegrationCredential = {
      id,
      workspaceId: command.workspaceId,
      name,
      secretHash,
      scopes,
      active: true,
      expiresAt: expiresAt === null ? null : new Date(expiresAt),
      revokedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.unitOfWork.run(async ({ credentials, workspaces, auditEvents }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      await credentials.insert(credential);
      await auditEvents.append({
        workspaceId: credential.workspaceId,
        action: "integration.credential_provisioned",
        entityType: "integration_credential",
        entityId: credential.id,
        data: {
          name: credential.name,
          scopes: credential.scopes,
          expiresAt: credential.expiresAt?.toISOString() ?? null,
        },
        occurredAt: now,
      });
      return toCredentialDto(credential);
    });
  }
}

export class RevokeIntegrationCredential {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: RevokeIntegrationCredentialCommand): Promise<IntegrationCredentialDto> {
    const now = validNow(this.clock);
    const id = normalizeUuid(command.credentialId, "credential_id");
    return this.unitOfWork.run(async ({ credentials, auditEvents }) => {
      const current = await credentials.findById(id);
      if (current === null) {
        throw new DomainError(
          "integration.credential_not_found",
          "The integration credential does not exist.",
        );
      }
      if (!current.active && current.revokedAt !== null) return toCredentialDto(current);
      const revoked: IntegrationCredential = {
        ...current,
        active: false,
        revokedAt: now,
        updatedAt: now,
        version: current.version + 1,
      };
      await credentials.save(revoked, current.version);
      await auditEvents.append({
        workspaceId: revoked.workspaceId,
        action: "integration.credential_revoked",
        entityType: "integration_credential",
        entityId: revoked.id,
        data: {},
        occurredAt: now,
      });
      return toCredentialDto(revoked);
    });
  }
}

export class ListIntegrationCredentials {
  constructor(private readonly unitOfWork: IntegrationUnitOfWork) {}

  execute(query: ListIntegrationCredentialsQuery): Promise<readonly IntegrationCredentialDto[]> {
    return this.unitOfWork.run(async ({ credentials, workspaces }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      return (await credentials.list(query.workspaceId)).map(toCredentialDto);
    });
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError(
        "integration.result_invalid",
        "Integration results require finite numbers.",
      );
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value !== "object") {
    throw new DomainError("integration.result_invalid", "Integration results must be JSON-ready.");
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    result[key] = toJsonValue(child);
  }
  return result;
}

export class GetIntegrationToday {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(query: GetIntegrationTodayQuery): Promise<IntegrationTodayResult> {
    const now = validNow(this.clock);
    const date = localDate(query.date);
    return this.unitOfWork.run(async ({ credentials, dailyPlans }) => {
      const credential = await revalidateCredential(
        credentials,
        query.principal,
        "schedule:read",
        now,
      );
      const current = await dailyPlans.findCurrent(credential.workspaceId, date);
      if (current === null) {
        throw new DomainError(
          "planning.current_not_found",
          "No current plan exists for this date.",
        );
      }
      const { inputSnapshot, ...plan } = current.plan;
      const request =
        typeof inputSnapshot === "object" &&
        inputSnapshot !== null &&
        !Array.isArray(inputSnapshot) &&
        "request" in inputSnapshot
          ? inputSnapshot.request
          : null;
      return {
        workspaceId: credential.workspaceId,
        date,
        headVersion: current.headVersion,
        plan: toJsonValue({ ...plan, request }),
      };
    });
  }
}

function optionalWorkItemStatus(value: unknown): (typeof workItemStatuses)[number] | undefined {
  if (value === undefined) return undefined;
  if (!workItemStatuses.includes(value as never)) {
    throw new DomainError("integration.work_item_status_invalid", "status is not supported.");
  }
  return value as (typeof workItemStatuses)[number];
}

function optionalWorkItemPriority(value: unknown): (typeof workItemPriorities)[number] | undefined {
  if (value === undefined) return undefined;
  if (!workItemPriorities.includes(value as never)) {
    throw new DomainError("integration.work_item_priority_invalid", "priority is not supported.");
  }
  return value as (typeof workItemPriorities)[number];
}

function boundedIntegrationPageValue(
  value: unknown,
  field: "limit" | "offset",
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new DomainError(
      `integration.work_item_${field}_invalid`,
      `${field} must be a whole number between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export class ListIntegrationWorkItems {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(query: ListIntegrationWorkItemsQuery): Promise<IntegrationWorkItemPageResult> {
    const now = validNow(this.clock);
    const status = optionalWorkItemStatus(query.status);
    const priority = optionalWorkItemPriority(query.priority);
    const limit = boundedIntegrationPageValue(query.limit, "limit", 100, 1, 200);
    const offset = boundedIntegrationPageValue(query.offset, "offset", 0, 0, 1_000_000);
    return this.unitOfWork.run(async ({ credentials, workspaces, workItems }) => {
      const credential = await revalidateCredential(
        credentials,
        query.principal,
        "schedule:read",
        now,
      );
      if ((await workspaces.findById(credential.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const items = await workItems.list(credential.workspaceId, status, priority, limit, offset);
      return { items: items.map(toWorkItemDto), page: { limit, offset } };
    });
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertCommandObject(
  command: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts command is Readonly<Record<string, unknown>> {
  if (typeof command !== "object" || command === null || Array.isArray(command)) {
    throw new DomainError(
      "integration.command_invalid",
      "An integration command must be an object.",
    );
  }
  const keys = Object.keys(command);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !hasOwn(command, key))) {
    throw new DomainError(
      "integration.command_invalid",
      "The integration command has missing or unsupported fields.",
    );
  }
  if (keys.some((key) => (command as Record<string, unknown>)[key] === undefined)) {
    throw new DomainError(
      "integration.command_invalid",
      "Integration command fields must be JSON values, not undefined.",
    );
  }
}

function requireText(value: unknown, field: string, allowNull = false): void {
  if ((allowNull && value === null) || typeof value === "string") return;
  throw new DomainError(
    "integration.command_invalid",
    `${field} must be text${allowNull ? " or null" : ""}.`,
  );
}

function requireOptionalText(
  command: Readonly<Record<string, unknown>>,
  field: string,
  allowNull = false,
): void {
  if (hasOwn(command, field)) requireText(command[field], field, allowNull);
}

function requireOptionalLocalDate(command: Readonly<Record<string, unknown>>, field: string): void {
  if (!hasOwn(command, field)) return;
  const value = command[field];
  if (value === null) return;
  if (typeof value === "string" && isValidLocalDate(value)) return;
  throw new DomainError(
    "integration.command_invalid",
    `${field} must be a Gregorian YYYY-MM-DD date or null.`,
  );
}

function requireTextBounds(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  trim = false,
): void {
  requireText(value, field);
  const text = trim ? (value as string).trim() : (value as string);
  if (text.length < minimum || text.length > maximum) {
    throw new DomainError(
      "integration.command_invalid",
      `${field} must contain between ${minimum} and ${maximum} characters.`,
    );
  }
}

function requireInteger(value: unknown, field: string, minimum = 1, maximum = 2_147_483_647): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DomainError(
      "integration.command_invalid",
      `${field} must be a whole number between ${minimum} and ${maximum}.`,
    );
  }
}

function parseInstant(value: unknown, field: string): Date {
  requireText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value as string)) {
    throw new DomainError("integration.command_invalid", `${field} must be an ISO timestamp.`);
  }
  const date = new Date(value as string);
  if (!Number.isFinite(date.getTime())) {
    throw new DomainError("integration.command_invalid", `${field} must be an ISO timestamp.`);
  }
  return date;
}

function validateMetadata(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError(
      "integration.command_invalid",
      "metadata must be an object of JSON scalars.",
    );
  }
  const entries = Object.entries(value);
  if (
    entries.length > 8 ||
    entries.some(
      ([key, child]) =>
        key.trim().length < 1 ||
        key.length > 64 ||
        (typeof child === "string" && child.length > 256) ||
        (child !== null &&
          typeof child !== "string" &&
          typeof child !== "boolean" &&
          !(typeof child === "number" && Number.isFinite(child))),
    )
  ) {
    throw new DomainError(
      "integration.command_invalid",
      "metadata must contain only JSON scalars.",
    );
  }
}

function validateIntegrationCommand(command: IntegrationCommand): IntegrationCommand {
  if (typeof command !== "object" || command === null) {
    throw new DomainError(
      "integration.command_invalid",
      "An integration command must be an object.",
    );
  }
  switch (command.type) {
    case "work_item.create": {
      assertCommandObject(
        command,
        ["type", "title", "description", "status", "priority", "planningDurationMinutes", "dueOn"],
        ["type", "title"],
      );
      requireTextBounds(command.title, "title", 1, 240, true);
      requireOptionalText(command, "description", true);
      if (typeof command.description === "string" && command.description.length > 4_000) {
        throw new DomainError(
          "integration.command_invalid",
          "description cannot exceed 4000 characters.",
        );
      }
      if (hasOwn(command, "status") && !workItemStatuses.includes(command.status as never)) {
        throw new DomainError("integration.command_invalid", "status is not supported.");
      }
      if (hasOwn(command, "priority") && !workItemPriorities.includes(command.priority as never)) {
        throw new DomainError("integration.command_invalid", "priority is not supported.");
      }
      if (hasOwn(command, "planningDurationMinutes") && command.planningDurationMinutes !== null) {
        requireInteger(command.planningDurationMinutes, "planningDurationMinutes", 1, 43_200);
      }
      requireOptionalLocalDate(command, "dueOn");
      break;
    }
    case "work_item.update": {
      assertCommandObject(
        command,
        [
          "type",
          "workItemId",
          "expectedVersion",
          "title",
          "description",
          "status",
          "priority",
          "planningDurationMinutes",
          "dueOn",
        ],
        ["type", "workItemId", "expectedVersion"],
      );
      normalizeUuid(command.workItemId, "work_item_id");
      requireInteger(command.expectedVersion, "expectedVersion");
      if (
        !["title", "description", "status", "priority", "planningDurationMinutes", "dueOn"].some(
          (field) => hasOwn(command, field),
        )
      ) {
        throw new DomainError(
          "integration.command_invalid",
          "A work item update must contain at least one change.",
        );
      }
      requireOptionalText(command, "title");
      requireOptionalText(command, "description", true);
      if (typeof command.title === "string") {
        requireTextBounds(command.title, "title", 1, 240, true);
      }
      if (typeof command.description === "string" && command.description.length > 4_000) {
        throw new DomainError(
          "integration.command_invalid",
          "description cannot exceed 4000 characters.",
        );
      }
      if (hasOwn(command, "status") && !workItemStatuses.includes(command.status as never)) {
        throw new DomainError("integration.command_invalid", "status is not supported.");
      }
      if (hasOwn(command, "priority") && !workItemPriorities.includes(command.priority as never)) {
        throw new DomainError("integration.command_invalid", "priority is not supported.");
      }
      if (hasOwn(command, "planningDurationMinutes") && command.planningDurationMinutes !== null) {
        requireInteger(command.planningDurationMinutes, "planningDurationMinutes", 1, 43_200);
      }
      requireOptionalLocalDate(command, "dueOn");
      break;
    }
    case "schedule_block.create": {
      assertCommandObject(
        command,
        ["type", "workItemId", "title", "startsAt", "endsAt", "timeZone"],
        ["type", "startsAt", "endsAt", "timeZone"],
      );
      if (hasOwn(command, "workItemId") && command.workItemId !== null) {
        normalizeUuid(command.workItemId, "work_item_id");
      }
      requireOptionalText(command, "title", true);
      if (typeof command.title === "string" && command.title.length > 240) {
        throw new DomainError("integration.command_invalid", "title cannot exceed 240 characters.");
      }
      const startsAt = parseInstant(command.startsAt, "startsAt");
      const endsAt = parseInstant(command.endsAt, "endsAt");
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new DomainError("integration.command_invalid", "endsAt must be after startsAt.");
      }
      requireTextBounds(command.timeZone, "timeZone", 1, 80, true);
      if (!isIanaTimeZone(command.timeZone)) {
        throw new DomainError("integration.command_invalid", "timeZone must be a valid IANA zone.");
      }
      break;
    }
    case "schedule_block.update": {
      assertCommandObject(
        command,
        [
          "type",
          "scheduleBlockId",
          "expectedVersion",
          "workItemId",
          "title",
          "startsAt",
          "endsAt",
          "timeZone",
        ],
        ["type", "scheduleBlockId", "expectedVersion"],
      );
      normalizeUuid(command.scheduleBlockId, "schedule_block_id");
      requireInteger(command.expectedVersion, "expectedVersion");
      if (
        !["workItemId", "title", "startsAt", "endsAt", "timeZone"].some((field) =>
          hasOwn(command, field),
        )
      ) {
        throw new DomainError(
          "integration.command_invalid",
          "A schedule block update must contain at least one change.",
        );
      }
      if (hasOwn(command, "workItemId") && command.workItemId !== null) {
        normalizeUuid(command.workItemId, "work_item_id");
      }
      requireOptionalText(command, "title", true);
      if (typeof command.title === "string" && command.title.length > 240) {
        throw new DomainError("integration.command_invalid", "title cannot exceed 240 characters.");
      }
      if (hasOwn(command, "startsAt")) parseInstant(command.startsAt, "startsAt");
      if (hasOwn(command, "endsAt")) parseInstant(command.endsAt, "endsAt");
      if (command.startsAt !== undefined && command.endsAt !== undefined) {
        const startsAt = parseInstant(command.startsAt, "startsAt");
        const endsAt = parseInstant(command.endsAt, "endsAt");
        if (endsAt.getTime() <= startsAt.getTime()) {
          throw new DomainError("integration.command_invalid", "endsAt must be after startsAt.");
        }
      }
      requireOptionalText(command, "timeZone");
      if (typeof command.timeZone === "string") {
        requireTextBounds(command.timeZone, "timeZone", 1, 80, true);
        if (!isIanaTimeZone(command.timeZone)) {
          throw new DomainError(
            "integration.command_invalid",
            "timeZone must be a valid IANA zone.",
          );
        }
      }
      break;
    }
    case "plan_item.activity": {
      assertCommandObject(
        command,
        [
          "type",
          "date",
          "expectedPlanId",
          "itemId",
          "expectedHeadVersion",
          "activityType",
          "occurredAt",
          "timeZone",
          "durationMinutes",
          "reason",
          "metadata",
        ],
        [
          "type",
          "date",
          "expectedPlanId",
          "itemId",
          "expectedHeadVersion",
          "activityType",
          "occurredAt",
          "timeZone",
        ],
      );
      requireText(command.date, "date");
      localDate(command.date);
      normalizeUuid(command.expectedPlanId, "plan_id");
      normalizeUuid(command.itemId, "plan_item_id");
      requireInteger(command.expectedHeadVersion, "expectedHeadVersion");
      if (
        typeof command.activityType !== "string" ||
        !isPlanItemActivityActionType(command.activityType)
      ) {
        throw new DomainError("integration.command_invalid", "activityType is not supported.");
      }
      parseInstant(command.occurredAt, "occurredAt");
      requireTextBounds(command.timeZone, "timeZone", 1, 80, true);
      if (!isIanaTimeZone(command.timeZone)) {
        throw new DomainError("integration.command_invalid", "timeZone must be a valid IANA zone.");
      }
      if (hasOwn(command, "durationMinutes") && command.durationMinutes !== null) {
        requireInteger(command.durationMinutes, "durationMinutes", 1, 43_200);
      }
      if (
        command.activityType !== "completed" &&
        hasOwn(command, "durationMinutes") &&
        command.durationMinutes !== null
      ) {
        throw new DomainError(
          "integration.command_invalid",
          "Only a completed plan item can record an actual duration.",
        );
      }
      requireOptionalText(command, "reason", true);
      if (typeof command.reason === "string" && command.reason.length > 500) {
        throw new DomainError(
          "integration.command_invalid",
          "reason cannot exceed 500 characters.",
        );
      }
      if (hasOwn(command, "metadata")) validateMetadata(command.metadata);
      break;
    }
    default:
      throw new DomainError(
        "integration.command_invalid",
        "The integration command type is not supported.",
      );
  }
  return command;
}

function displayJsonString(value: string): string {
  let encoded = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && unsafeSummaryCodePoint(codePoint)) {
      for (let index = 0; index < character.length; index += 1) {
        encoded += `\\u${character.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
      }
    } else {
      const jsonCharacter = JSON.stringify(character);
      encoded += jsonCharacter.slice(1, -1);
    }
  }
  return `${encoded}"`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return displayJsonString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new DomainError("integration.command_invalid", "Numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object") {
    throw new DomainError("integration.command_invalid", "Commands must contain JSON values.");
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${displayJsonString(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function exactStoredCommand(command: IntegrationCommand, expectedHash: string): IntegrationCommand {
  try {
    const validated = validateIntegrationCommand(command);
    const canonical = canonicalize(validated);
    const actualHash = createHash("sha256").update(canonical).digest("hex");
    if (actualHash !== expectedHash) throw new Error("hash mismatch");
    return JSON.parse(canonical) as IntegrationCommand;
  } catch {
    throw new DomainError(
      "integration.confirmation_corrupt",
      "The stored integration confirmation command is invalid or does not match its hash.",
    );
  }
}

function unsafeSummaryCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x206f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0xfeff
  );
}

function sanitizeSummaryText(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint !== undefined && unsafeSummaryCodePoint(codePoint) ? " " : character;
  }
  return sanitized.trim().replace(/\s+/gu, " ");
}

function truncateSummaryText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let truncated = "";
  for (const character of value) {
    if (truncated.length + character.length > maximum - 1) break;
    truncated += character;
  }
  return `${truncated.trimEnd()}…`;
}

function shortText(value: string): string {
  return truncateSummaryText(sanitizeSummaryText(value), 100);
}

function quoted(value: string): string {
  return `“${shortText(value)}”`;
}

function nullableText(value: string | null): string {
  return value === null || value.trim().length === 0 ? "clear it" : `set it to ${quoted(value)}`;
}

function rawCommandSummary(command: IntegrationCommand): string {
  switch (command.type) {
    case "work_item.create": {
      const details = [
        `status ${command.status ?? "backlog"}`,
        `priority ${command.priority ?? "none"}`,
        command.planningDurationMinutes === undefined || command.planningDurationMinutes === null
          ? "not included in daily planning"
          : `${command.planningDurationMinutes} planned minutes`,
        command.dueOn === undefined || command.dueOn === null
          ? "no due date"
          : `due ${command.dueOn}`,
      ];
      if (typeof command.description === "string" && command.description.trim().length > 0) {
        details.push(`description ${quoted(command.description)}`);
      }
      return `Create work item ${quoted(command.title)} (${details.join(", ")}).`;
    }
    case "work_item.update": {
      const changes: string[] = [];
      if (command.title !== undefined) changes.push(`set title to ${quoted(command.title)}`);
      if (command.description !== undefined) {
        changes.push(`description: ${nullableText(command.description)}`);
      }
      if (command.status !== undefined) changes.push(`set status to ${command.status}`);
      if (command.priority !== undefined) changes.push(`set priority to ${command.priority}`);
      if (command.planningDurationMinutes !== undefined) {
        changes.push(
          command.planningDurationMinutes === null
            ? "remove from daily planning"
            : `set planned duration to ${command.planningDurationMinutes} minutes`,
        );
      }
      if (command.dueOn !== undefined) {
        changes.push(
          command.dueOn === null ? "clear due date" : `set due date to ${command.dueOn}`,
        );
      }
      return `Update work item ${command.workItemId}: ${changes.join("; ")}.`;
    }
    case "schedule_block.create": {
      const title =
        command.title === undefined || command.title === null ? "untitled" : quoted(command.title);
      const association =
        command.workItemId === undefined || command.workItemId === null
          ? "no linked work item"
          : `linked to work item ${command.workItemId}`;
      return `Create ${title} schedule block from ${command.startsAt} to ${command.endsAt} (${command.timeZone}, ${association}).`;
    }
    case "schedule_block.update": {
      const changes: string[] = [];
      if (command.title !== undefined) changes.push(`title: ${nullableText(command.title)}`);
      if (command.workItemId !== undefined) {
        changes.push(
          command.workItemId === null
            ? "remove linked work item"
            : `link work item ${command.workItemId}`,
        );
      }
      if (command.startsAt !== undefined) changes.push(`set start to ${command.startsAt}`);
      if (command.endsAt !== undefined) changes.push(`set end to ${command.endsAt}`);
      if (command.timeZone !== undefined) changes.push(`set time zone to ${command.timeZone}`);
      return `Update schedule block ${command.scheduleBlockId}: ${changes.join("; ")}.`;
    }
    case "plan_item.activity": {
      const details = [
        `on plan date ${command.date}`,
        `at ${command.occurredAt}`,
        command.durationMinutes === undefined || command.durationMinutes === null
          ? null
          : `${command.durationMinutes} actual minutes`,
      ].filter((value): value is string => value !== null);
      if (typeof command.reason === "string" && command.reason.trim().length > 0) {
        details.push(`reason ${quoted(command.reason)}`);
      }
      return `Record ${command.activityType.replaceAll("_", " ")} for plan item ${command.itemId} (${details.join(", ")}).`;
    }
  }
}

function commandSummary(command: IntegrationCommand): string {
  return truncateSummaryText(sanitizeSummaryText(rawCommandSummary(command)), 500);
}

function preparedDto(record: {
  readonly id: string;
  readonly requestId: string;
  readonly commandHash: string;
  readonly command: IntegrationCommand;
  readonly summary: string;
  readonly expiresAt: Date;
}): PreparedIntegrationCommand {
  const command = exactStoredCommand(record.command, record.commandHash);
  return {
    confirmationId: record.id,
    requestId: record.requestId,
    commandHash: record.commandHash,
    command,
    commandDisplay: canonicalize(command),
    summary: truncateSummaryText(sanitizeSummaryText(record.summary), 500),
    expiresAt: record.expiresAt.toISOString(),
  };
}

function confirmationMatchesCredential(
  confirmation: IntegrationConfirmationRecordLike,
  credential: IntegrationCredential,
): boolean {
  return (
    confirmation.credentialId === credential.id &&
    confirmation.workspaceId === credential.workspaceId &&
    confirmation.expiresAt instanceof Date &&
    Number.isFinite(confirmation.expiresAt.getTime()) &&
    (confirmation.consumedAt === null ||
      (confirmation.consumedAt instanceof Date &&
        Number.isFinite(confirmation.consumedAt.getTime())))
  );
}

interface IntegrationConfirmationRecordLike {
  readonly credentialId: string;
  readonly workspaceId: WorkspaceId;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export class PrepareIntegrationCommand {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly clock: Clock,
    private readonly confirmationTtlMilliseconds = DEFAULT_CONFIRMATION_TTL_MILLISECONDS,
  ) {
    if (!Number.isInteger(confirmationTtlMilliseconds) || confirmationTtlMilliseconds < 1) {
      throw new DomainError(
        "integration.confirmation_ttl_invalid",
        "Confirmation TTL must be positive.",
      );
    }
  }

  execute(input: PrepareIntegrationCommandInput): Promise<PreparedIntegrationCommand> {
    const now = validNow(this.clock);
    const requestId = normalizeBounded(input.requestId, "request_id", 160);
    const validatedCommand = validateIntegrationCommand(input.command);
    const canonicalCommand = canonicalize(validatedCommand);
    const command = JSON.parse(canonicalCommand) as IntegrationCommand;
    const hash = createHash("sha256").update(canonicalCommand).digest("hex");
    const summary = commandSummary(command);
    return this.unitOfWork.run(async ({ credentials, confirmations, auditEvents }) => {
      const credential = await revalidateCredential(
        credentials,
        input.principal,
        "schedule:write",
        now,
      );
      const existing = await confirmations.findByRequestId(credential.id, requestId);
      if (existing !== null) {
        if (!confirmationMatchesCredential(existing, credential)) {
          throw new DomainError(
            "integration.confirmation_corrupt",
            "The stored integration confirmation has invalid ownership or timestamps.",
          );
        }
        if (existing.commandHash !== hash || existing.requestId !== requestId) {
          throw new DomainError(
            "integration.request_conflict",
            "This integration request ID was already used for a different command.",
          );
        }
        return preparedDto(existing);
      }
      const record = {
        id: randomUUID(),
        credentialId: credential.id,
        workspaceId: credential.workspaceId,
        requestId,
        commandHash: hash,
        command,
        summary,
        expiresAt: new Date(now.getTime() + this.confirmationTtlMilliseconds),
        consumedAt: null,
        createdAt: now,
      };
      const stored = await confirmations.insertOrFind(record);
      if (!confirmationMatchesCredential(stored.confirmation, credential)) {
        throw new DomainError(
          "integration.confirmation_corrupt",
          "The stored integration confirmation has invalid ownership or timestamps.",
        );
      }
      if (stored.confirmation.commandHash !== hash || stored.confirmation.requestId !== requestId) {
        throw new DomainError(
          "integration.request_conflict",
          "This integration request ID was already used for a different command.",
        );
      }
      if (stored.kind === "inserted") {
        await auditEvents.append({
          workspaceId: credential.workspaceId,
          action: "integration.command_prepared",
          entityType: "integration_confirmation",
          entityId: stored.confirmation.id,
          data: {
            credentialId: credential.id,
            requestId,
            commandHash: hash,
            operation: command.type,
            summary,
          },
          occurredAt: now,
        });
      }
      return preparedDto(stored.confirmation);
    });
  }
}

function toWorkItemDto(item: WorkItem): IntegrationWorkItemDto {
  return {
    ...item,
    workspaceId: item.workspaceId,
    id: item.id,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    dueOn: item.dueOn,
  };
}

function toScheduleBlockDto(block: ScheduleBlock): IntegrationScheduleBlockDto {
  return {
    ...block,
    id: block.id,
    workspaceId: block.workspaceId,
    workItemId: block.workItemId,
    startsAt: block.startsAt.toISOString(),
    endsAt: block.endsAt.toISOString(),
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
  };
}

function toActivityEventDto(event: ActivityEvent): IntegrationActivityEventDto {
  const { idempotencyKey, ...publicEvent } = event;
  void idempotencyKey;
  return {
    ...publicEvent,
    id: event.id,
    workspaceId: event.workspaceId,
    routineId: event.routineId,
    workItemId: event.workItemId,
    planId: event.planId,
    planItemId: event.planItemId,
    occurredAt: event.occurredAt.toISOString(),
    localDate: event.localDate,
    referenceEventId: event.referenceEventId,
    recordedAt: event.recordedAt.toISOString(),
  };
}

function planActivityDto(result: PlanItemActivityResult): IntegrationPlanItemActivityDto {
  return {
    planId: result.planId,
    itemId: result.itemId,
    activityState: result.activityState,
    activityEvent: toActivityEventDto(result.activityEvent),
    headVersion: result.headVersion,
  };
}

async function requireWorkItem(
  context: IntegrationTransactionContext,
  workspaceIdValue: WorkspaceId,
  id: string,
): Promise<WorkItem> {
  const item = await context.workItems.findById(workspaceIdValue, workItemId(id));
  if (item === null) throw new DomainError("work_item.not_found", "The work item does not exist.");
  return item;
}

async function dispatchCommand(
  context: IntegrationTransactionContext,
  credential: IntegrationCredential,
  confirmation: {
    readonly requestId: string;
    readonly commandHash: string;
    readonly command: IntegrationCommand;
  },
  now: Date,
): Promise<IntegrationCommandOutcome> {
  const { command } = confirmation;
  switch (command.type) {
    case "work_item.create": {
      const item = createWorkItem({
        workspaceId: credential.workspaceId,
        title: command.title,
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.status === undefined ? {} : { status: command.status }),
        ...(command.priority === undefined ? {} : { priority: command.priority }),
        ...(command.planningDurationMinutes === undefined
          ? {}
          : { planningDurationMinutes: command.planningDurationMinutes }),
        ...(command.dueOn === undefined
          ? {}
          : { dueOn: command.dueOn === null ? null : localDate(command.dueOn) }),
        now,
      });
      await context.workItems.insert(item);
      return { type: "work_item.created", workItem: toWorkItemDto(item) };
    }
    case "work_item.update": {
      const current = await requireWorkItem(context, credential.workspaceId, command.workItemId);
      if (current.version !== command.expectedVersion) {
        throw new DomainError(
          "work_item.version_conflict",
          "The work item changed before this update could be applied.",
        );
      }
      const updated = updateWorkItem(current, {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.status === undefined ? {} : { status: command.status }),
        ...(command.priority === undefined ? {} : { priority: command.priority }),
        ...(command.planningDurationMinutes === undefined
          ? {}
          : { planningDurationMinutes: command.planningDurationMinutes }),
        ...(command.dueOn === undefined
          ? {}
          : { dueOn: command.dueOn === null ? null : localDate(command.dueOn) }),
        now,
      });
      if (updated !== current) {
        await context.workItems.save(updated, current.version);
        await context.notifications.deleteIntentsForTarget(
          credential.workspaceId,
          "work_item",
          updated.id,
        );
      }
      return { type: "work_item.updated", workItem: toWorkItemDto(updated) };
    }
    case "schedule_block.create": {
      if (command.workItemId !== undefined && command.workItemId !== null) {
        await requireWorkItem(context, credential.workspaceId, command.workItemId);
      }
      const block = createScheduleBlock({
        workspaceId: credential.workspaceId,
        ...(command.workItemId === undefined
          ? {}
          : { workItemId: command.workItemId === null ? null : workItemId(command.workItemId) }),
        ...(command.title === undefined ? {} : { title: command.title }),
        startsAt: parseInstant(command.startsAt, "startsAt"),
        endsAt: parseInstant(command.endsAt, "endsAt"),
        timeZone: command.timeZone,
        now,
      });
      await context.scheduleBlocks.insert(block);
      return { type: "schedule_block.created", scheduleBlock: toScheduleBlockDto(block) };
    }
    case "schedule_block.update": {
      const id = scheduleBlockId(command.scheduleBlockId);
      const current = await context.scheduleBlocks.findById(credential.workspaceId, id);
      if (current === null) {
        throw new DomainError("schedule_block.not_found", "The schedule block does not exist.");
      }
      if (current.version !== command.expectedVersion) {
        throw new DomainError(
          "schedule_block.version_conflict",
          "The schedule block changed before this update could be applied.",
        );
      }
      if (command.workItemId !== undefined && command.workItemId !== null) {
        await requireWorkItem(context, credential.workspaceId, command.workItemId);
      }
      const updated = updateScheduleBlock(current, {
        ...(command.workItemId === undefined
          ? {}
          : { workItemId: command.workItemId === null ? null : workItemId(command.workItemId) }),
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.startsAt === undefined
          ? {}
          : { startsAt: parseInstant(command.startsAt, "startsAt") }),
        ...(command.endsAt === undefined ? {} : { endsAt: parseInstant(command.endsAt, "endsAt") }),
        ...(command.timeZone === undefined ? {} : { timeZone: command.timeZone }),
        now,
      });
      if (updated !== current) {
        await context.scheduleBlocks.save(updated, current.version);
        await context.notifications.deleteIntentsForTarget(
          credential.workspaceId,
          "schedule_block",
          updated.id,
        );
      }
      return { type: "schedule_block.updated", scheduleBlock: toScheduleBlockDto(updated) };
    }
    case "plan_item.activity": {
      const nestedIdempotencyKey = `integration:${createHash("sha256")
        .update(`${credential.id}|${confirmation.requestId}|${confirmation.commandHash}`)
        .digest("hex")}`;
      const result = await context.dailyPlans.recordItemActivity({
        workspaceId: credential.workspaceId,
        date: localDate(command.date),
        expectedPlanId: dailyPlanId(command.expectedPlanId),
        itemId: planItemId(command.itemId),
        expectedHeadVersion: command.expectedHeadVersion,
        type: command.activityType,
        occurredAt: parseInstant(command.occurredAt, "occurredAt"),
        timeZone: command.timeZone,
        durationMinutes: command.durationMinutes ?? null,
        reason: command.reason ?? null,
        metadata: command.metadata ?? {},
        idempotencyKey: nestedIdempotencyKey,
        now,
      });
      if (["completed", "skipped", "deferred", "dismissed"].includes(result.activityState)) {
        await context.notifications.deleteIntentsForTarget(
          credential.workspaceId,
          "daily_plan",
          result.planId,
          "daily_follow_up",
        );
      }
      if (
        result.activityState === "completed" &&
        result.activityEvent.sourceType === "work_item" &&
        result.activityEvent.workItemId !== null
      ) {
        await context.notifications.deleteIntentsForTarget(
          credential.workspaceId,
          "work_item",
          result.activityEvent.workItemId,
          "work_item_due",
        );
      }
      return { type: "plan_item.activity_recorded", planItemActivity: planActivityDto(result) };
    }
    default:
      throw new DomainError(
        "integration.confirmation_corrupt",
        "The stored integration confirmation contains an unsupported command.",
      );
  }
}

function outcomeEntity(outcome: IntegrationCommandOutcome): {
  entityType: string;
  entityId: string;
} {
  if (outcome.type.startsWith("work_item.")) {
    return {
      entityType: "work_item",
      entityId: (outcome as Extract<IntegrationCommandOutcome, { workItem: unknown }>).workItem.id,
    };
  }
  if (outcome.type.startsWith("schedule_block.")) {
    return {
      entityType: "schedule_block",
      entityId: (outcome as Extract<IntegrationCommandOutcome, { scheduleBlock: unknown }>)
        .scheduleBlock.id,
    };
  }
  return {
    entityType: "plan_item",
    entityId: (outcome as Extract<IntegrationCommandOutcome, { planItemActivity: unknown }>)
      .planItemActivity.itemId,
  };
}

function receiptResult(
  request: IntegrationRequestRecord,
  confirmation: {
    readonly id: string;
    readonly credentialId: string;
    readonly workspaceId: WorkspaceId;
    readonly commandHash: string;
    readonly command: IntegrationCommand;
  },
): ConfirmedIntegrationCommandResult {
  const result = request.result;
  const legacyReceipt = result?.receiptVersion === undefined;
  if (
    request.state !== "succeeded" ||
    result === null ||
    request.credentialId !== confirmation.credentialId ||
    request.workspaceId !== confirmation.workspaceId ||
    request.confirmationId !== confirmation.id ||
    request.commandHash !== confirmation.commandHash ||
    request.operation !== confirmation.command.type ||
    result.confirmationId !== confirmation.id ||
    result.commandHash !== confirmation.commandHash ||
    result.operation !== confirmation.command.type ||
    (legacyReceipt
      ? !exactKeys(result as unknown as Record<string, unknown>, [
          "confirmationId",
          "operation",
          "commandHash",
          "outcome",
        ])
      : result.receiptVersion !== 1 ||
        !exactKeys(result as unknown as Record<string, unknown>, [
          "receiptVersion",
          "confirmationId",
          "operation",
          "commandHash",
          "outcome",
        ])) ||
    !validReceiptOutcome(
      result.outcome,
      confirmation.command,
      confirmation.workspaceId,
      legacyReceipt,
    )
  ) {
    throw new DomainError(
      "integration.receipt_corrupt",
      "The stored integration receipt is incomplete or inconsistent.",
    );
  }
  canonicalize(result);
  return result;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUuidText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isInstantText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function isNullableString(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maximum);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
  );
}

function isPositiveDuration(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function isMetadataObject(value: unknown): boolean {
  const metadata = objectValue(value);
  if (metadata === null || Object.keys(metadata).length > 8) return false;
  return Object.entries(metadata).every(
    ([key, child]) =>
      key.trim().length > 0 &&
      key.length <= 64 &&
      (child === null ||
        typeof child === "boolean" ||
        (typeof child === "string" && child.length <= 256) ||
        (typeof child === "number" && Number.isFinite(child))),
  );
}

function validReceiptOutcome(
  value: unknown,
  command: IntegrationCommand,
  workspaceIdValue: WorkspaceId,
  legacyReceipt: boolean,
): boolean {
  const outcome = objectValue(value);
  if (outcome === null || typeof outcome.type !== "string") return false;
  if (command.type === "work_item.create" || command.type === "work_item.update") {
    const expectedType =
      command.type === "work_item.create" ? "work_item.created" : "work_item.updated";
    const item = objectValue(outcome.workItem);
    return (
      outcome.type === expectedType &&
      exactKeys(outcome, ["type", "workItem"]) &&
      item !== null &&
      exactKeys(
        item,
        legacyReceipt
          ? [
              "id",
              "workspaceId",
              "title",
              "description",
              "status",
              "priority",
              "planningDurationMinutes",
              "version",
              "createdAt",
              "updatedAt",
            ]
          : [
              "id",
              "workspaceId",
              "title",
              "description",
              "status",
              "priority",
              "planningDurationMinutes",
              "dueOn",
              "version",
              "createdAt",
              "updatedAt",
            ],
      ) &&
      item.workspaceId === workspaceIdValue &&
      isUuidText(item.id) &&
      typeof item.title === "string" &&
      item.title.trim().length > 0 &&
      item.title.length <= 240 &&
      isNullableString(item.description, 4_000) &&
      typeof item.status === "string" &&
      workItemStatuses.includes(item.status as never) &&
      typeof item.priority === "string" &&
      workItemPriorities.includes(item.priority as never) &&
      isPositiveDuration(item.planningDurationMinutes) &&
      (legacyReceipt
        ? command.dueOn === undefined && !hasOwn(item, "dueOn")
        : (item.dueOn === null ||
            (typeof item.dueOn === "string" && isValidLocalDate(item.dueOn))) &&
          (command.type === "work_item.create"
            ? item.dueOn === (command.dueOn ?? null)
            : command.dueOn === undefined || item.dueOn === command.dueOn)) &&
      isPositiveInteger(item.version) &&
      isInstantText(item.createdAt) &&
      isInstantText(item.updatedAt) &&
      (command.type === "work_item.create" || item.id === command.workItemId)
    );
  }
  if (command.type === "schedule_block.create" || command.type === "schedule_block.update") {
    const expectedType =
      command.type === "schedule_block.create"
        ? "schedule_block.created"
        : "schedule_block.updated";
    const block = objectValue(outcome.scheduleBlock);
    return (
      outcome.type === expectedType &&
      exactKeys(outcome, ["type", "scheduleBlock"]) &&
      block !== null &&
      exactKeys(block, [
        "id",
        "workspaceId",
        "workItemId",
        "title",
        "startsAt",
        "endsAt",
        "timeZone",
        "version",
        "createdAt",
        "updatedAt",
      ]) &&
      block.workspaceId === workspaceIdValue &&
      isUuidText(block.id) &&
      (block.workItemId === null || isUuidText(block.workItemId)) &&
      isNullableString(block.title, 240) &&
      isInstantText(block.startsAt) &&
      isInstantText(block.endsAt) &&
      new Date(block.endsAt).getTime() > new Date(block.startsAt).getTime() &&
      typeof block.timeZone === "string" &&
      block.timeZone.length <= 80 &&
      isIanaTimeZone(block.timeZone) &&
      isPositiveInteger(block.version) &&
      isInstantText(block.createdAt) &&
      isInstantText(block.updatedAt) &&
      (command.type === "schedule_block.create" || block.id === command.scheduleBlockId)
    );
  }
  const activity = objectValue(outcome.planItemActivity);
  const event = objectValue(activity?.activityEvent);
  return (
    command.type === "plan_item.activity" &&
    outcome.type === "plan_item.activity_recorded" &&
    exactKeys(outcome, ["type", "planItemActivity"]) &&
    activity !== null &&
    exactKeys(activity, ["planId", "itemId", "activityState", "activityEvent", "headVersion"]) &&
    activity.planId === command.expectedPlanId &&
    activity.itemId === command.itemId &&
    typeof activity.activityState === "string" &&
    planItemActivityStates.includes(activity.activityState as never) &&
    activity.activityState ===
      (command.activityType === "completion_reversed" ? "pending" : command.activityType) &&
    isPositiveInteger(activity.headVersion) &&
    event !== null &&
    exactKeys(event, [
      "id",
      "workspaceId",
      "sourceType",
      "routineId",
      "workItemId",
      "planId",
      "planItemId",
      "type",
      "occurredAt",
      "localDate",
      "timeZone",
      "durationMinutes",
      "reason",
      "referenceEventId",
      "metadata",
      "recordedAt",
    ]) &&
    isUuidText(event.id) &&
    event.workspaceId === workspaceIdValue &&
    (event.sourceType === "routine" || event.sourceType === "work_item") &&
    (event.sourceType === "routine"
      ? isUuidText(event.routineId) && event.workItemId === null
      : event.routineId === null && isUuidText(event.workItemId)) &&
    event.planId === command.expectedPlanId &&
    event.planItemId === command.itemId &&
    typeof event.type === "string" &&
    activityEventTypes.includes(event.type as never) &&
    event.type === command.activityType &&
    isInstantText(event.occurredAt) &&
    typeof event.localDate === "string" &&
    isValidLocalDate(event.localDate) &&
    typeof event.timeZone === "string" &&
    event.timeZone.length <= 80 &&
    isIanaTimeZone(event.timeZone) &&
    isPositiveDuration(event.durationMinutes) &&
    isNullableString(event.reason, 500) &&
    (event.referenceEventId === null || isUuidText(event.referenceEventId)) &&
    isMetadataObject(event.metadata) &&
    isInstantText(event.recordedAt)
  );
}

export class ConfirmIntegrationCommand {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(input: ConfirmIntegrationCommandInput): Promise<ConfirmedIntegrationCommandResult> {
    const now = validNow(this.clock);
    const confirmationId = normalizeUuid(input.confirmationId, "confirmation_id");
    const idempotencyKey = normalizeBounded(input.idempotencyKey, "idempotency_key", 160);
    return this.unitOfWork.run(async (context) => {
      const credential = await revalidateCredential(
        context.credentials,
        input.principal,
        "schedule:write",
        now,
      );
      const confirmation = await context.confirmations.findByIdForUpdate(
        credential.id,
        confirmationId,
      );
      if (confirmation === null) {
        throw new DomainError(
          "integration.confirmation_not_found",
          "The integration confirmation does not exist.",
        );
      }
      if (!confirmationMatchesCredential(confirmation, credential)) {
        throw new DomainError(
          "integration.confirmation_corrupt",
          "The stored integration confirmation has invalid ownership or timestamps.",
        );
      }
      const storedCommand = exactStoredCommand(confirmation.command, confirmation.commandHash);
      const verifiedConfirmation = { ...confirmation, command: storedCommand };
      const reservation = await context.requests.reserve({
        id: randomUUID(),
        credentialId: credential.id,
        workspaceId: credential.workspaceId,
        idempotencyKey,
        confirmationId,
        operation: storedCommand.type,
        commandHash: confirmation.commandHash,
        createdAt: now,
      });
      if (reservation.kind === "replay") {
        return receiptResult(reservation.request, verifiedConfirmation);
      }
      if (confirmation.consumedAt !== null) {
        throw new DomainError(
          "integration.confirmation_consumed",
          "The integration confirmation has already been consumed.",
        );
      }
      if (confirmation.expiresAt.getTime() <= now.getTime()) {
        throw new DomainError(
          "integration.confirmation_expired",
          "The integration confirmation has expired.",
        );
      }
      await context.notifications.lockWorkspace(credential.workspaceId);
      if (!(await context.confirmations.consume(credential.id, confirmation.id, now))) {
        throw new DomainError(
          "integration.confirmation_consumed",
          "The integration confirmation is no longer available.",
        );
      }
      const outcome = await dispatchCommand(context, credential, verifiedConfirmation, now);
      const result: ConfirmedIntegrationCommandResult = {
        receiptVersion: 1,
        confirmationId: confirmation.id,
        operation: storedCommand.type,
        commandHash: confirmation.commandHash,
        outcome,
      };
      const entity = outcomeEntity(outcome);
      await context.auditEvents.append({
        workspaceId: credential.workspaceId,
        action: "integration.command_confirmed",
        entityType: entity.entityType,
        entityId: entity.entityId,
        data: {
          credentialId: credential.id,
          confirmationId: confirmation.id,
          requestId: confirmation.requestId,
          idempotencyKey,
          commandHash: confirmation.commandHash,
          operation: storedCommand.type,
          outcome: outcome.type,
        },
        occurredAt: now,
      });
      const completed = await context.requests.succeed(reservation.request.id, result, now);
      return receiptResult(completed, verifiedConfirmation);
    });
  }
}
