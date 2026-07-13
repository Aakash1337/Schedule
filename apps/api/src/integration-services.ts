import { createHmac, timingSafeEqual } from "node:crypto";

import {
  AuthenticateIntegrationCredential,
  ConfirmIntegrationCommand,
  GetIntegrationToday,
  PrepareIntegrationCommand,
  type Clock,
  type IntegrationUnitOfWork,
  type SecretVerifier,
} from "@schedule/application";

import type { IntegrationServices } from "./integration-routes.js";

export function createIntegrationSecretVerifier(pepper: string): SecretVerifier {
  if (pepper.length < 32) {
    throw new Error("The integration API pepper must contain at least 32 characters.");
  }

  return {
    async verify(secret, secretHash) {
      const actual = Buffer.from(createHmac("sha256", pepper).update(secret, "utf8").digest("hex"));
      const expected = /^[a-f0-9]{64}$/.test(secretHash)
        ? Buffer.from(secretHash)
        : Buffer.from("0".repeat(64));
      return timingSafeEqual(actual, expected);
    },
  };
}

export function createIntegrationServices(
  unitOfWork: IntegrationUnitOfWork,
  clock: Clock,
  pepper: string,
  confirmationTtlSeconds = 600,
): IntegrationServices {
  if (
    !Number.isInteger(confirmationTtlSeconds) ||
    confirmationTtlSeconds < 60 ||
    confirmationTtlSeconds > 3_600
  ) {
    throw new Error("The integration confirmation TTL must be between 60 and 3600 seconds.");
  }

  const authenticateCredential = new AuthenticateIntegrationCredential(
    unitOfWork,
    clock,
    createIntegrationSecretVerifier(pepper),
  );
  const getToday = new GetIntegrationToday(unitOfWork, clock);
  const prepareCommand = new PrepareIntegrationCommand(
    unitOfWork,
    clock,
    confirmationTtlSeconds * 1_000,
  );
  const confirmCommand = new ConfirmIntegrationCommand(unitOfWork, clock);

  return {
    authenticateCredential: (input) => authenticateCredential.execute(input),
    getToday: (input) => getToday.execute(input),
    prepareCommand: (input) => prepareCommand.execute(input),
    confirmCommand: (input) => confirmCommand.execute(input),
  };
}
