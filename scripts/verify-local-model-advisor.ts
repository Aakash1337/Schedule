import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  SCHEDULING_ADVISOR_CONTEXT_VERSION,
  SCHEDULING_ADVISOR_OUTPUT_VERSION,
  schedulingAdvisorUnavailableReasons,
  type SchedulingAdvisorContext,
} from "../packages/application/src/index.js";
import { loadApiConfig } from "../packages/config/src/index.js";
import { localDate } from "../packages/domain/src/index.js";
import { OllamaSchedulingAdvisor } from "../apps/api/src/local-model-advisor.js";

const MAXIMUM_SUMMARY_CHARACTERS = 280;
const MAXIMUM_SUGGESTIONS = 5;
const MAXIMUM_SUGGESTION_TITLE_CHARACTERS = 120;
const MAXIMUM_RATIONALE_CHARACTERS = 400;

export interface LocalModelAdvisorVerificationSummary {
  readonly provider: "ollama";
  readonly model: string;
  readonly latencyMs: number;
  readonly suggestionCount: number;
}

export class LocalModelAdvisorVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalModelAdvisorVerificationError";
  }
}

function fail(message: string): never {
  throw new LocalModelAdvisorVerificationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

function isBoundedText(value: unknown, maximumCharacters: number): value is string {
  return (
    typeof value === "string" && [...value].length >= 1 && [...value].length <= maximumCharacters
  );
}

export function createLocalModelAdvisorVerificationContext(): SchedulingAdvisorContext {
  return {
    version: SCHEDULING_ADVISOR_CONTEXT_VERSION,
    requestId: "5f66cae4-9ce7-4cc5-8b82-b95a249c4fa2",
    date: localDate("2026-07-15"),
    focus: "both",
    plan: {
      id: "local-advisor-smoke-plan",
      headVersion: 1,
      date: localDate("2026-07-15"),
      totalMinutes: 30,
      warnings: [],
      items: [
        {
          id: "local-advisor-smoke-plan-item",
          title: "Review the current plan",
          position: 0,
          scheduledMinutes: 30,
          locked: false,
          activityState: "pending",
          sourceType: "routine",
          reasons: ["Fits the available time"],
        },
      ],
    },
    backlog: [
      {
        id: "local-advisor-smoke-work-item",
        version: 1,
        title: "Prepare the next task",
        status: "backlog",
        priority: "medium",
        dueOn: null,
        planningDurationMinutes: 30,
      },
    ],
    truncated: { planItems: false, backlog: false },
  };
}

/** Independently checks the production adapter result without exposing its content. */
export function validateLocalModelAdvisorVerificationResult(
  context: SchedulingAdvisorContext,
  result: unknown,
): number {
  if (
    isRecord(result) &&
    result.status === "unavailable" &&
    schedulingAdvisorUnavailableReasons.some((reason) => reason === result.reason)
  ) {
    fail(
      `Local-model advisor verification failed: provider unavailable: ${String(result.reason)}.`,
    );
  }
  if (!isRecord(result) || result.status !== "available" || !isRecord(result.output)) {
    fail("Local-model advisor verification failed: the provider did not return available advice.");
  }
  const output = result.output;
  if (
    !hasExactKeys(output, ["version", "summary", "suggestions"]) ||
    output.version !== SCHEDULING_ADVISOR_OUTPUT_VERSION ||
    !isBoundedText(output.summary, MAXIMUM_SUMMARY_CHARACTERS) ||
    !Array.isArray(output.suggestions) ||
    output.suggestions.length > MAXIMUM_SUGGESTIONS
  ) {
    fail("Local-model advisor verification failed: the provider output contract is invalid.");
  }

  const planItemIds = new Set(context.plan.items.map((item) => item.id));
  const backlogIds = new Set(context.backlog.map((item) => item.id));
  const fingerprints = new Set<string>();
  for (const suggestion of output.suggestions) {
    if (
      !isRecord(suggestion) ||
      !hasExactKeys(suggestion, [
        "kind",
        "targetType",
        "targetId",
        "title",
        "rationale",
        "confidence",
      ]) ||
      !isBoundedText(suggestion.title, MAXIMUM_SUGGESTION_TITLE_CHARACTERS) ||
      !isBoundedText(suggestion.rationale, MAXIMUM_RATIONALE_CHARACTERS) ||
      (suggestion.confidence !== "low" && suggestion.confidence !== "medium")
    ) {
      fail("Local-model advisor verification failed: a suggestion is invalid.");
    }

    if (suggestion.kind === "focus" || suggestion.kind === "sequence") {
      if (
        suggestion.targetType !== "plan_item" ||
        typeof suggestion.targetId !== "string" ||
        !planItemIds.has(suggestion.targetId)
      ) {
        fail("Local-model advisor verification failed: a plan-item target is invalid.");
      }
    } else if (suggestion.kind === "consider_backlog") {
      if (
        suggestion.targetType !== "work_item" ||
        typeof suggestion.targetId !== "string" ||
        !backlogIds.has(suggestion.targetId)
      ) {
        fail("Local-model advisor verification failed: a backlog target is invalid.");
      }
    } else if (
      suggestion.kind !== "plan_observation" ||
      suggestion.targetType !== null ||
      suggestion.targetId !== null
    ) {
      fail("Local-model advisor verification failed: a suggestion relationship is invalid.");
    }

    const fingerprint = JSON.stringify(suggestion);
    if (fingerprints.has(fingerprint)) {
      fail("Local-model advisor verification failed: duplicate suggestions were returned.");
    }
    fingerprints.add(fingerprint);
  }
  return output.suggestions.length;
}

export function assertLocalModelAdvisorContextUnchanged(
  canonicalBefore: string,
  context: SchedulingAdvisorContext,
): void {
  if (JSON.stringify(context) !== canonicalBefore) {
    fail("Local-model advisor verification failed: the adapter mutated its input context.");
  }
}

export function formatLocalModelAdvisorVerificationSummary(
  summary: LocalModelAdvisorVerificationSummary,
): string {
  return JSON.stringify(summary);
}

export async function runLocalModelAdvisorVerification(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalModelAdvisorVerificationSummary> {
  let config: ReturnType<typeof loadApiConfig>;
  try {
    config = loadApiConfig(environment);
  } catch {
    fail("Local-model advisor verification failed: the API configuration is invalid.");
  }
  if (config.LOCAL_MODEL_ADVISOR_MODE !== "ollama") {
    fail("Local-model advisor verification requires LOCAL_MODEL_ADVISOR_MODE=ollama.");
  }

  let advisor: OllamaSchedulingAdvisor;
  try {
    advisor = new OllamaSchedulingAdvisor({
      baseUrl: config.LOCAL_MODEL_ADVISOR_URL,
      model: config.LOCAL_MODEL_ADVISOR_MODEL,
      connectTimeoutMs: config.LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: config.LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS,
      maxResponseBytes: config.LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES,
      maxConcurrent: config.LOCAL_MODEL_ADVISOR_MAX_CONCURRENT,
    });
  } catch {
    fail("Local-model advisor verification failed: the adapter configuration is invalid.");
  }

  const context = createLocalModelAdvisorVerificationContext();
  const canonicalBefore = JSON.stringify(context);
  const startedAt = performance.now();
  let result: unknown;
  try {
    result = await advisor.advise(context);
  } catch {
    fail("Local-model advisor verification failed: the local provider request failed.");
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  assertLocalModelAdvisorContextUnchanged(canonicalBefore, context);
  const suggestionCount = validateLocalModelAdvisorVerificationResult(context, result);
  return {
    provider: "ollama",
    model: advisor.model,
    latencyMs,
    suggestionCount,
  };
}

async function main(): Promise<void> {
  try {
    const summary = await runLocalModelAdvisorVerification();
    console.log(formatLocalModelAdvisorVerificationSummary(summary));
  } catch (error) {
    console.error(
      error instanceof LocalModelAdvisorVerificationError
        ? error.message
        : "Local-model advisor verification failed safely.",
    );
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
