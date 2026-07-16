import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type RailwayManifest = Readonly<{
  $schema?: string;
  build?: Readonly<{ builder?: string; dockerfilePath?: string }>;
  deploy?: Readonly<{
    preDeployCommand?: readonly string[];
    startCommand?: string;
    healthcheckPath?: string;
    healthcheckTimeout?: number;
    drainingSeconds?: string;
    restartPolicyType?: string;
    restartPolicyMaxRetries?: number;
  }>;
}>;

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = (name: "api" | "worker"): RailwayManifest =>
  JSON.parse(
    readFileSync(`${root}/infra/deploy/railway/${name}.railway.json`, "utf8"),
  ) as RailwayManifest;

describe("Railway deployment contract", () => {
  it("gates the API on one migration and database-backed readiness", () => {
    const api = manifest("api");

    expect(api.$schema).toBe("https://railway.com/railway.schema.json");
    expect(api.build).toEqual({
      builder: "DOCKERFILE",
      dockerfilePath: "infra/docker/api.Dockerfile",
    });
    expect(api.deploy).toEqual({
      preDeployCommand: ["node node_modules/@schedule/database/dist/migrate.js"],
      healthcheckPath: "/health/ready",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
    });
    expect(existsSync(`${root}/${api.build?.dockerfilePath ?? ""}`)).toBe(true);
  });

  it("gates the worker on database readiness without a competing migration", () => {
    const worker = manifest("worker");

    expect(worker.$schema).toBe("https://railway.com/railway.schema.json");
    expect(worker.build).toEqual({
      builder: "DOCKERFILE",
      dockerfilePath: "infra/docker/worker.Dockerfile",
    });
    expect(worker.deploy).toEqual({
      healthcheckPath: "/health/ready",
      healthcheckTimeout: 300,
      drainingSeconds: "40",
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
    });
    expect(worker.deploy?.startCommand).toBeUndefined();
    expect(existsSync(`${root}/${worker.build?.dockerfilePath ?? ""}`)).toBe(true);
  });
});
