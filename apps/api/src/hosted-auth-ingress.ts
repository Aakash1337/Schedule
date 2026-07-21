import type { FastifyRequest } from "fastify";

export type HostedIngressDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export interface HostedAuthTrafficGuard {
  admitLoginStart(): HostedIngressDecision;
  enterCallback(): (() => void) | null;
}

export interface HostedAuthTrafficLimits {
  readonly loginStartsPerMinute: number;
  readonly maxConcurrentCallbacks: number;
}

function headerValues(request: FastifyRequest, name: string): readonly string[] {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const candidateName = raw[index];
    const candidateValue = raw[index + 1];
    if (candidateName?.toLowerCase() === name && typeof candidateValue === "string") {
      values.push(candidateValue);
    }
  }
  if (values.length > 0) return values;
  const fallback = request.headers[name];
  return typeof fallback === "string" ? [fallback] : Array.isArray(fallback) ? fallback : [];
}

function optionalExactHeader(request: FastifyRequest, name: string, expected: string): boolean {
  const values = headerValues(request, name);
  return values.length === 0 || (values.length === 1 && values[0] === expected);
}

function requestPath(url: string): string {
  const query = url.indexOf("?");
  return query < 0 ? url : url.slice(0, query);
}

/** Keep operational request paths while excluding query credentials and browser secrets. */
export function hostedRequestLogProtection() {
  return {
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-schedule-csrf"]',
        'res.headers["set-cookie"]',
      ],
      censor: "[Redacted]",
    },
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: requestPath(request.url),
        version: request.headers["accept-version"],
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket.remotePort,
      }),
    },
  };
}

/** Exact public-origin boundary plus constant-space auth workload admission. */
export class HostedAuthIngressGuard implements HostedAuthTrafficGuard {
  readonly #expectedHost: string;
  readonly #limits: HostedAuthTrafficLimits;
  readonly #now: () => number;
  #loginWindowStartedAt: number;
  #loginStarts = 0;
  #activeCallbacks = 0;

  constructor(hostedOrigin: string, limits: HostedAuthTrafficLimits, now: () => number = Date.now) {
    let origin: URL;
    try {
      origin = new URL(hostedOrigin);
    } catch {
      throw new TypeError("Hosted auth ingress configuration is invalid.");
    }
    if (
      origin.protocol !== "https:" ||
      origin.origin !== hostedOrigin ||
      !Number.isInteger(limits.loginStartsPerMinute) ||
      limits.loginStartsPerMinute < 1 ||
      limits.loginStartsPerMinute > 1_000 ||
      !Number.isInteger(limits.maxConcurrentCallbacks) ||
      limits.maxConcurrentCallbacks < 1 ||
      limits.maxConcurrentCallbacks > 32
    ) {
      throw new TypeError("Hosted auth ingress configuration is invalid.");
    }
    this.#expectedHost = origin.host;
    this.#limits = Object.freeze({ ...limits });
    this.#now = now;
    this.#loginWindowStartedAt = now();
  }

  accepts(request: FastifyRequest): boolean {
    const hosts = headerValues(request, "host");
    return (
      hosts.length === 1 &&
      hosts[0] === this.#expectedHost &&
      request.protocol === "https" &&
      optionalExactHeader(request, "x-forwarded-host", this.#expectedHost) &&
      optionalExactHeader(request, "x-forwarded-proto", "https")
    );
  }

  admitLoginStart(): HostedIngressDecision {
    const now = this.#now();
    if (now - this.#loginWindowStartedAt >= 60_000) {
      this.#loginWindowStartedAt = now;
      this.#loginStarts = 0;
    }
    if (this.#loginStarts >= this.#limits.loginStartsPerMinute) {
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((60_000 - (now - this.#loginWindowStartedAt)) / 1_000),
        ),
      });
    }
    this.#loginStarts += 1;
    return Object.freeze({ allowed: true });
  }

  enterCallback(): (() => void) | null {
    if (this.#activeCallbacks >= this.#limits.maxConcurrentCallbacks) return null;
    this.#activeCallbacks += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeCallbacks -= 1;
    };
  }
}
