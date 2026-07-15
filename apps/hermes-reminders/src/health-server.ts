import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { HermesReminderSupervisorHealth } from "./supervisor.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const DEFAULT_HOST = "127.0.0.1" as const;

export interface HermesReminderHealthProvider {
  health(): HermesReminderSupervisorHealth;
}

export interface RunHermesReminderHealthServerOptions {
  readonly provider: HermesReminderHealthProvider;
  readonly port: number;
  readonly host?: "127.0.0.1" | "::1";
  readonly onListening?: (address: AddressInfo) => void;
}

function commonHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": JSON_CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, commonHeaders());
  response.end(JSON.stringify(body));
}

export function createHermesReminderHealthHandler(
  provider: HermesReminderHealthProvider,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, { status: "method_not_allowed" });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(response, 400, { status: "bad_request" });
      return;
    }
    if (pathname === "/health/live") {
      sendJson(response, 200, { status: "alive" });
      return;
    }
    if (pathname === "/health/ready") {
      try {
        const ready = provider.health().ready;
        sendJson(
          response,
          ready ? 200 : 503,
          ready ? { status: "ready" } : { status: "not_ready" },
        );
      } catch {
        sendJson(response, 503, { status: "not_ready" });
      }
      return;
    }
    sendJson(response, 404, { status: "not_found" });
  };
}

/** Runs a health-only listener on a literal loopback address until shutdown. */
export async function runHermesReminderHealthServer(
  options: RunHermesReminderHealthServerOptions,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new RangeError("Hermes reminder health port must be between 0 and 65535.");
  }
  const host = options.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new TypeError("Hermes reminder health must bind to a literal loopback address.");
  }
  if (signal.aborted) return;

  const server = createServer(createHermesReminderHealthHandler(options.provider));
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    let settled = false;
    let firstFailure: Error | undefined;
    const listenerFailure = (): Error => new Error("Hermes reminder health listener failed.");
    const onAbort = (): void => close();
    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      server.removeListener("error", fail);
      server.removeListener("close", closed);
      if (failure === undefined) resolve();
      else reject(failure);
    };
    const fail = (): void => close(listenerFailure());
    const closed = (): void => finish(firstFailure ?? (closing ? undefined : listenerFailure()));
    const close = (failure?: Error): void => {
      if (failure instanceof Error && firstFailure === undefined) firstFailure = failure;
      if (closing) return;
      closing = true;
      signal.removeEventListener("abort", onAbort);
      try {
        server.close((error) => {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          finish(
            firstFailure ??
              (error === undefined || code === "ERR_SERVER_NOT_RUNNING"
                ? undefined
                : listenerFailure()),
          );
        });
        server.closeAllConnections();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        finish(firstFailure ?? (code === "ERR_SERVER_NOT_RUNNING" ? undefined : listenerFailure()));
      }
    };

    server.once("error", fail);
    server.once("close", closed);
    signal.addEventListener("abort", onAbort, { once: true });
    server.listen(options.port, host, () => {
      server.removeListener("error", fail);
      server.on("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        close(listenerFailure());
        return;
      }
      try {
        options.onListening?.(address);
      } catch {
        close(listenerFailure());
      }
    });
    if (signal.aborted) close();
  });
}
