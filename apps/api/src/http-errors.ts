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
    } else if (error instanceof DomainError) {
      status = domainStatus(error);
      code = error.code;
      message = error.message;
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
    void reply.code(status).send(body);
  });
}
