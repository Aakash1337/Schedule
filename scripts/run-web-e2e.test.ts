import { createServer } from "node:net";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildTestEnvironment,
  composeProjectName,
  parsePublishedPostgresPort,
  requireReleasedPorts,
  reservePorts,
  runCommand,
  runCommandCapture,
} from "./run-web-e2e.js";

const openServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe("browser E2E runner", () => {
  it("builds a bounded project name and rejects unsafe overrides", () => {
    expect(composeProjectName({}, 17, 36)).toBe("schedule-web-e2e-17-10");
    expect(composeProjectName({ E2E_COMPOSE_PROJECT: "schedule-web-e2e-ci_123" })).toBe(
      "schedule-web-e2e-ci_123",
    );
    expect(() => composeProjectName({ E2E_COMPOSE_PROJECT: "../Production" })).toThrow(
      "must start with schedule-web-e2e-",
    );
    expect(parsePublishedPostgresPort("127.0.0.1:55432")).toBe(55_432);
    expect(() => parsePublishedPostgresPort("0.0.0.0:5432")).toThrow("invalid PostgreSQL port");
  });

  it("overrides inherited production and database settings with disposable loopback values", () => {
    const environment = buildTestEnvironment(
      { postgres: 55_432, api: 44_000, web: 41_730 },
      {
        NODE_ENV: "production",
        API_HOST: "0.0.0.0",
        DATABASE_URL: "postgres://production.example/schedule",
      },
    );

    expect(environment).toMatchObject({
      NODE_ENV: "test",
      PRODUCT_API_MODE: "local_unauthenticated",
      API_HOST: "127.0.0.1",
      API_PORT: "44000",
      DATABASE_URL: "postgres://schedule:schedule@127.0.0.1:55432/schedule",
      SCHEDULE_API_URL: "http://127.0.0.1:44000",
      E2E_API_PORT: "44000",
      E2E_WEB_PORT: "41730",
    });
  });

  it("reserves distinct loopback ports and releases them before returning", async () => {
    const ports = await reservePorts(3);
    expect(new Set(ports).size).toBe(3);
    await expect(requireReleasedPorts(ports, 250, 5)).resolves.toBeUndefined();
    await expect(reservePorts(0)).rejects.toThrow("positive integer");
  });

  it("reports a port that remains occupied", async () => {
    const server = createServer();
    openServers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Test server did not receive a TCP port."));
          return;
        }
        resolve(address.port);
      });
    });

    await expect(requireReleasedPorts([port], 25, 5)).rejects.toThrow(String(port));
  });

  it("propagates child-process failures", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "process.exit(0)"], process.env),
    ).resolves.toBeUndefined();
    await expect(
      runCommand(process.execPath, ["-e", "process.exit(7)"], process.env),
    ).rejects.toThrow("exited with code 7");
    await expect(
      runCommandCapture(process.execPath, ["-e", 'process.stdout.write("captured")'], process.env),
    ).resolves.toBe("captured");
    await expect(
      runCommandCapture(
        process.execPath,
        ["-e", 'process.stderr.write("expected failure"); process.exit(8)'],
        process.env,
      ),
    ).rejects.toThrow("expected failure");
  });
});
