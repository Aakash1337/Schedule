import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  NATURAL_LANGUAGE_PROPOSER_CONTEXT_VERSION,
  NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
  SCHEDULING_ADVISOR_CONTEXT_VERSION,
  SCHEDULING_ADVISOR_OUTPUT_VERSION,
  type SchedulingAdvisorContext,
  type SchedulingAdvisorOutput,
  type NaturalLanguageProposerContext,
  type NaturalLanguageProposerOutput,
} from "@schedule/application";
import { localDate } from "@schedule/domain";
import { describe, expect, it } from "vitest";

import {
  DisabledSchedulingAdvisor,
  OllamaSchedulingAdvisor,
  type OllamaSchedulingAdvisorOptions,
} from "./local-model-advisor.js";

interface RunningServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const planItemId = "11111111-1111-4111-8111-111111111111";
const workItemId = "22222222-2222-4222-8222-222222222222";

const context: SchedulingAdvisorContext = {
  version: SCHEDULING_ADVISOR_CONTEXT_VERSION,
  requestId: "33333333-3333-4333-8333-333333333333",
  date: localDate("2026-07-13"),
  focus: "both",
  plan: {
    id: "44444444-4444-4444-8444-444444444444",
    headVersion: 3,
    date: localDate("2026-07-13"),
    totalMinutes: 45,
    warnings: [],
    items: [
      {
        id: planItemId,
        title: "Prepare weekly review",
        position: 0,
        scheduledMinutes: 45,
        locked: false,
        activityState: "pending",
        sourceType: "routine",
        reasons: ["Weekly cadence is due."],
      },
    ],
  },
  backlog: [
    {
      id: workItemId,
      version: 2,
      title: "Outline the next project",
      status: "backlog",
      priority: "medium",
      dueOn: null,
      planningDurationMinutes: 30,
    },
  ],
  truncated: { planItems: false, backlog: false },
};

const validOutput: SchedulingAdvisorOutput = {
  version: SCHEDULING_ADVISOR_OUTPUT_VERSION,
  summary: "Start with the weekly review while your plan is still flexible.",
  suggestions: [
    {
      kind: "focus",
      targetType: "plan_item",
      targetId: planItemId,
      title: "Begin with the weekly review",
      rationale: "It is already scheduled and its weekly cadence is due.",
      confidence: "medium",
    },
    {
      kind: "consider_backlog",
      targetType: "work_item",
      targetId: workItemId,
      title: "Consider the project outline if time remains",
      rationale: "It is a bounded medium-priority follow-up.",
      confidence: "low",
    },
  ],
};

const proposalContext: NaturalLanguageProposerContext = {
  version: NATURAL_LANGUAGE_PROPOSER_CONTEXT_VERSION,
  requestId: "88888888-8888-4888-8888-888888888888",
  prompt: "Add prepare the quarterly report to my work list",
  referenceDate: localDate("2026-07-13"),
};

const validProposalOutput: NaturalLanguageProposerOutput = {
  version: NATURAL_LANGUAGE_PROPOSER_OUTPUT_VERSION,
  summary: "Prepare one reviewable work item.",
  warnings: ["Review the title before confirming."],
  command: { type: "work_item.create", title: "Prepare the quarterly report" },
  modelSuggestions: {
    priority: "high",
    dueOn: "2026-07-20",
    planningDurationMinutes: 90,
  },
};

function ollamaEnvelope(output: unknown = validOutput): string {
  return JSON.stringify({
    model: "gemma4:e4b",
    created_at: "2026-07-13T20:00:00Z",
    message: {
      role: "assistant",
      content: JSON.stringify(output),
      thinking: "This metadata must never leave the adapter.",
    },
    done: true,
    total_duration: 12_345,
  });
}

function sendJson(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<RunningServer> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

function advisorOptions(
  baseUrl: string,
  overrides: Partial<OllamaSchedulingAdvisorOptions> = {},
): OllamaSchedulingAdvisorOptions {
  return {
    baseUrl,
    model: "gemma4:e4b",
    connectTimeoutMs: 100,
    requestTimeoutMs: 2_000,
    maxResponseBytes: 32_768,
    maxConcurrent: 1,
    ...overrides,
  };
}

async function withResponse(
  body: string,
  assertion: (advisor: OllamaSchedulingAdvisor) => Promise<void>,
): Promise<void> {
  const server = await startServer((_request, response) => sendJson(response, body));
  try {
    await assertion(new OllamaSchedulingAdvisor(advisorOptions(server.baseUrl)));
  } finally {
    await server.close();
  }
}

async function reserveClosedPort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return port;
}

describe("DisabledSchedulingAdvisor", () => {
  it("returns disabled without opening a network connection", async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.end();
    });
    try {
      const advisor = new DisabledSchedulingAdvisor();
      const controller = new AbortController();
      controller.abort();
      expect(advisor.provider).toBe("disabled");
      expect(advisor.model).toBeNull();
      await expect(advisor.advise(context, controller.signal)).resolves.toEqual({
        status: "unavailable",
        reason: "disabled",
      });
      expect(requestCount).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("OllamaSchedulingAdvisor security boundary", () => {
  it("accepts the canonical production origin and only the allowlisted local models", () => {
    for (const model of ["gemma4:e2b", "gemma4:e4b", "gemma4:26b", "gemma4:31b"]) {
      expect(
        () => new OllamaSchedulingAdvisor(advisorOptions("http://127.0.0.1:11434", { model })),
      ).not.toThrow();
    }
  });

  it.each([
    "http://127.0.0.1:11434/",
    "http://127.0.0.1:11434/api",
    "http://127.0.0.1:11434?model=other",
    "http://localhost:11434",
    "http://[::1]:11434",
    "http://2130706433:11434",
    "http://user@127.0.0.1:11434",
    "https://127.0.0.1:11434",
  ])("rejects the non-canonical or non-loopback origin %s", (baseUrl) => {
    expect(() => new OllamaSchedulingAdvisor(advisorOptions(baseUrl))).toThrow(
      /exact IPv4 loopback origin/,
    );
  });

  it.each(["gemma4", "gemma4:latest", "gemma4:e4b-cloud", "gpt-oss:120b-cloud"])(
    "rejects the non-allowlisted model %s",
    (model) => {
      expect(
        () => new OllamaSchedulingAdvisor(advisorOptions("http://127.0.0.1:11434", { model })),
      ).toThrow(/allowed local Gemma model/);
    },
  );

  it("mirrors the configuration bounds", () => {
    const base = "http://127.0.0.1:11434";
    expect(
      () => new OllamaSchedulingAdvisor(advisorOptions(base, { connectTimeoutMs: 99 })),
    ).toThrow(/connectTimeoutMs/);
    expect(
      () => new OllamaSchedulingAdvisor(advisorOptions(base, { requestTimeoutMs: 999 })),
    ).toThrow(/requestTimeoutMs/);
    expect(
      () => new OllamaSchedulingAdvisor(advisorOptions(base, { maxResponseBytes: 1_023 })),
    ).toThrow(/maxResponseBytes/);
    expect(() => new OllamaSchedulingAdvisor(advisorOptions(base, { maxConcurrent: 5 }))).toThrow(
      /maxConcurrent/,
    );
    expect(
      () =>
        new OllamaSchedulingAdvisor(
          advisorOptions(base, { connectTimeoutMs: 2_000, requestTimeoutMs: 1_000 }),
        ),
    ).toThrow(/at least connectTimeoutMs/);
  });

  it("sends one fixed, schema-constrained, tool-free request to the immutable path", async () => {
    let method: string | undefined;
    let path: string | undefined;
    let contentType: string | undefined;
    let accept: string | undefined;
    let body = "";
    const server = await startServer((request, response) => {
      method = request.method;
      path = request.url;
      contentType = request.headers["content-type"];
      accept = request.headers.accept;
      void readBody(request).then((value) => {
        body = value;
        sendJson(response, ollamaEnvelope());
      });
    });

    try {
      const advisor = new OllamaSchedulingAdvisor(advisorOptions(server.baseUrl));
      await expect(advisor.advise(context)).resolves.toEqual({
        status: "available",
        output: validOutput,
      });
      expect(method).toBe("POST");
      expect(path).toBe("/api/chat");
      expect(contentType).toBe("application/json");
      expect(accept).toBe("application/json");

      const outbound = JSON.parse(body) as {
        readonly model: string;
        readonly messages: readonly { readonly role: string; readonly content: string }[];
        readonly stream: boolean;
        readonly think: boolean;
        readonly format: {
          readonly additionalProperties: boolean;
          readonly description: string;
          readonly properties: {
            readonly suggestions: {
              readonly description: string;
              readonly maxItems: number;
              readonly items: {
                readonly additionalProperties: boolean;
                readonly properties: {
                  readonly kind: { readonly description: string };
                  readonly targetType: { readonly description: string };
                  readonly targetId: { readonly description: string };
                };
              };
            };
          };
        };
        readonly options: {
          readonly temperature: number;
          readonly seed: number;
          readonly num_predict: number;
        };
        readonly tools?: unknown;
      };
      expect(Object.keys(outbound).sort()).toEqual([
        "format",
        "messages",
        "model",
        "options",
        "stream",
        "think",
      ]);
      expect(outbound.model).toBe("gemma4:e4b");
      expect(outbound.messages).toHaveLength(2);
      expect(outbound.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(outbound.messages[0]?.content).toContain(
        'For kind "focus" or "sequence": set targetType to "plan_item"',
      );
      expect(outbound.messages[0]?.content).toContain(
        'For kind "consider_backlog": set targetType to "work_item"',
      );
      expect(outbound.messages[0]?.content).toContain(
        'For kind "plan_observation": set both targetType and targetId to null.',
      );
      expect(outbound.messages[0]?.content).toContain("return an empty suggestions array");
      expect(outbound.messages[1]?.content).toBe(
        `BEGIN_SCHEDULE_CONTEXT_JSON\n${JSON.stringify(context)}\nEND_SCHEDULE_CONTEXT_JSON`,
      );
      expect(outbound.stream).toBe(false);
      expect(outbound.think).toBe(false);
      expect(outbound).not.toHaveProperty("tools");
      expect(outbound.options).toEqual({ temperature: 0, seed: 42, num_predict: 768 });
      expect(outbound.format.additionalProperties).toBe(false);
      expect(outbound.format.description).toContain("Read-only scheduling advice");
      expect(outbound.format.properties.suggestions.maxItems).toBe(5);
      expect(outbound.format.properties.suggestions.description).toContain(
        "empty array rather than an invalid target pairing",
      );
      expect(outbound.format.properties.suggestions.items.additionalProperties).toBe(false);
      expect(outbound.format.properties.suggestions.items.properties.kind.description).toContain(
        "plan_observation has no target",
      );
      expect(
        outbound.format.properties.suggestions.items.properties.targetType.description,
      ).toContain("null for plan_observation");
      expect(
        outbound.format.properties.suggestions.items.properties.targetId.description,
      ).toContain("exact supplied plan item ID");
    } finally {
      await server.close();
    }
  });

  it.each([204, 302, 429, 500])(
    "treats HTTP %i as a terminal provider rejection",
    async (status) => {
      const server = await startServer((_request, response) => {
        response.writeHead(status, status === 302 ? { location: "http://example.com/" } : {});
        response.end("private provider error");
      });
      try {
        const advisor = new OllamaSchedulingAdvisor(advisorOptions(server.baseUrl));
        await expect(advisor.advise(context)).resolves.toEqual({
          status: "unavailable",
          reason: "provider_rejected",
        });
      } finally {
        await server.close();
      }
    },
  );

  it("returns only the fixed unreachable reason when the loopback service is absent", async () => {
    const port = await reserveClosedPort();
    const advisor = new OllamaSchedulingAdvisor(advisorOptions(`http://127.0.0.1:${port}`));
    await expect(advisor.advise(context)).resolves.toEqual({
      status: "unavailable",
      reason: "unreachable",
    });
  });

  it("does not connect or consume a permit when the signal is already aborted", async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      sendJson(response, ollamaEnvelope());
    });
    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { maxConcurrent: 1 }),
      );
      const controller = new AbortController();
      controller.abort();

      await expect(advisor.advise(context, controller.signal)).resolves.toEqual({
        status: "unavailable",
        reason: "unreachable",
      });
      expect(requestCount).toBe(0);

      await expect(advisor.advise(context)).resolves.toEqual({
        status: "available",
        output: validOutput,
      });
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("enforces an end-to-end timeout without retrying", async () => {
    let requestCount = 0;
    const server = await startServer((_request, _response) => {
      requestCount += 1;
    });
    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { requestTimeoutMs: 1_000 }),
      );
      await expect(advisor.advise(context)).resolves.toEqual({
        status: "unavailable",
        reason: "timeout",
      });
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("rejects an oversized declared response before buffering it", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": "2048" });
      response.flushHeaders();
    });
    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { maxResponseBytes: 1_024 }),
      );
      await expect(advisor.advise(context)).resolves.toEqual({
        status: "unavailable",
        reason: "response_too_large",
      });
    } finally {
      await server.close();
    }
  });

  it("stops an undeclared streamed response at the byte limit", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("x".repeat(1_025));
      response.end();
    });
    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { maxResponseBytes: 1_024 }),
      );
      await expect(advisor.advise(context)).resolves.toEqual({
        status: "unavailable",
        reason: "response_too_large",
      });
    } finally {
      await server.close();
    }
  });
});

describe("OllamaSchedulingAdvisor response validation", () => {
  it.each([
    ["invalid outer JSON", "not-json"],
    ["missing done", JSON.stringify({ message: { content: JSON.stringify(validOutput) } })],
    [
      "unfinished response",
      JSON.stringify({ done: false, message: { content: JSON.stringify(validOutput) } }),
    ],
    ["missing message", JSON.stringify({ done: true })],
    ["missing content", JSON.stringify({ done: true, message: {} })],
    [
      "tool call",
      JSON.stringify({
        done: true,
        message: { content: JSON.stringify(validOutput), tool_calls: [{ function: {} }] },
      }),
    ],
    ["invalid content JSON", JSON.stringify({ done: true, message: { content: "nope" } })],
  ])("rejects %s without exposing response details", async (_label, body) => {
    await withResponse(body, async (advisor) => {
      await expect(advisor.advise(context)).resolves.toEqual({
        status: "unavailable",
        reason: "malformed_response",
      });
    });
  });

  it.each([
    ["wrong version", { ...validOutput, version: "schedule.advisor-output/v2" }],
    ["unknown output key", { ...validOutput, action: "apply" }],
    ["empty summary", { ...validOutput, summary: "" }],
    ["oversized summary", { ...validOutput, summary: "s".repeat(281) }],
    [
      "too many suggestions",
      { ...validOutput, suggestions: Array.from({ length: 6 }, () => validOutput.suggestions[0]) },
    ],
    [
      "unknown suggestion key",
      {
        ...validOutput,
        suggestions: [{ ...validOutput.suggestions[0], apply: true }],
      },
    ],
    [
      "invalid kind",
      {
        ...validOutput,
        suggestions: [{ ...validOutput.suggestions[0], kind: "delete" }],
      },
    ],
    [
      "oversized title",
      {
        ...validOutput,
        suggestions: [{ ...validOutput.suggestions[0], title: "t".repeat(121) }],
      },
    ],
    [
      "oversized rationale",
      {
        ...validOutput,
        suggestions: [{ ...validOutput.suggestions[0], rationale: "r".repeat(401) }],
      },
    ],
    [
      "plan advice with a work-item target",
      {
        ...validOutput,
        suggestions: [
          { ...validOutput.suggestions[0], targetType: "work_item", targetId: workItemId },
        ],
      },
    ],
    [
      "backlog advice without a target",
      {
        ...validOutput,
        suggestions: [
          {
            ...validOutput.suggestions[1],
            targetType: null,
            targetId: null,
          },
        ],
      },
    ],
    [
      "plan observation with a target",
      {
        ...validOutput,
        suggestions: [
          {
            ...validOutput.suggestions[0],
            kind: "plan_observation",
          },
        ],
      },
    ],
    [
      "unsafe control text",
      {
        ...validOutput,
        suggestions: [{ ...validOutput.suggestions[0], rationale: "Unsafe\ntext" }],
      },
    ],
  ])("rejects strict output violation: %s", async (_label, output) => {
    await withResponse(ollamaEnvelope(output), async (advisor) => {
      await expect(advisor.advise(context)).resolves.toEqual({
        status: "unavailable",
        reason: "malformed_response",
      });
    });
  });

  it("returns only the validated contract and discards outer metadata", async () => {
    await withResponse(ollamaEnvelope(), async (advisor) => {
      const result = await advisor.advise(context);
      expect(result).toEqual({ status: "available", output: validOutput });
      expect(JSON.stringify(result)).not.toContain("This metadata must never leave the adapter");
      expect(JSON.stringify(result)).not.toContain("total_duration");
    });
  });
});

describe("OllamaSchedulingAdvisor proposal boundary", () => {
  it("sends a fixed tool-free proposal request and returns only strict review data", async () => {
    let body = "";
    const server = await startServer((request, response) => {
      void readBody(request).then((value) => {
        body = value;
        sendJson(response, ollamaEnvelope(validProposalOutput));
      });
    });
    try {
      const advisor = new OllamaSchedulingAdvisor(advisorOptions(server.baseUrl));
      await expect(advisor.propose(proposalContext)).resolves.toEqual({
        status: "available",
        output: validProposalOutput,
      });
      const outbound = JSON.parse(body) as {
        readonly messages: readonly { readonly role: string; readonly content: string }[];
        readonly format: {
          readonly additionalProperties: boolean;
          readonly properties: {
            readonly command: { readonly oneOf: readonly unknown[] };
            readonly modelSuggestions: {
              readonly oneOf: readonly {
                readonly additionalProperties?: boolean;
                readonly required?: readonly string[];
                readonly not?: unknown;
                readonly properties?: {
                  readonly dueOn?: {
                    readonly minLength?: number;
                    readonly maxLength?: number;
                    readonly pattern?: string;
                  };
                };
              }[];
            };
          };
        };
        readonly tools?: unknown;
        readonly think: boolean;
      };
      expect(outbound.messages[0]?.content).toContain("human must review and explicitly confirm");
      expect(outbound.messages[0]?.content).toContain("modelSuggestions are review-only advice");
      expect(outbound.messages[0]?.content).toContain(
        "only when the user text states that value explicitly and unambiguously",
      );
      expect(outbound.messages[0]?.content).toContain("preserve that exact priority word");
      expect(outbound.messages[0]?.content).toContain("set modelSuggestions itself to null");
      expect(outbound.messages[0]?.content).toContain("only against context.referenceDate");
      expect(outbound.messages[0]?.content).toContain("mutate Schedule");
      expect(outbound.messages[1]?.content).toBe(
        `BEGIN_UNTRUSTED_WORK_CONTEXT_JSON\n${JSON.stringify(proposalContext)}\nEND_UNTRUSTED_WORK_CONTEXT_JSON`,
      );
      expect(outbound.format.additionalProperties).toBe(false);
      expect(outbound.format.properties.command.oneOf).toHaveLength(2);
      expect(outbound.format.properties.modelSuggestions.oneOf).toHaveLength(2);
      expect(outbound.format.properties.modelSuggestions.oneOf[1]?.required).toEqual([
        "priority",
        "dueOn",
        "planningDurationMinutes",
      ]);
      expect(outbound.format.properties.modelSuggestions.oneOf[1]?.additionalProperties).toBe(
        false,
      );
      expect(outbound.format.properties.modelSuggestions.oneOf[1]).not.toHaveProperty("not");
      expect(outbound.format.properties.modelSuggestions.oneOf[1]?.properties?.dueOn).toMatchObject(
        { minLength: 10, maxLength: 10 },
      );
      expect(
        outbound.format.properties.modelSuggestions.oneOf[1]?.properties?.dueOn,
      ).not.toHaveProperty("pattern");
      expect(outbound).not.toHaveProperty("tools");
      expect(outbound.think).toBe(false);
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      "extra command field",
      { ...validProposalOutput, command: { ...validProposalOutput.command, dueOn: "tomorrow" } },
    ],
    [
      "unsupported command",
      { ...validProposalOutput, command: { type: "work_item.delete", title: "No" } },
    ],
    [
      "unsafe title",
      { ...validProposalOutput, command: { type: "work_item.create", title: "First\nSecond" } },
    ],
    ["duplicate warnings", { ...validProposalOutput, warnings: ["Review it.", "Review it."] }],
    [
      "missing model suggestions",
      (({ modelSuggestions: _ignored, ...output }) => output)(validProposalOutput),
    ],
    [
      "unknown model suggestion field",
      {
        ...validProposalOutput,
        modelSuggestions: { ...validProposalOutput.modelSuggestions, inferred: true },
      },
    ],
    [
      "all-null model suggestions",
      {
        ...validProposalOutput,
        modelSuggestions: { priority: null, dueOn: null, planningDurationMinutes: null },
      },
    ],
    [
      "relative model due date",
      {
        ...validProposalOutput,
        modelSuggestions: { ...validProposalOutput.modelSuggestions, dueOn: "tomorrow" },
      },
    ],
    [
      "invalid Gregorian model due date",
      {
        ...validProposalOutput,
        modelSuggestions: { ...validProposalOutput.modelSuggestions, dueOn: "2026-02-30" },
      },
    ],
    [
      "out-of-range model duration",
      {
        ...validProposalOutput,
        modelSuggestions: {
          ...validProposalOutput.modelSuggestions,
          planningDurationMinutes: 43_201,
        },
      },
    ],
  ])("rejects proposal output with %s", async (_label, output) => {
    await withResponse(ollamaEnvelope(output), async (advisor) => {
      await expect(advisor.propose(proposalContext)).resolves.toEqual({
        status: "unavailable",
        reason: "malformed_response",
      });
    });
  });

  it("shares the same concurrency permit across advice and proposal work", async () => {
    let heldResponse: ServerResponse | undefined;
    let announceRequest: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });
    const server = await startServer((_request, response) => {
      heldResponse = response;
      announceRequest?.();
    });
    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { maxConcurrent: 1 }),
      );
      const advice = advisor.advise(context);
      await requestStarted;
      await expect(advisor.propose(proposalContext)).resolves.toEqual({
        status: "unavailable",
        reason: "busy",
      });
      if (heldResponse === undefined) throw new Error("The held response was not captured.");
      sendJson(heldResponse, ollamaEnvelope());
      await expect(advice).resolves.toEqual({ status: "available", output: validOutput });
    } finally {
      await server.close();
    }
  });
});

describe("OllamaSchedulingAdvisor concurrency", () => {
  it("aborts an in-flight request and releases the default concurrency permit", async () => {
    let requestCount = 0;
    let announceFirstRequest: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      announceFirstRequest = resolve;
    });
    let announceFirstClose: (() => void) | undefined;
    const firstClose = new Promise<void>((resolve) => {
      announceFirstClose = resolve;
    });
    const server = await startServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.once("close", () => announceFirstClose?.());
        announceFirstRequest?.();
        return;
      }
      sendJson(response, ollamaEnvelope());
    });

    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { maxConcurrent: 1, requestTimeoutMs: 5_000 }),
      );
      const controller = new AbortController();
      const first = advisor.advise(context, controller.signal);
      await firstRequest;

      controller.abort();
      await expect(first).resolves.toEqual({
        status: "unavailable",
        reason: "unreachable",
      });
      await firstClose;

      await expect(advisor.advise(context)).resolves.toEqual({
        status: "available",
        output: validOutput,
      });
      expect(requestCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("releases one aborted permit while another request remains at the maximum", async () => {
    let requestCount = 0;
    const heldResponses: ServerResponse[] = [];
    let announceTwoRequests: (() => void) | undefined;
    const twoRequests = new Promise<void>((resolve) => {
      announceTwoRequests = resolve;
    });
    const server = await startServer((_request, response) => {
      requestCount += 1;
      if (requestCount <= 2) {
        heldResponses.push(response);
        if (requestCount === 2) announceTwoRequests?.();
        return;
      }
      sendJson(response, ollamaEnvelope());
    });

    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { maxConcurrent: 2, requestTimeoutMs: 5_000 }),
      );
      const firstController = new AbortController();
      const first = advisor.advise(context, firstController.signal);
      const second = advisor.advise(context);
      await twoRequests;

      await expect(advisor.advise(context)).resolves.toEqual({
        status: "unavailable",
        reason: "busy",
      });
      firstController.abort();
      await expect(first).resolves.toEqual({
        status: "unavailable",
        reason: "unreachable",
      });

      await expect(advisor.advise(context)).resolves.toEqual({
        status: "available",
        output: validOutput,
      });
      expect(requestCount).toBe(3);

      const secondResponse = heldResponses[1];
      if (secondResponse === undefined) throw new Error("The second response was not captured.");
      sendJson(secondResponse, ollamaEnvelope());
      await expect(second).resolves.toEqual({ status: "available", output: validOutput });
    } finally {
      await server.close();
    }
  });

  it("returns busy without opening another request and releases its permit in finally", async () => {
    let requestCount = 0;
    let firstResponse: ServerResponse | undefined;
    let announceFirstRequest: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      announceFirstRequest = resolve;
    });
    const server = await startServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        firstResponse = response;
        announceFirstRequest?.();
        return;
      }
      sendJson(response, ollamaEnvelope());
    });

    try {
      const advisor = new OllamaSchedulingAdvisor(
        advisorOptions(server.baseUrl, { maxConcurrent: 1 }),
      );
      const first = advisor.advise(context);
      await firstRequest;

      await expect(advisor.advise(context)).resolves.toEqual({
        status: "unavailable",
        reason: "busy",
      });
      expect(requestCount).toBe(1);

      if (firstResponse === undefined) throw new Error("The first response was not captured.");
      sendJson(firstResponse, ollamaEnvelope());
      await expect(first).resolves.toEqual({ status: "available", output: validOutput });

      await expect(advisor.advise(context)).resolves.toEqual({
        status: "available",
        output: validOutput,
      });
      expect(requestCount).toBe(2);
    } finally {
      await server.close();
    }
  });
});
