import { describe, expect, it } from "vitest";

import { clearDesktopApiTokenEnvironment, desktopApiReadyLine } from "./desktop-api-runtime.js";

describe("desktop API runtime handshake", () => {
  it("emits only the versioned dynamic-port readiness record", () => {
    expect(desktopApiReadyLine({ address: "127.0.0.1", family: "IPv4", port: 49_321 })).toBe(
      'SCHEDULE_DESKTOP_API_READY_V1 {"port":49321}\n',
    );
  });

  it("rejects non-TCP and unbound readiness addresses", () => {
    for (const address of [null, "pipe", { address: "127.0.0.1", family: "IPv4", port: 0 }]) {
      expect(() => desktopApiReadyLine(address)).toThrow("valid TCP readiness address");
    }
  });

  it("removes the raw launch credential without changing other runtime values", () => {
    const environment = { DESKTOP_API_TOKEN: "secret", API_HOST: "127.0.0.1" };
    clearDesktopApiTokenEnvironment(environment);
    expect(environment).toEqual({ API_HOST: "127.0.0.1" });
  });
});
