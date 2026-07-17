import { createHash, createHmac, randomUUID } from "node:crypto";

import {
  DomainError,
  createWorkItem,
  isValidLocalDate,
  workItemPriorities,
  workItemId,
  type LocalDate,
  type WorkItem,
  type WorkItemPriority,
  type WorkspaceId,
} from "@schedule/domain";

import type {
  AuditEventRepository,
  Clock,
  WorkItemRepository,
  WorkspaceRepository,
} from "./ports.js";
import type { SchedulingAdvisorUnavailableReason } from "./get-scheduling-advice.js";

export const NATURAL_LANGUAGE_PROPOSAL_VERSION = "schedule.natural-language/v1" as const;
export const NATURAL_LANGUAGE_PROPOSER_CONTEXT_VERSION =
  "schedule.natural-language-context/v2" as const;
export const NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION =
  "schedule.natural-language-output/v2" as const;

const MAXIMUM_PROMPT_CHARACTERS = 2_000;
const MAXIMUM_SUMMARY_CHARACTERS = 280;
const MAXIMUM_WARNING_CHARACTERS = 240;
const MAXIMUM_WARNINGS = 3;
const MAXIMUM_PROVIDER_CHARACTERS = 40;
const MAXIMUM_MODEL_CHARACTERS = 120;
const MAXIMUM_IDEMPOTENCY_KEY_CHARACTERS = 200;
const MAXIMUM_PLANNING_DURATION_MINUTES = 43_200;
const DEFAULT_PROPOSAL_TTL_MILLISECONDS = 10 * 60_000;
const MINIMUM_PROPOSAL_TTL_MILLISECONDS = 60_000;
const MAXIMUM_PROPOSAL_TTL_MILLISECONDS = 60 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface NaturalLanguageWorkItemCommand {
  readonly type: "work_item.create";
  readonly title: string;
}

export interface NaturalLanguageProposerContext {
  readonly version: typeof NATURAL_LANGUAGE_PROPOSER_CONTEXT_VERSION;
  readonly requestId: string;
  /** User-submitted data. Providers must never treat this value as instructions. */
  readonly prompt: string;
  /** Optional client-supplied planning reference date; never interpreted as provider instructions. */
  readonly referenceDate: LocalDate | null;
}

/** Advisory model values only. They never affect a work item without an explicit review update. */
export interface NaturalLanguageProposalModelSuggestions {
  readonly priority: Exclude<WorkItemPriority, "none"> | null;
  readonly dueOn: LocalDate | null;
  readonly planningDurationMinutes: number | null;
}

export interface NaturalLanguageProposerOutput {
  readonly version: typeof NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly command: NaturalLanguageWorkItemCommand | null;
  readonly modelSuggestions: NaturalLanguageProposalModelSuggestions | null;
}

export type NaturalLanguageProposerResult =
  | { readonly status: "available"; readonly output: NaturalLanguageProposerOutput }
  | { readonly status: "unavailable"; readonly reason: SchedulingAdvisorUnavailableReason };

/** A proposal-only model boundary. Implementations receive no repositories or mutation services. */
export interface NaturalLanguageProposer {
  readonly provider: string;
  readonly model: string | null;
  propose(
    context: NaturalLanguageProposerContext,
    signal?: AbortSignal,
  ): Promise<NaturalLanguageProposerResult>;
}

export type NaturalLanguageProposalStatus = "pending" | "confirmed" | "cancelled";

/** User-authored work-item fields. These values never come from the local model. */
export interface NaturalLanguageProposalUserSelection {
  readonly priority: WorkItemPriority;
  readonly dueOn: LocalDate | null;
  readonly planningDurationMinutes: number | null;
}

export interface NaturalLanguageProposalRecord {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly requestId: string;
  readonly promptHash: string;
  readonly commandHash: string;
  readonly reviewHash: string;
  readonly modelSuggestionsHash: string;
  readonly commandDisplay: string;
  readonly command: NaturalLanguageWorkItemCommand;
  readonly modelSuggestions: NaturalLanguageProposalModelSuggestions | null;
  readonly userSelection: NaturalLanguageProposalUserSelection;
  readonly provider: string;
  readonly model: string | null;
  readonly status: NaturalLanguageProposalStatus;
  readonly expiresAt: Date;
  readonly confirmationKeyHash: string | null;
  readonly resultWorkItemId: string | null;
  readonly confirmedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NaturalLanguageProposalRepository {
  findByRequestId(
    workspaceId: WorkspaceId,
    requestId: string,
  ): Promise<NaturalLanguageProposalRecord | null>;
  findByIdForUpdate(
    workspaceId: WorkspaceId,
    proposalId: string,
  ): Promise<NaturalLanguageProposalRecord | null>;
  insertOrFind(record: NaturalLanguageProposalRecord): Promise<{
    readonly kind: "inserted" | "existing";
    readonly proposal: NaturalLanguageProposalRecord;
  }>;
  save(record: NaturalLanguageProposalRecord, expectedVersion: number): Promise<void>;
}

export interface NaturalLanguageProposalTransactionContext {
  readonly workspaces: WorkspaceRepository;
  readonly workItems: WorkItemRepository;
  readonly auditEvents: AuditEventRepository;
  readonly proposals: NaturalLanguageProposalRepository;
}

export interface NaturalLanguageProposalUnitOfWork {
  run<Result>(
    operation: (context: NaturalLanguageProposalTransactionContext) => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result>;
}

export interface PreparedNaturalLanguageProposal {
  readonly id: string;
  readonly requestId: string;
  readonly commandHash: string;
  readonly commandDisplay: string;
  readonly command: NaturalLanguageWorkItemCommand;
  readonly modelSuggestions: NaturalLanguageProposalModelSuggestions | null;
  readonly userSelection: NaturalLanguageProposalUserSelection;
  readonly provider: string;
  readonly model: string | null;
  readonly status: NaturalLanguageProposalStatus;
  readonly expiresAt: string;
  readonly version: number;
}

export interface GenerateNaturalLanguageProposalCommand {
  readonly version: typeof NATURAL_LANGUAGE_PROPOSAL_VERSION;
  readonly requestId: string;
  readonly workspaceId: WorkspaceId;
  readonly prompt: string;
  readonly referenceDate: LocalDate | null;
}

export interface GenerateNaturalLanguageProposalResult {
  readonly version: typeof NATURAL_LANGUAGE_PROPOSAL_VERSION;
  readonly requestId: string;
  readonly status: "proposal" | "no_proposal" | "unavailable";
  readonly reason: SchedulingAdvisorUnavailableReason | "no_proposal" | null;
  readonly summary: string | null;
  readonly warnings: readonly string[];
  readonly proposal: PreparedNaturalLanguageProposal | null;
  readonly provenance: {
    readonly provider: "disabled" | "ollama" | "unknown";
    readonly model: string | null;
    readonly requestedAt: string;
    readonly completedAt: string;
    readonly latencyMs: number;
  };
}

export interface UpdateNaturalLanguageProposalCommand {
  readonly workspaceId: WorkspaceId;
  readonly proposalId: string;
  readonly expectedVersion: number;
  readonly title: string;
  readonly userSelection: NaturalLanguageProposalUserSelection;
}

export interface CancelNaturalLanguageProposalCommand {
  readonly workspaceId: WorkspaceId;
  readonly proposalId: string;
  readonly expectedVersion: number;
}

export interface ConfirmNaturalLanguageProposalCommand {
  readonly workspaceId: WorkspaceId;
  readonly proposalId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface ConfirmNaturalLanguageProposalResult {
  readonly proposalId: string;
  readonly commandHash: string;
  readonly replayed: boolean;
  readonly workItem: WorkItem;
}

export interface NaturalLanguagePromptHasher {
  digest(input: {
    readonly workspaceId: WorkspaceId;
    readonly requestId: string;
    readonly prompt: string;
    readonly referenceDate: LocalDate | null;
  }): string;
}

/** Uses a deployment secret so persisted prompt fingerprints are not dictionary-testable hashes. */
export class HmacNaturalLanguagePromptHasher implements NaturalLanguagePromptHasher {
  private readonly key: Buffer;

  constructor(key: string) {
    if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) {
      throw new TypeError("The natural-language prompt fingerprint key must be at least 32 bytes.");
    }
    this.key = Buffer.from(key, "utf8");
  }

  digest(input: {
    readonly workspaceId: WorkspaceId;
    readonly requestId: string;
    readonly prompt: string;
    readonly referenceDate: LocalDate | null;
  }): string {
    return createHmac("sha256", this.key)
      .update(NATURAL_LANGUAGE_PROPOSAL_VERSION, "utf8")
      .update("\0", "utf8")
      .update(input.workspaceId, "utf8")
      .update("\0", "utf8")
      .update(input.requestId, "utf8")
      .update("\0", "utf8")
      .update(input.prompt, "utf8")
      .update("\0", "utf8")
      .update(input.referenceDate ?? "", "utf8")
      .digest("hex");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasUnsafeText(value: string, allowLineBreaks = false): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    if (allowLineBreaks && (codePoint === 0x09 || codePoint === 0x0a)) return false;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x61c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function safeSingleLine(value: unknown, maximumCharacters: number, label: string): string {
  if (typeof value !== "string") {
    throw new DomainError("natural_language.proposal_invalid", `${label} must be text.`);
  }
  const normalized = value.normalize("NFC");
  if (
    normalized.trim() !== normalized ||
    normalized.replace(/\s+/gu, " ") !== normalized ||
    normalized.length === 0 ||
    [...normalized].length > maximumCharacters ||
    hasUnsafeText(normalized)
  ) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      `${label} contains unsupported or unsafe text.`,
    );
  }
  return normalized;
}

function normalizePrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError(
      "natural_language.request_invalid",
      "A natural-language prompt is required.",
    );
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    [...normalized].length > MAXIMUM_PROMPT_CHARACTERS ||
    hasUnsafeText(normalized, true)
  ) {
    throw new DomainError(
      "natural_language.request_invalid",
      "The prompt must contain 1 to 2,000 safe text characters.",
    );
  }
  return normalized;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new DomainError(
      "natural_language.request_invalid",
      "A UUID natural-language request ID is required.",
    );
  }
  return value.toLowerCase();
}

function parseReferenceDate(value: unknown): LocalDate | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isValidLocalDate(value)) {
    throw new DomainError(
      "natural_language.request_invalid",
      "The planning reference date must be a valid local date or null.",
    );
  }
  return value as LocalDate;
}

function validateVersion(value: unknown): void {
  if (value !== NATURAL_LANGUAGE_PROPOSAL_VERSION) {
    throw new DomainError(
      "natural_language.request_invalid",
      "A supported natural-language proposal version is required.",
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }
  throw new DomainError(
    "natural_language.proposal_invalid",
    "The proposal command cannot be represented canonically.",
  );
}

function parseCommand(
  value: unknown,
  workspaceId: WorkspaceId,
  now: Date,
): NaturalLanguageWorkItemCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The local model returned an invalid work-item proposal.",
    );
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(candidate, ["title", "type"]) ||
    candidate.type !== "work_item.create" ||
    typeof candidate.title !== "string"
  ) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The local model may propose only one backlog work-item title.",
    );
  }
  const item = createWorkItem({ workspaceId, title: candidate.title.normalize("NFC"), now });
  if (hasUnsafeText(item.title)) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The proposed work-item title contains unsupported or unsafe text.",
    );
  }
  return { type: "work_item.create", title: item.title };
}

function parseUserSelection(value: unknown): NaturalLanguageProposalUserSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(
      "natural_language.review_invalid",
      "The proposal review fields are invalid.",
    );
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(candidate, ["dueOn", "planningDurationMinutes", "priority"]) ||
    !workItemPriorities.some((priority) => priority === candidate.priority) ||
    !(
      candidate.dueOn === null ||
      (typeof candidate.dueOn === "string" && isValidLocalDate(candidate.dueOn))
    ) ||
    !(
      candidate.planningDurationMinutes === null ||
      (typeof candidate.planningDurationMinutes === "number" &&
        Number.isInteger(candidate.planningDurationMinutes) &&
        candidate.planningDurationMinutes > 0 &&
        candidate.planningDurationMinutes <= MAXIMUM_PLANNING_DURATION_MINUTES)
    )
  ) {
    throw new DomainError(
      "natural_language.review_invalid",
      "Priority, due date, and planning duration must be valid user choices.",
    );
  }
  return {
    priority: candidate.priority as WorkItemPriority,
    dueOn: candidate.dueOn as LocalDate | null,
    planningDurationMinutes: candidate.planningDurationMinutes as number | null,
  };
}

function parseModelSuggestions(value: unknown): NaturalLanguageProposalModelSuggestions | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The local model suggestions are invalid.",
    );
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(candidate, ["dueOn", "planningDurationMinutes", "priority"]) ||
    !(
      candidate.priority === null ||
      candidate.priority === "low" ||
      candidate.priority === "medium" ||
      candidate.priority === "high" ||
      candidate.priority === "urgent"
    ) ||
    !(
      candidate.dueOn === null ||
      (typeof candidate.dueOn === "string" && isValidLocalDate(candidate.dueOn))
    ) ||
    !(
      candidate.planningDurationMinutes === null ||
      (typeof candidate.planningDurationMinutes === "number" &&
        Number.isInteger(candidate.planningDurationMinutes) &&
        candidate.planningDurationMinutes > 0 &&
        candidate.planningDurationMinutes <= MAXIMUM_PLANNING_DURATION_MINUTES)
    )
  ) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The local model suggestions must be valid advisory planning values.",
    );
  }
  if (
    candidate.priority === null &&
    candidate.dueOn === null &&
    candidate.planningDurationMinutes === null
  ) {
    return null;
  }
  return {
    priority: candidate.priority as Exclude<WorkItemPriority, "none"> | null,
    dueOn: candidate.dueOn as LocalDate | null,
    planningDurationMinutes: candidate.planningDurationMinutes as number | null,
  };
}

function parseStoredUserSelection(value: unknown): NaturalLanguageProposalUserSelection {
  try {
    return parseUserSelection(value);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored proposal review fields are invalid.",
    );
  }
}

function sameUserSelection(
  left: NaturalLanguageProposalUserSelection,
  right: NaturalLanguageProposalUserSelection,
): boolean {
  return (
    left.priority === right.priority &&
    left.dueOn === right.dueOn &&
    left.planningDurationMinutes === right.planningDurationMinutes
  );
}

function userSelectionHash(userSelection: NaturalLanguageProposalUserSelection): string {
  return hash(canonicalize(userSelection));
}

function validatedStoredUserSelection(
  record: NaturalLanguageProposalRecord,
): NaturalLanguageProposalUserSelection {
  const userSelection = parseStoredUserSelection(record.userSelection);
  if (userSelectionHash(userSelection) !== record.reviewHash) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored proposal review fields do not match their digest.",
    );
  }
  return userSelection;
}

function validatedStoredCommand(
  record: NaturalLanguageProposalRecord,
  workspaceId: WorkspaceId,
  now: Date,
): NaturalLanguageWorkItemCommand {
  let command: NaturalLanguageWorkItemCommand;
  try {
    command = parseCommand(record.command, workspaceId, now);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored proposal command is invalid.",
    );
  }
  const commandDisplay = canonicalize(command);
  if (commandDisplay !== record.commandDisplay || hash(commandDisplay) !== record.commandHash) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored proposal does not match its command hash.",
    );
  }
  return command;
}

function parseOutput(
  output: NaturalLanguageProposerOutput,
  workspaceId: WorkspaceId,
  now: Date,
): {
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly command: NaturalLanguageWorkItemCommand | null;
  readonly modelSuggestions: NaturalLanguageProposalModelSuggestions | null;
} {
  const value = output as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The local model output is invalid.",
    );
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(candidate, ["command", "modelSuggestions", "summary", "version", "warnings"]) ||
    candidate.version !== NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION ||
    !Array.isArray(candidate.warnings) ||
    candidate.warnings.length > MAXIMUM_WARNINGS
  ) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The local model output is invalid.",
    );
  }
  const warnings = candidate.warnings.map((warning) =>
    safeSingleLine(warning, MAXIMUM_WARNING_CHARACTERS, "A proposal warning"),
  );
  if (new Set(warnings).size !== warnings.length) {
    throw new DomainError(
      "natural_language.proposal_invalid",
      "The local model returned duplicate proposal warnings.",
    );
  }
  return {
    summary: safeSingleLine(candidate.summary, MAXIMUM_SUMMARY_CHARACTERS, "Proposal summary"),
    warnings,
    command: candidate.command === null ? null : parseCommand(candidate.command, workspaceId, now),
    modelSuggestions: parseModelSuggestions(candidate.modelSuggestions),
  };
}

function providerName(value: string): "disabled" | "ollama" | "unknown" {
  return value === "disabled" || value === "ollama" ? value : "unknown";
}

function normalizeProvider(value: unknown): string {
  return safeSingleLine(value, MAXIMUM_PROVIDER_CHARACTERS, "Provider name");
}

function normalizeModel(value: unknown): string | null {
  return value === null ? null : safeSingleLine(value, MAXIMUM_MODEL_CHARACTERS, "Model name");
}

function prepared(record: NaturalLanguageProposalRecord): PreparedNaturalLanguageProposal {
  return {
    id: record.id,
    requestId: record.requestId,
    commandHash: record.commandHash,
    commandDisplay: record.commandDisplay,
    command: record.command,
    modelSuggestions: record.modelSuggestions,
    userSelection: record.userSelection,
    provider: record.provider,
    model: record.model,
    status: record.status,
    expiresAt: record.expiresAt.toISOString(),
    version: record.version,
  };
}

function assertPositiveVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(
      "natural_language.version_invalid",
      "A positive expected proposal version is required.",
    );
  }
}

function assertPending(record: NaturalLanguageProposalRecord, now: Date): void {
  if (record.status === "confirmed") {
    throw new DomainError(
      "natural_language.proposal_confirmed",
      "The proposal has already been confirmed.",
    );
  }
  if (record.status === "cancelled") {
    throw new DomainError(
      "natural_language.proposal_cancelled",
      "The proposal has been cancelled.",
    );
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    throw new DomainError("natural_language.proposal_expired", "The proposal has expired.");
  }
}

export class DisabledNaturalLanguageProposer implements NaturalLanguageProposer {
  readonly provider = "disabled";
  readonly model = null;

  async propose(): Promise<NaturalLanguageProposerResult> {
    return { status: "unavailable", reason: "disabled" };
  }
}

export class GenerateNaturalLanguageProposal {
  constructor(
    private readonly unitOfWork: NaturalLanguageProposalUnitOfWork,
    private readonly proposer: NaturalLanguageProposer,
    private readonly clock: Clock,
    private readonly promptHasher: NaturalLanguagePromptHasher,
    private readonly proposalTtlMilliseconds = DEFAULT_PROPOSAL_TTL_MILLISECONDS,
  ) {
    if (
      !Number.isInteger(proposalTtlMilliseconds) ||
      proposalTtlMilliseconds < MINIMUM_PROPOSAL_TTL_MILLISECONDS ||
      proposalTtlMilliseconds > MAXIMUM_PROPOSAL_TTL_MILLISECONDS
    ) {
      throw new TypeError("proposalTtlMilliseconds must be between one minute and one hour.");
    }
  }

  async execute(
    input: GenerateNaturalLanguageProposalCommand,
    signal?: AbortSignal,
  ): Promise<GenerateNaturalLanguageProposalResult> {
    validateVersion(input.version);
    const requestId = validateRequestId(input.requestId);
    const prompt = normalizePrompt(input.prompt);
    const referenceDate = parseReferenceDate(input.referenceDate);
    const promptHash = this.promptHasher.digest({
      workspaceId: input.workspaceId,
      requestId,
      prompt,
      referenceDate,
    });
    const requestedAt = this.clock.now();
    const provider = normalizeProvider(this.proposer.provider);
    const model = normalizeModel(this.proposer.model);

    const existing = await this.unitOfWork.run(async ({ proposals, workspaces }) => {
      if ((await workspaces.findById(input.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      return proposals.findByRequestId(input.workspaceId, requestId);
    }, signal);
    if (existing !== null) {
      if (existing.promptHash !== promptHash) {
        throw new DomainError(
          "natural_language.request_conflict",
          "The request ID was already used for different text.",
        );
      }
      assertPending(existing, requestedAt);
      return {
        version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
        requestId,
        status: "proposal",
        reason: null,
        summary: null,
        warnings: [],
        proposal: prepared(existing),
        provenance: {
          provider: providerName(existing.provider),
          model: existing.model,
          requestedAt: existing.createdAt.toISOString(),
          completedAt: existing.createdAt.toISOString(),
          latencyMs: 0,
        },
      };
    }

    let providerResult: NaturalLanguageProposerResult;
    try {
      throwIfAborted(signal);
      providerResult = await this.proposer.propose(
        Object.freeze({
          version: NATURAL_LANGUAGE_PROPOSER_CONTEXT_VERSION,
          requestId,
          prompt,
          referenceDate,
        }),
        signal,
      );
    } catch {
      throwIfAborted(signal);
      providerResult = { status: "unavailable", reason: "unreachable" };
    }
    throwIfAborted(signal);
    const completedAt = this.clock.now();
    const provenance = {
      provider: providerName(provider),
      model,
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: Math.max(0, completedAt.getTime() - requestedAt.getTime()),
    } as const;

    if (providerResult.status === "unavailable") {
      return {
        version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
        requestId,
        status: "unavailable",
        reason: providerResult.reason,
        summary: null,
        warnings: [],
        proposal: null,
        provenance,
      };
    }

    let parsed: ReturnType<typeof parseOutput>;
    try {
      parsed = parseOutput(providerResult.output, input.workspaceId, completedAt);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return {
        version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
        requestId,
        status: "unavailable",
        reason: "malformed_response",
        summary: null,
        warnings: [],
        proposal: null,
        provenance,
      };
    }

    if (parsed.command === null) {
      return {
        version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
        requestId,
        status: "no_proposal",
        reason: "no_proposal",
        summary: parsed.summary,
        warnings: parsed.warnings,
        proposal: null,
        provenance,
      };
    }

    const commandDisplay = canonicalize(parsed.command);
    const commandHash = hash(commandDisplay);
    const userSelection: NaturalLanguageProposalUserSelection = {
      priority: "none",
      dueOn: null,
      planningDurationMinutes: null,
    };
    const record: NaturalLanguageProposalRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      requestId,
      promptHash,
      commandHash,
      reviewHash: userSelectionHash(userSelection),
      modelSuggestionsHash: hash(canonicalize(parsed.modelSuggestions)),
      commandDisplay,
      command: parsed.command,
      modelSuggestions: parsed.modelSuggestions,
      userSelection,
      provider,
      model,
      status: "pending",
      expiresAt: new Date(completedAt.getTime() + this.proposalTtlMilliseconds),
      confirmationKeyHash: null,
      resultWorkItemId: null,
      confirmedAt: null,
      cancelledAt: null,
      version: 1,
      createdAt: new Date(completedAt),
      updatedAt: new Date(completedAt),
    };

    const stored = await this.unitOfWork.run(async ({ auditEvents, proposals, workspaces }) => {
      throwIfAborted(signal);
      if ((await workspaces.findById(input.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      throwIfAborted(signal);
      const result = await proposals.insertOrFind(record);
      if (result.proposal.promptHash !== promptHash) {
        throw new DomainError(
          "natural_language.request_conflict",
          "The request ID was already used for different text.",
        );
      }
      if (result.kind === "existing") assertPending(result.proposal, completedAt);
      if (result.kind === "inserted") {
        throwIfAborted(signal);
        await auditEvents.append({
          workspaceId: input.workspaceId,
          action: "natural_language.proposal_prepared",
          entityType: "natural_language_proposal",
          entityId: result.proposal.id,
          data: {
            requestId,
            commandHash,
            provider,
            model,
            expiresAt: record.expiresAt.toISOString(),
          },
          occurredAt: completedAt,
        });
      }
      throwIfAborted(signal);
      return result;
    }, signal);

    const finalProvenance =
      stored.kind === "inserted"
        ? provenance
        : {
            provider: providerName(stored.proposal.provider),
            model: stored.proposal.model,
            requestedAt: stored.proposal.createdAt.toISOString(),
            completedAt: stored.proposal.createdAt.toISOString(),
            latencyMs: 0,
          };

    return {
      version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
      requestId,
      status: "proposal",
      reason: null,
      summary: stored.kind === "inserted" ? parsed.summary : null,
      warnings: stored.kind === "inserted" ? parsed.warnings : [],
      proposal: prepared(stored.proposal),
      provenance: finalProvenance,
    };
  }
}

export class UpdateNaturalLanguageProposal {
  constructor(
    private readonly unitOfWork: NaturalLanguageProposalUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: UpdateNaturalLanguageProposalCommand,
  ): Promise<PreparedNaturalLanguageProposal> {
    assertPositiveVersion(input.expectedVersion);
    return this.unitOfWork.run(async ({ auditEvents, proposals }) => {
      const current = await proposals.findByIdForUpdate(input.workspaceId, input.proposalId);
      if (current === null) {
        throw new DomainError(
          "natural_language.proposal_not_found",
          "The proposal does not exist.",
        );
      }
      const now = this.clock.now();
      const command = parseCommand(
        { type: "work_item.create", title: input.title },
        input.workspaceId,
        now,
      );
      const commandDisplay = canonicalize(command);
      const commandHash = hash(commandDisplay);
      const userSelection = parseUserSelection(input.userSelection);
      const currentUserSelection = validatedStoredUserSelection(current);
      const nextReviewHash = userSelectionHash(userSelection);
      assertPending(current, now);
      if (
        current.commandHash === commandHash &&
        sameUserSelection(currentUserSelection, userSelection) &&
        input.expectedVersion <= current.version
      ) {
        return prepared(current);
      }
      if (current.version !== input.expectedVersion) {
        throw new DomainError(
          "natural_language.version_conflict",
          "The proposal changed before it was updated.",
        );
      }
      const updated: NaturalLanguageProposalRecord = {
        ...current,
        command,
        commandDisplay,
        commandHash,
        reviewHash: nextReviewHash,
        userSelection,
        version: current.version + 1,
        updatedAt: new Date(now),
      };
      await proposals.save(updated, current.version);
      await auditEvents.append({
        workspaceId: input.workspaceId,
        action: "natural_language.proposal_edited",
        entityType: "natural_language_proposal",
        entityId: current.id,
        data: {
          previousCommandHash: current.commandHash,
          commandHash,
          previousReviewHash: current.reviewHash,
          reviewHash: nextReviewHash,
        },
        occurredAt: now,
      });
      return prepared(updated);
    });
  }
}

export class CancelNaturalLanguageProposal {
  constructor(
    private readonly unitOfWork: NaturalLanguageProposalUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: CancelNaturalLanguageProposalCommand,
  ): Promise<PreparedNaturalLanguageProposal> {
    assertPositiveVersion(input.expectedVersion);
    return this.unitOfWork.run(async ({ auditEvents, proposals }) => {
      const current = await proposals.findByIdForUpdate(input.workspaceId, input.proposalId);
      if (current === null) {
        throw new DomainError(
          "natural_language.proposal_not_found",
          "The proposal does not exist.",
        );
      }
      const now = this.clock.now();
      assertPending(current, now);
      if (current.version !== input.expectedVersion) {
        throw new DomainError(
          "natural_language.version_conflict",
          "The proposal changed before it was cancelled.",
        );
      }
      const cancelled: NaturalLanguageProposalRecord = {
        ...current,
        status: "cancelled",
        cancelledAt: new Date(now),
        version: current.version + 1,
        updatedAt: new Date(now),
      };
      await proposals.save(cancelled, current.version);
      await auditEvents.append({
        workspaceId: input.workspaceId,
        action: "natural_language.proposal_cancelled",
        entityType: "natural_language_proposal",
        entityId: current.id,
        data: { commandHash: current.commandHash },
        occurredAt: now,
      });
      return prepared(cancelled);
    });
  }
}

export class ConfirmNaturalLanguageProposal {
  constructor(
    private readonly unitOfWork: NaturalLanguageProposalUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: ConfirmNaturalLanguageProposalCommand,
  ): Promise<ConfirmNaturalLanguageProposalResult> {
    assertPositiveVersion(input.expectedVersion);
    if (
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > MAXIMUM_IDEMPOTENCY_KEY_CHARACTERS ||
      hasUnsafeText(input.idempotencyKey)
    ) {
      throw new DomainError(
        "natural_language.idempotency_key_invalid",
        "A bounded idempotency key is required.",
      );
    }
    const confirmationKeyHash = hash(input.idempotencyKey);
    return this.unitOfWork.run(async ({ auditEvents, proposals, workItems }) => {
      const current = await proposals.findByIdForUpdate(input.workspaceId, input.proposalId);
      if (current === null) {
        throw new DomainError(
          "natural_language.proposal_not_found",
          "The proposal does not exist.",
        );
      }
      const now = this.clock.now();
      if (current.status === "confirmed") {
        if (
          current.confirmationKeyHash !== confirmationKeyHash ||
          current.resultWorkItemId === null
        ) {
          throw new DomainError(
            "natural_language.confirmation_conflict",
            "The proposal was already confirmed by another request.",
          );
        }
        validatedStoredCommand(current, input.workspaceId, now);
        validatedStoredUserSelection(current);
        if (current.resultWorkItemId !== workItemId(current.id)) {
          throw new DomainError(
            "natural_language.confirmation_corrupt",
            "The confirmed proposal result identity is invalid.",
          );
        }
        const existingWorkItem = await workItems.findById(
          input.workspaceId,
          current.resultWorkItemId as WorkItem["id"],
        );
        if (existingWorkItem === null) {
          throw new DomainError(
            "natural_language.confirmation_corrupt",
            "The confirmed proposal result is unavailable.",
          );
        }
        return {
          proposalId: current.id,
          commandHash: current.commandHash,
          replayed: true,
          workItem: existingWorkItem,
        };
      }
      assertPending(current, now);
      if (current.version !== input.expectedVersion) {
        throw new DomainError(
          "natural_language.version_conflict",
          "The proposal changed before it was confirmed.",
        );
      }
      const command = validatedStoredCommand(current, input.workspaceId, now);
      const userSelection = validatedStoredUserSelection(current);
      const deterministicWorkItemId = workItemId(current.id);
      const priorWorkItem = await workItems.findById(input.workspaceId, deterministicWorkItemId);
      const desiredWorkItem = createWorkItem({
        id: deterministicWorkItemId,
        workspaceId: input.workspaceId,
        parentWorkItemId: null,
        title: command.title,
        description: null,
        status: "backlog",
        priority: userSelection.priority,
        dueOn: userSelection.dueOn,
        planningDurationMinutes: userSelection.planningDurationMinutes,
        now,
      });
      const workItem = priorWorkItem ?? desiredWorkItem;
      if (
        priorWorkItem !== null &&
        (priorWorkItem.id !== desiredWorkItem.id ||
          priorWorkItem.workspaceId !== desiredWorkItem.workspaceId ||
          priorWorkItem.parentWorkItemId !== null ||
          priorWorkItem.title !== desiredWorkItem.title ||
          priorWorkItem.description !== null ||
          priorWorkItem.status !== "backlog" ||
          priorWorkItem.priority !== desiredWorkItem.priority ||
          priorWorkItem.dueOn !== desiredWorkItem.dueOn ||
          priorWorkItem.planningDurationMinutes !== desiredWorkItem.planningDurationMinutes ||
          priorWorkItem.version !== 1)
      ) {
        throw new DomainError(
          "natural_language.confirmation_corrupt",
          "The proposal creation identity is already used by different work.",
        );
      }
      if (priorWorkItem === null) await workItems.insert(workItem);
      const confirmed: NaturalLanguageProposalRecord = {
        ...current,
        status: "confirmed",
        confirmationKeyHash,
        resultWorkItemId: workItem.id,
        confirmedAt: new Date(now),
        version: current.version + 1,
        updatedAt: new Date(now),
      };
      await proposals.save(confirmed, current.version);
      await auditEvents.append({
        workspaceId: input.workspaceId,
        action: "natural_language.proposal_confirmed",
        entityType: "natural_language_proposal",
        entityId: current.id,
        data: {
          commandHash: current.commandHash,
          reviewHash: current.reviewHash,
          workItemId: workItem.id,
          provider: current.provider,
          model: current.model,
        },
        occurredAt: now,
      });
      return {
        proposalId: current.id,
        commandHash: current.commandHash,
        replayed: false,
        workItem,
      };
    });
  }
}
