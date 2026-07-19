import { describe, expect, it, vi } from "vitest";

import { desktopApiTransport } from "./api-transport.js";
import { mountDesktopApp } from "./mount.js";

describe("desktop UI mount", () => {
  it("installs the native transport before rendering the React application", () => {
    const events: string[] = [];
    const configureTransport = vi.fn((transport: typeof desktopApiTransport) => {
      expect(transport).toBe(desktopApiTransport);
      events.push("configured");
    });
    const render = vi.fn(() => events.push("rendered"));

    mountDesktopApp({} as HTMLElement, { configureTransport, render });

    expect(events).toEqual(["configured", "rendered"]);
    expect(render).toHaveBeenCalledOnce();
  });
});
