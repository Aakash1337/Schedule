import {
  AddWorkItemDependency,
  ApproveRoutineDurationInsight,
  CancelNaturalLanguageProposal,
  CreateRoutine,
  CreateNotificationRule,
  CreateOneOffReminder,
  CreateScheduleBlock,
  CreateWorkItem,
  CreateWorkspace,
  DismissDailyPlanFitInsight,
  DismissRoutineDurationInsight,
  DailyPlanAlternatives,
  GenerateDailyPlan,
  GenerateNaturalLanguageProposal,
  GetCurrentDailyPlan,
  GetDailyPlan,
  GetDailyPlanFitInsight,
  GetSchedulingAdvice,
  GetRoutine,
  GetRoutineSelectionPreferenceState,
  GetNotificationProfile,
  GetRoutineDurationInsight,
  GetScheduleBlock,
  GetWorkItem,
  GetWorkspace,
  ListRoutineActivity,
  ListDailyPlanFitUsageOutcomes,
  ListNotificationIntents,
  ListNotificationDeliveries,
  ListNotificationRules,
  ListOneOffReminders,
  ListRoutines,
  ListScheduleBlocks,
  ListWorkItemDependencies,
  ListWorkItemChildren,
  ListWorkItems,
  ListWorkspaces,
  MutateDailyPlan,
  MaterializeNotificationIntents,
  ConfigureNotificationProfile,
  CancelOneOffReminder,
  RecordActivityEvent,
  RecordPlanItemActivity,
  RecordRoutineSelectionPreferenceFeedback,
  RemoveWorkItemDependency,
  ResetDailyPlanFitInsightDismissal,
  ResetRoutineDurationInsightDismissal,
  SetPlanItemLock,
  DeleteScheduleBlock,
  UpdateScheduleBlock,
  UpdateWorkItem,
  UpdateRoutine,
  UpdateNotificationRule,
  UpdateNaturalLanguageProposal,
  UpdateOneOffReminder,
  ConfirmNaturalLanguageProposal,
  type Clock,
  type NaturalLanguagePromptHasher,
  type NaturalLanguageProposalUnitOfWork,
  type NaturalLanguageProposer,
  type SchedulingAdvisor,
  type UnitOfWork,
} from "@schedule/application";

import { DisabledSchedulingAdvisor } from "./local-model-advisor.js";
import type { ProductServices } from "./product-routes.js";

export interface NaturalLanguageProductOptions {
  readonly unitOfWork: NaturalLanguageProposalUnitOfWork;
  readonly proposer: NaturalLanguageProposer;
  readonly promptHasher: NaturalLanguagePromptHasher;
  readonly proposalTtlMilliseconds?: number;
}

export function createProductServices(
  unitOfWork: UnitOfWork,
  clock: Clock,
  advisor: SchedulingAdvisor = new DisabledSchedulingAdvisor(),
  naturalLanguage?: NaturalLanguageProductOptions,
): ProductServices {
  const approveRoutineDurationInsight = new ApproveRoutineDurationInsight(unitOfWork, clock);
  const addWorkItemDependency = new AddWorkItemDependency(unitOfWork, clock);
  const dismissDailyPlanFitInsight = new DismissDailyPlanFitInsight(unitOfWork, clock);
  const dismissRoutineDurationInsight = new DismissRoutineDurationInsight(unitOfWork, clock);
  const createWorkspace = new CreateWorkspace(unitOfWork, clock);
  const getWorkspace = new GetWorkspace(unitOfWork);
  const listWorkspaces = new ListWorkspaces(unitOfWork);
  const createRoutine = new CreateRoutine(unitOfWork, clock);
  const createWorkItem = new CreateWorkItem(unitOfWork, clock);
  const getWorkItem = new GetWorkItem(unitOfWork);
  const listWorkItems = new ListWorkItems(unitOfWork);
  const listWorkItemChildren = new ListWorkItemChildren(unitOfWork);
  const updateWorkItem = new UpdateWorkItem(unitOfWork, clock);
  const createScheduleBlock = new CreateScheduleBlock(unitOfWork, clock);
  const getScheduleBlock = new GetScheduleBlock(unitOfWork);
  const listScheduleBlocks = new ListScheduleBlocks(unitOfWork);
  const listWorkItemDependencies = new ListWorkItemDependencies(unitOfWork);
  const updateScheduleBlock = new UpdateScheduleBlock(unitOfWork, clock);
  const deleteScheduleBlock = new DeleteScheduleBlock(unitOfWork, clock);
  const getRoutine = new GetRoutine(unitOfWork);
  const getRoutineSelectionPreferenceState = new GetRoutineSelectionPreferenceState(
    unitOfWork,
    clock,
  );
  const getRoutineDurationInsight = new GetRoutineDurationInsight(unitOfWork, clock);
  const updateRoutine = new UpdateRoutine(unitOfWork, clock);
  const listRoutines = new ListRoutines(unitOfWork);
  const listRoutineActivity = new ListRoutineActivity(unitOfWork);
  const recordActivityEvent = new RecordActivityEvent(unitOfWork, clock);
  const recordPlanItemActivity = new RecordPlanItemActivity(unitOfWork, clock);
  const recordRoutineSelectionPreferenceFeedback = new RecordRoutineSelectionPreferenceFeedback(
    unitOfWork,
    clock,
  );
  const removeWorkItemDependency = new RemoveWorkItemDependency(unitOfWork, clock);
  const resetRoutineDurationInsightDismissal = new ResetRoutineDurationInsightDismissal(
    unitOfWork,
    clock,
  );
  const generateDailyPlan = new GenerateDailyPlan(unitOfWork, clock);
  const dailyPlanAlternatives = new DailyPlanAlternatives(unitOfWork, clock);
  const getCurrentDailyPlan = new GetCurrentDailyPlan(unitOfWork);
  const getDailyPlanFitInsight = new GetDailyPlanFitInsight(unitOfWork, clock);
  const listDailyPlanFitUsageOutcomes = new ListDailyPlanFitUsageOutcomes(unitOfWork);
  const setPlanItemLock = new SetPlanItemLock(unitOfWork, clock);
  const mutateDailyPlan = new MutateDailyPlan(unitOfWork, clock);
  const getDailyPlan = new GetDailyPlan(unitOfWork);
  const resetDailyPlanFitInsightDismissal = new ResetDailyPlanFitInsightDismissal(
    unitOfWork,
    clock,
  );
  const getSchedulingAdvice = new GetSchedulingAdvice(unitOfWork, advisor, clock);
  const configureNotificationProfile = new ConfigureNotificationProfile(unitOfWork, clock);
  const getNotificationProfile = new GetNotificationProfile(unitOfWork);
  const createNotificationRule = new CreateNotificationRule(unitOfWork, clock);
  const updateNotificationRule = new UpdateNotificationRule(unitOfWork, clock);
  const listNotificationRules = new ListNotificationRules(unitOfWork);
  const createOneOffReminder = new CreateOneOffReminder(unitOfWork, clock);
  const updateOneOffReminder = new UpdateOneOffReminder(unitOfWork, clock);
  const cancelOneOffReminder = new CancelOneOffReminder(unitOfWork, clock);
  const listOneOffReminders = new ListOneOffReminders(unitOfWork);
  const listNotificationIntents = new ListNotificationIntents(unitOfWork);
  const listNotificationDeliveries = new ListNotificationDeliveries(unitOfWork);
  const materializeNotificationIntents = new MaterializeNotificationIntents(unitOfWork, clock);
  const generateNaturalLanguageProposal =
    naturalLanguage === undefined
      ? null
      : new GenerateNaturalLanguageProposal(
          naturalLanguage.unitOfWork,
          naturalLanguage.proposer,
          clock,
          naturalLanguage.promptHasher,
          naturalLanguage.proposalTtlMilliseconds,
        );
  const updateNaturalLanguageProposal =
    naturalLanguage === undefined
      ? null
      : new UpdateNaturalLanguageProposal(naturalLanguage.unitOfWork, clock);
  const cancelNaturalLanguageProposal =
    naturalLanguage === undefined
      ? null
      : new CancelNaturalLanguageProposal(naturalLanguage.unitOfWork, clock);
  const confirmNaturalLanguageProposal =
    naturalLanguage === undefined
      ? null
      : new ConfirmNaturalLanguageProposal(naturalLanguage.unitOfWork, clock);

  const naturalLanguageDisabled = (): never => {
    throw new Error("Natural-language proposal services are not configured.");
  };

  return {
    addWorkItemDependency: (command) => addWorkItemDependency.execute(command),
    approveRoutineDurationInsight: (command) => approveRoutineDurationInsight.execute(command),
    dismissDailyPlanFitInsight: (command) => dismissDailyPlanFitInsight.execute(command),
    dismissRoutineDurationInsight: (command) => dismissRoutineDurationInsight.execute(command),
    createWorkspace: (command) => createWorkspace.execute(command),
    getWorkspace: (query) => getWorkspace.execute(query),
    listWorkspaces: (query) => listWorkspaces.execute(query),
    createRoutine: (command) => createRoutine.execute(command),
    createWorkItem: (command) => createWorkItem.execute(command),
    getWorkItem: (query) => getWorkItem.execute(query),
    listWorkItems: (query) => listWorkItems.execute(query),
    listWorkItemChildren: (query) => listWorkItemChildren.execute(query),
    updateWorkItem: (command) => updateWorkItem.execute(command),
    createScheduleBlock: (command) => createScheduleBlock.execute(command),
    getScheduleBlock: (query) => getScheduleBlock.execute(query),
    listScheduleBlocks: (query) => listScheduleBlocks.execute(query),
    listWorkItemDependencies: (query) => listWorkItemDependencies.execute(query),
    updateScheduleBlock: (command) => updateScheduleBlock.execute(command),
    deleteScheduleBlock: (command) => deleteScheduleBlock.execute(command),
    getRoutine: (query) => getRoutine.execute(query),
    getRoutineSelectionPreferenceState: (query) =>
      getRoutineSelectionPreferenceState.execute(query),
    getRoutineDurationInsight: (query) => getRoutineDurationInsight.execute(query),
    updateRoutine: (command) => updateRoutine.execute(command),
    listRoutines: (query) => listRoutines.execute(query),
    listRoutineActivity: (query) => listRoutineActivity.execute(query),
    recordActivityEvent: (command) => recordActivityEvent.execute(command),
    recordPlanItemActivity: (command) => recordPlanItemActivity.execute(command),
    recordRoutineSelectionPreferenceFeedback: (command) =>
      recordRoutineSelectionPreferenceFeedback.execute(command),
    removeWorkItemDependency: (command) => removeWorkItemDependency.execute(command),
    resetRoutineDurationInsightDismissal: (command) =>
      resetRoutineDurationInsightDismissal.execute(command),
    resetDailyPlanFitInsightDismissal: (command) =>
      resetDailyPlanFitInsightDismissal.execute(command),
    generateDailyPlan: (command) => generateDailyPlan.execute(command),
    previewDailyPlanAlternatives: (command) => dailyPlanAlternatives.preview(command),
    selectDailyPlanAlternative: (command) => dailyPlanAlternatives.select(command),
    getCurrentDailyPlan: (query) => getCurrentDailyPlan.execute(query),
    getDailyPlanFitInsight: (query) => getDailyPlanFitInsight.execute(query),
    listDailyPlanFitUsageOutcomes: (query) => listDailyPlanFitUsageOutcomes.execute(query),
    setPlanItemLock: (command) => setPlanItemLock.execute(command),
    regenerateDailyPlan: (command) => mutateDailyPlan.regenerate(command),
    replacePlanItem: (command) => mutateDailyPlan.replace(command),
    applyRoutineFeedback: (command) => mutateDailyPlan.applyRoutineFeedback(command),
    resetRoutineFeedback: (command) => mutateDailyPlan.resetRoutineFeedback(command),
    getDailyPlan: (query) => getDailyPlan.execute(query),
    getSchedulingAdvice: (command, signal) => getSchedulingAdvice.execute(command, signal),
    configureNotificationProfile: (command) => configureNotificationProfile.execute(command),
    getNotificationProfile: (workspaceId) => getNotificationProfile.execute(workspaceId),
    createNotificationRule: (command) => createNotificationRule.execute(command),
    updateNotificationRule: (command) => updateNotificationRule.execute(command),
    listNotificationRules: (workspaceId) => listNotificationRules.execute(workspaceId),
    createOneOffReminder: (command) => createOneOffReminder.execute(command),
    updateOneOffReminder: (command) => updateOneOffReminder.execute(command),
    cancelOneOffReminder: (command) => cancelOneOffReminder.execute(command),
    listOneOffReminders: (query) => listOneOffReminders.execute(query),
    listNotificationIntents: (query) => listNotificationIntents.execute(query),
    listNotificationDeliveries: (query) => listNotificationDeliveries.execute(query),
    materializeNotificationIntents: (command) => materializeNotificationIntents.execute(command),
    generateNaturalLanguageProposal: (command, signal) => {
      if (generateNaturalLanguageProposal === null) return naturalLanguageDisabled();
      return generateNaturalLanguageProposal.execute(command, signal);
    },
    updateNaturalLanguageProposal: (command) => {
      if (updateNaturalLanguageProposal === null) return naturalLanguageDisabled();
      return updateNaturalLanguageProposal.execute(command);
    },
    cancelNaturalLanguageProposal: (command) => {
      if (cancelNaturalLanguageProposal === null) return naturalLanguageDisabled();
      return cancelNaturalLanguageProposal.execute(command);
    },
    confirmNaturalLanguageProposal: (command) => {
      if (confirmNaturalLanguageProposal === null) return naturalLanguageDisabled();
      return confirmNaturalLanguageProposal.execute(command);
    },
  };
}
