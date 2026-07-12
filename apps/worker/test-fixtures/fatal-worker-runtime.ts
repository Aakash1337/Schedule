import { runWorkerRuntime } from "../src/runtime.js";

setInterval(() => undefined, 60_000);

await runWorkerRuntime({
  run: async () => {
    throw new Error("simulated fatal lease loss");
  },
  close: async () => {
    process.stderr.write("fixture cleanup completed\n");
  },
});
