import { runHermesReminderProcess } from "./process.js";
import { HermesReminderSupervisorError } from "./supervisor.js";

const controller = new AbortController();
const stop = (): void => controller.abort("process signal");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runHermesReminderProcess(process.env, controller.signal);
} catch (error) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "hermes_reminder_process_failed",
      failureClass:
        error instanceof HermesReminderSupervisorError
          ? `supervisor_${error.code}`
          : "bootstrap_or_runtime_failure",
    }),
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
