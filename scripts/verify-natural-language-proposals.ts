import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
  ConfirmNaturalLanguageProposal,
  GenerateNaturalLanguageProposal,
  HmacNaturalLanguagePromptHasher,
  NATURAL_LANGUAGE_PROPOSAL_VERSION,
  NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
  type NaturalLanguageProposer,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  PostgresNaturalLanguageProposalUnitOfWork,
} from "../packages/database/src/index.js";
import { workspaceId } from "../packages/domain/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const firstConnection = createDatabase(databaseUrl, 2);
const secondConnection = createDatabase(databaseUrl, 2);
const observerConnection = createDatabase(databaseUrl, 2);
const now = new Date("2026-07-15T12:00:00.000Z");
const clock = { now: () => new Date(now) };
const promptHasher = new HmacNaturalLanguagePromptHasher(
  "natural-language-live-verifier-key-material-2026",
);
const proposer: NaturalLanguageProposer = {
  provider: "ollama",
  model: "gemma4:e4b",
  async propose(context) {
    return {
      status: "available",
      output: {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: `Prepared one reviewable proposal for ${context.requestId}.`,
        warnings: ["Confirm only after reviewing the exact title."],
        command: { type: "work_item.create", title: "Prepare the launch checklist" },
      },
    };
  },
};
const firstUnitOfWork = new PostgresNaturalLanguageProposalUnitOfWork(firstConnection);
const secondUnitOfWork = new PostgresNaturalLanguageProposalUnitOfWork(secondConnection);
const generate = new GenerateNaturalLanguageProposal(
  firstUnitOfWork,
  proposer,
  clock,
  promptHasher,
  10 * 60_000,
);
const firstConfirm = new ConfirmNaturalLanguageProposal(firstUnitOfWork, clock);
const secondConfirm = new ConfirmNaturalLanguageProposal(secondUnitOfWork, clock);
const createdWorkspaceIds: string[] = [];

async function createVerificationWorkspace(label: string): Promise<ReturnType<typeof workspaceId>> {
  const id = workspaceId(randomUUID());
  createdWorkspaceIds.push(id);
  await observerConnection.sql`
    insert into workspaces (id, name, created_at, updated_at)
    values (${id}, ${label}, ${now.toISOString()}, ${now.toISOString()})
  `;
  return id;
}

async function prepareProposal(targetWorkspaceId: ReturnType<typeof workspaceId>, prompt: string) {
  const requestId = randomUUID();
  const result = await generate.execute({
    version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
    workspaceId: targetWorkspaceId,
    requestId,
    prompt,
  });
  assert.equal(result.status, "proposal");
  assert.equal(result.summary?.includes(requestId), true);
  assert.deepEqual(result.warnings, ["Confirm only after reviewing the exact title."]);
  assert.notEqual(result.proposal, null);
  return { requestId, proposal: result.proposal! };
}

function domainErrorCode(initialError: unknown): string | null {
  let error: unknown = initialError;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
    ) {
      return error.code;
    }
    if (error === null || typeof error !== "object" || !("cause" in error)) return null;
    error = error.cause;
  }
  return null;
}

function rejectionCode(result: PromiseSettledResult<unknown>): string | null {
  return result.status === "rejected" ? domainErrorCode(result.reason) : null;
}

async function removeVerificationWorkspaces(): Promise<void> {
  if (createdWorkspaceIds.length === 0) return;
  await observerConnection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_daily_plan_fit_insight_feedback_event_change', 'on', true)`;
    await sql`delete from workspaces where id = any(${createdWorkspaceIds})`;
  });
}

try {
  const privateWorkspaceId = await createVerificationWorkspace(
    "Natural-language proposal verifier",
  );
  const privatePrompt = "Turn my private launch notes into one checklist task.";
  const prepared = await prepareProposal(privateWorkspaceId, privatePrompt);

  const columns = await observerConnection.sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'natural_language_proposals'
    order by column_name
  `;
  const columnNames = new Set(columns.map((row) => row.column_name));
  assert.equal(columnNames.has("prompt"), false);
  assert.equal(columnNames.has("summary"), false);
  assert.equal(columnNames.has("warnings"), false);

  const [persisted] = await observerConnection.sql<
    { prompt_hash: string; command_display: string; command: unknown; status: string }[]
  >`
    select prompt_hash, command_display, command, status
    from natural_language_proposals
    where workspace_id = ${privateWorkspaceId} and id = ${prepared.proposal.id}
  `;
  assert.notEqual(persisted, undefined);
  assert.equal(persisted!.status, "pending");
  assert.equal(JSON.stringify(persisted).includes(privatePrompt), false);
  assert.notEqual(
    persisted!.prompt_hash,
    createHash("sha256").update(privatePrompt, "utf8").digest("hex"),
  );
  assert.equal(persisted!.command_display, prepared.proposal.commandDisplay);

  const [beforeConfirmation] = await observerConnection.sql<{ count: string }[]>`
    select count(*)::text as count from work_items where workspace_id = ${privateWorkspaceId}
  `;
  assert.equal(beforeConfirmation?.count, "0");

  const sameKeyCommand = {
    workspaceId: privateWorkspaceId,
    proposalId: prepared.proposal.id,
    expectedVersion: prepared.proposal.version,
    idempotencyKey: "natural-language-same-key-live-verification",
  };
  const sameKeyResults = await Promise.all([
    firstConfirm.execute(sameKeyCommand),
    secondConfirm.execute(sameKeyCommand),
  ]);
  assert.deepEqual(sameKeyResults.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(sameKeyResults[0]?.workItem.id, prepared.proposal.id);
  assert.equal(sameKeyResults[1]?.workItem.id, prepared.proposal.id);

  const [sameKeyCounts] = await observerConnection.sql<
    { work_items: string; confirmation_events: string }[]
  >`
    select
      (select count(*)::text from work_items
       where workspace_id = ${privateWorkspaceId} and id = ${prepared.proposal.id}) as work_items,
      (select count(*)::text from audit_events
       where workspace_id = ${privateWorkspaceId}
         and entity_id = ${prepared.proposal.id}
         and action = 'natural_language.proposal_confirmed') as confirmation_events
  `;
  assert.deepEqual(sameKeyCounts, { work_items: "1", confirmation_events: "1" });

  const conflictWorkspaceId = await createVerificationWorkspace(
    "Natural-language conflict verifier",
  );
  const conflicting = await prepareProposal(conflictWorkspaceId, "Create one release task.");
  const conflictingResults = await Promise.allSettled([
    firstConfirm.execute({
      workspaceId: conflictWorkspaceId,
      proposalId: conflicting.proposal.id,
      expectedVersion: conflicting.proposal.version,
      idempotencyKey: "natural-language-first-confirmation",
    }),
    secondConfirm.execute({
      workspaceId: conflictWorkspaceId,
      proposalId: conflicting.proposal.id,
      expectedVersion: conflicting.proposal.version,
      idempotencyKey: "natural-language-second-confirmation",
    }),
  ]);
  assert.equal(conflictingResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(
    conflictingResults.map(rejectionCode).filter((code) => code !== null),
    ["natural_language.confirmation_conflict"],
  );
  const [conflictingCounts] = await observerConnection.sql<
    { work_items: string; confirmation_events: string }[]
  >`
    select
      (select count(*)::text from work_items
       where workspace_id = ${conflictWorkspaceId} and id = ${conflicting.proposal.id}) as work_items,
      (select count(*)::text from audit_events
       where workspace_id = ${conflictWorkspaceId}
         and entity_id = ${conflicting.proposal.id}
         and action = 'natural_language.proposal_confirmed') as confirmation_events
  `;
  assert.deepEqual(conflictingCounts, { work_items: "1", confirmation_events: "1" });

  const isolatedWorkspaceId = await createVerificationWorkspace(
    "Natural-language tenant isolation verifier",
  );
  await assert.rejects(
    firstConfirm.execute({
      workspaceId: isolatedWorkspaceId,
      proposalId: conflicting.proposal.id,
      expectedVersion: conflicting.proposal.version,
      idempotencyKey: "natural-language-tenant-isolation",
    }),
    (error: unknown) => domainErrorCode(error) === "natural_language.proposal_not_found",
  );

  console.log(
    "Natural-language proposal verification passed private persistence, tenant isolation, and concurrent exactly-once confirmation",
  );
} finally {
  await removeVerificationWorkspaces().catch(() => undefined);
  await Promise.all([
    firstConnection.close(),
    secondConnection.close(),
    observerConnection.close(),
  ]);
}
