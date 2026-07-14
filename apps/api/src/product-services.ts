import {
  ApproveRoutineDurationInsight,
  CreateRoutine,
  CreateScheduleBlock,
  CreateWorkItem,
  CreateWorkspace,
  DismissRoutineDurationInsight,
  GenerateDailyPlan,
  GetCurrentDailyPlan,
  GetDailyPlan,
  GetSchedulingAdvice,
  GetRoutine,
  GetRoutineDurationInsight,
  GetScheduleBlock,
  GetWorkItem,
  GetWorkspace,
  ListRoutineActivity,
  ListRoutines,
  ListScheduleBlocks,
  ListWorkItems,
  ListWorkspaces,
  MutateDailyPlan,
  RecordActivityEvent,
  RecordPlanItemActivity,
  ResetRoutineDurationInsightDismissal,
  SetPlanItemLock,
  DeleteScheduleBlock,
  UpdateScheduleBlock,
  UpdateWorkItem,
  UpdateRoutine,
  type Clock,
  type SchedulingAdvisor,
  type UnitOfWork,
} from "@schedule/application";

import { DisabledSchedulingAdvisor } from "./local-model-advisor.js";
import type { ProductServices } from "./product-routes.js";

export function createProductServices(
  unitOfWork: UnitOfWork,
  clock: Clock,
  advisor: SchedulingAdvisor = new DisabledSchedulingAdvisor(),
): ProductServices {
  const approveRoutineDurationInsight = new ApproveRoutineDurationInsight(unitOfWork, clock);
  const dismissRoutineDurationInsight = new DismissRoutineDurationInsight(unitOfWork, clock);
  const createWorkspace = new CreateWorkspace(unitOfWork, clock);
  const getWorkspace = new GetWorkspace(unitOfWork);
  const listWorkspaces = new ListWorkspaces(unitOfWork);
  const createRoutine = new CreateRoutine(unitOfWork, clock);
  const createWorkItem = new CreateWorkItem(unitOfWork, clock);
  const getWorkItem = new GetWorkItem(unitOfWork);
  const listWorkItems = new ListWorkItems(unitOfWork);
  const updateWorkItem = new UpdateWorkItem(unitOfWork, clock);
  const createScheduleBlock = new CreateScheduleBlock(unitOfWork, clock);
  const getScheduleBlock = new GetScheduleBlock(unitOfWork);
  const listScheduleBlocks = new ListScheduleBlocks(unitOfWork);
  const updateScheduleBlock = new UpdateScheduleBlock(unitOfWork, clock);
  const deleteScheduleBlock = new DeleteScheduleBlock(unitOfWork, clock);
  const getRoutine = new GetRoutine(unitOfWork);
  const getRoutineDurationInsight = new GetRoutineDurationInsight(unitOfWork, clock);
  const updateRoutine = new UpdateRoutine(unitOfWork, clock);
  const listRoutines = new ListRoutines(unitOfWork);
  const listRoutineActivity = new ListRoutineActivity(unitOfWork);
  const recordActivityEvent = new RecordActivityEvent(unitOfWork, clock);
  const recordPlanItemActivity = new RecordPlanItemActivity(unitOfWork, clock);
  const resetRoutineDurationInsightDismissal = new ResetRoutineDurationInsightDismissal(
    unitOfWork,
    clock,
  );
  const generateDailyPlan = new GenerateDailyPlan(unitOfWork, clock);
  const getCurrentDailyPlan = new GetCurrentDailyPlan(unitOfWork);
  const setPlanItemLock = new SetPlanItemLock(unitOfWork, clock);
  const mutateDailyPlan = new MutateDailyPlan(unitOfWork, clock);
  const getDailyPlan = new GetDailyPlan(unitOfWork);
  const getSchedulingAdvice = new GetSchedulingAdvice(unitOfWork, advisor, clock);

  return {
    approveRoutineDurationInsight: (command) => approveRoutineDurationInsight.execute(command),
    dismissRoutineDurationInsight: (command) => dismissRoutineDurationInsight.execute(command),
    createWorkspace: (command) => createWorkspace.execute(command),
    getWorkspace: (query) => getWorkspace.execute(query),
    listWorkspaces: (query) => listWorkspaces.execute(query),
    createRoutine: (command) => createRoutine.execute(command),
    createWorkItem: (command) => createWorkItem.execute(command),
    getWorkItem: (query) => getWorkItem.execute(query),
    listWorkItems: (query) => listWorkItems.execute(query),
    updateWorkItem: (command) => updateWorkItem.execute(command),
    createScheduleBlock: (command) => createScheduleBlock.execute(command),
    getScheduleBlock: (query) => getScheduleBlock.execute(query),
    listScheduleBlocks: (query) => listScheduleBlocks.execute(query),
    updateScheduleBlock: (command) => updateScheduleBlock.execute(command),
    deleteScheduleBlock: (command) => deleteScheduleBlock.execute(command),
    getRoutine: (query) => getRoutine.execute(query),
    getRoutineDurationInsight: (query) => getRoutineDurationInsight.execute(query),
    updateRoutine: (command) => updateRoutine.execute(command),
    listRoutines: (query) => listRoutines.execute(query),
    listRoutineActivity: (query) => listRoutineActivity.execute(query),
    recordActivityEvent: (command) => recordActivityEvent.execute(command),
    recordPlanItemActivity: (command) => recordPlanItemActivity.execute(command),
    resetRoutineDurationInsightDismissal: (command) =>
      resetRoutineDurationInsightDismissal.execute(command),
    generateDailyPlan: (command) => generateDailyPlan.execute(command),
    getCurrentDailyPlan: (query) => getCurrentDailyPlan.execute(query),
    setPlanItemLock: (command) => setPlanItemLock.execute(command),
    regenerateDailyPlan: (command) => mutateDailyPlan.regenerate(command),
    replacePlanItem: (command) => mutateDailyPlan.replace(command),
    applyRoutineFeedback: (command) => mutateDailyPlan.applyRoutineFeedback(command),
    resetRoutineFeedback: (command) => mutateDailyPlan.resetRoutineFeedback(command),
    getDailyPlan: (query) => getDailyPlan.execute(query),
    getSchedulingAdvice: (command, signal) => getSchedulingAdvice.execute(command, signal),
  };
}
