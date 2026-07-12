import {
  CreateRoutine,
  CreateWorkspace,
  GenerateDailyPlan,
  GetCurrentDailyPlan,
  GetDailyPlan,
  GetRoutine,
  ListRoutineActivity,
  ListRoutines,
  MutateDailyPlan,
  RecordActivityEvent,
  RecordPlanItemActivity,
  SetPlanItemLock,
  UpdateRoutine,
  type Clock,
  type UnitOfWork,
} from "@schedule/application";

import type { ProductServices } from "./product-routes.js";

export function createProductServices(unitOfWork: UnitOfWork, clock: Clock): ProductServices {
  const createWorkspace = new CreateWorkspace(unitOfWork, clock);
  const createRoutine = new CreateRoutine(unitOfWork, clock);
  const getRoutine = new GetRoutine(unitOfWork);
  const updateRoutine = new UpdateRoutine(unitOfWork, clock);
  const listRoutines = new ListRoutines(unitOfWork);
  const listRoutineActivity = new ListRoutineActivity(unitOfWork);
  const recordActivityEvent = new RecordActivityEvent(unitOfWork, clock);
  const recordPlanItemActivity = new RecordPlanItemActivity(unitOfWork, clock);
  const generateDailyPlan = new GenerateDailyPlan(unitOfWork, clock);
  const getCurrentDailyPlan = new GetCurrentDailyPlan(unitOfWork);
  const setPlanItemLock = new SetPlanItemLock(unitOfWork, clock);
  const mutateDailyPlan = new MutateDailyPlan(unitOfWork, clock);
  const getDailyPlan = new GetDailyPlan(unitOfWork);

  return {
    createWorkspace: (command) => createWorkspace.execute(command),
    createRoutine: (command) => createRoutine.execute(command),
    getRoutine: (query) => getRoutine.execute(query),
    updateRoutine: (command) => updateRoutine.execute(command),
    listRoutines: (query) => listRoutines.execute(query),
    listRoutineActivity: (query) => listRoutineActivity.execute(query),
    recordActivityEvent: (command) => recordActivityEvent.execute(command),
    recordPlanItemActivity: (command) => recordPlanItemActivity.execute(command),
    generateDailyPlan: (command) => generateDailyPlan.execute(command),
    getCurrentDailyPlan: (query) => getCurrentDailyPlan.execute(query),
    setPlanItemLock: (command) => setPlanItemLock.execute(command),
    regenerateDailyPlan: (command) => mutateDailyPlan.regenerate(command),
    replacePlanItem: (command) => mutateDailyPlan.replace(command),
    getDailyPlan: (query) => getDailyPlan.execute(query),
  };
}
