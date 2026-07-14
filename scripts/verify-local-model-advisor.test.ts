import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  assertLocalModelAdvisorContextUnchanged,
  createLocalModelAdvisorVerificationContext,
  formatLocalModelAdvisorVerificationSummary,
  runLocalModelAdvisorVerification,
  validateLocalModelAdvisorVerificationResult,
} from "./verify-local-model-advisor.js";

const validObservation = {
  kind: "plan_observation",
  targetType: null,
  targetId: null,
  title: "Keep the plan focused",
  rationale: "The current plan already fits the available time.",
  confidence: "medium",
} as const;

function resultWith(suggestions: readonly unknown[]): unknown {
  return {
    status: "available",
    output: {
      version: "schedule.advisor-output/v1",
      summary: "The plan is appropriately bounded.",
      suggestions,
    },
  };
}

describe("local-model advisor verification", () => {
  it("builds one deterministic plan item and one deterministic backlog item", () => {
    const first = createLocalModelAdvisorVerificationContext();
    const second = createLocalModelAdvisorVerificationContext();

    expect(first).toEqual(second);
    expect(first.plan.items).toHaveLength(1);
    expect(first.backlog).toHaveLength(1);
    expect(first.focus).toBe("both");
  });

  it("accepts every valid target relationship", () => {
    const context = createLocalModelAdvisorVerificationContext();
    const suggestions = [
      {
        ...validObservation,
        kind: "focus",
        targetType: "plan_item",
        targetId: context.plan.items[0]!.id,
      },
      {
        ...validObservation,
        kind: "sequence",
        targetType: "plan_item",
        targetId: context.plan.items[0]!.id,
        title: "Keep this first",
      },
      {
        ...validObservation,
        kind: "consider_backlog",
        targetType: "work_item",
        targetId: context.backlog[0]!.id,
        title: "Consider this next",
      },
      validObservation,
    ];

    expect(validateLocalModelAdvisorVerificationResult(context, resultWith(suggestions))).toBe(4);
  });

  it.each([
    {
      name: "unknown plan item",
      suggestion: {
        ...validObservation,
        kind: "focus",
        targetType: "plan_item",
        targetId: "unknown",
      },
    },
    {
      name: "unknown backlog item",
      suggestion: {
        ...validObservation,
        kind: "consider_backlog",
        targetType: "work_item",
        targetId: "unknown",
      },
    },
    {
      name: "targeted observation",
      suggestion: {
        ...validObservation,
        targetType: "plan_item",
        targetId: "local-advisor-smoke-plan-item",
      },
    },
  ])("rejects $name without echoing content", ({ suggestion }) => {
    const context = createLocalModelAdvisorVerificationContext();

    expect(() =>
      validateLocalModelAdvisorVerificationResult(context, resultWith([suggestion])),
    ).toThrow(/Local-model advisor verification failed/);
  });

  it("rejects unavailable, oversized, duplicate, and extended output", () => {
    const context = createLocalModelAdvisorVerificationContext();
    const invalidResults = [
      { status: "unavailable", reason: "timeout" },
      resultWith(
        Array.from({ length: 6 }, (_, index) => ({ ...validObservation, title: `S${index}` })),
      ),
      resultWith([validObservation, validObservation]),
      resultWith([{ ...validObservation, action: "apply" }]),
    ];

    for (const result of invalidResults) {
      expect(() => validateLocalModelAdvisorVerificationResult(context, result)).toThrow(
        /Local-model advisor verification failed/,
      );
    }
  });

  it.each([
    "disabled",
    "busy",
    "timeout",
    "unreachable",
    "provider_rejected",
    "response_too_large",
    "malformed_response",
  ])("reports the fixed provider reason without including provider data: %s", (reason) => {
    const context = createLocalModelAdvisorVerificationContext();
    expect(() =>
      validateLocalModelAdvisorVerificationResult(context, {
        status: "unavailable",
        reason,
        raw: "must not be included",
      }),
    ).toThrow(`provider unavailable: ${reason}`);

    try {
      validateLocalModelAdvisorVerificationResult(context, {
        status: "unavailable",
        reason,
        raw: "must not be included",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("must not be included");
    }
  });

  it("uses the generic failure for an unrecognized unavailable reason", () => {
    const context = createLocalModelAdvisorVerificationContext();
    expect(() =>
      validateLocalModelAdvisorVerificationResult(context, {
        status: "unavailable",
        reason: "raw secret provider failure",
      }),
    ).toThrow("the provider did not return available advice");
  });

  it("detects context mutation using the retained canonical snapshot", () => {
    const context = createLocalModelAdvisorVerificationContext();
    const canonical = JSON.stringify(context);

    expect(() => assertLocalModelAdvisorContextUnchanged(canonical, context)).not.toThrow();
    const mutableItems = context.plan.items as unknown as { title: string }[];
    mutableItems[0]!.title = "Mutated";
    expect(() => assertLocalModelAdvisorContextUnchanged(canonical, context)).toThrow(
      /mutated its input context/,
    );
  });

  it("requires explicit Ollama mode before constructing a live adapter", async () => {
    await expect(runLocalModelAdvisorVerification({})).rejects.toThrow(
      "LOCAL_MODEL_ADVISOR_MODE=ollama",
    );
  });

  it("runs the production adapter against a deterministic loopback Ollama response", async () => {
    const modelSummary = "MODEL_OUTPUT_SENTINEL must remain private.";
    const modelRationale = "MODEL_RATIONALE_SENTINEL must remain private.";
    let requestBody = "";
    let requestMethod: string | undefined;
    let requestUrl: string | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        requestMethod = request.method;
        requestUrl = request.url;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requestBody = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            done: true,
            message: {
              role: "assistant",
              content: JSON.stringify({
                version: "schedule.advisor-output/v1",
                summary: modelSummary,
                suggestions: [
                  {
                    kind: "focus",
                    targetType: "plan_item",
                    targetId: "local-advisor-smoke-plan-item",
                    title: "Protect the first block",
                    rationale: modelRationale,
                    confidence: "medium",
                  },
                  {
                    kind: "consider_backlog",
                    targetType: "work_item",
                    targetId: "local-advisor-smoke-work-item",
                    title: "Keep the backlog item nearby",
                    rationale: "It is the only eligible backlog item supplied.",
                    confidence: "low",
                  },
                ],
              }),
            },
          }),
        );
      })().catch(() => {
        response.destroy();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    try {
      const summary = await runLocalModelAdvisorVerification({
        LOCAL_MODEL_ADVISOR_MODE: "ollama",
        LOCAL_MODEL_ADVISOR_URL: `http://127.0.0.1:${String(address.port)}`,
        LOCAL_MODEL_ADVISOR_MODEL: "gemma4:e4b",
        LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: "1000",
        LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: "5000",
        LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES: "32768",
        LOCAL_MODEL_ADVISOR_MAX_CONCURRENT: "1",
      });
      const printed = formatLocalModelAdvisorVerificationSummary(summary);

      expect(summary).toMatchObject({
        provider: "ollama",
        model: "gemma4:e4b",
        suggestionCount: 2,
      });
      expect(summary.latencyMs).toBeGreaterThanOrEqual(0);
      expect(requestMethod).toBe("POST");
      expect(requestUrl).toBe("/api/chat");
      const outbound = JSON.parse(requestBody) as {
        model: string;
        stream: boolean;
        think: boolean;
        tools?: unknown;
        format: { properties: { version: { const: string } } };
        messages: { role: string; content: string }[];
      };
      expect(outbound).toMatchObject({
        model: "gemma4:e4b",
        stream: false,
        think: false,
        format: {
          properties: { version: { const: "schedule.advisor-output/v1" } },
        },
      });
      expect(outbound.tools).toBeUndefined();
      expect(outbound.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(outbound.messages[1]?.content).toContain("local-advisor-smoke-plan-item");
      expect(JSON.parse(printed)).toEqual({
        provider: "ollama",
        model: "gemma4:e4b",
        latencyMs: summary.latencyMs,
        suggestionCount: 2,
      });
      for (const privateContent of [
        "Review the current plan",
        "Prepare the next task",
        modelSummary,
        modelRationale,
      ]) {
        expect(printed).not.toContain(privateContent);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("formats only the allowed safe diagnostics", () => {
    const formatted = formatLocalModelAdvisorVerificationSummary({
      provider: "ollama",
      model: "gemma4:e4b",
      latencyMs: 125,
      suggestionCount: 2,
    });

    expect(JSON.parse(formatted)).toEqual({
      provider: "ollama",
      model: "gemma4:e4b",
      latencyMs: 125,
      suggestionCount: 2,
    });
    expect(formatted).not.toContain("Review the current plan");
  });
});
