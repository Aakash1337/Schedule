import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(repositoryRoot, "evaluation", "features.json");
const statuses = new Set(["implemented", "partial", "deferred"]);
const risks = new Set(["critical", "high", "normal"]);
const evidenceLevels = new Set(["unit", "component", "integration", "drill"]);

type JsonObject = Record<string, unknown>;

export interface EvaluationScorecard {
  readonly schemaVersion: number;
  readonly totalFeatures: number;
  readonly implementedFeatures: number;
  readonly partialFeatures: number;
  readonly deferredFeatures: number;
  readonly implementedWithRegisteredEvidence: number;
  readonly criticalImplementedFeatures: number;
  readonly criticalWithRegisteredIntegrationEvidence: number;
  readonly evidenceItems: number;
  readonly referencedCommands: readonly string[];
  readonly missingOrStaleEvidence: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function workflowRunCommands(workflow: string): ReadonlySet<string> {
  const commands = new Set<string>();
  for (const line of workflow.split(/\r?\n/u)) {
    const match = /^\s*(?:-\s*)?run:\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] === undefined) continue;
    const command = match[1].replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2").trim();
    if (command !== "") commands.add(command);
  }
  return commands;
}

function safeRepositoryPath(relativePath: string): string {
  if (path.isAbsolute(relativePath))
    throw new Error(`Evidence path must be relative: ${relativePath}`);
  const resolved = path.resolve(repositoryRoot, relativePath);
  if (!resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error(`Evidence path leaves the repository: ${relativePath}`);
  }
  return resolved;
}

async function defaultReadEvidence(relativePath: string): Promise<string> {
  const resolved = safeRepositoryPath(relativePath);
  if (!(await stat(resolved)).isFile())
    throw new Error(`Evidence path is not a file: ${relativePath}`);
  return readFile(resolved, "utf8");
}

export async function evaluateFeatureRegistry(
  registry: unknown,
  readEvidence: (relativePath: string) => Promise<string> = defaultReadEvidence,
): Promise<EvaluationScorecard> {
  const errors: string[] = [];
  if (!isObject(registry)) throw new Error("Feature registry must be a JSON object.");
  if (registry.schemaVersion !== 1) errors.push("schemaVersion must equal 1.");

  const ciWorkflow = nonEmptyString(registry.ciWorkflow) ? registry.ciWorkflow : "";
  let ciWorkflowContent = "";
  if (ciWorkflow === "") {
    errors.push("ciWorkflow must identify the workflow that executes registered evidence.");
  } else {
    try {
      ciWorkflowContent = await readEvidence(ciWorkflow);
    } catch (error) {
      errors.push(
        `ciWorkflow cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const ciRunCommands = workflowRunCommands(ciWorkflowContent);

  const commands = isObject(registry.commands) ? registry.commands : {};
  if (!isObject(registry.commands)) errors.push("commands must be an object.");
  for (const [id, value] of Object.entries(commands)) {
    if (!isObject(value) || !nonEmptyString(value.command) || typeof value.ci !== "boolean") {
      errors.push(`Command ${id} must declare a non-empty command and boolean ci flag.`);
      continue;
    }
    if (value.ci) {
      const declaredWorkflow = value.workflow;
      if (declaredWorkflow !== undefined && !nonEmptyString(declaredWorkflow)) {
        errors.push(`CI command ${id} workflow must be a non-empty path when supplied.`);
        continue;
      }
      const workflow = nonEmptyString(declaredWorkflow) ? declaredWorkflow : ciWorkflow;
      let runCommands = ciRunCommands;
      if (workflow !== ciWorkflow) {
        try {
          runCommands = workflowRunCommands(await readEvidence(workflow));
        } catch (error) {
          errors.push(
            `CI command ${id} workflow cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      if (workflow !== "" && !runCommands.has(value.command)) {
        errors.push(`CI command ${id} is not an exact run step in ${workflow}: ${value.command}`);
      }
    }
  }

  const features = Array.isArray(registry.features) ? registry.features : [];
  if (!Array.isArray(registry.features) || features.length === 0) {
    errors.push("features must be a non-empty array.");
  }

  const seenIds = new Set<string>();
  const referencedCommands = new Set<string>();
  let implemented = 0;
  let partial = 0;
  let deferred = 0;
  let implementedWithEvidence = 0;
  let criticalImplemented = 0;
  let criticalWithIntegration = 0;
  let evidenceItems = 0;
  let staleEvidence = 0;

  for (const [index, rawFeature] of features.entries()) {
    const label = `features[${index}]`;
    if (!isObject(rawFeature)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    const id = nonEmptyString(rawFeature.id) ? rawFeature.id : label;
    if (!nonEmptyString(rawFeature.id)) errors.push(`${label}.id must be non-empty.`);
    if (seenIds.has(id)) errors.push(`Duplicate feature id: ${id}.`);
    seenIds.add(id);

    const status = nonEmptyString(rawFeature.status) ? rawFeature.status : "";
    const risk = nonEmptyString(rawFeature.risk) ? rawFeature.risk : "";
    if (!statuses.has(status)) errors.push(`${id}.status is invalid.`);
    if (!risks.has(risk)) errors.push(`${id}.risk is invalid.`);

    const contract = rawFeature.contract;
    if (!isObject(contract) || !nonEmptyString(contract.file) || !nonEmptyString(contract.anchor)) {
      errors.push(`${id}.contract must declare file and anchor.`);
    } else {
      try {
        const content = await readEvidence(contract.file);
        if (!content.includes(contract.anchor)) {
          errors.push(`${id}.contract anchor is missing from ${contract.file}.`);
          staleEvidence += 1;
        }
      } catch (error) {
        errors.push(
          `${id}.contract cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        );
        staleEvidence += 1;
      }
    }

    const evidence = Array.isArray(rawFeature.evidence) ? rawFeature.evidence : [];
    if (!Array.isArray(rawFeature.evidence)) errors.push(`${id}.evidence must be an array.`);
    const limitations = Array.isArray(rawFeature.limitations)
      ? rawFeature.limitations.filter(nonEmptyString)
      : [];

    if (status === "implemented") {
      implemented += 1;
      if (evidence.length > 0) implementedWithEvidence += 1;
      else errors.push(`Implemented feature ${id} has no registered evidence.`);
    } else if (status === "partial") {
      partial += 1;
      if (evidence.length === 0)
        errors.push(`Partial feature ${id} has no implemented-scope evidence.`);
      if (limitations.length === 0) errors.push(`Partial feature ${id} must declare limitations.`);
    } else if (status === "deferred") {
      deferred += 1;
      if (evidence.length > 0)
        errors.push(`Deferred feature ${id} must not claim passing evidence.`);
      if (limitations.length === 0)
        errors.push(`Deferred feature ${id} must explain its boundary.`);
    }

    let hasIntegrationEvidence = false;
    for (const [evidenceIndex, rawEvidence] of evidence.entries()) {
      evidenceItems += 1;
      const evidenceLabel = `${id}.evidence[${evidenceIndex}]`;
      if (!isObject(rawEvidence)) {
        errors.push(`${evidenceLabel} must be an object.`);
        continue;
      }
      const level = nonEmptyString(rawEvidence.level) ? rawEvidence.level : "";
      const file = nonEmptyString(rawEvidence.file) ? rawEvidence.file : "";
      const command = nonEmptyString(rawEvidence.command) ? rawEvidence.command : "";
      const anchors = Array.isArray(rawEvidence.anchors)
        ? rawEvidence.anchors.filter(nonEmptyString)
        : [];
      if (!evidenceLevels.has(level)) errors.push(`${evidenceLabel}.level is invalid.`);
      if (level === "integration" || level === "drill") hasIntegrationEvidence = true;
      if (!nonEmptyString(file)) errors.push(`${evidenceLabel}.file must be non-empty.`);
      if (!nonEmptyString(command) || !Object.hasOwn(commands, command)) {
        errors.push(`${evidenceLabel}.command does not reference a registered command.`);
      } else {
        referencedCommands.add(command);
        const registeredCommand = commands[command];
        if (!isObject(registeredCommand) || registeredCommand.ci !== true) {
          errors.push(`${evidenceLabel}.command does not reference a CI-enabled command.`);
        }
      }
      if (anchors.length === 0) errors.push(`${evidenceLabel} must declare at least one anchor.`);
      if (file !== "") {
        try {
          const content = await readEvidence(file);
          for (const anchor of anchors) {
            if (!content.includes(anchor)) {
              errors.push(`${evidenceLabel} anchor is missing from ${file}: ${anchor}`);
              staleEvidence += 1;
            }
          }
        } catch (error) {
          errors.push(
            `${evidenceLabel} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          );
          staleEvidence += 1;
        }
      }
    }

    if (status === "implemented" && risk === "critical") {
      criticalImplemented += 1;
      if (hasIntegrationEvidence) criticalWithIntegration += 1;
      else errors.push(`Critical implemented feature ${id} has no integration or drill evidence.`);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors.map((message) => new Error(message)),
      `Feature evaluation failed with ${errors.length} issue(s):\n${errors.join("\n")}`,
    );
  }

  return {
    schemaVersion: 1,
    totalFeatures: features.length,
    implementedFeatures: implemented,
    partialFeatures: partial,
    deferredFeatures: deferred,
    implementedWithRegisteredEvidence: implementedWithEvidence,
    criticalImplementedFeatures: criticalImplemented,
    criticalWithRegisteredIntegrationEvidence: criticalWithIntegration,
    evidenceItems,
    referencedCommands: [...referencedCommands].sort(),
    missingOrStaleEvidence: staleEvidence,
  };
}

function requestedOutput(args: readonly string[]): string | undefined {
  const normalized = args.filter((arg) => arg !== "--");
  const inline = normalized.find((arg) => arg.startsWith("--output="));
  if (inline !== undefined && normalized.length === 1) return inline.slice("--output=".length);
  if (normalized.length === 2 && normalized[0] === "--output") return normalized[1];
  if (normalized.length === 0) return undefined;
  throw new Error("Usage: pnpm eval:features [--output <scorecard.json>]");
}

async function main(): Promise<void> {
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
  const scorecard = await evaluateFeatureRegistry(registry);
  console.table({
    registeredEvidence: `${scorecard.implementedWithRegisteredEvidence}/${scorecard.implementedFeatures}`,
    registeredCriticalIntegration: `${scorecard.criticalWithRegisteredIntegrationEvidence}/${scorecard.criticalImplementedFeatures}`,
    partial: scorecard.partialFeatures,
    deferred: scorecard.deferredFeatures,
    evidenceItems: scorecard.evidenceItems,
    staleEvidence: scorecard.missingOrStaleEvidence,
  });
  const output = requestedOutput(process.argv.slice(2));
  if (output !== undefined) {
    const resolved = path.resolve(repositoryRoot, output);
    if (!resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error("Scorecard output must stay inside the repository.");
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(scorecard, null, 2)}\n`, { flag: "w" });
    console.log(`Evaluation scorecard written: ${path.relative(repositoryRoot, resolved)}`);
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
