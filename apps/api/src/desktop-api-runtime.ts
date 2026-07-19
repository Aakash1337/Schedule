import type { AddressInfo } from "node:net";

const readyPrefix = "SCHEDULE_DESKTOP_API_READY_V1";
const desktopShutdownCommand = "shutdown";
const maximumDesktopControlLineBytes = 64;
const desktopShutdownCommandBytes = [...Buffer.from(desktopShutdownCommand)];

type ProductApiMode = "disabled" | "local_unauthenticated" | "desktop_authenticated";

export interface DesktopShutdownControl {
  dispose(): void;
}

export interface DesktopShutdownControlOptions {
  readonly mode: ProductApiMode;
  readonly input: NodeJS.ReadableStream;
  readonly onShutdown: () => void;
}

export function clearDesktopApiTokenEnvironment(environment: NodeJS.ProcessEnv): void {
  delete environment.DESKTOP_API_TOKEN;
}

export function desktopApiReadyLine(address: AddressInfo | string | null): string {
  if (
    address === null ||
    typeof address === "string" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535
  ) {
    throw new Error("The desktop API did not expose a valid TCP readiness address.");
  }
  return `${readyPrefix} ${JSON.stringify({ port: address.port })}\n`;
}

/**
 * Installs the desktop supervisor's intentionally tiny stdin protocol. Input is
 * interpreted as bytes so a hostile or accidental oversized line cannot cause
 * unbounded buffering. EOF means the inherited supervisor channel has closed.
 */
export function installDesktopShutdownControl({
  mode,
  input,
  onShutdown,
}: DesktopShutdownControlOptions): DesktopShutdownControl {
  if (mode !== "desktop_authenticated") {
    return { dispose() {} };
  }

  let disposed = false;
  let shutdownRequested = false;
  let discardingLine = false;
  let line: number[] = [];

  const requestShutdown = (): void => {
    if (shutdownRequested || disposed) return;
    shutdownRequested = true;
    onShutdown();
  };

  const isShutdownCommand = (): boolean =>
    line.length === desktopShutdownCommandBytes.length &&
    line.every((byte, index) => byte === desktopShutdownCommandBytes[index]);

  const resetLine = (): void => {
    line = [];
    discardingLine = false;
  };

  const onData = (chunk: string | Uint8Array): void => {
    if (disposed || shutdownRequested) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const byte of bytes) {
      if (byte === 0x0a) {
        if (!discardingLine) {
          // Accept conventional CRLF framing without accepting any other text.
          if (line.at(-1) === 0x0d) line.pop();
          if (isShutdownCommand()) requestShutdown();
        }
        resetLine();
        if (shutdownRequested) return;
        continue;
      }
      if (discardingLine) continue;
      if (line.length >= maximumDesktopControlLineBytes) {
        line = [];
        discardingLine = true;
        continue;
      }
      line.push(byte);
    }
  };

  const onEnd = (): void => requestShutdown();

  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onEnd);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      line = [];
    },
  };
}
