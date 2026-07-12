import {
  CreateRoutine,
  CreateWorkspace,
  GenerateDailyPlan,
  GetDailyPlan,
  GetRoutine,
  ListRoutineActivity,
  ListRoutines,
  RecordActivityEvent,
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
  const generateDailyPlan = new GenerateDailyPlan(unitOfWork, clock);
  const getDailyPlan = new GetDailyPlan(unitOfWork);

  return {
    createWorkspace: (command) => createWorkspace.execute(command),
    createRoutine: (command) => createRoutine.execute(command),
    getRoutine: (query) => getRoutine.execute(query),
    updateRoutine: (command) => updateRoutine.execute(command),
    listRoutines: (query) => listRoutines.execute(query),
    listRoutineActivity: (query) => listRoutineActivity.execute(query),
    recordActivityEvent: (command) => recordActivityEvent.execute(command),
    generateDailyPlan: (command) => generateDailyPlan.execute(command),
    getDailyPlan: (query) => getDailyPlan.execute(query),
  };
}
