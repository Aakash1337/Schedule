import { afterEach, describe, expect, it, vi } from "vitest";

import { browserApiTransport, configureApiTransport, dispatchApiRequest } from "./api-transport.js";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  vi.unstubAllGlobals();
});

describe("API transport", () => {
  it("uses browser fetch by default", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    const response = await browserApiTransport("/v1/workspaces", { method: "GET" });

    expect(response.status).toBe(204);
    expect(fetch).toHaveBeenCalledWith("/v1/workspaces", { method: "GET" });
  });

  it("installs and restores one scoped transport without changing callers", async () => {
    const first = vi.fn(async () => new Response('{"source":"first"}'));
    const second = vi.fn(async () => new Response('{"source":"second"}'));
    restores.push(configureApiTransport(first));
    restores.push(configureApiTransport(second));

    expect(await (await dispatchApiRequest("/v1/workspaces", {})).json()).toEqual({
      source: "second",
    });
    restores.pop()?.();
    expect(await (await dispatchApiRequest("/v1/workspaces", {})).json()).toEqual({
      source: "first",
    });
  });
});
