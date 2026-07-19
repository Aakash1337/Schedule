import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  clearDesktopApiTokenEnvironment,
  desktopApiReadyLine,
  installDesktopShutdownControl,
} from "./desktop-api-runtime.js";

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

  it("shuts down when the inherited desktop stdin reaches EOF", async () => {
    const input = new PassThrough();
    let shutdowns = 0;
    await new Promise<void>((resolve) => {
      installDesktopShutdownControl({
        mode: "desktop_authenticated",
        input,
        onShutdown: () => {
          shutdowns += 1;
          resolve();
        },
      });

      input.end();
    });

    expect(shutdowns).toBe(1);
  });

  it("shuts down when the inherited desktop control stream fails", () => {
    const input = new PassThrough();
    let shutdowns = 0;
    installDesktopShutdownControl({
      mode: "desktop_authenticated",
      input,
      onShutdown: () => {
        shutdowns += 1;
      },
    });

    input.emit("error", new Error("control channel failed"));
    expect(shutdowns).toBe(1);
  });

  it("accepts one shutdown command even when it is repeated", () => {
    const input = new PassThrough();
    let shutdowns = 0;
    installDesktopShutdownControl({
      mode: "desktop_authenticated",
      input,
      onShutdown: () => {
        shutdowns += 1;
      },
    });

    input.write("shutdown\nshutdown\n");
    expect(shutdowns).toBe(1);
  });

  it("silently ignores malformed and oversized control lines", () => {
    const input = new PassThrough();
    let shutdowns = 0;
    installDesktopShutdownControl({
      mode: "desktop_authenticated",
      input,
      onShutdown: () => {
        shutdowns += 1;
      },
    });

    input.write("Shutdown\nshutdown now\n");
    input.write(`${"x".repeat(65)}\n`);
    expect(shutdowns).toBe(0);
  });

  it("leaves inherited stdin untouched outside desktop authenticated mode", () => {
    const input = new PassThrough();
    let shutdowns = 0;
    installDesktopShutdownControl({
      mode: "local_unauthenticated",
      input,
      onShutdown: () => {
        shutdowns += 1;
      },
    });

    input.write("shutdown\n");
    input.end();
    expect(shutdowns).toBe(0);
  });
});
