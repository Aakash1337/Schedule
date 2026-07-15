import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createWorkItem,
  createWorkspace,
  localDate,
  workItemId,
  workspaceId,
  type WorkItem,
  type Workspace,
  type WorkspaceId,
} from "@schedule/domain";

import type {
  AuditEventRecord,
  AuditEventRepository,
  Clock,
  WorkItemRepository,
  WorkspaceRepository,
} from "./ports.js";
import {
  CancelNaturalLanguageProposal,
  ConfirmNaturalLanguageProposal,
  GenerateNaturalLanguageProposal,
  HmacNaturalLanguagePromptHasher,
  NATURAL_LANGUAGE_PROPOSAL_VERSION,
  NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
  UpdateNaturalLanguageProposal,
  type NaturalLanguageProposalRecord,
  type NaturalLanguageProposalRepository,
  type NaturalLanguageProposalUserSelection,
  type NaturalLanguageProposalTransactionContext,
  type NaturalLanguageProposalUnitOfWork,
  type NaturalLanguageProposer,
  type NaturalLanguageProposerContext,
  type NaturalLanguageProposerResult,
} from "./local-natural-language-proposal.js";

const WORKSPACE_ID = workspaceId("11111111-1111-4111-8111-111111111111");
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-14T14:00:00.000Z");
const promptHasher = new HmacNaturalLanguagePromptHasher(
  "test-only-natural-language-prompt-key-0000000000000000",
);

function available(title = "Prepare release notes"): NaturalLanguageProposerResult {
  return {
    status: "available",
    output: {
      version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
      summary: "Create one backlog work item.",
      warnings: ["Review the title before confirming."],
      command: { type: "work_item.create", title },
    },
  };
}

interface Harness {
  readonly workspaces: Workspace[];
  readonly proposals: NaturalLanguageProposalRecord[];
  readonly workItems: WorkItem[];
  readonly audits: AuditEventRecord[];
  readonly unitOfWork: NaturalLanguageProposalUnitOfWork;
  readonly proposer: NaturalLanguageProposer & {
    readonly propose: ReturnType<typeof vi.fn>;
  };
  readonly clock: Clock;
  setNow(value: Date): void;
  failAudits(value: boolean): void;
}

function createHarness(result: NaturalLanguageProposerResult = available()): Harness {
  const workspaces = [createWorkspace({ id: WORKSPACE_ID, name: "Personal", now: NOW })];
  const proposals: NaturalLanguageProposalRecord[] = [];
  const workItems: WorkItem[] = [];
  const audits: AuditEventRecord[] = [];
  let now = new Date(NOW);
  let auditFailure = false;

  const workspaceRepository: WorkspaceRepository = {
    findById: async (id) => workspaces.find((workspace) => workspace.id === id) ?? null,
    list: async () => workspaces,
    insert: async (workspace) => {
      workspaces.push(workspace);
    },
  };
  const workItemRepository = {
    findById: async (targetWorkspaceId: WorkspaceId, id: WorkItem["id"]) =>
      workItems.find((item) => item.workspaceId === targetWorkspaceId && item.id === id) ?? null,
    list: async () => workItems,
    listPlanningCandidates: async () => workItems,
    insert: async (item: WorkItem) => {
      workItems.push(item);
    },
    save: async () => undefined,
  } satisfies WorkItemRepository;
  const proposalRepository: NaturalLanguageProposalRepository = {
    findByRequestId: async (targetWorkspaceId, requestId) =>
      proposals.find(
        (proposal) =>
          proposal.workspaceId === targetWorkspaceId && proposal.requestId === requestId,
      ) ?? null,
    findByIdForUpdate: async (targetWorkspaceId, proposalId) =>
      proposals.find(
        (proposal) => proposal.workspaceId === targetWorkspaceId && proposal.id === proposalId,
      ) ?? null,
    insertOrFind: async (record) => {
      const existing = proposals.find(
        (proposal) =>
          proposal.workspaceId === record.workspaceId && proposal.requestId === record.requestId,
      );
      if (existing !== undefined) return { kind: "existing", proposal: existing };
      proposals.push(record);
      return { kind: "inserted", proposal: record };
    },
    save: async (record, expectedVersion) => {
      const index = proposals.findIndex(
        (proposal) =>
          proposal.workspaceId === record.workspaceId &&
          proposal.id === record.id &&
          proposal.version === expectedVersion,
      );
      if (index < 0) throw new Error("proposal write conflict");
      proposals[index] = record;
    },
  };
  const auditRepository: AuditEventRepository = {
    append: async (event) => {
      if (auditFailure) throw new Error("audit unavailable");
      audits.push(event);
    },
  };
  const context: NaturalLanguageProposalTransactionContext = {
    workspaces: workspaceRepository,
    workItems: workItemRepository,
    auditEvents: auditRepository,
    proposals: proposalRepository,
  };
  const unitOfWork: NaturalLanguageProposalUnitOfWork = {
    run: async (operation) => {
      const proposalSnapshot = [...proposals];
      const workItemSnapshot = [...workItems];
      const auditSnapshot = [...audits];
      try {
        return await operation(context);
      } catch (error) {
        proposals.splice(0, proposals.length, ...proposalSnapshot);
        workItems.splice(0, workItems.length, ...workItemSnapshot);
        audits.splice(0, audits.length, ...auditSnapshot);
        throw error;
      }
    },
  };
  const propose = vi.fn(async (_context: NaturalLanguageProposerContext) => result);
  const proposer = {
    provider: "ollama",
    model: "gemma4:e4b",
    propose,
  };
  return {
    workspaces,
    proposals,
    workItems,
    audits,
    unitOfWork,
    proposer,
    clock: { now: () => new Date(now) },
    setNow: (value) => {
      now = new Date(value);
    },
    failAudits: (value) => {
      auditFailure = value;
    },
  };
}

function retryOnceAfter(
  test: Harness,
  firstAttemptCompletes: () => void,
): NaturalLanguageProposalUnitOfWork {
  return {
    run: async (operation) => {
      try {
        return await test.unitOfWork.run(async (context) => {
          await operation(context);
          firstAttemptCompletes();
          throw new Error("test serialization retry");
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "test serialization retry") throw error;
        return test.unitOfWork.run(operation);
      }
    },
  };
}

async function prepare(test: Harness, prompt = "Add prepare release notes to my work list") {
  return new GenerateNaturalLanguageProposal(
    test.unitOfWork,
    test.proposer,
    test.clock,
    promptHasher,
  ).execute({
    version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
    requestId: REQUEST_ID,
    workspaceId: WORKSPACE_ID,
    prompt,
  });
}

describe("local natural-language work-item proposals", () => {
  it("persists a bounded hash-bound proposal without mutating work or storing the prompt", async () => {
    const test = createHarness();

    const result = await prepare(test);

    expect(result).toMatchObject({
      status: "proposal",
      proposal: {
        command: { type: "work_item.create", title: "Prepare release notes" },
        userSelection: {
          priority: "none",
          dueOn: null,
          planningDurationMinutes: null,
        },
        status: "pending",
        version: 1,
      },
    });
    expect(test.workItems).toHaveLength(0);
    expect(test.proposals).toHaveLength(1);
    expect(test.proposals[0]).not.toHaveProperty("prompt");
    expect(test.proposals[0]).not.toHaveProperty("summary");
    expect(test.proposals[0]).not.toHaveProperty("warnings");
    expect(test.proposals[0]?.promptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(test.proposals[0]?.commandDisplay).toBe(
      '{"title":"Prepare release notes","type":"work_item.create"}',
    );
    expect(test.audits.map((event) => event.action)).toEqual([
      "natural_language.proposal_prepared",
    ]);
    expect(test.proposer.propose).toHaveBeenCalledTimes(1);
    const context = test.proposer.propose.mock.calls[0]?.[0] as NaturalLanguageProposerContext;
    expect(context).toEqual({
      version: "schedule.natural-language-context/v1",
      requestId: REQUEST_ID,
      prompt: "Add prepare release notes to my work list",
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("keys prompt fingerprints and separates request and workspace domains", () => {
    const common = { requestId: REQUEST_ID, workspaceId: WORKSPACE_ID, prompt: "Buy milk" };
    const digest = promptHasher.digest(common);

    expect(promptHasher.digest(common)).toBe(digest);
    expect(
      promptHasher.digest({
        ...common,
        requestId: "99999999-9999-4999-8999-999999999999",
      }),
    ).not.toBe(digest);
    expect(
      promptHasher.digest({
        ...common,
        workspaceId: workspaceId("33333333-3333-4333-8333-333333333333"),
      }),
    ).not.toBe(digest);
    expect(() => new HmacNaturalLanguagePromptHasher("too-short")).toThrow("at least 32 bytes");
  });

  it("replays a request without another model call and rejects request-id content conflicts", async () => {
    const test = createHarness();
    const first = await prepare(test);
    const replay = await prepare(test);

    expect(replay.proposal?.id).toBe(first.proposal?.id);
    expect(test.proposer.propose).toHaveBeenCalledTimes(1);
    await expect(prepare(test, "Add a different task")).rejects.toMatchObject({
      code: "natural_language.request_conflict",
    });
  });

  it.each([
    ["disabled", { status: "unavailable", reason: "disabled" }],
    ["busy", { status: "unavailable", reason: "busy" }],
    ["timeout", { status: "unavailable", reason: "timeout" }],
  ] as const)("returns a non-mutating %s provider state", async (_label, providerResult) => {
    const test = createHarness(providerResult);

    await expect(prepare(test)).resolves.toMatchObject({
      status: "unavailable",
      reason: providerResult.reason,
      proposal: null,
    });
    expect(test.proposals).toHaveLength(0);
    expect(test.workItems).toHaveLength(0);
  });

  it("does not persist when the request is aborted as inference completes", async () => {
    const test = createHarness();
    const controller = new AbortController();
    test.proposer.propose.mockImplementation(async () => {
      controller.abort();
      return available();
    });

    await expect(
      new GenerateNaturalLanguageProposal(
        test.unitOfWork,
        test.proposer,
        test.clock,
        promptHasher,
      ).execute(
        {
          version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
          requestId: REQUEST_ID,
          workspaceId: WORKSPACE_ID,
          prompt: "Add prepare release notes to my work list",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(test.proposals).toHaveLength(0);
    expect(test.workItems).toHaveLength(0);
    expect(test.audits).toHaveLength(0);
  });

  it("rechecks cancellation inside the persistence transaction", async () => {
    const test = createHarness();
    const controller = new AbortController();
    let transactionCount = 0;
    const abortingUnitOfWork: NaturalLanguageProposalUnitOfWork = {
      run: async (operation) => {
        transactionCount += 1;
        if (transactionCount === 2) controller.abort();
        return test.unitOfWork.run(operation);
      },
    };

    await expect(
      new GenerateNaturalLanguageProposal(
        abortingUnitOfWork,
        test.proposer,
        test.clock,
        promptHasher,
      ).execute(
        {
          version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
          requestId: REQUEST_ID,
          workspaceId: WORKSPACE_ID,
          prompt: "Add prepare release notes to my work list",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(test.proposals).toHaveLength(0);
    expect(test.workItems).toHaveLength(0);
    expect(test.audits).toHaveLength(0);
  });

  it("rolls back when cancellation arrives after the audit write but before commit", async () => {
    const test = createHarness();
    const controller = new AbortController();
    const abortAfterAuditUnitOfWork: NaturalLanguageProposalUnitOfWork = {
      run: async (operation, signal) =>
        test.unitOfWork.run(
          async (context) =>
            operation({
              ...context,
              auditEvents: {
                append: async (event) => {
                  await context.auditEvents.append(event);
                  controller.abort();
                },
              },
            }),
          signal,
        ),
    };

    await expect(
      new GenerateNaturalLanguageProposal(
        abortAfterAuditUnitOfWork,
        test.proposer,
        test.clock,
        promptHasher,
      ).execute(
        {
          version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
          requestId: REQUEST_ID,
          workspaceId: WORKSPACE_ID,
          prompt: "Add prepare release notes to my work list",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(test.proposals).toHaveLength(0);
    expect(test.workItems).toHaveLength(0);
    expect(test.audits).toHaveLength(0);
  });

  it("returns a reviewable no-proposal result without persisting or mutating", async () => {
    const output = available();
    if (output.status !== "available") throw new Error("invalid fixture");
    const test = createHarness({
      ...output,
      output: {
        ...output.output,
        summary: "This first version can capture one work item at a time.",
        warnings: ["Describe a single concrete task."],
        command: null,
      },
    });

    await expect(prepare(test)).resolves.toMatchObject({
      status: "no_proposal",
      reason: "no_proposal",
      summary: "This first version can capture one work item at a time.",
      proposal: null,
    });
    expect(test.proposals).toHaveLength(0);
    expect(test.workItems).toHaveLength(0);
  });

  it("fails closed for extra model fields, unsafe strings, and unsupported commands", async () => {
    const cases: unknown[] = [
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Create work.",
        warnings: [],
        command: { type: "work_item.create", title: "Allowed", priority: "urgent" },
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Create\u202ework.",
        warnings: [],
        command: { type: "work_item.create", title: "Allowed" },
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Update work.",
        warnings: [],
        command: { type: "work_item.update", title: "Not allowed" },
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Create work.",
        warnings: [],
        command: { type: "work_item.create", title: 42 },
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Create work.",
        warnings: [],
        command: { type: "work_item.create", title: "Misleading\nsecond line" },
      },
    ];

    for (const output of cases) {
      const test = createHarness({ status: "available", output } as NaturalLanguageProposerResult);
      await expect(prepare(test)).resolves.toMatchObject({
        status: "unavailable",
        reason: "malformed_response",
      });
      expect(test.proposals).toHaveLength(0);
      expect(test.workItems).toHaveLength(0);
    }
  });

  it("edits the exact proposal title with a new version and audit", async () => {
    const test = createHarness();
    const generated = await prepare(test);
    const proposal = generated.proposal!;

    const updated = await new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      title: "Prepare final release notes",
      userSelection: {
        priority: "high",
        dueOn: localDate("2026-07-20"),
        planningDurationMinutes: 90,
      },
    });

    expect(updated).toMatchObject({
      command: { title: "Prepare final release notes" },
      userSelection: {
        priority: "high",
        dueOn: "2026-07-20",
        planningDurationMinutes: 90,
      },
      version: 2,
    });
    expect(updated.commandHash).not.toBe(proposal.commandHash);
    await expect(
      new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        title: "Prepare final release notes",
        userSelection: updated.userSelection,
      }),
    ).resolves.toMatchObject({
      command: { title: "Prepare final release notes" },
      version: 2,
    });
    await expect(
      new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: 99,
        title: "Prepare final release notes",
        userSelection: updated.userSelection,
      }),
    ).rejects.toMatchObject({ code: "natural_language.version_conflict" });
    expect(test.workItems).toHaveLength(0);
    expect(test.audits.map((event) => event.action)).toEqual([
      "natural_language.proposal_prepared",
      "natural_language.proposal_edited",
    ]);
  });

  it("cancels without creating work and makes the proposal terminal", async () => {
    const test = createHarness();
    const proposal = (await prepare(test)).proposal!;
    const cancelled = await new CancelNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
    });

    expect(cancelled).toMatchObject({ status: "cancelled", version: 2 });
    expect(test.workItems).toHaveLength(0);
    await expect(
      new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: 2,
        idempotencyKey: "confirm-cancelled",
      }),
    ).rejects.toMatchObject({ code: "natural_language.proposal_cancelled" });
  });

  it("confirms the complete user-reviewed snapshot as one root backlog item", async () => {
    const test = createHarness();
    const proposal = (await prepare(test)).proposal!;
    const updated = await new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      title: "Prepare final release notes",
      userSelection: {
        priority: "urgent",
        dueOn: localDate("2026-07-21"),
        planningDurationMinutes: 75,
      },
    });

    const result = await new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: updated.id,
      expectedVersion: updated.version,
      idempotencyKey: "confirm-reviewed-snapshot",
    });

    expect(result.workItem).toMatchObject({
      id: proposal.id,
      workspaceId: WORKSPACE_ID,
      parentWorkItemId: null,
      title: "Prepare final release notes",
      description: null,
      status: "backlog",
      priority: "urgent",
      dueOn: "2026-07-21",
      planningDurationMinutes: 75,
      version: 1,
    });
    expect(test.workItems).toHaveLength(1);
  });

  it("rejects invalid review fields and deterministic work-item mismatches", async () => {
    const invalidReview = createHarness();
    const invalidProposal = (await prepare(invalidReview)).proposal!;
    await expect(
      new UpdateNaturalLanguageProposal(invalidReview.unitOfWork, invalidReview.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: invalidProposal.id,
        expectedVersion: invalidProposal.version,
        title: invalidProposal.command.title,
        userSelection: {
          priority: "urgent",
          dueOn: null,
          planningDurationMinutes: 43_201,
        } as unknown as NaturalLanguageProposalUserSelection,
      }),
    ).rejects.toMatchObject({ code: "natural_language.review_invalid" });
    expect(invalidReview.proposals[0]).toMatchObject({ version: 1, status: "pending" });

    const corruptedReview = createHarness();
    const corruptedProposal = (await prepare(corruptedReview)).proposal!;
    corruptedReview.proposals[0] = {
      ...corruptedReview.proposals[0]!,
      userSelection: {
        priority: "urgent",
        dueOn: null,
        planningDurationMinutes: null,
      },
    };
    await expect(
      new ConfirmNaturalLanguageProposal(corruptedReview.unitOfWork, corruptedReview.clock).execute(
        {
          workspaceId: WORKSPACE_ID,
          proposalId: corruptedProposal.id,
          expectedVersion: corruptedProposal.version,
          idempotencyKey: "corrupt-review-digest",
        },
      ),
    ).rejects.toMatchObject({ code: "natural_language.confirmation_corrupt" });

    const collision = createHarness();
    const collisionProposal = (await prepare(collision)).proposal!;
    collision.workItems.push(
      createWorkItem({
        id: workItemId(collisionProposal.id),
        workspaceId: WORKSPACE_ID,
        title: collisionProposal.command.title,
        priority: "high",
        now: NOW,
      }),
    );
    await expect(
      new ConfirmNaturalLanguageProposal(collision.unitOfWork, collision.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: collisionProposal.id,
        expectedVersion: collisionProposal.version,
        idempotencyKey: "mismatched-existing-work-item",
      }),
    ).rejects.toMatchObject({ code: "natural_language.confirmation_corrupt" });
    expect(collision.proposals[0]).toMatchObject({ version: 1, status: "pending" });
  });

  it("rejects a confirmed replay whose stored result points at another work item", async () => {
    const test = createHarness();
    const proposal = (await prepare(test)).proposal!;
    const confirmation = new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock);
    const command = {
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      idempotencyKey: "confirmed-result-identity",
    } as const;
    await confirmation.execute(command);
    const unrelated = createWorkItem({
      id: workItemId("33333333-3333-4333-8333-333333333333"),
      workspaceId: WORKSPACE_ID,
      title: "Unrelated work",
      now: NOW,
    });
    test.workItems.push(unrelated);
    test.proposals[0] = { ...test.proposals[0]!, resultWorkItemId: unrelated.id };

    await expect(confirmation.execute(command)).rejects.toMatchObject({
      code: "natural_language.confirmation_corrupt",
    });
  });

  it("confirms the persisted command exactly once and replays the same idempotency key", async () => {
    const test = createHarness();
    const proposal = (await prepare(test)).proposal!;
    const confirm = new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock);
    const command = {
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      idempotencyKey: "confirm-release-notes",
    } as const;

    const first = await confirm.execute(command);
    const replay = await confirm.execute(command);

    expect(first).toMatchObject({ replayed: false, workItem: { title: "Prepare release notes" } });
    expect(first.workItem.id).toBe(proposal.id);
    expect(replay).toMatchObject({ replayed: true, workItem: { id: first.workItem.id } });
    expect(test.workItems).toHaveLength(1);
    expect(test.proposals[0]).toMatchObject({
      status: "confirmed",
      resultWorkItemId: first.workItem.id,
      version: 2,
    });
    expect(test.audits.map((event) => event.action)).toEqual([
      "natural_language.proposal_prepared",
      "natural_language.proposal_confirmed",
    ]);

    await expect(
      confirm.execute({ ...command, idempotencyKey: "another-confirmation-key" }),
    ).rejects.toMatchObject({ code: "natural_language.confirmation_conflict" });
    expect(test.workItems).toHaveLength(1);
  });

  it("recovers a deterministic proposal work item without creating a duplicate", async () => {
    const test = createHarness();
    const proposal = (await prepare(test)).proposal!;
    test.workItems.push(
      createWorkItem({
        id: workItemId(proposal.id),
        workspaceId: WORKSPACE_ID,
        title: proposal.command.title,
        now: NOW,
      }),
    );

    const result = await new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      idempotencyKey: "recover-existing-work-item",
    });

    expect(result).toMatchObject({ replayed: false, workItem: { id: proposal.id } });
    expect(test.workItems).toHaveLength(1);
    expect(test.proposals[0]?.status).toBe("confirmed");
  });

  it("rejects expiry, stale versions, foreign workspaces, and malformed requests", async () => {
    const test = createHarness();
    const proposal = (await prepare(test)).proposal!;
    const confirm = new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock);

    await expect(
      confirm.execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: 99,
        idempotencyKey: "stale-version",
      }),
    ).rejects.toMatchObject({ code: "natural_language.version_conflict" });

    test.setNow(new Date(NOW.getTime() + 11 * 60_000));
    await expect(prepare(test)).rejects.toMatchObject({
      code: "natural_language.proposal_expired",
    });
    expect(test.proposer.propose).toHaveBeenCalledTimes(1);
    await expect(
      confirm.execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: 1,
        idempotencyKey: "expired",
      }),
    ).rejects.toMatchObject({ code: "natural_language.proposal_expired" });
    await expect(
      confirm.execute({
        workspaceId: workspaceId("33333333-3333-4333-8333-333333333333"),
        proposalId: proposal.id,
        expectedVersion: 1,
        idempotencyKey: "foreign",
      }),
    ).rejects.toMatchObject({ code: "natural_language.proposal_not_found" });

    const invalid = new GenerateNaturalLanguageProposal(
      test.unitOfWork,
      test.proposer,
      test.clock,
      promptHasher,
    );
    await expect(
      invalid.execute({
        version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
        requestId: randomUUID(),
        workspaceId: WORKSPACE_ID,
        prompt: `unsafe${String.fromCodePoint(0)}text`,
      }),
    ).rejects.toMatchObject({ code: "natural_language.request_invalid" });
  });

  it("re-evaluates expiry when a serialized mutation transaction is retried", async () => {
    for (const mutation of ["edit", "cancel", "confirm"] as const) {
      const test = createHarness();
      const proposal = (await prepare(test)).proposal!;
      const retryingUnitOfWork = retryOnceAfter(test, () => {
        test.setNow(new Date(NOW.getTime() + 11 * 60_000));
      });

      const operation =
        mutation === "edit"
          ? new UpdateNaturalLanguageProposal(retryingUnitOfWork, test.clock).execute({
              workspaceId: WORKSPACE_ID,
              proposalId: proposal.id,
              expectedVersion: proposal.version,
              title: "Prepare final release notes",
              userSelection: proposal.userSelection,
            })
          : mutation === "cancel"
            ? new CancelNaturalLanguageProposal(retryingUnitOfWork, test.clock).execute({
                workspaceId: WORKSPACE_ID,
                proposalId: proposal.id,
                expectedVersion: proposal.version,
              })
            : new ConfirmNaturalLanguageProposal(retryingUnitOfWork, test.clock).execute({
                workspaceId: WORKSPACE_ID,
                proposalId: proposal.id,
                expectedVersion: proposal.version,
                idempotencyKey: "retry-across-expiry",
              });

      await expect(operation).rejects.toMatchObject({
        code: "natural_language.proposal_expired",
      });
      expect(test.proposals).toHaveLength(1);
      expect(test.proposals[0]).toMatchObject({ status: "pending", version: 1 });
      expect(test.workItems).toHaveLength(0);
      expect(test.audits.map((event) => event.action)).toEqual([
        "natural_language.proposal_prepared",
      ]);
    }
  });

  it("rejects a concurrent proposal winner that expires while inference is running", async () => {
    const winner = createHarness();
    await prepare(winner);
    const test = createHarness();
    test.setNow(new Date(NOW.getTime() + 11 * 60_000));
    test.proposer.propose.mockImplementation(async () => {
      test.proposals.push(winner.proposals[0]!);
      return available();
    });

    await expect(prepare(test)).rejects.toMatchObject({
      code: "natural_language.proposal_expired",
    });
    expect(test.workItems).toHaveLength(0);
    expect(test.audits).toHaveLength(0);
  });

  it("rolls back proposal creation and confirmation when audit persistence fails", async () => {
    const prepareFailure = createHarness();
    prepareFailure.failAudits(true);
    await expect(prepare(prepareFailure)).rejects.toThrow("audit unavailable");
    expect(prepareFailure.proposals).toHaveLength(0);

    const confirmFailure = createHarness();
    const proposal = (await prepare(confirmFailure)).proposal!;
    confirmFailure.failAudits(true);
    await expect(
      new ConfirmNaturalLanguageProposal(confirmFailure.unitOfWork, confirmFailure.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        idempotencyKey: "atomic-confirm",
      }),
    ).rejects.toThrow("audit unavailable");
    expect(confirmFailure.workItems).toHaveLength(0);
    expect(confirmFailure.proposals[0]?.status).toBe("pending");
  });
});
