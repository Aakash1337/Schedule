import { describe, expect, it } from "vitest";

import { evaluateFeatureRegistry } from "./evaluate-features.js";

const files = new Map([
  [
    ".github/workflows/ci.yml",
    "- run: pnpm check\n- run: pnpm verify:database\n- run: pnpm verify:recovery-state-machine",
  ],
  [".github/workflows/desktop.yml", "- run: pnpm desktop:check"],
  ["docs/contract.md", "# Contract\nImplemented behavior"],
  ["src/feature.test.ts", 'it("proves the behavior", () => true);'],
  ["scripts/verify.ts", 'console.log("integration passed")'],
]);

const readEvidence = async (file: string): Promise<string> => {
  const content = files.get(file);
  if (content === undefined) throw new Error(`missing ${file}`);
  return content;
};

function validRegistry(): unknown {
  return {
    schemaVersion: 1,
    ciWorkflow: ".github/workflows/ci.yml",
    commands: {
      unit: { command: "pnpm check", ci: true },
      integration: { command: "pnpm verify:database", ci: true },
    },
    features: [
      {
        id: "critical-feature",
        status: "implemented",
        risk: "critical",
        contract: { file: "docs/contract.md", anchor: "Implemented behavior" },
        evidence: [
          {
            level: "unit",
            file: "src/feature.test.ts",
            command: "unit",
            anchors: ["proves the behavior"],
          },
          {
            level: "integration",
            file: "scripts/verify.ts",
            command: "integration",
            anchors: ["integration passed"],
          },
        ],
      },
      {
        id: "future-feature",
        status: "deferred",
        risk: "normal",
        contract: { file: "docs/contract.md", anchor: "Contract" },
        limitations: ["Not implemented."],
        evidence: [],
      },
    ],
  };
}

describe("feature evidence registry", () => {
  it("produces a structural scorecard for implemented and deferred behavior", async () => {
    await expect(evaluateFeatureRegistry(validRegistry(), readEvidence)).resolves.toEqual({
      schemaVersion: 1,
      totalFeatures: 2,
      implementedFeatures: 1,
      partialFeatures: 0,
      deferredFeatures: 1,
      implementedWithRegisteredEvidence: 1,
      criticalImplementedFeatures: 1,
      criticalWithRegisteredIntegrationEvidence: 1,
      evidenceItems: 2,
      referencedCommands: ["integration", "unit"],
      missingOrStaleEvidence: 0,
    });
  });

  it("rejects duplicate features, unknown commands, and stale anchors together", async () => {
    const registry = validRegistry() as { features: JsonFeature[] };
    const duplicate = structuredClone(registry.features[0]!);
    duplicate.evidence[0]!.command = "missing";
    duplicate.evidence[0]!.anchors = ["not in the file"];
    registry.features.push(duplicate);

    await expect(evaluateFeatureRegistry(registry, readEvidence)).rejects.toThrow(
      /Duplicate feature id[\s\S]*registered command[\s\S]*anchor is missing/,
    );
  });

  it("does not allow deferred claims or critical features without integration evidence", async () => {
    const registry = validRegistry() as { features: JsonFeature[] };
    registry.features[0]!.evidence = [registry.features[0]!.evidence[0]!];
    registry.features[1]!.evidence = [registry.features[0]!.evidence[0]!];

    await expect(evaluateFeatureRegistry(registry, readEvidence)).rejects.toThrow(
      /no integration or drill evidence[\s\S]*must not claim passing evidence/,
    );
  });

  it("does not credit evidence whose command is excluded from CI", async () => {
    const registry = validRegistry() as {
      commands: Record<string, { command: string; ci: boolean }>;
      features: JsonFeature[];
    };
    registry.commands.local = { command: "pnpm local-only", ci: false };
    registry.features[0]!.evidence[0]!.command = "local";

    await expect(evaluateFeatureRegistry(registry, readEvidence)).rejects.toThrow(
      /does not reference a CI-enabled command/,
    );
  });

  it("does not accept a registry-controlled alias for an unrelated CI step", async () => {
    const registry = validRegistry() as {
      commands: Record<string, { command: string; ci: boolean }>;
    };
    registry.commands.unit = { command: "pnpm forged-unit-command", ci: true };

    await expect(evaluateFeatureRegistry(registry, readEvidence)).rejects.toThrow(
      /not an exact run step/,
    );
  });

  it("accepts exact evidence commands from a declared secondary workflow", async () => {
    const registry = validRegistry() as {
      commands: Record<string, { command: string; ci: boolean; workflow?: string }>;
      features: JsonFeature[];
    };
    registry.commands.desktop = {
      command: "pnpm desktop:check",
      ci: true,
      workflow: ".github/workflows/desktop.yml",
    };
    registry.features[0]!.evidence[0]!.command = "desktop";

    await expect(evaluateFeatureRegistry(registry, readEvidence)).resolves.toMatchObject({
      missingOrStaleEvidence: 0,
    });
  });
});

interface JsonEvidence {
  level: string;
  file: string;
  command: string;
  anchors: string[];
}

interface JsonFeature {
  id: string;
  status: string;
  risk: string;
  contract: { file: string; anchor: string };
  limitations?: string[];
  evidence: JsonEvidence[];
}
