import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import {
  ConfirmNaturalLanguageProposal,
  GenerateNaturalLanguageProposal,
  HmacNaturalLanguagePromptHasher,
  NATURAL_LANGUAGE_PROPOSAL_VERSION,
  NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
  UpdateNaturalLanguageProposal,
  type NaturalLanguageProposer,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  PostgresNaturalLanguageProposalUnitOfWork,
} from "../packages/database/src/index.js";
import { localDate, workspaceId } from "../packages/domain/src/index.js";

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
        modelSuggestions: {
          priority: "high",
          dueOn: context.referenceDate,
          planningDurationMinutes: 60,
        },
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
const update = new UpdateNaturalLanguageProposal(firstUnitOfWork, clock);
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
    referenceDate: localDate("2026-07-15"),
    timeZone: "UTC",
  });
  assert.equal(result.status, "proposal");
  assert.equal(result.summary?.includes(requestId), true);
  assert.deepEqual(result.warnings, ["Confirm only after reviewing the exact title."]);
  assert.notEqual(result.proposal, null);
  assert.deepEqual(result.proposal!.userSelection, {
    priority: "none",
    dueOn: null,
    planningDurationMinutes: null,
  });
  assert.deepEqual(result.proposal!.modelSuggestions, {
    priority: "high",
    dueOn: "2026-07-15",
    planningDurationMinutes: 60,
  });
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
  assert.equal(columnNames.has("review_priority"), true);
  assert.equal(columnNames.has("review_due_on"), true);
  assert.equal(columnNames.has("review_planning_duration_minutes"), true);
  assert.equal(columnNames.has("review_hash"), true);
  assert.equal(columnNames.has("model_suggestions"), true);
  assert.equal(columnNames.has("model_suggestions_hash"), true);
  assert.equal(columnNames.has("result_schedule_block_id"), true);

  const [persisted] = await observerConnection.sql<
    {
      prompt_hash: string;
      command_display: string;
      command: unknown;
      model_suggestions: unknown;
      model_suggestions_hash: string;
      review_hash: string;
      status: string;
    }[]
  >`
    select prompt_hash, command_display, command, model_suggestions, model_suggestions_hash,
      review_hash, status
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
  assert.deepEqual(persisted!.model_suggestions, {
    priority: "high",
    dueOn: "2026-07-15",
    planningDurationMinutes: 60,
  });
  assert.equal(
    persisted!.model_suggestions_hash,
    createHash("sha256")
      .update('{"dueOn":"2026-07-15","planningDurationMinutes":60,"priority":"high"}', "utf8")
      .digest("hex"),
  );
  assert.equal(
    persisted!.review_hash,
    createHash("sha256")
      .update('{"dueOn":null,"planningDurationMinutes":null,"priority":"none"}', "utf8")
      .digest("hex"),
  );

  const reviewed = await update.execute({
    workspaceId: privateWorkspaceId,
    proposalId: prepared.proposal.id,
    expectedVersion: prepared.proposal.version,
    command: { type: "work_item.create", title: "Prepare the reviewed launch checklist" },
    userSelection: {
      priority: "urgent",
      dueOn: localDate("2026-07-20"),
      planningDurationMinutes: 75,
    },
  });
  assert.deepEqual(reviewed.userSelection, {
    priority: "urgent",
    dueOn: "2026-07-20",
    planningDurationMinutes: 75,
  });
  const [persistedReview] = await observerConnection.sql<
    {
      review_hash: string;
      model_suggestions: unknown;
      model_suggestions_hash: string;
      review_priority: string;
      review_due_on: string | null;
      review_planning_duration_minutes: number | null;
    }[]
  >`
    select model_suggestions, model_suggestions_hash, review_hash, review_priority, review_due_on,
      review_planning_duration_minutes
    from natural_language_proposals
    where workspace_id = ${privateWorkspaceId} and id = ${reviewed.id}
  `;
  assert.deepEqual(persistedReview, {
    model_suggestions: {
      priority: "high",
      dueOn: "2026-07-15",
      planningDurationMinutes: 60,
    },
    model_suggestions_hash: persisted!.model_suggestions_hash,
    review_hash: createHash("sha256")
      .update('{"dueOn":"2026-07-20","planningDurationMinutes":75,"priority":"urgent"}', "utf8")
      .digest("hex"),
    review_priority: "urgent",
    review_due_on: "2026-07-20",
    review_planning_duration_minutes: 75,
  });

  const [beforeConfirmation] = await observerConnection.sql<{ count: string }[]>`
    select count(*)::text as count from work_items where workspace_id = ${privateWorkspaceId}
  `;
  assert.equal(beforeConfirmation?.count, "0");

  const sameKeyCommand = {
    workspaceId: privateWorkspaceId,
    proposalId: reviewed.id,
    expectedVersion: reviewed.version,
    idempotencyKey: "natural-language-same-key-live-verification",
  };
  const sameKeyResults = await Promise.all([
    firstConfirm.execute(sameKeyCommand),
    secondConfirm.execute(sameKeyCommand),
  ]);
  assert.equal(sameKeyResults[0]?.resultType, "work_item");
  assert.equal(sameKeyResults[1]?.resultType, "work_item");
  if (
    sameKeyResults[0]?.resultType !== "work_item" ||
    sameKeyResults[1]?.resultType !== "work_item"
  ) {
    throw new Error("Expected work-item confirmation results.");
  }
  assert.deepEqual(sameKeyResults.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(sameKeyResults[0]?.workItem.id, prepared.proposal.id);
  assert.equal(sameKeyResults[1]?.workItem.id, prepared.proposal.id);
  assert.deepEqual(
    {
      parentWorkItemId: sameKeyResults[0]?.workItem.parentWorkItemId,
      title: sameKeyResults[0]?.workItem.title,
      description: sameKeyResults[0]?.workItem.description,
      status: sameKeyResults[0]?.workItem.status,
      priority: sameKeyResults[0]?.workItem.priority,
      dueOn: sameKeyResults[0]?.workItem.dueOn,
      planningDurationMinutes: sameKeyResults[0]?.workItem.planningDurationMinutes,
    },
    {
      parentWorkItemId: null,
      title: "Prepare the reviewed launch checklist",
      description: null,
      status: "backlog",
      priority: "urgent",
      dueOn: "2026-07-20",
      planningDurationMinutes: 75,
    },
  );

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

  const scheduleWorkspaceId = await createVerificationWorkspace(
    "Natural-language calendar-block verifier",
  );
  const scheduleGenerate = new GenerateNaturalLanguageProposal(
    firstUnitOfWork,
    {
      provider: "ollama",
      model: "gemma4:e4b",
      async propose() {
        return {
          status: "available" as const,
          output: {
            version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
            summary: "Prepared one reviewable calendar block.",
            warnings: [],
            command: {
              type: "schedule_block.create" as const,
              title: "Quarterly report",
              startsAt: "2026-07-16T14:00:00.000Z",
              endsAt: "2026-07-16T15:00:00.000Z",
              timeZone: "UTC",
            },
            modelSuggestions: null,
          },
        };
      },
    },
    clock,
    promptHasher,
    10 * 60_000,
  );
  const schedulePrepared = await scheduleGenerate.execute({
    version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
    workspaceId: scheduleWorkspaceId,
    requestId: randomUUID(),
    prompt: "Block tomorrow from 2 to 3 PM for the quarterly report.",
    referenceDate: localDate("2026-07-15"),
    timeZone: "UTC",
  });
  assert.equal(schedulePrepared.status, "proposal");
  assert.notEqual(schedulePrepared.proposal, null);
  const scheduleCommand = {
    workspaceId: scheduleWorkspaceId,
    proposalId: schedulePrepared.proposal!.id,
    expectedVersion: schedulePrepared.proposal!.version,
    idempotencyKey: "natural-language-calendar-same-key-live-verification",
  };
  const scheduleResults = await Promise.all([
    firstConfirm.execute(scheduleCommand),
    secondConfirm.execute(scheduleCommand),
  ]);
  assert.deepEqual(scheduleResults.map((result) => result.replayed).sort(), [false, true]);
  for (const result of scheduleResults) {
    assert.equal(result.resultType, "schedule_block");
    if (result.resultType !== "schedule_block") throw new Error("Expected a calendar block.");
    assert.equal(result.scheduleBlock.id, schedulePrepared.proposal!.id);
    assert.equal(result.scheduleBlock.workItemId, null);
    assert.equal(result.scheduleBlock.startsAt.toISOString(), "2026-07-16T14:00:00.000Z");
  }
  const [scheduleCounts] = await observerConnection.sql<
    {
      schedule_blocks: string;
      work_items: string;
      result_schedule_block_id: string | null;
      result_work_item_id: string | null;
    }[]
  >`
    select
      (select count(*)::text from schedule_blocks
       where workspace_id = ${scheduleWorkspaceId}
         and id = ${schedulePrepared.proposal!.id}) as schedule_blocks,
      (select count(*)::text from work_items
       where workspace_id = ${scheduleWorkspaceId}) as work_items,
      result_schedule_block_id,
      result_work_item_id
    from natural_language_proposals
    where workspace_id = ${scheduleWorkspaceId} and id = ${schedulePrepared.proposal!.id}
  `;
  assert.deepEqual(scheduleCounts, {
    schedule_blocks: "1",
    work_items: "0",
    result_schedule_block_id: schedulePrepared.proposal!.id,
    result_work_item_id: null,
  });
  await assert.rejects(
    observerConnection.sql`
      update natural_language_proposals
      set command = ${JSON.stringify({ title: "Missing command type" })}::jsonb
      where workspace_id = ${scheduleWorkspaceId} and id = ${schedulePrepared.proposal!.id}
    `,
    /natural_language_proposals_lifecycle_valid/,
  );

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
    "Natural-language proposal verification passed advisory suggestion isolation, private review persistence, exact work-item and calendar-block creation, tenant isolation, and concurrent exactly-once confirmation",
  );
} finally {
  await removeVerificationWorkspaces().catch(() => undefined);
  await Promise.all([
    firstConnection.close(),
    secondConnection.close(),
    observerConnection.close(),
  ]);
}
