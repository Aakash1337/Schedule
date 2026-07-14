import { DomainError } from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { ZodError, type ZodType } from "zod";

export class RequestValidationError extends Error {
  readonly code = "request.validation_failed";

  constructor(readonly details: readonly { path: string; message: string }[]) {
    super("The request is invalid.");
    this.name = "RequestValidationError";
  }
}

export class ResourceNotFoundError extends Error {
  readonly code: string;

  constructor(resource: "plan") {
    super(`The requested ${resource} does not exist.`);
    this.name = "ResourceNotFoundError";
    this.code = `${resource}.not_found`;
  }
}

export class RequestThrottledError extends Error {
  readonly code: string;

  constructor(code = "request.rate_limit_exceeded") {
    super("Too many requests are in progress. Try again shortly.");
    this.name = "RequestThrottledError";
    this.code = code;
  }
}

export class IntegrationAuthenticationError extends Error {
  readonly code = "integration.authentication_failed";

  constructor() {
    super("Authentication failed.");
    this.name = "IntegrationAuthenticationError";
  }
}

export class UnsupportedMediaTypeError extends Error {
  readonly code = "request.media_type_unsupported";

  constructor() {
    super("The request media type is not supported.");
    this.name = "UnsupportedMediaTypeError";
  }
}

export function parseRequest<Output>(schema: ZodType<Output>, value: unknown): Output {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestValidationError(
        error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    throw error;
  }
}

function domainStatus(error: DomainError): number {
  if (error.code === "integration.authentication_failed") return 401;
  if (error.code === "integration.scope_denied") return 403;
  if (
    error.code === "integration.confirmation_expired" ||
    error.code === "integration.confirmation_consumed"
  ) {
    return 410;
  }
  if (
    error.code === "integration.request_conflict" ||
    error.code === "integration.receipt_conflict" ||
    error.code === "integration.receipt_in_progress"
  ) {
    return 409;
  }
  if (error.code.endsWith(".not_found") || error.code.endsWith("_not_found")) return 404;
  if (
    error.code.endsWith(".conflict") ||
    error.code.endsWith("_conflict") ||
    error.code.includes("version_conflict") ||
    error.code.includes("write_conflict")
  ) {
    return 409;
  }
  return 422;
}

function publicDomainMessage(error: DomainError): string {
  switch (error.code) {
    case "integration.authentication_failed":
      return "Authentication failed.";
    case "integration.scope_denied":
      return "The credential is not authorized for this operation.";
    case "integration.request_conflict":
    case "integration.receipt_conflict":
    case "integration.receipt_in_progress":
      return "The request conflicts with an existing integration request.";
    case "integration.confirmation_not_found":
      return "The requested confirmation does not exist.";
    case "integration.confirmation_expired":
    case "integration.confirmation_consumed":
      return "The requested confirmation is no longer available.";
    default:
      return error.message;
  }
}

const INTERNAL_INTEGRATION_FAILURES = new Set([
  "integration.confirmation_corrupt",
  "integration.confirmation_ttl_invalid",
  "integration.confirmation_write_conflict",
  "integration.receipt_corrupt",
  "integration.receipt_invalid",
  "integration.receipt_not_found",
  "integration.receipt_write_conflict",
  "integration.result_invalid",
  "integration.timestamp_invalid",
]);
const INTERNAL_PLANNING_FAILURES = new Set(["planning.work_item_graph_corrupt"]);

function isInternalIntegrationFailure(error: DomainError): boolean {
  return INTERNAL_INTEGRATION_FAILURES.has(error.code);
}

function isInternalPlanningFailure(error: DomainError): boolean {
  return INTERNAL_PLANNING_FAILURES.has(error.code);
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = error.statusCode;
  return typeof value === "number" ? value : undefined;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let code = "internal.unexpected_error";
    let message = "An unexpected error occurred.";
    let details: RequestValidationError["details"] | undefined;

    if (error instanceof RequestValidationError) {
      status = 400;
      code = error.code;
      message = error.message;
      details = error.details;
    } else if (error instanceof ResourceNotFoundError) {
      status = 404;
      code = error.code;
      message = error.message;
    } else if (error instanceof RequestThrottledError) {
      status = 429;
      code = error.code;
      message = error.message;
    } else if (error instanceof IntegrationAuthenticationError) {
      status = 401;
      code = error.code;
      message = error.message;
    } else if (error instanceof UnsupportedMediaTypeError) {
      status = 415;
      code = error.code;
      message = error.message;
    } else if (error instanceof DomainError && isInternalPlanningFailure(error)) {
      request.log.error({ code: error.code }, "planning invariant failed");
    } else if (error instanceof DomainError && isInternalIntegrationFailure(error)) {
      request.log.error({ code: error.code }, "integration invariant failed");
    } else if (error instanceof DomainError) {
      status = domainStatus(error);
      code = error.code;
      message = publicDomainMessage(error);
    } else if (errorStatusCode(error) === 413) {
      status = 413;
      code = "request.body_too_large";
      message = "The request body is too large.";
    } else if (errorStatusCode(error) === 400) {
      status = 400;
      code = "request.malformed";
      message = "The request could not be parsed.";
    } else if (errorStatusCode(error) === 404) {
      status = 404;
      code = "request.route_not_found";
      message = "The requested route does not exist.";
    } else if (errorStatusCode(error) === 415) {
      status = 415;
      code = "request.media_type_unsupported";
      message = "The request media type is not supported.";
    } else {
      request.log.error({ err: error }, "unhandled API error");
    }

    const body = {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
      requestId: request.id,
    };
    if (status === 401) reply.header("www-authenticate", "Bearer");
    void reply.code(status).send(body);
  });
}
