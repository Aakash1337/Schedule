import type { AddressInfo } from "node:net";

const readyPrefix = "SCHEDULE_DESKTOP_API_READY_V1";

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
