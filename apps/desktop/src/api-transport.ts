import { invoke } from "@tauri-apps/api/core";

import type { ApiTransport } from "../../web/src/api-transport.js";

type DesktopApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface DesktopApiRequest {
  readonly method: DesktopApiMethod;
  readonly path: string;
  readonly jsonBody?: string;
  readonly idempotencyKey?: string;
}

interface DesktopApiResponse {
  readonly status: number;
  readonly jsonBody?: string;
  readonly requestId?: string | null;
}

const methods = new Set<DesktopApiMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? abortError();
}

export const desktopApiTransport: ApiTransport = async (path, init) => {
  throwIfAborted(init.signal);

  const method = (init.method ?? "GET").toUpperCase();
  if (!methods.has(method as DesktopApiMethod)) {
    throw new TypeError("The desktop API request method is not supported.");
  }
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new TypeError("The desktop API accepts only serialized JSON request bodies.");
  }

  const idempotencyKey = new Headers(init.headers).get("idempotency-key") ?? undefined;
  const request: DesktopApiRequest = {
    method: method as DesktopApiMethod,
    path,
    ...(init.body === undefined ? {} : { jsonBody: init.body }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
  const response = await invoke<DesktopApiResponse>("api_request", { request });
  throwIfAborted(init.signal);

  const hasNullBody = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(hasNullBody ? null : (response.jsonBody ?? null), {
    status: response.status,
    headers: {
      "content-type": "application/json",
      ...(response.requestId === undefined || response.requestId === null
        ? {}
        : { "x-request-id": response.requestId }),
    },
  });
};
