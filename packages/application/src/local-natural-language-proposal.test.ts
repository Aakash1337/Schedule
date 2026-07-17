import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createScheduleBlock,
  createWorkItem,
  createWorkspace,
  localDate,
  scheduleBlockId,
  routineId,
  workItemId,
  workspaceId,
  type ScheduleBlock,
  type Routine,
  type WorkItem,
  type Workspace,
  type WorkspaceId,
} from "@schedule/domain";

import type {
  AuditEventRecord,
  AuditEventRepository,
  Clock,
  ScheduleBlockRepository,
  RoutineRepository,
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
  naturalLanguageProposalCommandDisplay,
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
      modelSuggestions: null,
    },
  };
}

function availableScheduleBlock(
  overrides: Partial<{
    title: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
  }> = {},
): NaturalLanguageProposerResult {
  return {
    status: "available",
    output: {
      version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
      summary: "Review one calendar block.",
      warnings: [],
      command: {
        type: "schedule_block.create",
        title: overrides.title ?? "Quarterly report",
        startsAt: overrides.startsAt ?? "2026-07-15T14:00:00.000Z",
        endsAt: overrides.endsAt ?? "2026-07-15T15:00:00.000Z",
        timeZone: overrides.timeZone ?? "UTC",
      },
      modelSuggestions: null,
    },
  };
}

function availableRoutine(title = "Practice piano"): NaturalLanguageProposerResult {
  return {
    status: "available",
    output: {
      version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
      summary: "Review one routine.",
      warnings: [],
      command: { type: "routine.create", title },
      modelSuggestions: null,
    },
  };
}

interface Harness {
  readonly workspaces: Workspace[];
  readonly proposals: NaturalLanguageProposalRecord[];
  readonly workItems: WorkItem[];
  readonly scheduleBlocks: ScheduleBlock[];
  readonly routines: Routine[];
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
  const scheduleBlocks: ScheduleBlock[] = [];
  const routines: Routine[] = [];
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
  const scheduleBlockRepository = {
    findById: async (targetWorkspaceId, id) =>
      scheduleBlocks.find((block) => block.workspaceId === targetWorkspaceId && block.id === id) ??
      null,
    listOverlapping: async () => scheduleBlocks,
    insert: async (block) => {
      scheduleBlocks.push(block);
    },
    save: async () => undefined,
    delete: async () => undefined,
  } satisfies ScheduleBlockRepository;
  const routineRepository = {
    findById: async (targetWorkspaceId: WorkspaceId, id: Routine["id"]) =>
      routines.find((routine) => routine.workspaceId === targetWorkspaceId && routine.id === id) ??
      null,
    list: async () => routines,
    listPlanningCandidates: async () => routines,
    insert: async (routine: Routine) => {
      routines.push(routine);
    },
    save: async () => undefined,
  } satisfies RoutineRepository;
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
    scheduleBlocks: scheduleBlockRepository,
    routines: routineRepository,
    auditEvents: auditRepository,
    proposals: proposalRepository,
  };
  const unitOfWork: NaturalLanguageProposalUnitOfWork = {
    run: async (operation) => {
      const proposalSnapshot = [...proposals];
      const workItemSnapshot = [...workItems];
      const scheduleBlockSnapshot = [...scheduleBlocks];
      const routineSnapshot = [...routines];
      const auditSnapshot = [...audits];
      try {
        return await operation(context);
      } catch (error) {
        proposals.splice(0, proposals.length, ...proposalSnapshot);
        workItems.splice(0, workItems.length, ...workItemSnapshot);
        scheduleBlocks.splice(0, scheduleBlocks.length, ...scheduleBlockSnapshot);
        routines.splice(0, routines.length, ...routineSnapshot);
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
    scheduleBlocks,
    routines,
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
    referenceDate: null,
    timeZone: "UTC",
  });
}

describe("local natural-language proposals", () => {
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
      version: "schedule.natural-language-context/v4",
      requestId: REQUEST_ID,
      prompt: "Add prepare release notes to my work list",
      referenceDate: null,
      timeZone: "UTC",
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("keys prompt fingerprints and separates request and workspace domains", () => {
    const common = {
      requestId: REQUEST_ID,
      workspaceId: WORKSPACE_ID,
      prompt: "Buy milk",
      referenceDate: null,
      timeZone: "UTC",
    };
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
    expect(promptHasher.digest({ ...common, referenceDate: localDate("2026-07-14") })).not.toBe(
      digest,
    );
    expect(() => new HmacNaturalLanguagePromptHasher("too-short")).toThrow("at least 32 bytes");
  });

  it("binds the reference date into the model context and request replay fingerprint", async () => {
    const test = createHarness();
    const generate = new GenerateNaturalLanguageProposal(
      test.unitOfWork,
      test.proposer,
      test.clock,
      promptHasher,
    );
    const input = {
      version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
      requestId: REQUEST_ID,
      workspaceId: WORKSPACE_ID,
      prompt: "Add prepare release notes to my work list",
      referenceDate: localDate("2026-07-14"),
      timeZone: "UTC",
    } as const;

    await generate.execute(input);
    expect(test.proposer.propose.mock.calls[0]?.[0]).toMatchObject({
      version: "schedule.natural-language-context/v4",
      referenceDate: "2026-07-14",
      timeZone: "UTC",
    });
    await expect(
      generate.execute({ ...input, referenceDate: localDate("2026-07-15") }),
    ).rejects.toMatchObject({ code: "natural_language.request_conflict" });
    expect(test.proposer.propose).toHaveBeenCalledTimes(1);
  });

  it("keeps model suggestions advisory until an explicit user review update", async () => {
    const output = available();
    if (output.status !== "available") throw new Error("invalid fixture");
    const test = createHarness({
      ...output,
      output: {
        ...output.output,
        modelSuggestions: {
          priority: "urgent",
          dueOn: "2026-07-20",
          planningDurationMinutes: 90,
        },
      },
    });
    const proposal = (await prepare(test)).proposal!;

    expect(proposal).toMatchObject({
      modelSuggestions: { priority: "urgent", dueOn: "2026-07-20", planningDurationMinutes: 90 },
      userSelection: { priority: "none", dueOn: null, planningDurationMinutes: null },
    });
    expect(test.audits[0]?.data).not.toHaveProperty("modelSuggestions");
    const confirmed = await new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock).execute(
      {
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        idempotencyKey: "confirm-defaults-ignore-suggestions",
      },
    );
    expect(confirmed.workItem).toMatchObject({
      priority: "none",
      dueOn: null,
      planningDurationMinutes: null,
    });
    expect(test.audits.at(-1)?.data).not.toHaveProperty("modelSuggestions");
  });

  it("strictly rejects malformed model suggestions and normalizes an empty suggestion object to null", async () => {
    const base = available();
    if (base.status !== "available") throw new Error("invalid fixture");
    const normalized = createHarness({
      ...base,
      output: {
        ...base.output,
        modelSuggestions: { priority: null, dueOn: null, planningDurationMinutes: null },
      },
    });
    await expect(prepare(normalized)).resolves.toMatchObject({
      proposal: { modelSuggestions: null },
    });

    for (const modelSuggestions of [
      { priority: "none", dueOn: null, planningDurationMinutes: null },
      { priority: "high", dueOn: "2026-02-30", planningDurationMinutes: null },
      { priority: "medium", dueOn: null, planningDurationMinutes: 0 },
      { priority: "low", dueOn: null, planningDurationMinutes: null, extra: true },
    ]) {
      const test = createHarness({
        ...base,
        output: { ...base.output, modelSuggestions },
      });
      await expect(prepare(test)).resolves.toMatchObject({
        status: "unavailable",
        reason: "malformed_response",
      });
      expect(test.proposals).toHaveLength(0);
      expect(test.workItems).toHaveLength(0);
    }
  });

  it("preserves immutable model suggestions across an explicit user review update", async () => {
    const output = available();
    if (output.status !== "available") throw new Error("invalid fixture");
    const test = createHarness({
      ...output,
      output: {
        ...output.output,
        modelSuggestions: { priority: "high", dueOn: null, planningDurationMinutes: 45 },
      },
    });
    const proposal = (await prepare(test)).proposal!;
    const updated = await new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      command: { type: "work_item.create", title: proposal.command.title },
      userSelection: { priority: "high", dueOn: null, planningDurationMinutes: 45 },
    });

    expect(updated.modelSuggestions).toEqual(proposal.modelSuggestions);
    expect(test.audits.at(-1)?.data).not.toHaveProperty("modelSuggestions");
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

  it("permits v3 only as a hash-matched pending replay and always returns the v4 envelope", async () => {
    const test = createHarness();
    const first = await prepare(test);
    const legacyInput = {
      version: "schedule.natural-language/v3" as const,
      requestId: REQUEST_ID,
      workspaceId: WORKSPACE_ID,
      prompt: "Add prepare release notes to my work list",
      referenceDate: null,
      timeZone: "UTC",
    };
    test.proposals[0] = {
      ...test.proposals[0]!,
      promptHash: promptHasher.digestLegacyV3({
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        prompt: legacyInput.prompt,
        referenceDate: null,
        timeZone: "UTC",
      }),
    };
    const replay = await new GenerateNaturalLanguageProposal(
      test.unitOfWork,
      test.proposer,
      test.clock,
      promptHasher,
    ).execute(legacyInput);
    expect(replay).toMatchObject({
      version: NATURAL_LANGUAGE_PROPOSAL_VERSION,
      proposal: { id: first.proposal!.id },
    });
    expect(test.proposer.propose).toHaveBeenCalledTimes(1);

    await expect(
      new GenerateNaturalLanguageProposal(
        test.unitOfWork,
        test.proposer,
        test.clock,
        promptHasher,
      ).execute({
        ...legacyInput,
        prompt: "Different legacy text",
      }),
    ).rejects.toMatchObject({ code: "natural_language.request_conflict" });
  });

  it("rejects a new v3 request without provider work or proposal persistence", async () => {
    const test = createHarness();
    await expect(
      new GenerateNaturalLanguageProposal(
        test.unitOfWork,
        test.proposer,
        test.clock,
        promptHasher,
      ).execute({
        version: "schedule.natural-language/v3",
        requestId: REQUEST_ID,
        workspaceId: WORKSPACE_ID,
        prompt: "Create a legacy proposal",
        referenceDate: null,
        timeZone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "natural_language.request_invalid" });
    expect(test.proposer.propose).not.toHaveBeenCalled();
    expect(test.proposals).toHaveLength(0);
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
          referenceDate: null,
          timeZone: "UTC",
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
          referenceDate: null,
          timeZone: "UTC",
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
          referenceDate: null,
          timeZone: "UTC",
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
        modelSuggestions: null,
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
        modelSuggestions: null,
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Create\u202ework.",
        warnings: [],
        command: { type: "work_item.create", title: "Allowed" },
        modelSuggestions: null,
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Update work.",
        warnings: [],
        command: { type: "work_item.update", title: "Not allowed" },
        modelSuggestions: null,
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Create work.",
        warnings: [],
        command: { type: "work_item.create", title: 42 },
        modelSuggestions: null,
      },
      {
        version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
        summary: "Create work.",
        warnings: [],
        command: { type: "work_item.create", title: "Misleading\nsecond line" },
        modelSuggestions: null,
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
      command: { type: "work_item.create", title: "Prepare final release notes" },
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
        command: { type: "work_item.create", title: "Prepare final release notes" },
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
        command: { type: "work_item.create", title: "Prepare final release notes" },
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
      command: { type: "work_item.create", title: "Prepare final release notes" },
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
        command: { type: "work_item.create", title: invalidProposal.command.title },
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

  it("confirms one reviewed calendar block exactly once without creating work", async () => {
    const test = createHarness(availableScheduleBlock());
    const proposal = (await prepare(test, "Block tomorrow from 2 to 3 for the report")).proposal!;
    expect(proposal.command.type).toBe("schedule_block.create");
    const confirm = new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock);
    const command = {
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      idempotencyKey: "confirm-calendar-block",
    } as const;

    const first = await confirm.execute(command);
    const replay = await confirm.execute(command);

    expect(first).toMatchObject({
      replayed: false,
      resultType: "schedule_block",
      workItem: null,
      scheduleBlock: {
        id: proposal.id,
        workspaceId: WORKSPACE_ID,
        workItemId: null,
        title: "Quarterly report",
        startsAt: new Date("2026-07-15T14:00:00.000Z"),
        endsAt: new Date("2026-07-15T15:00:00.000Z"),
        timeZone: "UTC",
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      resultType: "schedule_block",
      scheduleBlock: { id: proposal.id },
    });
    expect(test.workItems).toHaveLength(0);
    expect(test.scheduleBlocks).toHaveLength(1);
    expect(test.proposals[0]).toMatchObject({
      status: "confirmed",
      resultWorkItemId: null,
      resultScheduleBlockId: proposal.id,
      version: 2,
    });
    await expect(
      confirm.execute({ ...command, idempotencyKey: "different-calendar-key" }),
    ).rejects.toMatchObject({ code: "natural_language.confirmation_conflict" });
  });

  it("persists reviewed calendar-block edits before confirmation", async () => {
    const test = createHarness(availableScheduleBlock());
    const proposal = (await prepare(test)).proposal!;
    const updater = new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock);
    await expect(
      updater.execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        command: {
          type: "schedule_block.create",
          title: "Deep work",
          startsAt: "2026-07-15T15:30:00.000Z",
          endsAt: "2026-07-15T17:00:00.000Z",
          timeZone: "America/New_York",
        },
      }),
    ).rejects.toMatchObject({ code: "natural_language.proposal_invalid" });

    const updated = await updater.execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      command: {
        type: "schedule_block.create",
        title: "Deep work",
        startsAt: "2026-07-15T15:30:00.000Z",
        endsAt: "2026-07-15T17:00:00.000Z",
        timeZone: "UTC",
      },
    });

    expect(updated).toMatchObject({
      version: 2,
      command: {
        type: "schedule_block.create",
        title: "Deep work",
        startsAt: "2026-07-15T15:30:00.000Z",
        endsAt: "2026-07-15T17:00:00.000Z",
      },
      userSelection: { priority: "none", dueOn: null, planningDurationMinutes: null },
    });
    const result = await new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: updated.version,
      idempotencyKey: "confirm-edited-calendar-block",
    });
    expect(result).toMatchObject({
      resultType: "schedule_block",
      scheduleBlock: { title: "Deep work", startsAt: new Date("2026-07-15T15:30:00.000Z") },
    });
  });

  it("fails closed for unsafe calendar-block model output and deterministic collisions", async () => {
    const scheduleBlockWithSuggestions = availableScheduleBlock();
    if (scheduleBlockWithSuggestions.status !== "available") throw new Error("Expected output.");
    const invalidOutputs = [
      availableScheduleBlock({ timeZone: "America/New_York" }),
      availableScheduleBlock({ startsAt: "2026-07-15T10:00:00-04:00" }),
      availableScheduleBlock({ endsAt: "2026-07-16T15:00:00.001Z" }),
      {
        ...scheduleBlockWithSuggestions,
        output: {
          ...scheduleBlockWithSuggestions.output,
          modelSuggestions: { priority: "high", dueOn: null, planningDurationMinutes: null },
        },
      },
    ];
    for (const output of invalidOutputs) {
      const test = createHarness(output);
      await expect(prepare(test)).resolves.toMatchObject({
        status: "unavailable",
        reason: "malformed_response",
      });
      expect(test.proposals).toHaveLength(0);
      expect(test.scheduleBlocks).toHaveLength(0);
    }

    const collision = createHarness(availableScheduleBlock());
    const proposal = (await prepare(collision)).proposal!;
    collision.scheduleBlocks.push(
      createScheduleBlock({
        id: scheduleBlockId(proposal.id),
        workspaceId: WORKSPACE_ID,
        title: "Different block",
        startsAt: new Date("2026-07-15T14:00:00.000Z"),
        endsAt: new Date("2026-07-15T15:00:00.000Z"),
        timeZone: "UTC",
        now: NOW,
      }),
    );
    await expect(
      new ConfirmNaturalLanguageProposal(collision.unitOfWork, collision.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        idempotencyKey: "calendar-collision",
      }),
    ).rejects.toMatchObject({ code: "natural_language.confirmation_corrupt" });
    expect(collision.proposals[0]?.status).toBe("pending");
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
              command: { type: "work_item.create", title: "Prepare final release notes" },
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

  it("normalizes a compact provider routine into the native editor defaults without a user selection", async () => {
    const test = createHarness(availableRoutine());
    const proposal = (await prepare(test)).proposal!;
    expect(proposal).toMatchObject({
      command: {
        type: "routine.create",
        title: "Practice piano",
        description: null,
        status: "active",
        tags: {
          priority: "medium",
          effort: "medium",
          energy: "normal",
          preference: "neutral",
          contexts: [],
          categories: [],
          freeForm: [],
        },
        duration: {
          minimumMinutes: 15,
          expectedMinutes: 30,
          maximumMinutes: 60,
          splittable: false,
          minimumSessionMinutes: null,
          overheadMinutes: 0,
        },
        cadence: {
          period: "week",
          rollingIntervalDays: null,
          targetCompletions: 3,
          minimumCompletions: null,
          maximumCompletions: null,
          minimumSpacingDays: 1,
          discourageConsecutiveDays: true,
          prohibitConsecutiveDays: false,
          weekStartsOn: 1,
          preferredWeekdays: [],
          excludedWeekdays: [],
          startsOn: null,
          pausedUntil: null,
          endsOn: null,
        },
      },
      userSelection: null,
      modelSuggestions: null,
    });
    expect(test.workItems).toHaveLength(0);
    expect(test.routines).toHaveLength(0);
  });

  it("rejects provider-authored routine policy fields or suggestions", async () => {
    const base = availableRoutine();
    if (base.status !== "available") throw new Error("invalid fixture");
    for (const output of [
      { ...base.output, command: { type: "routine.create", title: "Read", duration: {} } },
      {
        ...base.output,
        modelSuggestions: { priority: "high", dueOn: null, planningDurationMinutes: null },
      },
    ]) {
      const test = createHarness({ status: "available", output } as NaturalLanguageProposerResult);
      await expect(prepare(test)).resolves.toMatchObject({
        status: "unavailable",
        reason: "malformed_response",
      });
      expect(test.proposals).toHaveLength(0);
    }
  });

  it("accepts a native-cap routine description even when its canonical display exceeds the legacy database limit", async () => {
    const test = createHarness(availableRoutine());
    const proposal = (await prepare(test)).proposal!;
    const command = proposal.command as Extract<
      typeof proposal.command,
      { type: "routine.create" }
    >;
    const reviewed = {
      ...command,
      description: "d".repeat(4_000),
    } as const;
    expect(naturalLanguageProposalCommandDisplay(reviewed).length).toBeGreaterThan(1_000);

    await expect(
      new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
        workspaceId: WORKSPACE_ID,
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        command: reviewed,
      }),
    ).resolves.toMatchObject({ command: { description: reviewed.description } });
  });

  it("requires a full explicit routine review and confirms its exact deterministic snapshot once", async () => {
    const test = createHarness(availableRoutine());
    const proposal = (await prepare(test)).proposal!;
    const command = proposal.command as Extract<
      typeof proposal.command,
      { type: "routine.create" }
    >;
    const updated = await new UpdateNaturalLanguageProposal(test.unitOfWork, test.clock).execute({
      workspaceId: WORKSPACE_ID,
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      command: {
        ...command,
        title: "Practice piano scales",
        description: "Use a deliberate tempo and record one clean take.",
        tags: {
          priority: "high",
          effort: "medium",
          energy: "normal",
          preference: "enjoyable",
          contexts: ["home"],
          categories: ["music"],
          freeForm: ["piano"],
        },
        duration: { ...command.duration, expectedMinutes: 45, maximumMinutes: 60 },
      },
    });
    expect(updated.userSelection).toBeNull();
    const confirm = new ConfirmNaturalLanguageProposal(test.unitOfWork, test.clock);
    const request = {
      workspaceId: WORKSPACE_ID,
      proposalId: updated.id,
      expectedVersion: updated.version,
      idempotencyKey: "routine-confirm",
    } as const;
    const first = await confirm.execute(request);
    const replay = await confirm.execute(request);
    expect(first).toMatchObject({
      resultType: "routine",
      replayed: false,
      routine: { id: routineId(proposal.id), title: "Practice piano scales", version: 1 },
    });
    expect(replay).toMatchObject({
      resultType: "routine",
      replayed: true,
      routine: { id: routineId(proposal.id) },
    });
    expect(test.routines).toHaveLength(1);
    expect(test.audits.at(-1)?.data).toMatchObject({
      resultType: "routine",
      resultId: routineId(proposal.id),
    });
  });
});
