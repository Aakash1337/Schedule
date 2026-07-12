import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runWorkerRuntime } from "./runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker process runtime", () => {
  it("closes cleanly without terminating after an orderly worker stop", async () => {
    const order: string[] = [];
    const terminate = vi.fn();

    await runWorkerRuntime({
      run: async () => void order.push("run"),
      close: async () => void order.push("close"),
      terminate,
    });

    expect(order).toEqual(["run", "close"]);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("closes before terminating after an unexpected worker failure", async () => {
    const order: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runWorkerRuntime({
      run: async () => {
        order.push("run");
        throw new Error("private runtime detail");
      },
      close: async () => void order.push("close"),
      terminate: (code) => void order.push(`terminate:${code}`),
    });

    expect(order).toEqual(["run", "close", "terminate:1"]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('"failureClass":"worker_runtime_error"'),
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("private runtime detail");
  });

  it("terminates and emits a safe classification when database cleanup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const terminate = vi.fn();

    await runWorkerRuntime({
      run: async () => undefined,
      close: async () => {
        throw new Error("postgres://private-user:private-password@db.internal");
      },
      terminate,
    });

    expect(terminate).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('"failureClass":"worker_shutdown_error"'),
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("private-password");
  });

  it("exits nonzero after cleanup even when abandoned work retains an event-loop handle", async () => {
    const fixture = fileURLToPath(
      new URL("../test-fixtures/fatal-worker-runtime.ts", import.meta.url),
    );
    const child = spawn(process.execPath, ["--import=tsx", fixture], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("fatal worker fixture did not terminate within five seconds"));
        }, 5_000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      },
    );

    expect(outcome).toEqual({ code: 1, signal: null });
    expect(stderr).toContain('"failureClass":"worker_runtime_error"');
    expect(stderr).toContain("fixture cleanup completed");
  });
});
